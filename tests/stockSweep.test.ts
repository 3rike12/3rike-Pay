import { describe, it, expect, vi } from "vitest";
vi.mock("@/config", () => ({ config: { logLevel: "silent", stocks: { blockUs: true } } }));
import { runSweep, sweepMessage, type SweepDeps } from "@/services/stockSweep";
import { OrderRefused } from "@/services/orderErrors";

const tk = (a: string, ticker: string): any => ({ address: a, ticker, name: ticker, symbol: ticker + "c", decimals: 8, multiplier: 1 });
const N = tk("N", "NVDA"), M = tk("M", "MSFT");
const mk = (over: Partial<SweepDeps> = {}) => {
  const placed: any[] = [];
  const d: SweepDeps = {
    getRule: async () => ({ percent: 10, tokenAddress: "N" }),
    targets: async () => [{ tokenAddress: "N", percent: 60 }, { tokenAddress: "M", percent: 40 }],
    stocks: async () => [N, M],
    user: async () => ({ phone: "254712345678", business: { country: "KE" } }),
    place: async (p) => (placed.push(p), { state: "filled" }),
    ...over,
  };
  return { d, placed };
};
const sale = { merchantId: "m1", invoiceId: "inv1", amount: 10_000, currency: "KES" };

describe("runSweep", () => {
  it("invests the chosen share of the sale in the chosen stock, with a reference tied to the invoice", async () => {
    const { d, placed } = mk();
    const o = await runSweep(sale, d);
    expect(placed).toEqual([{ reference: "sweep:inv1:N", userId: "m1", token: N, cashAmount: 1000, currency: "KES" }]);
    expect(o!.placed).toEqual([{ ticker: "NVDA", cashAmount: 1000, state: "filled" }]);
  });

  it("with no stock chosen it follows the target mix", async () => {
    const { d, placed } = mk({ getRule: async () => ({ percent: 10, tokenAddress: null }) });
    await runSweep(sale, d);
    expect(placed.map((p) => [p.token.ticker, p.cashAmount])).toEqual([["NVDA", 600], ["MSFT", 400]]);
  });

  it("does nothing with no rule, or when the target mix is empty and no stock is chosen", async () => {
    expect(await runSweep(sale, mk({ getRule: async () => null }).d)).toBeNull();
    const { d, placed } = mk({ getRule: async () => ({ percent: 10, tokenAddress: null }), targets: async () => [] });
    expect(await runSweep(sale, d)).toBeNull();
    expect(placed).toEqual([]);
  });

  it("caps the share at 50% even if a bigger one was stored", async () => {
    const { d, placed } = mk({ getRule: async () => ({ percent: 90, tokenAddress: "N" }) });
    await runSweep(sale, d);
    expect(placed[0].cashAmount).toBe(5000);
  });

  it("rounds down to the cent, never above the share", async () => {
    const { d, placed } = mk();
    await runSweep({ ...sale, amount: 3333.33 }, d);
    expect(placed[0].cashAmount).toBe(333.33);
  });

  it("a refused order (for example below the minimum) is skipped quietly and the rest still go", async () => {
    let n = 0;
    const { d } = mk({ getRule: async () => ({ percent: 10, tokenAddress: null }), place: async () => { if (n++ === 0) throw new OrderRefused("too small"); return { state: "filled" }; } });
    const o = await runSweep(sale, d);
    expect(o!.skipped).toEqual(["NVDA"]);
    expect(o!.placed.map((x) => x.ticker)).toEqual(["MSFT"]);
  });

  it("NEVER throws: a failing store or order engine ends here", async () => {
    expect(await runSweep(sale, mk({ getRule: async () => { throw new Error("db down"); } }).d)).toBeNull();
    const o = await runSweep(sale, mk({ place: async () => { throw new Error("boom"); } }).d);
    expect(o!.skipped).toEqual(["NVDA"]);
  });

  it("does not invest for a US merchant", async () => {
    const { d, placed } = mk({ user: async () => ({ phone: "14155550100", business: { country: "US" } }) });
    expect(await runSweep(sale, d)).toBeNull();
    expect(placed).toEqual([]);
  });

  it("an invoice of nothing invests nothing", async () => {
    expect(await runSweep({ ...sale, amount: 0 }, mk().d)).toBeNull();
  });
});

describe("sweepMessage", () => {
  it("tells the merchant what was invested", () => {
    const m = sweepMessage({ placed: [{ ticker: "NVDA", cashAmount: 1000, state: "filled" }], skipped: [] }, (n) => `KES ${n}`)!;
    expect(m).toContain("KES 1000 into NVDA");
    expect(m).toContain("stop investing my sales");
  });
  it("says nothing when nothing filled", () => {
    expect(sweepMessage(null, String)).toBeNull();
    expect(sweepMessage({ placed: [{ ticker: "NVDA", cashAmount: 5, state: "refunded" }], skipped: [] }, String)).toBeNull();
  });
});
