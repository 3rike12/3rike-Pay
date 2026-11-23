import type { StockToken } from "@/services/stocks";
import type { BuyQuote, SellQuote, StockVenue, VenueResult, VenueStatus, VenueToken } from "@/services/stockVenue";

// ============================================
// Demo venue: a stand-in market for demos and testing
//
// Same contract as a real venue (idempotent on the reference, honours the minimum,
// tells the truth in status) but nothing is traded on any chain. Prices drift on a
// timer so alerts and price history have something to show. NOT for real money:
// the app only registers it when STOCKS_VENUE=demo.
// ============================================

const DECIMALS = 8;
const USDC = 1e6;
/** Pretend pool depth: bigger orders move the price more. */
const LIQUIDITY_USD = 1_500_000;

const fakeAddress = (n: number) => "0x" + "de" + n.toString(16).padStart(2, "0").repeat(19);

const BASE: Array<{ ticker: string; name: string; price: number; swing: number; period: number }> = [
  { ticker: "TSLA", name: "Tesla, Inc.", price: 245, swing: 0.07, period: 9 },
  { ticker: "NVDA", name: "NVIDIA Corporation", price: 138, swing: 0.06, period: 13 },
  { ticker: "AAPL", name: "Apple Inc.", price: 232, swing: 0.03, period: 17 },
  { ticker: "META", name: "Meta Platforms, Inc.", price: 590, swing: 0.05, period: 11 },
  { ticker: "GOOGL", name: "Alphabet Inc.", price: 178, swing: 0.04, period: 15 },
  { ticker: "MSFT", name: "Microsoft Corporation", price: 420, swing: 0.03, period: 19 },
];

/** A price that drifts smoothly: a base, plus a slow wave of up to `swing` either way (period in minutes). */
export function demoPrice(ticker: string, now = Date.now()): number {
  const b = BASE.find((x) => x.ticker === ticker);
  if (!b) throw new Error(`Unknown demo stock ${ticker}`);
  const phase = (now / 60_000 / b.period) * 2 * Math.PI + BASE.indexOf(b);
  return Math.round(b.price * (1 + b.swing * Math.sin(phase)) * 100) / 100;
}

/** The demo catalogue, priced at `now`. */
export function demoStocks(now = Date.now()): StockToken[] {
  return BASE.map((b, i) => ({
    address: fakeAddress(i + 1),
    symbol: `${b.ticker}c`,
    ticker: b.ticker,
    name: b.name,
    decimals: DECIMALS,
    multiplier: 1,
    navPrice: demoPrice(b.ticker, now),
    navUpdatedAt: new Date(now).toISOString(),
    isin: null,
    totalSupply: null,
  }));
}

function tickerOf(token: VenueToken): string {
  const i = demoStocks().findIndex((s) => s.address === token.address.toLowerCase());
  if (i < 0) throw new Error("Not a demo stock");
  return BASE[i].ticker;
}

const impactBps = (usd: number) => Math.max(1, Math.round((usd / LIQUIDITY_USD) * 10_000));

export function createDemoVenue(now: () => number = Date.now): StockVenue {
  const trades = new Map<string, VenueStatus>();

  const quoteBuy = async (token: VenueToken, usdcUnits: bigint): Promise<BuyQuote> => {
    const usd = Number(usdcUnits) / USDC;
    const bps = impactBps(usd);
    const price = demoPrice(tickerOf(token), now()) * (1 + bps / 10_000);
    return { tokenUnits: BigInt(Math.floor((usd / price) * 10 ** token.decimals)), priceImpactBps: bps };
  };
  const quoteSell = async (token: VenueToken, tokenUnits: bigint): Promise<SellQuote> => {
    const tokens = Number(tokenUnits) / 10 ** token.decimals;
    const mid = demoPrice(tickerOf(token), now());
    const bps = impactBps(tokens * mid);
    const price = mid * (1 - bps / 10_000);
    return { usdcUnits: BigInt(Math.floor(tokens * price * USDC)), priceImpactBps: bps };
  };

  const record = (reference: string, result: VenueResult): VenueResult => {
    trades.set(reference, result.status === "filled" ? { state: "filled", tokenUnits: result.tokenUnits, usdcUnits: result.usdcUnits, txHash: result.txHash } : { state: "rejected", reason: result.reason });
    return result;
  };
  const replay = (reference: string): VenueResult | null => {
    const t = trades.get(reference);
    if (!t) return null;
    if (t.state === "filled") return { status: "filled", tokenUnits: t.tokenUnits, usdcUnits: t.usdcUnits, txHash: t.txHash };
    if (t.state === "rejected") return { status: "rejected", reason: t.reason };
    return null;
  };
  const hash = (reference: string) => "0xdemo" + Buffer.from(reference).toString("hex").slice(0, 58).padEnd(58, "0");

  return {
    id: "demo",
    quoteBuy,
    quoteSell,
    async buy(req) {
      const again = replay(req.reference);
      if (again) return again;
      const q = await quoteBuy(req.token, req.usdcUnits);
      if (q.tokenUnits < req.minTokenUnits) return record(req.reference, { status: "rejected", reason: "Price moved beyond the allowed slippage." });
      return record(req.reference, { status: "filled", tokenUnits: q.tokenUnits, usdcUnits: req.usdcUnits, txHash: hash(req.reference) });
    },
    async sell(req) {
      const again = replay(req.reference);
      if (again) return again;
      const q = await quoteSell(req.token, req.tokenUnits);
      if (q.usdcUnits < req.minUsdcUnits) return record(req.reference, { status: "rejected", reason: "Price moved beyond the allowed slippage." });
      return record(req.reference, { status: "filled", tokenUnits: req.tokenUnits, usdcUnits: q.usdcUnits, txHash: hash(req.reference) });
    },
    async status(reference) {
      return trades.get(reference) ?? { state: "not_found" };
    },
  };
}
