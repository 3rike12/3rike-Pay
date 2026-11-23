import { describe, it, expect, vi } from "vitest";

vi.mock("@/config", () => ({ config: { logLevel: "silent" } }));
const db = vi.hoisted(() => ({ orders: [] as any[], schedules: [] as any[] }));
vi.mock("@/db/prisma", () => ({ prisma: { stockOrder: { findMany: async () => db.orders } } }));
vi.mock("@/services/stockSchedules", () => ({ listSchedules: async () => db.schedules }));

import { loadFills, loadRecurring, venuePriceUsd, annotateImpact } from "@/services/researchContext";
import type { Plan } from "@/services/planBuilder";

const A = "0x" + "1".repeat(40);
const tok: any = { address: A, ticker: "TSLA", decimals: 8, multiplier: 1 };
const AT = new Date("2026-11-01T00:00:00Z");

describe("loadFills", () => {
  it("returns filled orders as fills, with the time they finished", async () => {
    db.orders = [{ side: "buy", tokenAddress: A, tokenUnits: 200000000n, usdcUnits: 200000000n, updatedAt: AT }];
    expect(await loadFills("u1")).toEqual([{ side: "buy", tokenAddress: A, tokenUnits: 200000000n, usdcUnits: 200000000n, at: AT }]);
  });
  it("skips anything that did not really trade: zero units, zero cash, or an unknown side", async () => {
    db.orders = [
      { side: "buy", tokenAddress: A, tokenUnits: 0n, usdcUnits: 5n, updatedAt: AT },
      { side: "buy", tokenAddress: A, tokenUnits: 5n, usdcUnits: 0n, updatedAt: AT },
      { side: "swap", tokenAddress: A, tokenUnits: 5n, usdcUnits: 5n, updatedAt: AT },
    ];
    expect(await loadFills("u1")).toEqual([]);
  });
});

describe("loadRecurring", () => {
  it("lists active schedules only, in the shape the assistant uses", async () => {
    db.schedules = [
      { state: "active", ticker: "TSLA", cashAmount: 2000, currency: "KES", frequency: "weekly", tokenAddress: A },
      { state: "paused", ticker: "NVDA", cashAmount: 10, currency: "KES", frequency: "daily" },
    ];
    expect(await loadRecurring("u1")).toEqual([{ ticker: "TSLA", amount: 2000, currency: "KES", frequency: "weekly" }]);
  });
});

describe("venuePriceUsd", () => {
  it("prices ONE token from the venue's own sell quote", async () => {
    let asked: bigint | null = null;
    const venue: any = { quoteSell: async (_t: any, units: bigint) => ((asked = units), { usdcUnits: 215_500_000n, priceImpactBps: 1 }) };
    expect(await venuePriceUsd(venue)(tok)).toBe(215.5);
    expect(asked).toBe(100_000_000n);
  });
  it("is null with no venue, a failed quote or a zero quote", async () => {
    expect(await venuePriceUsd(null)(tok)).toBeNull();
    expect(await venuePriceUsd({ quoteSell: async () => { throw new Error("down"); } } as any)(tok)).toBeNull();
    expect(await venuePriceUsd({ quoteSell: async () => ({ usdcUnits: 0n, priceImpactBps: 0 }) } as any)(tok)).toBeNull();
  });
});

describe("annotateImpact", () => {
  const plan = (id: Plan["id"], lines: Array<[string, number]>): Plan => ({ id, title: id, notes: [], lines: lines.map(([ticker, amount]) => ({ ticker, amount, percent: 50 })) });
  const stocks: any[] = [tok, { address: "0x" + "2".repeat(40), ticker: "NVDA", decimals: 8, multiplier: 1 }];
  const venue = (bpsFor: Record<string, number>): any => ({ quoteBuy: async (t: any) => ({ tokenUnits: 1n, priceImpactBps: bpsFor[t.address] ?? 0 }) });

  it("adds the impact, converting the plan's currency to USD for the quote", async () => {
    let usdc: bigint | null = null;
    const v: any = { quoteBuy: async (_t: any, u: bigint) => ((usdc = u), { tokenUnits: 1n, priceImpactBps: 40 }) };
    const [p] = await annotateImpact([plan("even", [["TSLA", 13000]])], stocks, 0.00769, v);
    expect(p.lines[0].impactPercent).toBe(0.4);
    expect(usdc).toBe(BigInt(Math.round(13000 * 0.00769 * 1e6)));
  });

  it("does not offer a plan with an order the market cannot absorb", async () => {
    const plans = [plan("even", [["TSLA", 1000], ["NVDA", 1000]]), plan("focused", [["TSLA", 2000]])];
    const out = await annotateImpact(plans, stocks, 1, venue({ ["0x" + "2".repeat(40)]: 250 })); // NVDA moves 2.5%
    expect(out.map((p) => p.id)).toEqual(["focused"]);
  });

  it("keeps a line it cannot quote, with no impact claimed", async () => {
    const v: any = { quoteBuy: async () => { throw new Error("no route"); } };
    const [p] = await annotateImpact([plan("even", [["TSLA", 1000]])], stocks, 1, v);
    expect(p.lines[0]).not.toHaveProperty("impactPercent");
  });

  it("with no venue, returns the plans unchanged", async () => {
    const plans = [plan("even", [["TSLA", 1000]])];
    expect(await annotateImpact(plans, stocks, 1, null)).toEqual(plans);
  });

  it("keeps a ticker it does not know, unquoted", async () => {
    const [p] = await annotateImpact([plan("even", [["ZZZ", 1000]])], stocks, 1, venue({}));
    expect(p.lines[0].ticker).toBe("ZZZ");
  });
});
