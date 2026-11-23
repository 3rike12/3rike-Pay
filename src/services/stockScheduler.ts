import { acquireLock } from "@/utils/idempotency";
import { getStockVenue } from "@/services/stockVenue";
import { placeBuy, reconcileStuckOrders } from "@/services/stockOrders";
import { runDueSchedules, type RunEvent } from "@/services/stockSchedules";
import { runStockAlerts } from "@/services/stockAlerts";
import { prismaAlertStore } from "@/services/stockAlertStore";
import { getStocks } from "@/services/stocks";
import { positions } from "@/services/positions";
import { recordPrices, prismaPriceStore } from "@/services/priceHistory";
import { createLogger } from "@/utils/logger";

const logger = createLogger("stock-scheduler");

/** How long an order may sit unfinished before the background pass resolves it. Longer than any normal venue call. */
export const STUCK_AFTER_MS = 5 * 60_000;

export interface SchedulerDeps {
  notify(event: RunEvent): Promise<void> | void;
  /** Send an alert to a person. Without it, alerts are not run. */
  notifyUser?(userId: string, text: string): Promise<void>;
}

/**
 * One pass of the background work. Safe to run from several instances at once
 * (every step is idempotent); the lock only avoids doing the work twice.
 *
 * Alerts about stocks people hold run whether or not a venue is configured: they
 * only need holdings to exist. Resolving stuck orders and running recurring buys
 * need a venue, and without one they do nothing, so a due recurring buy waits
 * instead of failing and counting against the person.
 */
export async function runStockJobs(deps: SchedulerDeps): Promise<{ stuck: number; ran: number; alerted: number } | null> {
  let alerted = 0;
  // Keep a record of each new price the feed publishes, so trends and drops can be worked out later.
  // It needs no venue and must never hold up the rest.
  try {
    await recordPrices(await getStocks(), prismaPriceStore);
  } catch (error: any) {
    logger.warn("Could not record prices", { error: error?.message });
  }
  if (deps.notifyUser) {
    try {
      alerted = (await runStockAlerts({ stocks: getStocks, positions, store: prismaAlertStore, notify: deps.notifyUser })).sent;
    } catch (error: any) {
      // A failing alert pass must never stop orders and schedules from being resolved.
      logger.error("Stock alerts failed", { error: error?.message });
    }
  }
  if (!getStockVenue()) return alerted ? { stuck: 0, ran: 0, alerted } : null;
  const stuck = await reconcileStuckOrders(STUCK_AFTER_MS);
  const ran = await runDueSchedules({ place: placeBuy, notify: deps.notify });
  if (stuck || ran || alerted) logger.info("Stock jobs ran", { stuck, ran, alerted });
  return { stuck, ran, alerted };
}

/** Start the background pass on a timer. Returns a function that stops it. */
export function startStockScheduler(deps: SchedulerDeps, intervalMs = 60_000): () => void {
  const tick = async () => {
    // Slightly shorter than the interval so leadership can move if an instance dies. With no Redis
    // every instance runs, which is safe because everything underneath is idempotent.
    const lock = await acquireLock("stock-scheduler", Math.max(1, Math.floor(intervalMs / 1000) - 5));
    if (!lock) return;
    try {
      await runStockJobs(deps);
    } catch (error: any) {
      logger.error("Stock jobs failed", { error: error?.message });
    } finally {
      await lock.release();
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  logger.info("Stock scheduler started", { everyMs: intervalMs });
  return () => clearInterval(timer);
}
