import { config } from "@/config";
import { createLogger } from "@/utils/logger";

const logger = createLogger("fx");

// ============================================
// FX rates, and the record of which one a payment used
//
// Today every rate except USD/NGN comes from a static table
// (NEAR_INTENTS_FX_RATES). That is fine as long as it is never silent: each
// payment records the rate it was priced at and where it came from, so a
// disputed amount can be explained after the table has changed. When a live
// source is added it returns an `asOf` time and `isStale` starts to matter.
// ============================================

export type FxSource = "static" | "autoramp" | (string & {});

// A type alias, not an interface, so it can be stored in a Prisma Json column.
export type FxRecord = {
  currency: string;
  /** Units of `currency` per 1 USD. */
  perUsd: number;
  source: FxSource;
  /** When a live source quoted this rate. Null for the static table, which has no clock. */
  asOf: string | null;
};

/** The configured static rate for a currency, as a record. Throws when there is none. */
export function staticFx(currency: string): FxRecord {
  const cur = currency.toUpperCase();
  const perUsd = config.nearIntents?.fxRates?.[cur];
  if (!Number.isFinite(perUsd) || !perUsd || perUsd <= 0) throw new Error(`No FX rate for ${currency}`);
  return { currency: cur, perUsd, source: "static", asOf: null };
}

/** A live quote as a record. */
export function liveFx(currency: string, perUsd: number, source: FxSource, now = new Date()): FxRecord {
  if (!Number.isFinite(perUsd) || perUsd <= 0) throw new Error(`Bad FX rate for ${currency}`);
  return { currency: currency.toUpperCase(), perUsd, source, asOf: now.toISOString() };
}

/**
 * A rate older than `maxAgeMs` should not price new money. The static table is
 * a configured value, not a quote, so it is never stale.
 */
export function isStale(rate: FxRecord, maxAgeMs: number, now = Date.now()): boolean {
  if (rate.asOf === null) return false;
  const quoted = Date.parse(rate.asOf);
  return !Number.isFinite(quoted) || now - quoted > maxAgeMs;
}

/** USD value of `amount` at the recorded rate. */
export function usdAt(amount: number, rate: FxRecord): number {
  return amount / rate.perUsd;
}

// --------------------------------------------
// Live sources
// --------------------------------------------

export interface FxProvider {
  /** Matches the id in FX_LIVE_SOURCES and the `source` on a record. */
  id: string;
  supports(currency: string): boolean;
  /** Units of `currency` per 1 USD. Throws or returns a non-positive number when it has none. */
  fetch(currency: string): Promise<number>;
}

const providers = new Map<string, FxProvider>();
const cache = new Map<string, FxRecord>();

export function registerFxProvider(p: FxProvider) {
  providers.set(p.id, p);
}
export function unregisterFxProvider(id: string) {
  providers.delete(id);
  for (const key of [...cache.keys()]) if (key.startsWith(`${id}:`)) cache.delete(key);
}
export function resetFxCache() {
  cache.clear();
}

function settings() {
  const f: any = (config as any).fx ?? {};
  return {
    sources: (f.liveSources as string[] | undefined) ?? ["autoramp"],
    cacheMs: (Number.isFinite(f.cacheSeconds) ? f.cacheSeconds : 300) * 1000,
    maxAgeMs: (Number.isFinite(f.maxAgeSeconds) ? f.maxAgeSeconds : 900) * 1000,
    maxDeviation: Number.isFinite(f.maxDeviation) ? f.maxDeviation : 0.25,
  };
}

/** A live rate far from the configured table is more likely bad data than a real move. */
function plausible(currency: string, perUsd: number, maxDeviation: number): boolean {
  let reference: number;
  try {
    reference = staticFx(currency).perUsd;
  } catch {
    return true; // nothing to compare with
  }
  return Math.abs(perUsd - reference) / reference <= maxDeviation;
}

/**
 * The rate to price a currency at, as a record that says where it came from.
 *
 * A live source is tried first, if one is enabled for the currency. Its rate is
 * reused for `cacheSeconds`; if the source then fails, the last good rate keeps
 * being served until it is `maxAgeSeconds` old, after which it is never used.
 * An implausible rate is rejected. Whenever there is no usable live rate the
 * static table answers, and the record says "static" so nobody is misled.
 * Throws only when there is no rate of any kind.
 */
export async function getFx(currency: string, now = Date.now()): Promise<FxRecord> {
  const cur = currency.toUpperCase();
  const { sources, cacheMs, maxAgeMs, maxDeviation } = settings();

  if (cur !== "USD") {
    for (const id of sources) {
      const provider = providers.get(id);
      if (!provider || !provider.supports(cur)) continue;
      const key = `${id}:${cur}`;

      const cached = cache.get(key);
      const age = cached?.asOf ? now - Date.parse(cached.asOf) : Infinity;
      if (cached && age <= cacheMs) return cached;

      try {
        const perUsd = await provider.fetch(cur);
        if (!plausible(cur, perUsd, maxDeviation)) {
          logger.error("Live FX rate rejected: too far from the configured table", { currency: cur, source: id, perUsd });
          throw new Error("implausible rate");
        }
        const fresh = liveFx(cur, perUsd, id, new Date(now));
        cache.set(key, fresh);
        return fresh;
      } catch (error: any) {
        if (cached && age <= maxAgeMs) {
          logger.warn("Live FX source failed; serving its last good rate", { currency: cur, source: id, ageSeconds: Math.round(age / 1000) });
          return cached;
        }
        logger.warn("Live FX unavailable; using the static table", { currency: cur, source: id, error: error?.message });
      }
    }
  }
  return staticFx(cur);
}
