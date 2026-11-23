// ============================================
// Rebalancing: the arithmetic
//
// Given a target mix and what a person holds (valued in USD), work out which stocks
// to sell and which to buy to get back to the target. Pure code: exact, repeatable
// and testable. The model never does this, and nothing here trades.
//
// Only stocks named in the target are considered. A stock the person holds that is
// not in the target is left alone and not counted in the weights.
// ============================================

export interface Target {
  address: string;
  percent: number;
}

export interface Holding {
  address: string;
  valueUsd: number;
}

export interface Row {
  address: string;
  targetPercent: number;
  actualPercent: number;
  driftPercent: number;
}

export interface Trade {
  side: "buy" | "sell";
  address: string;
  /** Dollar value to move. */
  usd: number;
}

export interface RebalanceResult {
  total: number;
  rows: Row[];
  trades: Trade[];
  /** The biggest gap between actual and target, in percentage points. */
  maxDrift: number;
}

export interface RebalanceOptions {
  /** Do nothing while every stock is within this many points of its target. Default 5. */
  band?: number;
  /** Ignore any single trade smaller than this. Default 5. */
  minTradeUsd?: number;
  /**
   * Buys are scaled to this share of what the sells bring in, so a small price slip on the sells
   * never leaves a buy short of cash. Default 0.98.
   */
  buyCover?: number;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** True when the targets are usable: positive, no repeats, adding up to 100. */
export function validTargets(targets: Target[]): boolean {
  if (targets.length < 2) return false;
  if (new Set(targets.map((t) => t.address)).size !== targets.length) return false;
  if (targets.some((t) => !(t.percent > 0) || !Number.isFinite(t.percent))) return false;
  return Math.abs(targets.reduce((n, t) => n + t.percent, 0) - 100) <= 0.5;
}

export function computeRebalance(targets: Target[], holdings: Holding[], options: RebalanceOptions = {}): RebalanceResult {
  const band = options.band ?? 5;
  const minTrade = options.minTradeUsd ?? 5;
  const cover = options.buyCover ?? 0.98;

  const value = new Map(holdings.map((h) => [h.address, Math.max(0, h.valueUsd)]));
  const total = targets.reduce((n, t) => n + (value.get(t.address) ?? 0), 0);
  const scale = targets.reduce((n, t) => n + t.percent, 0) || 1;

  const rows: Row[] = targets.map((t) => {
    const targetPercent = (t.percent / scale) * 100;
    const actualPercent = total > 0 ? ((value.get(t.address) ?? 0) / total) * 100 : 0;
    return { address: t.address, targetPercent: round1(targetPercent), actualPercent: round1(actualPercent), driftPercent: round1(actualPercent - targetPercent) };
  });
  const maxDrift = rows.reduce((m, r) => Math.max(m, Math.abs(r.driftPercent)), 0);

  if (total <= 0 || maxDrift < band) return { total: round2(total), rows, trades: [], maxDrift };

  const sells: Trade[] = [];
  let buys: Trade[] = [];
  for (const t of targets) {
    const diff = (t.percent / scale) * total - (value.get(t.address) ?? 0);
    if (diff < 0) sells.push({ side: "sell", address: t.address, usd: round2(-diff) });
    else if (diff > 0) buys.push({ side: "buy", address: t.address, usd: round2(diff) });
  }
  const proceeds = sells.reduce((n, t) => n + t.usd, 0);
  const buyTotal = buys.reduce((n, t) => n + t.usd, 0);
  if (buyTotal > 0 && proceeds > 0) {
    const f = Math.min(1, (proceeds * cover) / buyTotal);
    buys = buys.map((t) => ({ ...t, usd: round2(t.usd * f) }));
  }

  const trades = [...sells, ...buys].filter((t) => t.usd >= minTrade);
  return { total: round2(total), rows, trades, maxDrift };
}
