import { describe, it, expect } from "vitest";
import { createDemoVenue, demoPrice, demoStocks } from "@/services/venues/demo";

const T0 = Date.UTC(2026, 11, 1, 12);
const tsla = demoStocks(T0).find((s) => s.ticker === "TSLA")!;
const tok = { address: tsla.address, decimals: tsla.decimals };
const usdc = (n: number) => BigInt(Math.round(n * 1e6));

describe("demo market", () => {
  it("has six stocks with fresh prices", () => {
    const s = demoStocks(T0);
    expect(s.map((x) => x.ticker)).toEqual(["TSLA", "NVDA", "AAPL", "META", "GOOGL", "MSFT"]);
    expect(s.every((x) => x.navPrice! > 0 && x.navUpdatedAt === new Date(T0).toISOString())).toBe(true);
  });
  it("prices drift over time but stay within the swing", () => {
    const prices = Array.from({ length: 120 }, (_, m) => demoPrice("TSLA", T0 + m * 4_500));
    expect(new Set(prices).size).toBeGreaterThan(20);
    expect(Math.min(...prices)).toBeGreaterThan(245 * 0.92);
    expect(Math.max(...prices)).toBeLessThan(245 * 1.08);
  });
});

describe("demo venue", () => {
  const v = () => createDemoVenue(() => T0);

  it("a buy then a sell nearly round-trips (only the price impact is lost)", async () => {
    const venue = v();
    const b: any = await venue.buy({ reference: "r1", token: tok, usdcUnits: usdc(100), minTokenUnits: 0n });
    expect(b.status).toBe("filled");
    const s: any = await venue.sell({ reference: "r2", token: tok, tokenUnits: b.tokenUnits, minUsdcUnits: 0n });
    expect(Number(s.usdcUnits) / 1e6).toBeGreaterThan(99.9);
    expect(Number(s.usdcUnits) / 1e6).toBeLessThan(100);
  });

  it("is idempotent on the reference: the same order trades once", async () => {
    const venue = v();
    const a: any = await venue.buy({ reference: "same", token: tok, usdcUnits: usdc(50), minTokenUnits: 0n });
    const b: any = await venue.buy({ reference: "same", token: tok, usdcUnits: usdc(50), minTokenUnits: 0n });
    expect(b).toEqual(a);
  });

  it("refuses to fill below the minimum", async () => {
    const r: any = await v().buy({ reference: "m", token: tok, usdcUnits: usdc(50), minTokenUnits: 10n ** 18n });
    expect(r.status).toBe("rejected");
    expect(((await v().status("m")) as any).state).toBe("not_found"); // another venue instance has no record
  });

  it("status tells the truth", async () => {
    const venue = v();
    expect((await venue.status("nope")).state).toBe("not_found");
    await venue.buy({ reference: "k", token: tok, usdcUnits: usdc(10), minTokenUnits: 0n });
    expect((await venue.status("k")).state).toBe("filled");
  });

  it("bigger orders move the price more", async () => {
    const venue = v();
    const small = await venue.quoteBuy(tok, usdc(10));
    const big = await venue.quoteBuy(tok, usdc(30_000));
    expect(big.priceImpactBps).toBeGreaterThan(small.priceImpactBps);
  });

  it("rejects a token that is not in the demo market", async () => {
    await expect(v().quoteBuy({ address: "0x" + "1".repeat(40), decimals: 8 }, usdc(10))).rejects.toThrow();
  });
});
