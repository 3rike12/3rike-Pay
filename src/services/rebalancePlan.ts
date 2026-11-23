import { computeRebalance, type RebalanceOptions } from "@/services/rebalance";
import type { StockToken } from "@/services/stocks";

// ============================================
// A rebalance plan for one person: the arithmetic from rebalance.ts, applied to
// what they hold and what the venue says it is worth, ready to be shown to them
// and, if they say yes, placed as ordinary orders.
// ============================================

export interface PlanDeps {
  targets(userId: string): Promise<Array<{ tokenAddress: string; percent: number }>>;
  holdings(userId: string): Promise<Array<{ tokenAddress: string; units: bigint }>>;
  stocks(): Promise<StockToken[]>;
  /** USD value of one whole token, from the venue. Null when it cannot be had. */
  tokenPriceUsd(token: StockToken): Promise<number | null>;
  /** USD to the person's currency. */
  fromUsd(usd: number, currency: string): number;
}

export interface PlanRow {
  token: StockToken;
  targetPercent: number;
  actualPercent: number;
  driftPercent: number;
}

export interface PlanTrade {
  side: "buy" | "sell";
  token: StockToken;
  usd: number;
  /** buy: the cash to spend, in the person's currency. */
  cashAmount?: number;
  /** sell: raw token units to sell. */
  units?: bigint;
}

export type RebalancePlan =
  | { status: "no_target" }
  | { status: "nothing_held"; rows: PlanRow[] }
  | { status: "unpriced"; missing: string[] }
  | { status: "balanced"; rows: PlanRow[]; maxDrift: number; total: number }
  | { status: "trades"; rows: PlanRow[]; trades: PlanTrade[]; maxDrift: number; total: number };

const floorCents = (n: number) => Math.floor(n * 100) / 100;

export async function planRebalance(userId: string, currency: string, deps: PlanDeps, options?: RebalanceOptions): Promise<RebalancePlan> {
  const saved = await deps.targets(userId);
  if (saved.length === 0) return { status: "no_target" };

  const catalogue = await deps.stocks();
  const byAddress = new Map(catalogue.map((s) => [s.address, s]));
  const targets = saved.filter((t) => byAddress.has(t.tokenAddress)).map((t) => ({ address: t.tokenAddress, percent: t.percent }));
  if (targets.length < 2) return { status: "no_target" };

  const held = new Map((await deps.holdings(userId)).map((h) => [h.tokenAddress, h.units]));
  const prices = new Map<string, number>();
  const missing: string[] = [];
  for (const t of targets) {
    const units = held.get(t.address) ?? 0n;
    const token = byAddress.get(t.address)!;
    // A stock they hold must be priced; one they do not hold is priced only if a buy is needed.
    const price = await deps.tokenPriceUsd(token).catch(() => null);
    if (price !== null && price > 0) prices.set(t.address, price);
    else if (units > 0n) missing.push(token.ticker);
  }
  if (missing.length) return { status: "unpriced", missing };

  const holdings = targets.map((t) => {
    const token = byAddress.get(t.address)!;
    const units = held.get(t.address) ?? 0n;
    return { address: t.address, valueUsd: (Number(units) / 10 ** token.decimals) * (prices.get(t.address) ?? 0) };
  });

  const result = computeRebalance(targets, holdings, options);
  const rows: PlanRow[] = result.rows.map((r) => ({ token: byAddress.get(r.address)!, targetPercent: r.targetPercent, actualPercent: r.actualPercent, driftPercent: r.driftPercent }));
  if (result.total <= 0) return { status: "nothing_held", rows };
  if (result.trades.length === 0) return { status: "balanced", rows, maxDrift: result.maxDrift, total: result.total };

  const trades: PlanTrade[] = [];
  for (const t of result.trades) {
    const token = byAddress.get(t.address)!;
    const price = prices.get(t.address);
    if (!price) continue; // a buy of a stock we cannot price is left out rather than guessed
    if (t.side === "sell") {
      const have = held.get(t.address) ?? 0n;
      let units = BigInt(Math.floor((t.usd / price) * 10 ** token.decimals));
      if (units > have) units = have;
      if (units > 0n) trades.push({ side: "sell", token, usd: t.usd, units });
    } else {
      const cashAmount = floorCents(deps.fromUsd(t.usd, currency));
      if (cashAmount > 0) trades.push({ side: "buy", token, usd: t.usd, cashAmount });
    }
  }
  if (trades.length === 0) return { status: "balanced", rows, maxDrift: result.maxDrift, total: result.total };
  return { status: "trades", rows, trades, maxDrift: result.maxDrift, total: result.total };
}
