import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const cfg: any = vi.hoisted(() => ({ logLevel: "silent", money: { readsFrom: "float" } }));
vi.mock("@/config", () => ({ config: cfg }));
vi.mock("@/utils/idempotency", () => ({ acquireLock: async () => ({ release: async () => {} }), withIdempotencyKey: async (_k: string, fn: () => Promise<unknown>) => fn() }));
vi.mock("@/db/prisma", async () => {
  const { makeLedgerDb } = await import("./helpers/fakeLedgerDb");
  const db = makeLedgerDb();
  return { __db: db, prisma: db };
});
const db = ((await import("@/db/prisma")) as any).__db;

import { ledger } from "@/services/ledger";

const wallets = () => [...db.wallets.values()];
const walletOf = (userId: string, currency = "KES") => wallets().find((w: any) => w.userId === userId && w.currency === currency);
const system = () => wallets().filter((w: any) => w.kind === "system");
const entriesOf = (journalId: string) => db.entries.filter((e: any) => e.journalId === journalId);
/** Per currency: the sum of every wallet's balance (user and system). Must always be zero. */
const totals = () => {
  const t: Record<string, bigint> = {};
  for (const w of wallets()) t[w.currency] = (t[w.currency] ?? 0n) + w.balanceMinor;
  return t;
};
const allZero = () => Object.values(totals()).every((v) => v === 0n);

beforeEach(() => {
  db.reset();
  cfg.money = { readsFrom: "float" };
});
afterEach(() => vi.restoreAllMocks());

describe("a journal must balance, per currency, before anything is written", () => {
  const line = (userId: string, currency: string, direction: "credit" | "debit", amount: number, extra: object = {}) => ({ userId, currency, direction, amount, ...extra });

  it("refuses debits and credits that do not match, and writes nothing at all", async () => {
    await expect(ledger.post({ reference: "r", lines: [line("a", "KES", "credit", 100, { system: true }), line("b", "KES", "debit", 90, { system: true })] })).rejects.toThrow(/balance/i);
    expect(db.wallets.size).toBe(0);
    expect(db.entries).toHaveLength(0);
    expect(db.journals.size).toBe(0);
  });

  it("refuses a journal with fewer than two lines", async () => {
    await expect(ledger.post({ reference: "r", lines: [line("a", "KES", "credit", 100)] })).rejects.toThrow(/at least two/i);
    await expect(ledger.post({ reference: "r", lines: [] })).rejects.toThrow(/at least two/i);
  });

  it("refuses zero, negative and non-numeric amounts", async () => {
    for (const amount of [0, -5, NaN, Infinity]) {
      await expect(ledger.post({ reference: "r", lines: [line("a", "KES", "credit", amount, { system: true }), line("b", "KES", "debit", amount, { system: true })] })).rejects.toThrow();
    }
    expect(db.wallets.size).toBe(0);
  });

  it("balances in whole minor units, so float noise cannot unbalance it or hide an imbalance", async () => {
    await ledger.post({ reference: "ok", lines: [line("a", "KES", "credit", 0.1 + 0.2, { system: true }), line("b", "KES", "debit", 0.3, { system: true })] });
    await expect(ledger.post({ reference: "bad", lines: [line("a", "KES", "credit", 0.1 + 0.2, { system: true }), line("b", "KES", "debit", 0.31, { system: true })] })).rejects.toThrow(/balance/i);
  });

  it("balances EACH currency separately: one currency's surplus cannot cover another's shortfall", async () => {
    await expect(ledger.post({ reference: "r", lines: [line("a", "KES", "debit", 13_000, { system: true }), line("b", "USDC", "credit", 13_000, { system: true })] })).rejects.toThrow(/balance/i);
  });

  it("accepts a foreign-exchange journal that balances in each currency through a clearing account", async () => {
    const r = await ledger.post({
      reference: "invoice-1",
      idempotencyKey: "fx-1",
      lines: [
        line("treasury", "USDC", "debit", 100, { system: true }), // we receive 100 USDC
        line("fx", "USDC", "credit", 100, { system: true }),
        line("fx", "KES", "debit", 13_000, { system: true }), // and owe the merchant 13,000 KES
        line("merchant", "KES", "credit", 13_000),
      ],
    });
    expect(r.entries).toHaveLength(4);
    expect(walletOf("merchant")!.balance).toBe(13_000);
    expect(allZero()).toBe(true);
  });
});

