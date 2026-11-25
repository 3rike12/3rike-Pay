import { config } from "@/config";

// Where each rail's minimum and maximum come from. Kept apart from the check
// itself so a rail can read its own limits without importing the registry.

export interface Limits {
  minUsd?: number;
  maxUsd?: number;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/**
 * A rail's limits from config. `RAIL_<ID>_MIN_USD` / `_MAX_USD` win; otherwise
 * the defaults below. Read at call time, so a changed config applies at once.
 */
export function configuredLimits(railId: string): Limits {
  const c: any = config;
  const own = c.rails?.[railId] ?? {};
  const treasury = c.treasury ?? {};
  switch (railId) {
    case "1click":
      return {
        // 1Click does not make small swaps worth quoting. This was the old TOPUP_MIN_USD.
        minUsd: num(own.minUsd) ?? num(treasury.minTopUpUsd) ?? 5,
        // The testnet demo network (Tidepool) is not capped.
        maxUsd: c.nearIntents?.network === "tidepool" ? undefined : (num(own.maxUsd) ?? num(treasury.maxWithdrawUsd)),
      };
    case "1click-payout":
    case "autoramp":
      return {
        minUsd: num(own.minUsd) ?? num(treasury.minWithdrawUsd),
        maxUsd: num(own.maxUsd) ?? num(treasury.maxWithdrawUsd),
      };
    default:
      return { minUsd: num(own.minUsd), maxUsd: num(own.maxUsd) };
  }
}
