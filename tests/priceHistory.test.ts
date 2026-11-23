import { describe, it, expect, vi } from "vitest";

vi.mock("@/config", () => ({ config: { logLevel: "silent", stocks: { navMaxAgeSeconds: 86400 } } }));
vi.mock("@/db/prisma", () => ({ prisma: {} }));

import { computeStats, recordPrices, type PricePoint, type PriceStore } from "@/services/priceHistory";
import type { StockToken } from "@/services/stocks";

const NOW = new Date("2026-11-23T12:00:00Z");
const DAY = 24 * 3600_000;
const A = "0x" + "1".repeat(40);
const pt = (daysAgo: number, price: number): PricePoint => ({ tokenAddress: A, price, observedAt: new Date(NOW.getTime() - daysAgo * DAY) });
const series = (...pairs: Array<[number, number]>) => pairs.map(([d, p]) => pt(d, p));

describe("computeStats: change", () => {
  it("compares the latest price with the one a week ago, and a month ago", () => {
    const s = computeStats(series([31, 100], [8, 100], [6, 105], [3, 108], [0.1, 110]), NOW);
    expect(s.change7dPercent).toBe(10); // 100 -> 110
    expect(s.change30dPercent).toBe(10);
  });

  it("is up or down by the sign", () => {
    expect(computeStats(series([8, 100], [0.1, 90], [4, 95]), NOW).change7dPercent).toBe(-10);
  });

  it("says nothing for a window it does not have history for, instead of comparing against something much shorter", () => {
    const s = computeStats(series([2, 100], [0.1, 110]), NOW); // 2 days of history
    expect(s.change7dPercent).toBeNull();
    expect(s.change30dPercent).toBeNull();
    expect(s.historyDays).toBe(1);
  });

  it("uses a window that is mostly covered (at least 60%)", () => {
    expect(computeStats(series([5, 100], [0.1, 110]), NOW).change7dPercent).toBe(10); // 5 of 7 days
    expect(computeStats(series([4, 100], [0.1, 110]), NOW).change7dPercent).toBeNull(); // 4 of 7: too little
  });

  it("with fewer than two points there is no change, no drawdown, no volatility", () => {
    for (const pts of [[], series([1, 100])]) {
      expect(computeStats(pts, NOW)).toEqual({ change7dPercent: null, change30dPercent: null, drawdown30dPercent: null, volatility: "unknown", historyDays: 0 });
    }
  });

  it("ignores points from the future and non-positive prices", () => {
    const s = computeStats([...series([8, 100], [0.1, 110]), pt(-3, 999), pt(2, 0), pt(1, -5)], NOW);
    expect(s.change7dPercent).toBe(10);
  });

  it("does not depend on the order the points arrive in", () => {
    const pts = series([8, 100], [6, 105], [3, 108], [0.1, 110]);
    expect(computeStats([...pts].reverse(), NOW)).toEqual(computeStats(pts, NOW));
  });

  it("does not care about the price's unit: scaling every price changes nothing", () => {
    const pts = series([8, 100], [6, 105], [3, 90], [0.1, 110]);
    const scaled = pts.map((p) => ({ ...p, price: p.price * 7.3 }));
    expect(computeStats(scaled, NOW)).toEqual(computeStats(pts, NOW));
  });
});

describe("computeStats: drawdown", () => {
  it("is the biggest fall from a peak, as a positive percent", () => {
    // peak 120, then low 90: 25% fall. The later recovery does not erase it.
    expect(computeStats(series([20, 100], [15, 120], [10, 90], [0.1, 115]), NOW).drawdown30dPercent).toBe(25);
  });
  it("is zero when it only went up", () => {
    expect(computeStats(series([20, 100], [10, 110], [0.1, 120]), NOW).drawdown30dPercent).toBe(0);
  });
  it("only looks at the last 30 days", () => {
    // a big fall 40 days ago must not count
    expect(computeStats(series([45, 200], [40, 100], [20, 100], [10, 102], [0.1, 104]), NOW).drawdown30dPercent).toBe(0);
  });
  it("needs at least three points to say anything", () => {
    expect(computeStats(series([20, 100], [0.1, 50]), NOW).drawdown30dPercent).toBeNull();
  });
});