describe("credit, debit and transfer are journals with a counter-account", () => {
  it("a credit is one journal: the user is credited and a system account is debited by the same amount", async () => {
    const r = await ledger.credit({ userId: "u1", amount: 100, currency: "KES", reference: "c1" });
    expect(db.journals.size).toBe(1);
    const lines = entriesOf([...db.journals.keys()][0]);
    expect(lines).toHaveLength(2);
    expect(lines.map((l: any) => [l.direction, l.amount]).sort()).toEqual([["credit", 100], ["debit", 100]]);
    expect(walletOf("u1")).toMatchObject({ balance: 100, kind: "user" });
    expect(system()).toHaveLength(1);
    expect(system()[0]).toMatchObject({ balance: -100, balanceMinor: -10000n }); // money in from outside: a negative (debit) balance
    expect(r.entry).toMatchObject({ direction: "credit", amount: 100 }); // the caller still gets the user's own entry
    expect(allZero()).toBe(true);
  });

  it("a debit mirrors it", async () => {
    await ledger.credit({ userId: "u1", amount: 100, currency: "KES", reference: "c1" });
    await ledger.debit({ userId: "u1", amount: 30, currency: "KES", reference: "d1" });
    expect(walletOf("u1")!.balance).toBe(70);
    expect(system().reduce((n: bigint, w: any) => n + w.balanceMinor, 0n)).toBe(-7000n);
    expect(allZero()).toBe(true);
  });

  it("a transfer is one journal between two people and touches no system account", async () => {
    await ledger.credit({ userId: "a", amount: 100, currency: "KES", reference: "seed" });
    const systemBefore = system().map((w: any) => w.balanceMinor);
    await ledger.transfer({ fromUserId: "a", toUserId: "b", amount: 40, currency: "KES", reference: "t1" });
    expect(walletOf("a")!.balance).toBe(60);
    expect(walletOf("b")!.balance).toBe(40);
    expect(system().map((w: any) => w.balanceMinor)).toEqual(systemBefore);
    const tJournal = [...db.journals.values()].find((j: any) => j.reference === "t1");
    expect(entriesOf(tJournal.id)).toHaveLength(2);
    expect(allZero()).toBe(true);
  });

  it("the counter-account can be named, so fees and other flows get their own books", async () => {
    await ledger.credit({ userId: "platform", amount: 5, currency: "KES", reference: "fee", counter: "fees", system: true });
    const names = system().map((w: any) => w.userId);
    expect(names.some((n: string) => n.includes("fees"))).toBe(true);
    expect(allZero()).toBe(true);
  });

  it("a credit marked as a system account is not a user liability, and may go negative", async () => {
    await ledger.credit({ userId: "platform", amount: 5, currency: "KES", reference: "fee", system: true });
    expect(walletOf("platform")).toMatchObject({ kind: "system" });
    await ledger.debit({ userId: "platform", amount: 50, currency: "KES", reference: "x", system: true });
    expect(walletOf("platform")!.balance).toBe(-45);
  });

  it("the counter-account is spread across shards, so no single row becomes the bottleneck for all money movement", async () => {
    for (let i = 0; i < 40; i++) await ledger.credit({ userId: `user-${i}`, amount: 10, currency: "KES", reference: `c${i}` });
    expect(system().length).toBeGreaterThan(1);
    expect(system().length).toBeLessThanOrEqual(8);
    expect(allZero()).toBe(true);
  });

  it("the same person always uses the same shard", async () => {
    await ledger.credit({ userId: "u1", amount: 10, currency: "KES", reference: "a" });
    const shardOf = (id: string) => id.split(":").pop();
    const first = shardOf(system()[0].userId);
    await ledger.credit({ userId: "u1", amount: 10, currency: "KES", reference: "b" });
    await ledger.debit({ userId: "u1", amount: 5, currency: "KES", reference: "c" });
    expect(new Set(system().map((w: any) => shardOf(w.userId)))).toEqual(new Set([first]));
  });

  it("money in comes from @world_in, money out goes to @world_out, and either spelling names the same account", async () => {
    await ledger.credit({ userId: "u1", amount: 10, currency: "KES", reference: "a" });
    await ledger.debit({ userId: "u1", amount: 4, currency: "KES", reference: "b" });
    await ledger.credit({ userId: "u1", amount: 1, currency: "KES", reference: "c", counter: "@world_out" }); // a reversal
    await ledger.debit({ userId: "u1", amount: 1, currency: "KES", reference: "d", counter: "world_out" });
    const named = (n: string) => system().filter((w: any) => w.userId.includes(`system:${n}:`));
    expect(named("world_in").map((w: any) => w.balance)).toEqual([-10]);
    expect(named("world_out").map((w: any) => w.balance)).toEqual([4]); // +4 out, -1 reversed, +1 out again... net 4
    expect(named("world_out")).toHaveLength(1);
  });

  it("a user can never be debited below zero, but the system side can be negative by design", async () => {
    await expect(ledger.debit({ userId: "u1", amount: 1, currency: "KES", reference: "d" })).rejects.toThrow("Insufficient");
    await ledger.credit({ userId: "u1", amount: 10, currency: "KES", reference: "c" });
    await expect(ledger.debit({ userId: "u1", amount: 11, currency: "KES", reference: "d" })).rejects.toThrow("Insufficient");
    expect(walletOf("u1")!.balance).toBe(10);
    expect(system()[0].balance).toBe(-10);
  });

  it("an explicit allowance can take a user below zero (a bookkeeping fee), still balanced", async () => {
    await ledger.credit({ userId: "u1", amount: 10, currency: "KES", reference: "c" });
    await ledger.debit({ userId: "u1", amount: 25, currency: "KES", reference: "fee", allowNegative: true });
    expect(walletOf("u1")!.balance).toBe(-15);
    expect(allZero()).toBe(true);
  });
});

