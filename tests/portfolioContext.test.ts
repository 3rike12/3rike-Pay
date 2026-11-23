import { describe, it, expect, vi } from "vitest";

vi.mock("@/config", () => ({ config: { logLevel: "silent" } }));

import { costBasis, buildPortfolioFacts, type Fill } from "@/services/portfolioContext";
import type { StockToken } from "@/services/stocks";

const NOW = new Date("2026-11-23T12:00:00Z");
const DAY = 24 * 3600_000;
const ONE = 100_000_000n;
const USD = (n: number) => BigInt(Math.round(n * 1e6));
const A = "0x" + "1".repeat(40);
const B = "0x" + "2".repeat(40);
const tok = (address: string, ticker: string, over: Partial<StockToken> = {}): StockToken => ({
  address, symbol: `${ticker}c`, ticker, name: `${ticker} Inc`, decimals: 8, multiplier: 1, navPrice: null, navUpdatedAt: null, isin: null, totalSupply: null, ...over,
});
const fill = (side: "buy" | "sell", tokenAddress: string, tokens: number, usd: number, daysAgo: number): Fill => ({
  side, tokenAddress, tokenUnits: BigInt(Math.round(tokens * 1e8)), usdcUnits: USD(usd), at: new Date(NOW.getTime() - daysAgo * DAY),
});

describe("costBasis (average cost, in whole integers)", () => {
  it("adds up buys: 2 tokens for $200 then 1 for $130 is 3 tokens costing $330", () => {
    const b = costBasis([fill("buy", A, 2, 200, 10), fill("buy", A, 1, 130, 5)]).get(A)!;
    expect(b).toMatchObject({ units: 3n * ONE, costUsdc: USD(330) });
  });

  it("a sale removes the cost of the units sold at the AVERAGE cost, leaving the average unchanged", () => {
    const b = costBasis([fill("buy", A, 2, 200, 10), fill("buy", A, 1, 130, 5), fill("sell", A, 1, 500, 2)]).get(A)!;
    expect(b.units).toBe(2n * ONE);
    expect(b.costUsdc).toBe(USD(220)); // 330 * 2/3
  });

  it("does not care how the fills are ordered in the list: it works in time order", () => {
    const fills = [fill("sell", A, 1, 500, 2), fill("buy", A, 2, 200, 10)];
    expect(costBasis(fills).get(A)).toMatchObject({ units: ONE, costUsdc: USD(100) });
  });

  it("selling everything resets the cost and the start date", () => {
    const b = costBasis([fill("buy", A, 2, 200, 10), fill("sell", A, 2, 300, 5)]).get(A)!;
    expect(b).toEqual({ units: 0n, costUsdc: 0n, heldSince: null });
  });

  it("a new buy after selling everything starts a new holding, with its own start date", () => {
    const b = costBasis([fill("buy", A, 2, 200, 20), fill("sell", A, 2, 300, 10), fill("buy", A, 1, 50, 3)]).get(A)!;
    expect(b.costUsdc).toBe(USD(50));
    expect(b.heldSince).toEqual(new Date(NOW.getTime() - 3 * DAY));
  });

  it("keeps the START of the holding through partial buys and sells", () => {
    const b = costBasis([fill("buy", A, 2, 200, 10), fill("buy", A, 1, 100, 5), fill("sell", A, 1, 150, 1)]).get(A)!;
    expect(b.heldSince).toEqual(new Date(NOW.getTime() - 10 * DAY));
  });

  it("a sale of more than is held can only take what there is", () => {
    const b = costBasis([fill("buy", A, 1, 100, 10), fill("sell", A, 5, 900, 5)]).get(A)!;
    expect(b).toEqual({ units: 0n, costUsdc: 0n, heldSince: null });
  });

  it("a sale before any buy changes nothing", () => {
    expect(costBasis([fill("sell", A, 1, 100, 5)]).get(A)).toEqual({ units: 0n, costUsdc: 0n, heldSince: null });
  });

  it("keeps each token separate", () => {
    const m = costBasis([fill("buy", A, 1, 100, 5), fill("buy", B, 4, 80, 5)]);
    expect(m.get(A)!.costUsdc).toBe(USD(100));
    expect(m.get(B)!.costUsdc).toBe(USD(80));
  });

  it("is exact where a float would not be", () => {
    const b = costBasis([{ side: "buy", tokenAddress: A, tokenUnits: 10n ** 24n + 1n, usdcUnits: 10n ** 20n + 7n, at: NOW }]).get(A)!;
    expect(b).toEqual({ units: 10n ** 24n + 1n, costUsdc: 10n ** 20n + 7n, heldSince: NOW });
  });
});

