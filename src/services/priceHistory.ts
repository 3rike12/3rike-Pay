import { prisma } from "@/db/prisma";
import { navFreshness, type StockToken } from "@/services/stocks";
import { createLogger } from "@/utils/logger";

const logger = createLogger("price-history");

// ============================================
// Price history and the numbers it gives us
//
// We record each NEW price data point a token's feed publishes (feeds update on a
// 0.5% move or once a day, so this is a few rows per token per day, not a flood).
// From that we compute, in code, the facts a researcher would want: the change over
// a week and a month, the worst drop, and how bumpy the ride has been.
//
// Only percentages are used, never the price itself: Coinbase's nav_price is
// unconfirmed as per-token or per-share, and a percentage is the same either way.
// ============================================

const DAY = 24 * 3600_000;

export interface PricePoint {
  tokenAddress: string;
  price: number;
  observedAt: Date;
}

export interface PriceStore {
  /** Save a point. Returns false if that exact data point was already saved. */
  record(point: PricePoint): Promise<boolean>;
  since(tokenAddress: string, from: Date): Promise<PricePoint[]>;
}

/** Record the latest fresh price of each token. Returns how many were new. */
export async function recordPrices(stocks: StockToken[], store: PriceStore, now = new Date()): Promise<number> {
  let added = 0;
  for (const s of stocks) {
    if (s.navPrice === null || !s.navUpdatedAt) continue;
    if (!navFreshness(s, now.getTime()).fresh) continue;
    const observedAt = new Date(s.navUpdatedAt);
    if (Number.isNaN(observedAt.getTime())) continue;
    try {
      if (await store.record({ tokenAddress: s.address, price: s.navPrice, observedAt })) added++;
    } catch (error: any) {
      logger.warn("Could not record a price point", { token: s.address, error: error?.message });
    }
  }
  return added;
}

export type Volatility = "low" | "medium" | "high" | "unknown";

export interface PriceStats {
  change7dPercent: number | null;
  change30dPercent: number | null;
  /** The biggest fall from a peak within the last 30 days, as a positive percent. */
  drawdown30dPercent: number | null;
  volatility: Volatility;
  /** How many days of history we have. */
  historyDays: number;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * The change over `days`: the latest price against the price at the start of the
 * window. If we do not have history that far back we say nothing rather than
 * compare against something much shorter (at least 60% of the window is needed).
 */
function changeOver(points: PricePoint[], days: number, now: Date): number | null {
  if (points.length < 2) return null;
  const latest = points[points.length - 1];
  const start = now.getTime() - days * DAY;
  const covered = latest.observedAt.getTime() - points[0].observedAt.getTime();
  if (covered < days * DAY * 0.6) return null;
  // The last point at or before the window start; if none, the first we have (history covers most of the window).
  let base = points[0];
  for (const p of points) if (p.observedAt.getTime() <= start) base = p;
  if (base.price <= 0 || base === latest) return null;
  return round1(((latest.price - base.price) / base.price) * 100);
}

/** Pure: the facts in a series of price points. */
export function computeStats(points: PricePoint[], now = new Date()): PriceStats {
  const sorted = [...points].filter((p) => p.price > 0 && p.observedAt.getTime() <= now.getTime()).sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
  const historyDays = sorted.length >= 2 ? Math.floor((sorted[sorted.length - 1].observedAt.getTime() - sorted[0].observedAt.getTime()) / DAY) : 0;
  const month = sorted.filter((p) => p.observedAt.getTime() >= now.getTime() - 30 * DAY);

  let drawdown: number | null = null;
  if (month.length >= 3) {
    let peak = month[0].price;
    let worst = 0;
    for (const p of month) {
      peak = Math.max(peak, p.price);
      worst = Math.max(worst, ((peak - p.price) / peak) * 100);
    }
    drawdown = round1(worst);
  }

  let volatility: Volatility = "unknown";
  if (month.length >= 5 && historyDays >= 7) {
    const prices = month.map((p) => p.price);
    const range = ((Math.max(...prices) - Math.min(...prices)) / Math.min(...prices)) * 100;
    volatility = range < 5 ? "low" : range < 15 ? "medium" : "high";
  }

  return {
    change7dPercent: changeOver(sorted, 7, now),
    change30dPercent: changeOver(sorted, 30, now),
    drawdown30dPercent: drawdown,
    volatility,
    historyDays,
  };
}

/**
 * Data points we already know are saved. The background pass runs every minute but a feed publishes a new
 * price only now and then, so most attempts are repeats. Remembering them avoids even asking the database.
 */
const SEEN_LIMIT = 5000;
const seen = new Set<string>();
const remember = (key: string) => {
  if (seen.size >= SEEN_LIMIT) seen.delete(seen.values().next().value as string); // oldest first
  seen.add(key);
};
/** For tests. */
export const forgetSeenPrices = () => seen.clear();

export const prismaPriceStore: PriceStore = {
  async record(point) {
    const key = `${point.tokenAddress}@${point.observedAt.getTime()}`;
    if (seen.has(key)) return false;
    const table = (prisma as any).stockPricePoint;
    // Ask first rather than insert and catch the duplicate: Prisma writes every failed insert to the log as an
    // error even when we handle it, which would bury real errors under one line per token per minute.
    const where = { tokenAddress_observedAt: { tokenAddress: point.tokenAddress, observedAt: point.observedAt } };
    if (await table.findUnique({ where })) {
      remember(key);
      return false;
    }
    try {
      await table.create({ data: point });
      remember(key);
      return true;
    } catch (error) {
      // Another instance saved it between the check and the insert: rare, and fine.
      if ((error as { code?: string })?.code === "P2002") {
        remember(key);
        return false;
      }
      throw error;
    }
  },
  async since(tokenAddress, from) {
    return (await (prisma as any).stockPricePoint.findMany({
      where: { tokenAddress, observedAt: { gte: from } },
      orderBy: { observedAt: "asc" },
    })) as PricePoint[];
  },
};

/** Stats for a token from the stored history. */
export async function statsFor(tokenAddress: string, store: PriceStore = prismaPriceStore, now = new Date()): Promise<PriceStats> {
  return computeStats(await store.since(tokenAddress, new Date(now.getTime() - 35 * DAY)), now);
}