describe("a journal happens once, whole", () => {
  const credit = (over: object = {}) => ledger.credit({ userId: "u1", amount: 50, currency: "KES", reference: "r", idempotencyKey: "k1", ...over });

  it("the same key twice is one journal, one set of entries, and the same answer", async () => {
    const a = await credit();
    const b = await credit();
    expect(db.journals.size).toBe(1);
    expect(db.entries).toHaveLength(2);
    expect(walletOf("u1")!.balance).toBe(50);
    expect(b.entry.id).toBe(a.entry.id);
  });

  it("a key reused for a different posting is refused", async () => {
    await credit();
    await expect(credit({ amount: 51 })).rejects.toThrow(/idempotency key/i);
    await expect(credit({ userId: "u2" })).rejects.toThrow(/idempotency key/i);
    expect(walletOf("u1")!.balance).toBe(50);
  });

  it("a journal posted twice with the same key and the same lines is replayed, with the replay flagged", async () => {
    const lines = [{ userId: "m", currency: "KES", direction: "credit" as const, amount: 10 }, { userId: "x", currency: "KES", direction: "debit" as const, amount: 10, system: true }];
    const first = await ledger.post({ reference: "r", idempotencyKey: "j1", lines });
    const second = await ledger.post({ reference: "r", idempotencyKey: "j1", lines });
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.journalId).toBe(first.journalId);
    expect(walletOf("m")!.balance).toBe(10);
  });

  it("five simultaneous first attempts post once", async () => {
    await Promise.all(Array.from({ length: 5 }, () => credit({ idempotencyKey: "race" })));
    expect(db.journals.size).toBe(1);
    expect(walletOf("u1")!.balance).toBe(50);
    expect(allZero()).toBe(true);
  });

  it("a refused journal does not use up its key", async () => {
    await expect(ledger.debit({ userId: "u1", amount: 50, currency: "KES", reference: "d", idempotencyKey: "needs-funds" })).rejects.toThrow("Insufficient");
    await credit({ idempotencyKey: "fund" });
    await ledger.debit({ userId: "u1", amount: 50, currency: "KES", reference: "d", idempotencyKey: "needs-funds" });
    expect(walletOf("u1")!.balance).toBe(0);
  });

  it("a lost race on the key returns the winner's journal", async () => {
    const first = await credit();
    vi.spyOn(db.journal, "findUnique").mockResolvedValueOnce(null);
    const second = await credit();
    expect(second.entry.id).toBe(first.entry.id);
    expect(db.journals.size).toBe(1);
  });

  it("if any line fails, the whole journal is undone: no half a movement", async () => {
    await ledger.credit({ userId: "a", amount: 100, currency: "KES", reference: "seed" });
    const before = { a: walletOf("a")!.balanceMinor, entries: db.entries.length, journals: db.journals.size };
    await expect(
      ledger.post({
        reference: "multi",
        lines: [
          { userId: "a", currency: "KES", direction: "debit", amount: 60 }, // fine
          { userId: "b", currency: "KES", direction: "debit", amount: 60 }, // b has nothing: refused
          { userId: "c", currency: "KES", direction: "credit", amount: 120 },
        ],
      })
    ).rejects.toThrow("Insufficient");
    expect(walletOf("a")!.balanceMinor).toBe(before.a); // a's 60 was NOT taken
    expect(walletOf("c")).toBeUndefined();
    expect(db.entries).toHaveLength(before.entries);
    expect(db.journals.size).toBe(before.journals);
    expect(allZero()).toBe(true);
  });

  it("a crash after the first entry is written undoes the first", async () => {
    const real = db.ledgerEntry.create;
    let calls = 0;
    vi.spyOn(db.ledgerEntry, "create").mockImplementation(async (args: any, ctx: any) => {
      if (++calls === 2) throw new Error("crash between the lines");
      return real(args, ctx);
    });
    await expect(ledger.credit({ userId: "u1", amount: 10, currency: "KES", reference: "r" })).rejects.toThrow("crash between");
    expect(db.wallets.size).toBe(0);
    expect(db.entries).toHaveLength(0);
    expect(db.journals.size).toBe(0);
  });
});

