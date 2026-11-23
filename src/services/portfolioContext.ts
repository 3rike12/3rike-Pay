import { sharesFor, type StockToken } from "@/services/stocks";

// ============================================
// What a person holds, and what it cost them
//
// Facts a good adviser would want before saying anything: how concentrated the
// portfolio is, what the person paid, how it is doing against that, and what they
// already have on a schedule. All of it is computed here, in code, from data we hold
// (the positions ledger and the order fills), so it is exact and checkable. The
// model only explains it.
//
// Cost uses the average-cost method, in whole integers. It is reported ONLY when it
// reconciles with the positions ledger: if the fills do not add up to what the person
// holds (units that arrived some other way, a gap in the history), the cost is left
// out rather than shown as a confident wrong number.
//
// Profit and loss compare a price per TOKEN with the cost per TOKEN, so the two are
// always in the same unit. The token price comes from the venue's own quote.
// ============================================

const DAY = 24 * 3600_000;
const USDC = 1e6;

export interface Fill {
  side: "buy" | "sell";
  tokenAddress: string;
  tokenUnits: bigint;
  usdcUnits: bigint;
  at: Date;
}

export interface Basis {
  units: bigint;
  costUsdc: bigint;
  /** When the current holding began; null once it is all sold. */
  heldSince: Date | null;
}

/** Average-cost basis per token from a person's fills. Pure. */
export function costBasis(fills: Fill[]): Map<string, Basis> {
  const out = new Map<string, Basis>();
  for (const f of [...fills].sort((a, b) => a.at.getTime() - b.at.getTime())) {
    const b = out.get(f.tokenAddress) ?? { units: 0n, costUsdc: 0n, heldSince: null };
    if (f.side === "buy") {
      if (b.units === 0n) b.heldSince = f.at;
      b.units += f.tokenUnits;
      b.costUsdc += f.usdcUnits;
    } else if (b.units > 0n) {
      const sold = f.tokenUnits < b.units ? f.tokenUnits : b.units;
      const removed = (b.costUsdc * sold) / b.units; // the cost that leaves with the units sold
      b.units -= sold;
      b.costUsdc -= removed;
      if (b.units === 0n) {
        b.costUsdc = 0n;
        b.heldSince = null;
      }
    }
    out.set(f.tokenAddress, b);
  }
  return out;
}

export interface PositionFacts {
  ticker: string;
  name: string;
  shares: number;
  /** Share of the portfolio by what was paid, in percent. Null unless every position's cost is known. */
  weightPercent: number | null;
  costUsd: number | null;
  /** Gain or loss against cost, in percent. Null without a cost or a current price. */
  profitLossPercent: number | null;
  heldDays: number | null;
}

export interface RecurringFacts {
  ticker: string;
  amount: number;
  currency: string;
  frequency: "daily" | "weekly" | "monthly";
}

export interface PortfolioFacts {
  positions: PositionFacts[];
  positionCount: number;
  largestPositionPercent: number | null;
  largestPositionTicker: string | null;
  recurringBuys: RecurringFacts[];
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
/** Two decimals from one share up; four below, so a small holding does not show as 0.01. */
const displayShares = (n: number) => (n >= 1 ? round2(n) : Math.round(n * 10000) / 10000);

export async function buildPortfolioFacts(p: {
  holdings: Array<{ token: StockToken; units: bigint }>;
  fills: Fill[];
  recurring: RecurringFacts[];
  /** The venue's price for one token in USD, or null when it cannot be had. */
  tokenPriceUsd(token: StockToken): Promise<number | null>;
  now?: Date;
}): Promise<PortfolioFacts> {
  const now = p.now ?? new Date();
  const basis = costBasis(p.fills);
  const held = p.holdings.filter((h) => h.units > 0n);

  const rows = await Promise.all(
    held.map(async ({ token, units }) => {
      const b = basis.get(token.address);
      // The cost is only trusted if the fills explain exactly what the person holds.
      const reconciled = !!b && b.units === units && b.costUsdc > 0n;
      const costUsd = reconciled ? Number(b!.costUsdc) / USDC : null;
      let pl: number | null = null;
      if (costUsd !== null) {
        const price = await p.tokenPriceUsd(token).catch(() => null);
        if (price !== null && price > 0) {
          const value = (Number(units) / 10 ** token.decimals) * price;
          pl = round1(((value - costUsd) / costUsd) * 100);
        }
      }
      return {
        token, units, costUsd, pl,
        heldDays: reconciled && b!.heldSince ? Math.floor((now.getTime() - b!.heldSince.getTime()) / DAY) : null,
      };
    })
  );

  // Weights need every cost: with one unknown, a weight would mislead.
  const allKnown = rows.length > 0 && rows.every((r) => r.costUsd !== null);
  const total = allKnown ? rows.reduce((n, r) => n + r.costUsd!, 0) : 0;

  const positions: PositionFacts[] = rows.map((r) => ({
    ticker: r.token.ticker,
    name: r.token.name,
    shares: displayShares(sharesFor(r.units, r.token)),
    weightPercent: allKnown && total > 0 ? round1((r.costUsd! / total) * 100) : null,
    costUsd: r.costUsd === null ? null : round2(r.costUsd),
    profitLossPercent: r.pl,
    heldDays: r.heldDays,
  }));

  const top = positions.filter((x) => x.weightPercent !== null).sort((a, b) => b.weightPercent! - a.weightPercent!)[0];
  return {
    positions,
    positionCount: positions.length,
    largestPositionPercent: top?.weightPercent ?? null,
    largestPositionTicker: top?.ticker ?? null,
    recurringBuys: p.recurring,
  };
}