describe("buildPortfolioFacts", () => {
  const price = (m: Record<string, number | null>) => async (t: StockToken) => m[t.address] ?? null;
  const build = (over: Record<string, any> = {}) =>
    buildPortfolioFacts({
      holdings: [{ token: tok(A, "TSLA"), units: 2n * ONE }, { token: tok(B, "NVDA"), units: 4n * ONE }],
      fills: [fill("buy", A, 2, 200, 30), fill("buy", B, 4, 100, 10)],
      recurring: [],
      tokenPriceUsd: price({ [A]: 110, [B]: 20 }),
      now: NOW,
      ...over,
    });

  it("weighs positions by what was paid, adding to 100%", async () => {
    const f = await build();
    expect(f.positions.map((p) => [p.ticker, p.weightPercent])).toEqual([["TSLA", 66.7], ["NVDA", 33.3]]);
    expect(f.largestPositionTicker).toBe("TSLA");
    expect(f.largestPositionPercent).toBe(66.7);
    expect(f.positionCount).toBe(2);
  });

  it("shows gain or loss against what was paid, in the same unit (per token)", async () => {
    const f = await build();
    // TSLA: 2 tokens at $110 = $220 vs $200 cost = +10%. NVDA: 4 at $20 = $80 vs $100 = -20%.
    expect(f.positions.map((p) => [p.ticker, p.costUsd, p.profitLossPercent])).toEqual([["TSLA", 200, 10], ["NVDA", 100, -20]]);
  });

  it("says how long each has been held", async () => {
    expect((await build()).positions.map((p) => p.heldDays)).toEqual([30, 10]);
  });

  it("leaves out profit and loss when the venue cannot give a price", async () => {
    const f = await build({ tokenPriceUsd: price({}) });
    expect(f.positions.map((p) => p.profitLossPercent)).toEqual([null, null]);
    expect(f.positions[0].costUsd).toBe(200); // the cost is still known
  });

  it("a price lookup that throws is not fatal", async () => {
    const f = await build({ tokenPriceUsd: async () => { throw new Error("venue down"); } });
    expect(f.positions.map((p) => p.profitLossPercent)).toEqual([null, null]);
  });

  it("DOES NOT show a cost the fills cannot explain: units that arrived another way leave it blank, not wrong", async () => {
    const f = await build({ holdings: [{ token: tok(A, "TSLA"), units: 5n * ONE }, { token: tok(B, "NVDA"), units: 4n * ONE }] }); // holds 5, fills explain 2
    const tsla = f.positions.find((p) => p.ticker === "TSLA")!;
    expect(tsla).toMatchObject({ costUsd: null, profitLossPercent: null, heldDays: null });
  });

  it("and with one cost unknown, no weights are shown at all, because they would mislead", async () => {
    const f = await build({ holdings: [{ token: tok(A, "TSLA"), units: 5n * ONE }, { token: tok(B, "NVDA"), units: 4n * ONE }] });
    expect(f.positions.map((p) => p.weightPercent)).toEqual([null, null]);
    expect(f.largestPositionPercent).toBeNull();
  });

  it("a holding with no fills at all (never bought through us) has no cost", async () => {
    const f = await build({ fills: [] });
    expect(f.positions.every((p) => p.costUsd === null && p.weightPercent === null)).toBe(true);
  });

  it("counts shares through the multiplier", async () => {
    const f = await build({ holdings: [{ token: tok(A, "TSLA", { multiplier: 1.5 }), units: 2n * ONE }], fills: [fill("buy", A, 2, 200, 5)] });
    expect(f.positions[0].shares).toBe(3);
  });

  it("an empty portfolio is empty, not an error", async () => {
    expect(await build({ holdings: [], fills: [] })).toEqual({ positions: [], positionCount: 0, largestPositionPercent: null, largestPositionTicker: null, recurringBuys: [] });
  });

  it("skips tokens sold down to nothing", async () => {
    const f = await build({ holdings: [{ token: tok(A, "TSLA"), units: 0n }, { token: tok(B, "NVDA"), units: 4n * ONE }], fills: [fill("buy", B, 4, 100, 10)] });
    expect(f.positions.map((p) => p.ticker)).toEqual(["NVDA"]);
    expect(f.positions[0].weightPercent).toBe(100);
  });

  it("passes the recurring buys through", async () => {
    const recurring = [{ ticker: "TSLA", amount: 2000, currency: "KES", frequency: "weekly" as const }];
    expect((await build({ recurring })).recurringBuys).toEqual(recurring);
  });

  it("a 2-decimal share count is rounded sensibly, and a tiny one keeps its digits", async () => {
    const f = await build({ holdings: [{ token: tok(A, "TSLA"), units: 1_234_567n }, { token: tok(B, "NVDA"), units: 123_456_789n }], fills: [fill("buy", A, 0.01234567, 5, 5), fill("buy", B, 1.23456789, 100, 5)] });
    expect(f.positions.map((p) => p.shares)).toEqual([0.0123, 1.23]);
  });
});
