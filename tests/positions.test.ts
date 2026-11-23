import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/config", () => ({ config: { logLevel: "silent" } }));
vi.mock("@/utils/idempotency", () => ({
  acquireLock: async () => ({ release: async () => {} }),
  withIdempotencyKey: async (_k: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock("@/db/prisma", async () => {
  const { makePositionDb } = await import("./helpers/fakePositionDb");
  const db = makePositionDb();
  return { __db: db, prisma: db };
});
const db = ((await import("@/db/prisma")) as any).__db;

import { positions } from "@/services/positions";

const TSLA = "0xb20000000000000000000016e38fd364d271ba28";
const NVDA = "0xb20000000000000000000006f910a0e7bbd3c168";
const row = (userId: string, token = TSLA) => [...db.positions.values()].find((p: any) => p.userId === userId && p.tokenAddress === token);
const entriesOf = (positionId: string) => db.entries.filter((e: any) => e.positionId === positionId);
const ONE = 100_000_000n; // one token at 8 decimals

beforeEach(() => db.reset());
afterEach(() => vi.restoreAllMocks());

describe("crediting units", () => {
  it("creates the position with the exact units and an entry that records the balance after it", async () => {
    const r = await positions.credit({ userId: "u1", tokenAddress: TSLA, units: 2n * ONE + 5n, reference: "order-1" });
    expect(row("u1").units).toBe(200_000_005n);
    expect(r.entry).toMatchObject({ direction: "credit", units: 200_000_005n, runningUnits: 200_000_005n, reference: "order-1" });
  });

  it("adds to an existing position", async () => {
    await positions.credit({ userId: "u1", tokenAddress: TSLA, units: ONE, reference: "o1" });
    await positions.credit({ userId: "u1", tokenAddress: TSLA, units: ONE / 2n, reference: "o2" });
    expect(row("u1").units).toBe(150_000_000n);
  });

  it("keeps a separate position per user and per token", async () => {
    await positions.credit({ userId: "u1", tokenAddress: TSLA, units: ONE, reference: "o1" });
    await positions.credit({ userId: "u1", tokenAddress: NVDA, units: 2n * ONE, reference: "o2" });
    await positions.credit({ userId: "u2", tokenAddress: TSLA, units: 3n * ONE, reference: "o3" });
    expect(row("u1", TSLA).units).toBe(ONE);
    expect(row("u1", NVDA).units).toBe(2n * ONE);
    expect(row("u2", TSLA).units).toBe(3n * ONE);
  });

  it("treats a mixed-case address as the same token as its lower-case form", async () => {
    await positions.credit({ userId: "u1", tokenAddress: "0xB20000000000000000000016E38FD364D271BA28", units: ONE, reference: "o1" });
    await positions.credit({ userId: "u1", tokenAddress: TSLA, units: ONE, reference: "o2" });
    expect(db.positions.size).toBe(1);
    expect(row("u1").units).toBe(2n * ONE);
  });

  it("is exact far beyond what a float can hold", async () => {
    const huge = 10n ** 24n + 1n; // not representable as a JS number
    await positions.credit({ userId: "u1", tokenAddress: TSLA, units: huge, reference: "o1" });
    await positions.credit({ userId: "u1", tokenAddress: TSLA, units: 1n, reference: "o2" });
    expect(row("u1").units).toBe(10n ** 24n + 2n);
  });

  it("refuses anything that is not a positive whole number of units", async () => {
    for (const units of [0n, -1n]) await expect(positions.credit({ userId: "u1", tokenAddress: TSLA, units, reference: "o" })).rejects.toThrow(/greater than zero/);
    // A JS number could silently lose precision: it is rejected outright.
    await expect(positions.credit({ userId: "u1", tokenAddress: TSLA, units: 5 as any, reference: "o" })).rejects.toThrow(/bigint/i);
    await expect(positions.credit({ userId: "u1", tokenAddress: TSLA, units: "5" as any, reference: "o" })).rejects.toThrow(/bigint/i);
    expect(db.positions.size).toBe(0);
  });

  it("refuses an address that is not one", async () => {
    for (const bad of ["tsla", "0x123", "", "0xZZ0000000000000000000016e38fd364d271ba28"]) {
      await expect(positions.credit({ userId: "u1", tokenAddress: bad, units: ONE, reference: "o" })).rejects.toThrow(/address/i);
    }
  });

  it("fifty simultaneous credits all land", async () => {
    await Promise.all(Array.from({ length: 50 }, (_, i) => positions.credit({ userId: "u1", tokenAddress: TSLA, units: ONE, reference: `o${i}` })));
    expect(row("u1").units).toBe(50n * ONE);
    expect(entriesOf(row("u1").id)).toHaveLength(50);
  });

  it("a lost race creating the position is retried, and nothing is lost", async () => {
    await positions.credit({ userId: "u1", tokenAddress: TSLA, units: ONE, reference: "o0" });
    const real = db.stockPosition.findUnique;
    let lied = false;
    vi.spyOn(db.stockPosition, "findUnique").mockImplementation(async (a: any) => {
      if (!lied && a.where.userId_tokenAddress) {
        lied = true;
        return null;
      }
      return real(a);
    });
    await positions.credit({ userId: "u1", tokenAddress: TSLA, units: ONE, reference: "o1" });
    expect(row("u1").units).toBe(2n * ONE);
    expect(db.positions.size).toBe(1);
  });
});

describe("debiting units", () => {
  beforeEach(async () => {
    await positions.credit({ userId: "u1", tokenAddress: TSLA, units: 10n * ONE, reference: "seed" });
  });

  it("reduces the position and records the balance after", async () => {
    const r = await positions.debit({ userId: "u1", tokenAddress: TSLA, units: 4n * ONE, reference: "sell-1" });
    expect(row("u1").units).toBe(6n * ONE);
    expect(r.entry).toMatchObject({ direction: "debit", units: 4n * ONE, runningUnits: 6n * ONE });
  });

  it("allows selling exactly everything, leaving zero", async () => {
    await positions.debit({ userId: "u1", tokenAddress: TSLA, units: 10n * ONE, reference: "sell-all" });
    expect(row("u1").units).toBe(0n);
  });

  it("refuses more than is owned, and changes nothing", async () => {
    await expect(positions.debit({ userId: "u1", tokenAddress: TSLA, units: 10n * ONE + 1n, reference: "x" })).rejects.toThrow(/Insufficient/);
    expect(row("u1").units).toBe(10n * ONE);
    expect(db.entries).toHaveLength(1);
  });

  it("refuses to sell what the user never held, and creates nothing", async () => {
    await expect(positions.debit({ userId: "u1", tokenAddress: NVDA, units: 1n, reference: "x" })).rejects.toThrow(/Insufficient/);
    await expect(positions.debit({ userId: "ghost", tokenAddress: TSLA, units: 1n, reference: "x" })).rejects.toThrow(/Insufficient/);
    expect(db.positions.size).toBe(1);
  });

  it("two simultaneous sales that together exceed the holding: exactly one goes through", async () => {
    const results = await Promise.allSettled([
      positions.debit({ userId: "u1", tokenAddress: TSLA, units: 8n * ONE, reference: "s1" }),
      positions.debit({ userId: "u1", tokenAddress: TSLA, units: 8n * ONE, reference: "s2" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(row("u1").units).toBe(2n * ONE);
  });

  it("ten simultaneous sales of 3 from 10 let exactly three through, never overselling", async () => {
    const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => positions.debit({ userId: "u1", tokenAddress: TSLA, units: 3n * ONE, reference: `s${i}` })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(row("u1").units).toBe(1n * ONE);
  });
});

describe("exactly once", () => {
  it("a repeated credit with the same key posts once and returns the original entry", async () => {
    const a = await positions.credit({ userId: "u1", tokenAddress: TSLA, units: ONE, reference: "o1", idempotencyKey: "buy:1" });
    const b = await positions.credit({ userId: "u1", tokenAddress: TSLA, units: ONE, reference: "o1", idempotencyKey: "buy:1" });
    expect(row("u1").units).toBe(ONE);
    expect(b.entry.id).toBe(a.entry.id);
    expect(db.entries).toHaveLength(1);
  });

  it("a repeated debit replays too", async () => {
    await positions.credit({ userId: "u1", tokenAddress: TSLA, units: 5n * ONE, reference: "seed" });
    await positions.debit({ userId: "u1", tokenAddress: TSLA, units: ONE, reference: "s", idempotencyKey: "sell:1" });
    await positions.debit({ userId: "u1", tokenAddress: TSLA, units: ONE, reference: "s", idempotencyKey: "sell:1" });
    expect(row("u1").units).toBe(4n * ONE);
  });

  it("five simultaneous first attempts with one key post exactly once", async () => {
    await Promise.all(Array.from({ length: 5 }, () => positions.credit({ userId: "u1", tokenAddress: TSLA, units: ONE, reference: "o1", idempotencyKey: "race" })));
    expect(row("u1").units).toBe(ONE);
    expect(db.entries).toHaveLength(1);
  });

  it("a lost race on the key returns the winner's entry", async () => {
    const first = await positions.credit({ userId: "u1", tokenAddress: TSLA, units: ONE, reference: "o1", idempotencyKey: "k" });
    vi.spyOn(db.positionEntry, "findUnique").mockResolvedValueOnce(null);
    const second = await positions.credit({ userId: "u1", tokenAddress: TSLA, units: ONE, reference: "o1", idempotencyKey: "k" });
    expect(second.entry.id).toBe(first.entry.id);
    expect(row("u1").units).toBe(ONE);
  });

  it("refuses a key reused for something different", async () => {
    await positions.credit({ userId: "u1", tokenAddress: TSLA, units: ONE, reference: "o1", idempotencyKey: "k" });
    await expect(positions.credit({ userId: "u1", tokenAddress: TSLA, units: 2n * ONE, reference: "o1", idempotencyKey: "k" })).rejects.toThrow(/idempotency key/i);
    await expect(positions.credit({ userId: "u2", tokenAddress: TSLA, units: ONE, reference: "o1", idempotencyKey: "k" })).rejects.toThrow(/idempotency key/i);
    await expect(positions.credit({ userId: "u1", tokenAddress: NVDA, units: ONE, reference: "o1", idempotencyKey: "k" })).rejects.toThrow(/idempotency key/i);
    await expect(positions.debit({ userId: "u1", tokenAddress: TSLA, units: ONE, reference: "o1", idempotencyKey: "k" })).rejects.toThrow(/idempotency key/i);
    expect(row("u1").units).toBe(ONE);
  });

  it("a refused debit does not use up its key", async () => {
    await expect(positions.debit({ userId: "u1", tokenAddress: TSLA, units: ONE, reference: "s", idempotencyKey: "sell:9" })).rejects.toThrow(/Insufficient/);
    await positions.credit({ userId: "u1", tokenAddress: TSLA, units: 2n * ONE, reference: "buy" });
    await positions.debit({ userId: "u1", tokenAddress: TSLA, units: ONE, reference: "s", idempotencyKey: "sell:9" });
    expect(row("u1").units).toBe(ONE);
  });

  it("a crash after the units move but before the entry is written undoes the move", async () => {
    vi.spyOn(db.positionEntry, "create").mockRejectedValue(new Error("connection lost"));
    await expect(positions.credit({ userId: "u1", tokenAddress: TSLA, units: ONE, reference: "o1" })).rejects.toThrow("connection lost");
    expect(db.positions.size).toBe(0);
  });
});

describe("reading", () => {
  it("returns a user's holdings, skipping tokens sold down to zero", async () => {
    await positions.credit({ userId: "u1", tokenAddress: TSLA, units: ONE, reference: "a" });
    await positions.credit({ userId: "u1", tokenAddress: NVDA, units: ONE, reference: "b" });
    await positions.debit({ userId: "u1", tokenAddress: NVDA, units: ONE, reference: "c" });
    const held = await positions.list("u1");
    expect(held.map((p) => [p.tokenAddress, p.units])).toEqual([[TSLA, ONE]]);
  });

  it("gets one position, zero when there is none", async () => {
    expect(await positions.get("u1", TSLA)).toBe(0n);
    await positions.credit({ userId: "u1", tokenAddress: TSLA, units: 7n, reference: "a" });
    expect(await positions.get("u1", TSLA)).toBe(7n);
    expect(await positions.get("u1", "0xB20000000000000000000016E38FD364D271BA28")).toBe(7n);
  });

  it("totals what every user owns of each token: what the treasury must hold", async () => {
    await positions.credit({ userId: "u1", tokenAddress: TSLA, units: 3n * ONE, reference: "a" });
    await positions.credit({ userId: "u2", tokenAddress: TSLA, units: 2n * ONE, reference: "b" });
    await positions.credit({ userId: "u2", tokenAddress: NVDA, units: ONE, reference: "c" });
    const totals = await positions.totals();
    expect(Object.fromEntries(totals.map((t) => [t.tokenAddress, t.units]))).toEqual({ [TSLA]: 5n * ONE, [NVDA]: ONE });
  });
});

describe("the entries always explain the holding", () => {
  const rng = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);

  it("after hundreds of random buys, sells and replays, every position equals its entries and none is negative", async () => {
    const rand = rng(7);
    const users = ["a", "b", "c"];
    const tokens = [TSLA, NVDA];
    for (let i = 0; i < 300; i++) {
      const u = users[Math.floor(rand() * users.length)];
      const t = tokens[Math.floor(rand() * tokens.length)];
      const units = BigInt(Math.floor(rand() * 500_000_000) + 1);
      const key = rand() < 0.3 ? `k${Math.floor(rand() * 30)}` : undefined;
      try {
        if (rand() < 0.55) await positions.credit({ userId: u, tokenAddress: t, units, reference: `r${i}`, ...(key ? { idempotencyKey: `c-${key}` } : {}) });
        else await positions.debit({ userId: u, tokenAddress: t, units, reference: `r${i}`, ...(key ? { idempotencyKey: `d-${key}` } : {}) });
      } catch (e: any) {
        expect(String(e.message)).toMatch(/Insufficient|idempotency key/i);
      }
    }
    for (const p of db.positions.values()) {
      const net = entriesOf(p.id).reduce((n: bigint, e: any) => n + (e.direction === "credit" ? e.units : -e.units), 0n);
      expect(p.units, `${p.userId}/${p.tokenAddress}`).toBe(net);
      expect(p.units).toBeGreaterThanOrEqual(0n);
      let running = 0n;
      for (const e of entriesOf(p.id)) {
        running += e.direction === "credit" ? e.units : -e.units;
        expect(e.runningUnits).toBe(running);
      }
    }
  });
});