describe("the books always balance", () => {
  const rng = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);

  it("after hundreds of mixed operations: every journal balances, every wallet equals its entries, nothing was created or lost", async () => {
    const rand = rng(99);
    const users = ["a", "b", "c", "d"];
    for (const u of users) await ledger.credit({ userId: u, amount: 500, currency: "KES", reference: `seed-${u}` });
    for (let i = 0; i < 300; i++) {
      const u = users[Math.floor(rand() * users.length)];
      const amount = Math.round(rand() * 20000) / 100;
      if (amount <= 0) continue;
      const key = rand() < 0.3 ? `k${Math.floor(rand() * 40)}` : undefined;
      const op = rand();
      try {
        if (op < 0.3) await ledger.credit({ userId: u, amount, currency: "KES", reference: `r${i}`, ...(key ? { idempotencyKey: `c-${key}` } : {}) });
        else if (op < 0.6) await ledger.debit({ userId: u, amount, currency: "KES", reference: `r${i}`, ...(key ? { idempotencyKey: `d-${key}` } : {}) });
        else if (op < 0.85) await ledger.transfer({ fromUserId: u, toUserId: users[(users.indexOf(u) + 1) % 4], amount, currency: "KES", reference: `r${i}`, ...(key ? { idempotencyKey: `t-${key}` } : {}) });
        else {
          // A foreign-exchange journal: USDC in, KES owed.
          await ledger.post({
            reference: `fx${i}`,
            ...(key ? { idempotencyKey: `fx-${key}` } : {}),
            lines: [
              { userId: "treasury", currency: "USDC", direction: "debit", amount: amount / 130, system: true },
              { userId: "fx", currency: "USDC", direction: "credit", amount: amount / 130, system: true },
              { userId: "fx", currency: "KES", direction: "debit", amount, system: true },
              { userId: u, currency: "KES", direction: "credit", amount },
            ],
          });
        }
      } catch (e: any) {
        expect(String(e.message)).toMatch(/Insufficient|idempotency key|balance/i);
      }
    }

    expect(allZero(), JSON.stringify(totals(), (_k, v) => (typeof v === "bigint" ? v.toString() : v))).toBe(true);

    // Every journal balances in every currency.
    for (const j of db.journals.values()) {
      const byCurrency: Record<string, bigint> = {};
      for (const e of entriesOf(j.id)) byCurrency[e.currency] = (byCurrency[e.currency] ?? 0n) + (e.direction === "credit" ? e.amountMinor : -e.amountMinor);
      expect(Object.values(byCurrency).every((v) => v === 0n), `journal ${j.reference}`).toBe(true);
    }
    // Every wallet equals the sum of its entries, and no user wallet is negative.
    for (const w of wallets()) {
      const net = db.entries.filter((e: any) => e.walletId === w.id).reduce((n: bigint, e: any) => n + (e.direction === "credit" ? e.amountMinor : -e.amountMinor), 0n);
      expect(w.balanceMinor, `wallet ${w.userId}/${w.currency}`).toBe(net);
      if (w.kind === "user") expect(w.balanceMinor).toBeGreaterThanOrEqual(0n);
    }
  });

  it("concurrent postings keep the books balanced", async () => {
    await Promise.all(Array.from({ length: 30 }, (_, i) => ledger.credit({ userId: `u${i % 5}`, amount: 10, currency: "KES", reference: `c${i}` })));
    await Promise.allSettled(Array.from({ length: 30 }, (_, i) => ledger.debit({ userId: `u${i % 5}`, amount: 7, currency: "KES", reference: `d${i}` })));
    expect(allZero()).toBe(true);
  });
});
