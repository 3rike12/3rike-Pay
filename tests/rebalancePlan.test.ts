import { describe, it, expect, vi } from "vitest";
vi.mock("@/config", () => ({ config: { logLevel: "silent", stocks: { blockUs: true } } }));
import { planRebalance, type PlanDeps } from "@/services/rebalancePlan";

const ONE = 100_000_000n;
const tk = (a: string, ticker: string): any => ({ address: a, ticker, name: ticker, symbol: ticker + "c", decimals: 8, multiplier: 1, navPrice: null, navUpdatedAt: null, isin: null, totalSupply: null });
const N = tk("N", "NVDA"), M = tk("M", "MSFT"), A = tk("A", "AAPL");
const deps = (over: Partial<PlanDeps> = {}): PlanDeps => ({
  targets: async () => [{ tokenAddress: "N", percent: 40 }, { tokenAddress: "M", percent: 35 }, { tokenAddress: "A", percent: 25 }],
  holdings: async () => [{ tokenAddress: "N", units: 11n * ONE }, { tokenAddress: "M", units: 5n * ONE }, { tokenAddress: "A", units: 4n * ONE }], // x $50 = 550 / 250 / 200
  stocks: async () => [N, M, A],
  tokenPriceUsd: async () => 50,
  fromUsd: (usd, cur) => (cur === "KES" ? usd * 130 : usd),
  ...over,
});

describe("planRebalance", () => {
  it("turns drift into real sells (units) and buys (cash in the person's currency)", async () => {
    const p: any = await planRebalance("u", "KES", deps());
    expect(p.status).toBe("trades");
    const sell = p.trades.find((t: any) => t.side === "sell");
    expect(sell.token.ticker).toBe("NVDA");
    expect(sell.units).toBe(3n * ONE); // $150 at $50 each
    const buy = p.trades.find((t: any) => t.side === "buy" && t.token.ticker === "MSFT");
    expect(buy.cashAmount).toBe(98 * 130);
    expect(p.rows.map((r: any) => r.actualPercent)).toEqual([55, 25, 20]);
  });

  it("never sells more than is held", async () => {
    const p: any = await planRebalance("u", "USD", deps({ tokenPriceUsd: async (t) => (t.ticker === "NVDA" ? 5 : 50) })); // price looks 10x lower: valued small, but units are capped
    for (const t of p.trades.filter((x: any) => x.side === "sell")) expect(t.units).toBeLessThanOrEqual(11n * ONE);
  });

  it("no target set", async () => expect(await planRebalance("u", "USD", deps({ targets: async () => [] }))).toEqual({ status: "no_target" }));

  it("nothing held yet", async () => expect((await planRebalance("u", "USD", deps({ holdings: async () => [] }))).status).toBe("nothing_held"));

  it("already balanced", async () => {
    const p: any = await planRebalance("u", "USD", deps({ holdings: async () => [{ tokenAddress: "N", units: 8n * ONE }, { tokenAddress: "M", units: 7n * ONE }, { tokenAddress: "A", units: 5n * ONE }] }));
    expect(p.status).toBe("balanced");
  });

  it("refuses to plan when a stock they hold cannot be priced, instead of guessing", async () => {
    const p: any = await planRebalance("u", "USD", deps({ tokenPriceUsd: async (t) => (t.ticker === "AAPL" ? null : 50) }));
    expect(p).toEqual({ status: "unpriced", missing: ["AAPL"] });
  });

  it("a price lookup that throws counts as unpriced, not a crash", async () => {
    const p: any = await planRebalance("u", "USD", deps({ tokenPriceUsd: async () => { throw new Error("venue down"); } }));
    expect(p.status).toBe("unpriced");
  });

  it("a target stock that left the catalogue is dropped; fewer than two left means no target", async () => {
    expect((await planRebalance("u", "USD", deps({ stocks: async () => [N] }))).status).toBe("no_target");
  });
});
