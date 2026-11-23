import { prisma } from "@/db/prisma";
import type { StockToken } from "@/services/stocks";
import type { StockVenue } from "@/services/stockVenue";
import type { Fill, RecurringFacts } from "@/services/portfolioContext";
import type { Plan } from "@/services/planBuilder";
import { listSchedules } from "@/services/stockSchedules";
import { createLogger } from "@/utils/logger";

const logger = createLogger("research-context");

// ============================================
// Gathering what the research assistant needs: the person's fills and recurring
// buys, a real per-token price from the venue, and what each planned order would do
// to the price. Everything here is read-only. Anything that cannot be had is left
// out, and the assistant is simply told less.
// ============================================

const USDC_DECIMALS = 6;

/** The person's completed orders as fills. Only orders that actually filled count. */
export async function loadFills(userId: string): Promise<Fill[]> {
  const rows = (await (prisma as any).stockOrder.findMany({
    where: { userId, state: "filled" },
    select: { side: true, tokenAddress: true, tokenUnits: true, usdcUnits: true, updatedAt: true },
  })) as Array<{ side: string; tokenAddress: string; tokenUnits: bigint; usdcUnits: bigint; updatedAt: Date }>;
  return rows
    .filter((r) => (r.side === "buy" || r.side === "sell") && r.tokenUnits > 0n && r.usdcUnits > 0n)
    .map((r) => ({ side: r.side as "buy" | "sell", tokenAddress: r.tokenAddress, tokenUnits: BigInt(r.tokenUnits), usdcUnits: BigInt(r.usdcUnits), at: r.updatedAt }));
}

/** The person's active recurring buys, so a plan does not duplicate one. */
export async function loadRecurring(userId: string): Promise<RecurringFacts[]> {
  const rows = await listSchedules(userId);
  return rows.filter((r) => r.state === "active").map((r) => ({ ticker: r.ticker, amount: r.cashAmount, currency: r.currency, frequency: r.frequency }));
}

/** What one token costs in USD, from the venue's own quote for selling one. Null when it cannot be had. */
export function venuePriceUsd(venue: StockVenue | null) {
  return async (token: StockToken): Promise<number | null> => {
    if (!venue) return null;
    try {
      const q = await venue.quoteSell({ address: token.address, decimals: token.decimals } as any, 10n ** BigInt(token.decimals));
      const usd = Number(q.usdcUnits) / 10 ** USDC_DECIMALS;
      return usd > 0 ? usd : null;
    } catch (error: any) {
      logger.warn("Could not price a token", { token: token.ticker, error: error?.message });
      return null;
    }
  };
}

/**
 * Add the price impact of each planned order, from the venue's quote, and drop any plan line whose
 * order the market could not absorb. `usdPerUnit` converts the plan's currency to USD.
 */
export async function annotateImpact(
  plans: Plan[],
  stocks: StockToken[],
  usdPerUnit: number,
  venue: StockVenue | null,
  maxImpactPercent = 1
): Promise<Plan[]> {
  if (!venue) return plans;
  const byTicker = new Map(stocks.map((s) => [s.ticker.toUpperCase(), s]));
  const out: Plan[] = [];
  for (const plan of plans) {
    const lines: Plan["lines"] = [];
    let blocked = false;
    for (const line of plan.lines) {
      const token = byTicker.get(line.ticker.toUpperCase());
      if (!token) {
        lines.push(line);
        continue;
      }
      try {
        const q = await venue.quoteBuy({ address: token.address, decimals: token.decimals } as any, BigInt(Math.round(line.amount * usdPerUnit * 10 ** USDC_DECIMALS)));
        const impact = Math.round((q.priceImpactBps / 100) * 100) / 100;
        if (impact > maxImpactPercent) blocked = true;
        lines.push({ ...line, impactPercent: impact });
      } catch {
        lines.push(line); // no quote: keep the line, say nothing about impact
      }
    }
    // A plan with an order the market cannot absorb is not offered at all, rather than offered with a warning.
    if (!blocked) out.push({ ...plan, lines });
  }
  return out;
}
