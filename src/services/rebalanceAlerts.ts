import { planRebalance, type PlanDeps } from "@/services/rebalancePlan";
import { getTargets, usersWithTargets } from "@/services/stockTargets";
import { prismaAlertStore } from "@/services/stockAlertStore";
import { getStocks } from "@/services/stocks";
import { positions } from "@/services/positions";
import { getStockVenue } from "@/services/stockVenue";
import { venuePriceUsd } from "@/services/researchContext";
import { fromUsd } from "@/services/treasury";
import { createLogger } from "@/utils/logger";

const logger = createLogger("rebalance-alerts");

// ============================================
// A weekly nudge when a person's stocks have drifted from their target mix.
// It only tells them; they decide whether to rebalance. At most one nudge per
// person per week, and nobody who turned stock alerts off is messaged.
// ============================================

export interface RebalanceCheckDeps {
  users(): Promise<string[]>;
  /** The plan for a person, or null when it cannot be worked out right now. */
  plan(userId: string): Promise<{ status: string; maxDrift?: number } | null>;
  isOptedOut(userId: string): Promise<boolean>;
  claim(key: string, userId: string, kind: string): Promise<boolean>;
  release(key: string): Promise<void>;
  notify(userId: string, text: string): Promise<void>;
  now?: () => Date;
}

/** A label for the ISO-ish week, so a nudge goes out at most once in it. */
export function weekKey(d: Date): string {
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.floor((d.getTime() - start) / (7 * 24 * 3600_000));
  return `${d.getUTCFullYear()}-w${week}`;
}

export function driftMessage(maxDrift: number): string {
  return `*Your stocks have drifted from your target mix*\n\nThe biggest gap is about ${Math.round(maxDrift)} points.\n\nSend *rebalance* and I'll show you exactly what it would take to get back on target. Nothing happens until you say yes.`;
}

export async function runRebalanceChecks(
  deps: Pick<RebalanceCheckDeps, "notify"> & Partial<RebalanceCheckDeps>
): Promise<{ checked: number; sent: number }> {
  const d: RebalanceCheckDeps = {
    users: usersWithTargets,
    plan: (userId) => planRebalance(userId, "USD", realPlanDeps),
    isOptedOut: (u) => prismaAlertStore.isOptedOut(u),
    claim: (k, u, kind) => prismaAlertStore.claim(k, u, kind),
    release: (k) => prismaAlertStore.release(k),
    ...deps,
  };
  const week = weekKey((d.now ?? (() => new Date()))());
  let checked = 0;
  let sent = 0;
  for (const userId of await d.users()) {
    checked++;
    try {
      if (await d.isOptedOut(userId)) continue;
      const plan = await d.plan(userId);
      if (!plan || plan.status !== "trades") continue;
      const key = `rebalance:${userId}:${week}`;
      if (!(await d.claim(key, userId, "rebalance"))) continue; // already nudged this week
      try {
        await d.notify(userId, driftMessage(plan.maxDrift ?? 0));
        sent++;
      } catch (error: any) {
        await d.release(key); // so the next pass can try again
        logger.warn("Could not deliver a rebalance nudge", { userId, error: error?.message });
      }
    } catch (error: any) {
      logger.warn("Rebalance check failed for a person", { userId, error: error?.message });
    }
  }
  return { checked, sent };
}

const realPlanDeps: PlanDeps = {
  targets: getTargets,
  holdings: (userId) => positions.list(userId),
  stocks: () => getStocks(),
  tokenPriceUsd: (token) => venuePriceUsd(getStockVenue())(token),
  fromUsd: (usd, currency) => fromUsd(usd, currency),
};