describe("computeStats: volatility", () => {
  const wiggle = (range: number) => series([20, 100], [15, 100 + range], [10, 100], [5, 100 + range / 2], [0.1, 100]);
  it("is low when the month's range is small", () => expect(computeStats(wiggle(3), NOW).volatility).toBe("low"));
  it("is medium for a moderate range", () => expect(computeStats(wiggle(10), NOW).volatility).toBe("medium"));
  it("is high for a wide range", () => expect(computeStats(wiggle(25), NOW).volatility).toBe("high"));
  it("is unknown without enough points or enough days", () => {
    expect(computeStats(series([20, 100], [10, 120], [0.1, 100]), NOW).volatility).toBe("unknown"); // 3 points
    expect(computeStats(series([5, 100], [4, 110], [3, 100], [2, 110], [0.1, 100]), NOW).volatility).toBe("unknown"); // 5 days
  });
  it("the thresholds are exact at their edges", () => {
    expect(computeStats(wiggle(4.99), NOW).volatility).toBe("low");
    expect(computeStats(wiggle(5), NOW).volatility).toBe("medium");
    expect(computeStats(wiggle(14.99), NOW).volatility).toBe("medium");
    expect(computeStats(wiggle(15), NOW).volatility).toBe("high");
  });
});

describe("recordPrices", () => {
  const token = (over: Partial<StockToken> = {}): StockToken => ({
    address: A, symbol: "TSLAc", ticker: "TSLA", name: "Tesla", decimals: 8, multiplier: 1, navPrice: 100,
    navUpdatedAt: new Date(NOW.getTime() - 3600_000).toISOString(), isin: null, totalSupply: null, ...over,
  });
  const store = () => {
    const rows: PricePoint[] = [];
    const s: PriceStore = {
      record: async (p) => (rows.some((r) => r.tokenAddress === p.tokenAddress && r.observedAt.getTime() === p.observedAt.getTime()) ? false : (rows.push(p), true)),
      since: async () => rows,
    };
    return { rows, s };
  };

  it("saves a fresh price, once: the same data point seen again is not saved twice", async () => {
    const { rows, s } = store();
    expect(await recordPrices([token()], s, NOW)).toBe(1);
    expect(await recordPrices([token()], s, NOW)).toBe(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tokenAddress: A, price: 100 });
  });

  it("saves a new data point when the feed publishes one", async () => {
    const { rows, s } = store();
    await recordPrices([token()], s, NOW);
    expect(await recordPrices([token({ navPrice: 104, navUpdatedAt: new Date(NOW.getTime() - 60_000).toISOString() })], s, NOW)).toBe(1);
    expect(rows).toHaveLength(2);
  });

  it("skips a token with no price, no timestamp, a bad timestamp, or a stale price", async () => {
    const { rows, s } = store();
    await recordPrices([
      token({ navPrice: null, navUpdatedAt: null }),
      token({ address: "0x" + "2".repeat(40), navUpdatedAt: null }),
      token({ address: "0x" + "3".repeat(40), navUpdatedAt: "garbage" }),
      token({ address: "0x" + "4".repeat(40), navUpdatedAt: new Date(NOW.getTime() - 30 * 3600_000).toISOString() }),
    ], s, NOW);
    expect(rows).toEqual([]);
  });

  it("one token failing to save does not stop the others", async () => {
    const saved: string[] = [];
    const s: PriceStore = {
      record: async (p) => {
        if (p.tokenAddress === A) throw new Error("db down");
        saved.push(p.tokenAddress);
        return true;
      },
      since: async () => [],
    };
    expect(await recordPrices([token(), token({ address: "0x" + "2".repeat(40) })], s, NOW)).toBe(1);
    expect(saved).toEqual(["0x" + "2".repeat(40)]);
  });
});
