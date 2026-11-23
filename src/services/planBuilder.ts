import type { Volatility } from "@/services/priceHistory";

// ============================================
// Candidate plans, computed in code
//
// For "I have 5000 a week, what should I buy?" the model never invents an
// allocation. We build a few options here, exactly and checkably, and the model
// only picks one and explains it. Every plan's amounts add up to the budget
// exactly, in whole currency units, and every line meets the minimum order.
// ============================================

export interface PlanCandidate {
  ticker: string;
  volatility: Volatility;
  /** Share of the person's portfolio this stock already is, in percent. Null when unknown. */
  currentWeightPercent: number | null;
}

export interface PlanLine {
  ticker: string;
  amount: number;
  percent: number;
  /** How much this order would move the price, in percent, from the venue's quote. Absent when it could not be quoted. */
  impactPercent?: number;
}

export interface Plan {
  id: "even" | "balanced" | "focused";
  title: string;
  lines: PlanLine[];
  /** Plain facts about how the plan was built, computed here. */
  notes: string[];
}

export interface PlanInput {
  budget: number;
  candidates: PlanCandidate[];
  /** The smallest order worth placing, in the budget's currency. */
  minOrder: number;
  /** Most stocks in one plan. Default 3. */
  maxLines?: number;
  /** A stock already above this share of the portfolio is left out of "balanced". Default 40. */
  concentrationCap?: number;
}

/**
 * Split `budget` by `weights` into whole units that add up to exactly the budget
 * (largest remainder method), so no amount is lost or invented by rounding.
 */
export function splitWhole(budget: number, weights: number[]): number[] {
  const total = weights.reduce((a, b) => a + b, 0);
  const whole = Math.floor(budget);
  if (!weights.length || total <= 0 || whole <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (w / total) * whole);
  const out = raw.map(Math.floor);
  let left = whole - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    out[i]++;
    left--;
  }
  return out;
}

function toLines(budget: number, tickers: string[], weights: number[], minOrder: number): PlanLine[] | null {
  let t = tickers.slice();
  let w = weights.slice();
  // Drop the smallest share until every line meets the minimum order.
  for (;;) {
    if (!t.length) return null;
    const amounts = splitWhole(budget, w);
    const smallest = amounts.indexOf(Math.min(...amounts));
    if (amounts[smallest] >= minOrder) {
      const sum = amounts.reduce((a, b) => a + b, 0);
      return t.map((ticker, i) => ({ ticker, amount: amounts[i], percent: Math.round((amounts[i] / sum) * 1000) / 10 }));
    }
    t.splice(smallest, 1);
    w.splice(smallest, 1);
  }
}

const RISK_WEIGHT: Record<Volatility, number> = { low: 1, medium: 1, unknown: 1, high: 0.5 };

export function buildPlans(input: PlanInput): Plan[] {
  const { budget, minOrder } = input;
  const maxLines = input.maxLines ?? 3;
  const cap = input.concentrationCap ?? 40;
  if (!Number.isFinite(budget) || Math.floor(budget) < Math.max(1, minOrder)) return [];

  const plans: Plan[] = [];
  const seen = new Set<string>();
  const add = (plan: Plan | null) => {
    if (!plan) return;
    const key = plan.lines.map((l) => `${l.ticker}:${l.amount}`).join("|");
    if (!seen.has(key)) {
      seen.add(key);
      plans.push(plan);
    }
  };

  // Same stock spelled twice counts once; the first one wins, and tickers are upper case.
  const byTicker = new Map<string, PlanCandidate>();
  for (const cand of input.candidates) {
    const ticker = cand.ticker.toUpperCase();
    if (!byTicker.has(ticker)) byTicker.set(ticker, { ...cand, ticker });
  }
  const unique = [...byTicker.values()];

  // Even: the first few, equal shares.
  const evenSet = unique.slice(0, maxLines);
  const even = toLines(budget, evenSet.map((c) => c.ticker), evenSet.map(() => 1), minOrder);
  if (even) add({ id: "even", title: "Even split", lines: even, notes: ["Equal amounts across each stock."] });

  // Balanced: leave out anything already a large part of the portfolio; tilt away from the bumpiest.
  const notes: string[] = [];
  const eligible = unique.filter((c) => {
    if (c.currentWeightPercent !== null && c.currentWeightPercent > cap) {
      notes.push(`Leaves out ${c.ticker}, already ${c.currentWeightPercent}% of your portfolio.`);
      return false;
    }
    return true;
  });
  const bal = eligible.slice(0, maxLines);
  const balLines = toLines(budget, bal.map((c) => c.ticker), bal.map((c) => RISK_WEIGHT[c.volatility]), minOrder);
  if (balLines) {
    for (const c of bal) if (c.volatility === "high") notes.push(`Puts less into ${c.ticker}, which has been bumpy lately.`);
    add({ id: "balanced", title: "Balanced", lines: balLines, notes: notes.length ? notes : ["Spreads across stocks, tilted away from the bumpiest."] });
  }

  // Focused: everything in the one stock that is calmest and least already held.
  const pick = [...eligible].sort((a, b) => (RISK_WEIGHT[b.volatility] - RISK_WEIGHT[a.volatility]) || ((a.currentWeightPercent ?? 0) - (b.currentWeightPercent ?? 0)))[0];
  if (pick) {
    const one = toLines(budget, [pick.ticker], [1], minOrder);
    if (one) add({ id: "focused", title: `All in ${pick.ticker}`, lines: one, notes: ["One stock only: simpler, but less spread out."] });
  }
  return plans;
}

/** Every number the plans mention, for the answer checker to allow. */
export function planNumbers(plans: Plan[]): number[] {
  return plans.flatMap((p) => p.lines.flatMap((l) => [l.amount, l.percent, ...(l.impactPercent !== undefined ? [l.impactPercent] : [])]));
}
