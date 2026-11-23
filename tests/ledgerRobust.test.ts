import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const cfg: any = vi.hoisted(() => ({ logLevel: "silent", money: { readsFrom: "float" } }));
vi.mock("@/config", () => ({ config: cfg }));
// No Redis: no wallet lock, no cached results. The database alone must keep the ledger correct.
vi.mock("@/utils/idempotency", () => ({
  acquireLock: async () => ({ release: async () => {} }),
  withIdempotencyKey: async (_k: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock("@/db/prisma", async () => {
  const { makeLedgerDb } = await import("./helpers/fakeLedgerDb");
  const db = makeLedgerDb();
  return { __db: db, prisma: db };
});
const db = ((await import("@/db/prisma")) as any).__db;

import { ledger } from "@/services/ledger";

const wallet = (userId: string, currency = "KES") => [...db.wallets.values()].find((w: any) => w.userId === userId && w.currency === currency);
const entriesFor = (walletId: string) => db.entries.filter((e: any) => e.walletId === walletId);
const netMinor = (walletId: string) => entriesFor(walletId).reduce((n: bigint, e: any) => n + (e.direction === "credit" ? e.amountMinor : -e.amountMinor), 0n);

beforeEach(() => {
  db.reset();
  cfg.money = { readsFrom: "float" };
});
afterEach(() => vi.restoreAllMocks());

describe("durable idempotency (the database, not Redis, makes a posting happen once)", () => {
  it("a repeated credit with the same key posts once and returns the same entry", async () => {
    const a = await ledger.credit({ userId: "u1", amount: 100, currency: "KES", reference: "r1", idempotencyKey: "k1" });
    const b = await ledger.credit({ userId: "u1", amount: 100, currency: "KES", reference: "r1", idempotencyKey: "k1" });
    expect(db.entries).toHaveLength(1);
    expect(wallet("u1").balance).toBe(100);
    expect(b.entry.id).toBe(a.entry.id);
  });

  it("holds however long ago the first posting was: no cache expiry can let it post twice", async () => {
    await ledger.credit({ userId: "u1", amount: 100, currency: "KES", reference: "r1", idempotencyKey: "refund:1" });
    // (the Redis result cache is gone: mocked to never remember anything)
    await ledger.credit({ userId: "u1", amount: 100, currency: "KES", reference: "r1", idempotencyKey: "refund:1" });
    expect(wallet("u1").balance).toBe(100);
  });

  it("five simultaneous first attempts with one key post exactly once", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => ledger.credit({ userId: "u1", amount: 40, currency: "KES", reference: "r1", idempotencyKey: "race" }))
    );
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(db.entries).toHaveLength(1);
    expect(wallet("u1").balance).toBe(40);
    expect(wallet("u1").balanceMinor).toBe(4000n);
  });

  it("different keys post separately", async () => {
    await ledger.credit({ userId: "u1", amount: 10, currency: "KES", reference: "r1", idempotencyKey: "a" });
    await ledger.credit({ userId: "u1", amount: 10, currency: "KES", reference: "r1", idempotencyKey: "b" });
    expect(wallet("u1").balance).toBe(20);
  });

  it("postings with no key are never merged", async () => {
    await ledger.credit({ userId: "u1", amount: 10, currency: "KES", reference: "r1" });
    await ledger.credit({ userId: "u1", amount: 10, currency: "KES", reference: "r1" });
    expect(wallet("u1").balance).toBe(20);
  });

  it("refuses a key reused for something different, instead of silently returning the old result", async () => {
    await ledger.credit({ userId: "u1", amount: 100, currency: "KES", reference: "r1", idempotencyKey: "k" });
    await expect(ledger.credit({ userId: "u1", amount: 999, currency: "KES", reference: "r1", idempotencyKey: "k" })).rejects.toThrow(/idempotency key/i);
    await expect(ledger.credit({ userId: "u2", amount: 100, currency: "KES", reference: "r1", idempotencyKey: "k" })).rejects.toThrow(/idempotency key/i);
    await expect(ledger.debit({ userId: "u1", amount: 100, currency: "KES", reference: "r1", idempotencyKey: "k" })).rejects.toThrow(/idempotency key/i);
    expect(wallet("u1").balance).toBe(100);
  });

  it("a debit replays too", async () => {
    await ledger.credit({ userId: "u1", amount: 100, currency: "KES", reference: "c" });
    await ledger.debit({ userId: "u1", amount: 30, currency: "KES", reference: "d", idempotencyKey: "d1" });
    await ledger.debit({ userId: "u1", amount: 30, currency: "KES", reference: "d", idempotencyKey: "d1" });
    expect(wallet("u1").balance).toBe(70);
  });

  it("a transfer replays: both legs once", async () => {
    db.seedWallet({ userId: "a", currency: "KES", balance: 100, balanceMinor: 10000n });
    await ledger.transfer({ fromUserId: "a", toUserId: "b", amount: 25, currency: "KES", reference: "t", idempotencyKey: "t1" });
    await ledger.transfer({ fromUserId: "a", toUserId: "b", amount: 25, currency: "KES", reference: "t", idempotencyKey: "t1" });
    expect(wallet("a").balance).toBe(75);
    expect(wallet("b").balance).toBe(25);
    expect(db.entries).toHaveLength(2);
  });

  it("a refused posting does not use up its key, so the retry after a top-up works", async () => {
    await expect(ledger.debit({ userId: "u1", amount: 50, currency: "KES", reference: "d", idempotencyKey: "needs-funds" })).rejects.toThrow("Insufficient");
    await ledger.credit({ userId: "u1", amount: 100, currency: "KES", reference: "c" });
    await ledger.debit({ userId: "u1", amount: 50, currency: "KES", reference: "d", idempotencyKey: "needs-funds" });
    expect(wallet("u1").balance).toBe(50);
  });
});

describe("no overdraft, even with no lock", () => {
  it("two simultaneous debits that together exceed the balance: exactly one succeeds", async () => {
    await ledger.credit({ userId: "u1", amount: 100, currency: "KES", reference: "c" });
    const results = await Promise.allSettled([
      ledger.debit({ userId: "u1", amount: 80, currency: "KES", reference: "d1" }),
      ledger.debit({ userId: "u1", amount: 80, currency: "KES", reference: "d2" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(wallet("u1").balance).toBe(20);
    expect(wallet("u1").balanceMinor).toBe(2000n);
  });

  it("the same holds reading from minor units", async () => {
    cfg.money = { readsFrom: "minor" };
    await ledger.credit({ userId: "u1", amount: 100, currency: "KES", reference: "c" });
    const results = await Promise.allSettled([
      ledger.debit({ userId: "u1", amount: 80, currency: "KES", reference: "d1" }),
      ledger.debit({ userId: "u1", amount: 80, currency: "KES", reference: "d2" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(wallet("u1").balanceMinor).toBe(2000n);
  });

  it("ten simultaneous debits of 30 from 100 let exactly three through", async () => {
    await ledger.credit({ userId: "u1", amount: 100, currency: "KES", reference: "c" });
    const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => ledger.debit({ userId: "u1", amount: 30, currency: "KES", reference: `d${i}` })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(wallet("u1").balance).toBe(10);
  });

  it("an explicitly allowed negative (a bookkeeping fee) still goes through", async () => {
    await ledger.credit({ userId: "u1", amount: 10, currency: "KES", reference: "c" });
    await ledger.debit({ userId: "u1", amount: 25, currency: "KES", reference: "fee", allowNegative: true });
    expect(wallet("u1").balance).toBe(-15);
    expect(wallet("u1").balanceMinor).toBe(-1500n);
  });

  it("a debit on a wallet that does not exist is refused, and creates nothing", async () => {
    await expect(ledger.debit({ userId: "ghost", amount: 1, currency: "KES", reference: "d" })).rejects.toThrow("Insufficient");
    expect(db.wallets.size).toBe(0);
  });

  it("a transfer cannot overdraw, and changes nothing when refused", async () => {
    db.seedWallet({ userId: "a", currency: "KES", balance: 50, balanceMinor: 5000n });
    await expect(ledger.transfer({ fromUserId: "a", toUserId: "b", amount: 80, currency: "KES", reference: "t" })).rejects.toThrow("Insufficient");
    expect(wallet("a").balance).toBe(50);
    expect(wallet("b")).toBeUndefined();
    expect(db.entries).toHaveLength(0);
  });

  it("two simultaneous transfers out of one wallet cannot together overdraw it", async () => {
    db.seedWallet({ userId: "a", currency: "KES", balance: 100, balanceMinor: 10000n });
    const results = await Promise.allSettled([
      ledger.transfer({ fromUserId: "a", toUserId: "b", amount: 80, currency: "KES", reference: "t1" }),
      ledger.transfer({ fromUserId: "a", toUserId: "c", amount: 80, currency: "KES", reference: "t2" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(wallet("a").balance).toBe(20);
  });
});

describe("no lost updates", () => {
  it("fifty simultaneous credits all land, in both columns", async () => {
    await Promise.all(Array.from({ length: 50 }, (_, i) => ledger.credit({ userId: "u1", amount: 10, currency: "KES", reference: `c${i}` })));
    expect(wallet("u1").balance).toBe(500);
    expect(wallet("u1").balanceMinor).toBe(50000n);
    expect(entriesFor(wallet("u1").id)).toHaveLength(50);
  });

  it("the first credits to a new wallet, all at once, create it once and lose nothing", async () => {
    await Promise.all(Array.from({ length: 8 }, (_, i) => ledger.credit({ userId: "new", amount: 5, currency: "KES", reference: `c${i}` })));
    expect([...db.wallets.values()].filter((w: any) => w.userId === "new")).toHaveLength(1);
    expect(wallet("new").balance).toBe(40);
  });

  it("opposite transfers at the same moment conserve money and finish", async () => {
    db.seedWallet({ userId: "a", currency: "KES", balance: 100, balanceMinor: 10000n });
    db.seedWallet({ userId: "b", currency: "KES", balance: 100, balanceMinor: 10000n });
    await Promise.all([
      ledger.transfer({ fromUserId: "a", toUserId: "b", amount: 30, currency: "KES", reference: "t1" }),
      ledger.transfer({ fromUserId: "b", toUserId: "a", amount: 10, currency: "KES", reference: "t2" }),
    ]);
    expect(wallet("a").balance + wallet("b").balance).toBe(200);
    expect(wallet("a").balance).toBe(80);
  });
});

describe("the entries always explain the balance", () => {
  // A small deterministic generator, so a failure is reproducible.
  const rng = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);

  it("after hundreds of mixed operations, every wallet equals the sum of its entries and none is negative", async () => {
    const rand = rng(42);
    const users = ["a", "b", "c", "d"];
    for (const u of users) await ledger.credit({ userId: u, amount: 500, currency: "KES", reference: `seed-${u}` });
    for (let i = 0; i < 300; i++) {
      const op = rand();
      const u = users[Math.floor(rand() * users.length)];
      const amount = Math.round(rand() * 20000) / 100; // up to 200.00, with cents
      if (amount <= 0) continue;
      const key = rand() < 0.3 ? `k${Math.floor(rand() * 40)}` : undefined; // some keys repeat on purpose
      try {
        if (op < 0.4) await ledger.credit({ userId: u, amount, currency: "KES", reference: `r${i}`, ...(key ? { idempotencyKey: `c-${key}` } : {}) });
        else if (op < 0.75) await ledger.debit({ userId: u, amount, currency: "KES", reference: `r${i}`, ...(key ? { idempotencyKey: `d-${key}` } : {}) });
        else {
          const to = users[(users.indexOf(u) + 1) % users.length];
          await ledger.transfer({ fromUserId: u, toUserId: to, amount, currency: "KES", reference: `r${i}`, ...(key ? { idempotencyKey: `t-${key}` } : {}) });
        }
      } catch (e: any) {
        // A reused key with a different amount is refused by design; an overdraft is refused by design.
        expect(String(e.message)).toMatch(/Insufficient|idempotency key/i);
      }
    }
    for (const w of db.wallets.values()) {
      expect(w.balanceMinor, `wallet ${w.userId} minor vs entries`).toBe(netMinor(w.id));
      expect(w.balance).toBeGreaterThanOrEqual(0);
      expect(w.balanceMinor).toBeGreaterThanOrEqual(0n);
    }
    // And money was only ever moved, never made, by transfers: totals match the entries overall.
    const total = [...db.wallets.values()].reduce((n: bigint, w: any) => n + w.balanceMinor, 0n);
    const fromEntries = db.entries.reduce((n: bigint, e: any) => n + (e.direction === "credit" ? e.amountMinor : -e.amountMinor), 0n);
    expect(total).toBe(fromEntries);
  });

  it("every entry's running balance is the wallet's balance right after it, per wallet in order", async () => {
    for (let i = 0; i < 25; i++) {
      await ledger.credit({ userId: "u1", amount: 12.34, currency: "KES", reference: `c${i}` });
      if (i % 3 === 0) await ledger.debit({ userId: "u1", amount: 5.01, currency: "KES", reference: `d${i}` });
    }
    let running = 0n;
    for (const e of entriesFor(wallet("u1").id)) {
      running += e.direction === "credit" ? e.amountMinor : -e.amountMinor;
      expect(e.runningBalanceMinor).toBe(running);
    }
    expect(running).toBe(wallet("u1").balanceMinor);
  });
});

describe("when the database says no (races and crashes)", () => {
  it("a lost race on the idempotency key returns the winner's entry instead of failing", async () => {
    const first = await ledger.credit({ userId: "u1", amount: 50, currency: "KES", reference: "r1", idempotencyKey: "k" });
    // This caller's early read misses the entry (it was not committed yet when it looked)...
    vi.spyOn(db.ledgerEntry, "findUnique").mockResolvedValueOnce(null);
    // ...so it tries to write, the unique key refuses, and it must come back with the winner's result.
    const second = await ledger.credit({ userId: "u1", amount: 50, currency: "KES", reference: "r1", idempotencyKey: "k" });
    expect(second.entry.id).toBe(first.entry.id);
    expect(wallet("u1").balance).toBe(50);
    expect(db.entries).toHaveLength(1);
  });

  it("a lost race creating a wallet is retried and the credit still lands once", async () => {
    await ledger.credit({ userId: "u1", amount: 10, currency: "KES", reference: "r0" });
    // The caller's read says "no wallet yet" although another caller just created it.
    const real = db.wallet.findUnique;
    let lied = false;
    vi.spyOn(db.wallet, "findUnique").mockImplementation(async (args: any, ctx: any) => {
      if (!lied && args.where.userId_currency) {
        lied = true;
        return null;
      }
      return real(args, ctx);
    });
    await ledger.credit({ userId: "u1", amount: 5, currency: "KES", reference: "r1" });
    expect(wallet("u1").balance).toBe(15);
    expect([...db.wallets.values()].filter((w: any) => w.userId === "u1")).toHaveLength(1);
  });

  it("a real database error is raised, not swallowed or retried forever", async () => {
    vi.spyOn(db.ledgerEntry, "create").mockRejectedValue(new Error("connection lost"));
    await expect(ledger.credit({ userId: "u1", amount: 5, currency: "KES", reference: "r" })).rejects.toThrow("connection lost");
    expect(wallet("u1")).toBeUndefined(); // the wallet created in the same transaction was rolled back
  });

  it("a transfer that dies after the first leg undoes the first leg", async () => {
    db.seedWallet({ userId: "a", currency: "KES", balance: 100, balanceMinor: 10000n });
    const real = db.ledgerEntry.create;
    let calls = 0;
    vi.spyOn(db.ledgerEntry, "create").mockImplementation(async (args: any, ctx: any) => {
      if (++calls === 2) throw new Error("crash between the legs");
      return real(args, ctx);
    });
    await expect(ledger.transfer({ fromUserId: "a", toUserId: "b", amount: 40, currency: "KES", reference: "t" })).rejects.toThrow("crash between");
    expect(wallet("a").balance).toBe(100); // not 60: the debit was rolled back
    expect(wallet("a").balanceMinor).toBe(10000n);
    expect(wallet("b")).toBeUndefined();
    expect(db.entries).toHaveLength(0);
  });

  it("a transfer retried after that crash then succeeds exactly once", async () => {
    db.seedWallet({ userId: "a", currency: "KES", balance: 100, balanceMinor: 10000n });
    const real = db.ledgerEntry.create;
    let calls = 0;
    vi.spyOn(db.ledgerEntry, "create").mockImplementation(async (args: any, ctx: any) => {
      if (++calls === 2) throw new Error("crash");
      return real(args, ctx);
    });
    await expect(ledger.transfer({ fromUserId: "a", toUserId: "b", amount: 40, currency: "KES", reference: "t", idempotencyKey: "t1" })).rejects.toThrow("crash");
    await ledger.transfer({ fromUserId: "a", toUserId: "b", amount: 40, currency: "KES", reference: "t", idempotencyKey: "t1" });
    await ledger.transfer({ fromUserId: "a", toUserId: "b", amount: 40, currency: "KES", reference: "t", idempotencyKey: "t1" });
    expect(wallet("a").balance).toBe(60);
    expect(wallet("b").balance).toBe(40);
  });

  it("a transfer replay with a different amount is refused", async () => {
    db.seedWallet({ userId: "a", currency: "KES", balance: 100, balanceMinor: 10000n });
    await ledger.transfer({ fromUserId: "a", toUserId: "b", amount: 10, currency: "KES", reference: "t", idempotencyKey: "t1" });
    await expect(ledger.transfer({ fromUserId: "a", toUserId: "b", amount: 99, currency: "KES", reference: "t", idempotencyKey: "t1" })).rejects.toThrow(/idempotency key/i);
    expect(wallet("a").balance).toBe(90);
  });

  it("refuses bad amounts before touching anything", async () => {
    for (const amount of [0, -5]) {
      await expect(ledger.credit({ userId: "u1", amount, currency: "KES", reference: "r" })).rejects.toThrow("greater than zero");
      await expect(ledger.debit({ userId: "u1", amount, currency: "KES", reference: "r" })).rejects.toThrow("greater than zero");
    }
    await expect(ledger.transfer({ fromUserId: "a", toUserId: "b", amount: 0, currency: "KES", reference: "r" })).rejects.toThrow("greater than zero");
    await expect(ledger.transfer({ fromUserId: "a", toUserId: "a", amount: 5, currency: "KES", reference: "r" })).rejects.toThrow("same user");
    expect(db.wallets.size).toBe(0);
  });
});

describe("a wallet that disagrees with its integer column (drift)", () => {
  it("is healed on its next posting, and concurrent postings to it still all land", async () => {
    db.seedWallet({ userId: "u1", currency: "KES", balance: 500, balanceMinor: 0n }); // never backfilled
    await ledger.credit({ userId: "u1", amount: 1, currency: "KES", reference: "heal" });
    expect(wallet("u1")).toMatchObject({ balance: 501, balanceMinor: 50100n });
    await Promise.all(Array.from({ length: 10 }, (_, i) => ledger.credit({ userId: "u1", amount: 1, currency: "KES", reference: `c${i}` })));
    expect(wallet("u1")).toMatchObject({ balance: 511, balanceMinor: 51100n });
  });

  it("a debit still cannot overdraw a drifted wallet", async () => {
    db.seedWallet({ userId: "u1", currency: "KES", balance: 50, balanceMinor: 0n });
    await expect(ledger.debit({ userId: "u1", amount: 80, currency: "KES", reference: "d" })).rejects.toThrow("Insufficient");
    expect(wallet("u1").balance).toBe(50);
  });
});
