import { railsFor } from "@/rails/router";
import { supports } from "@/rails/registry";
import type { Rail, RailDirection, RailNeed } from "@/rails/types";

export { configuredLimits, type Limits } from "@/rails/limitConfig";

// ============================================
// Rail limits
//
// Every rail has its own minimum and maximum, so the bot, the pay page and the
// payout flows must not hardcode one. A flow asks `checkLimits` "can any rail
// carry this?" and gets either the rails that can, or the reason none can,
// with the limit to show the user.
// ============================================

export type LimitCheck =
  /** At least one rail can carry it. Best first. */
  | { ok: true; rails: Rail[] }
  /** Under every rail's minimum. `minUsd` is the lowest one, so the user is told the easiest amount to reach. */
  | { ok: false; reason: "below_min"; minUsd: number }
  /** Over every rail's maximum. `maxUsd` is the highest one. */
  | { ok: false; reason: "above_max"; maxUsd: number }
  /** No rail handles this asset, chain, currency or country at all. */
  | { ok: false; reason: "unsupported" };

/**
 * Which rails in `direction` can carry `need` at `need.usd`, or why none can.
 * Rails that do not support the asset, chain, currency or country are never
 * candidates, so their limits are not quoted to someone they would not serve.
 */
export function checkLimits(direction: RailDirection, need: RailNeed & { usd: number }): LimitCheck {
  const { usd, ...rest } = need;
  const candidates = railsFor(direction).filter((r) => supports(r.capabilities(), rest));
  if (candidates.length === 0) return { ok: false, reason: "unsupported" };

  const fits = candidates
    .filter((r) => supports(r.capabilities(), need))
    .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
  if (fits.length) return { ok: true, rails: fits };

  const mins = candidates.map((r) => r.capabilities().minUsd).filter((m): m is number => m !== undefined);
  if (mins.length && usd < Math.min(...mins)) return { ok: false, reason: "below_min", minUsd: Math.min(...mins) };

  const maxes = candidates.map((r) => r.capabilities().maxUsd).filter((m): m is number => m !== undefined);
  return { ok: false, reason: "above_max", maxUsd: maxes.length ? Math.max(...maxes) : usd };
}
