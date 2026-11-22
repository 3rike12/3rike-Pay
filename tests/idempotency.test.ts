import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/config", () => ({ config: { logLevel: "silent" } }));

// A minimal Redis: strings with SET ... EX ... [NX], GET, DEL.
const store = new Map<string, string>();
vi.mock("@/services/redis", () => ({
  redis: {
    set: async (key: string, value: string, ...args: any[]) => {
      if (args.includes("NX") && store.has(key)) return null;
      store.set(key, value);
      return "OK";
    },
    get: async (key: string) => store.get(key) ?? null,
    del: async (key: string) => void store.delete(key),
  },
}));

import { withIdempotencyKey, stringifyResult } from "@/utils/idempotency";

beforeEach(() => store.clear());

describe("withIdempotencyKey", () => {
  it("runs once and returns the stored result on a repeat", async () => {
    const fn = vi.fn(async () => ({ ok: true }));
    expect(await withIdempotencyKey("k1", fn)).toEqual({ ok: true });
    expect(await withIdempotencyKey("k1", fn)).toEqual({ ok: true });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("still runs only once when the result carries BigInt minor-unit columns", async () => {
    // What ledger.credit returns now: rows with BigInt fields.
    const fn = vi.fn(async () => ({ wallet: { balance: 100, balanceMinor: 10000n }, entry: { amountMinor: 10000n } }));
    await withIdempotencyKey("ledger:credit-1", fn);
    const again = await withIdempotencyKey("ledger:credit-1", fn);
    expect(fn).toHaveBeenCalledTimes(1); // a second credit here would be a double credit
    expect(again).toEqual({ wallet: { balance: 100, balanceMinor: "10000" }, entry: { amountMinor: "10000" } });
  });

  it("different keys are independent", async () => {
    const fn = vi.fn(async () => 1);
    await withIdempotencyKey("a", fn);
    await withIdempotencyKey("b", fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe("stringifyResult", () => {
  it("writes BigInt as a string and leaves everything else alone", () => {
    expect(stringifyResult({ n: 5n, s: "x", f: 1.5, d: null, nested: { m: -3n } })).toBe('{"n":"5","s":"x","f":1.5,"d":null,"nested":{"m":"-3"}}');
  });
});
