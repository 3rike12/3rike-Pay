import { describe, it, expect } from "vitest";
import { computeRebalance, validTargets } from "@/services/rebalance";

const T = [{ address: "N", percent: 40 }, { address: "M", percent: 35 }, { address: "A", percent: 25 }];
const H = (n: number, m: number, a: number) => [{ address: "N", valueUsd: n }, { address: "M", valueUsd: m }, { address: "A", valueUsd: a }];
const trade = (r: ReturnType<typeof computeRebalance>, side: string, addr: string) => r.trades.find((t) => t.side === side && t.address === addr)?.usd;

describe("computeRebalance", () => {
  it("the example from the idea: Nvidia 55%, Microsoft 25%, Apple 20% back to 40/35/25", () => {
    const r = computeRebalance(T, H(550, 250, 200));
    expect(r.rows.map((x) => x.actualPercent)).toEqual([55, 25, 20]);
    expect(r.rows.map((x) => x.driftPercent)).toEqual([15, -10, -5]);
    expect(trade(r, "sell", "N")).toBe(150); // 550 -> 400
    // buys are 100 and 50, scaled to 98% of the 150 coming in so a price slip cannot leave them short
    expect(trade(r, "buy", "M")).toBe(98);
    expect(trade(r, "buy", "A")).toBe(49);
  });

  it("buys never spend more than the sells bring in", () => {
    const r = computeRebalance(T, H(700, 200, 100));
    const sold = r.trades.filter((t) => t.side === "sell").reduce((n, t) => n + t.usd, 0);
    const bought = r.trades.filter((t) => t.side === "buy").reduce((n, t) => n + t.usd, 0);
    expect(bought).toBeLessThanOrEqual(sold);
    expect(bought).toBeGreaterThan(sold * 0.95);
  });

  it("does nothing while every stock is inside the band", () => {
    const r = computeRebalance(T, H(430, 340, 230)); // 43 / 34 / 23: all within 5 points
    expect(r.trades).toEqual([]);
    expect(r.maxDrift).toBe(3);
  });

  it("acts as soon as one stock drifts past the band", () => {
    expect(computeRebalance(T, H(460, 310, 230)).trades.length).toBeGreaterThan(0); // 46 / 31 / 23: 6 points off on one
  });

  it("the band is adjustable", () => {
    expect(computeRebalance(T, H(430, 340, 230), { band: 2 }).trades.length).toBeGreaterThan(0);
  });

  it("ignores trades smaller than the minimum", () => {
    const r = computeRebalance(T, H(55, 25, 20), { minTradeUsd: 10 }); // the 5-dollar-ish buys are dropped
    expect(r.trades.every((t) => t.usd >= 10)).toBe(true);
  });

  it("a stock with no holding yet gets bought up to its target", () => {
    const r = computeRebalance(T, [{ address: "N", valueUsd: 500 }, { address: "M", valueUsd: 500 }]); // no Apple
    expect(trade(r, "buy", "A")).toBeGreaterThan(0);
    expect(r.rows.find((x) => x.address === "A")!.actualPercent).toBe(0);
  });

  it("holds nothing in the target: no trades, nothing to rebalance", () => {
    expect(computeRebalance(T, []).trades).toEqual([]);
    expect(computeRebalance(T, []).total).toBe(0);
  });

  it("a stock outside the target is left alone and not counted", () => {
    const r = computeRebalance(T, [...H(550, 250, 200), { address: "X", valueUsd: 9999 }]);
    expect(r.total).toBe(1000);
    expect(r.trades.every((t) => t.address !== "X")).toBe(true);
  });

  it("is deterministic", () => {
    expect(computeRebalance(T, H(550, 250, 200))).toEqual(computeRebalance(T, H(550, 250, 200)));
  });

  it("a negative or broken value is treated as nothing, not as a reason to trade wildly", () => {
    const r = computeRebalance(T, [{ address: "N", valueUsd: -50 }, { address: "M", valueUsd: 500 }, { address: "A", valueUsd: 500 }]);
    expect(r.trades.every((t) => t.usd > 0 && Number.isFinite(t.usd))).toBe(true);
  });
});

describe("validTargets", () => {
  it("accepts a mix that adds up to 100", () => expect(validTargets(T)).toBe(true));
  it("rejects a total that is not 100", () => expect(validTargets([{ address: "A", percent: 50 }, { address: "B", percent: 40 }])).toBe(false));
  it("rejects a single stock, repeats, zero or negative shares", () => {
    expect(validTargets([{ address: "A", percent: 100 }])).toBe(false);
    expect(validTargets([{ address: "A", percent: 50 }, { address: "A", percent: 50 }])).toBe(false);
    expect(validTargets([{ address: "A", percent: 100 }, { address: "B", percent: 0 }])).toBe(false);
    expect(validTargets([{ address: "A", percent: 120 }, { address: "B", percent: -20 }])).toBe(false);
  });
  it("allows a half-point of rounding", () => expect(validTargets([{ address: "A", percent: 33.3 }, { address: "B", percent: 33.3 }, { address: "C", percent: 33.3 }])).toBe(true));
});
