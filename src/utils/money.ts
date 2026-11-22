// ============================================
// Money in minor units
//
// Balances are stored as floating point today. Floats add up to errors
// (0.1 + 0.2), so every ledger write also stores the same amount as a whole
// number of minor units (cents). During the migration the float stays the
// source of truth and the minor value is derived from it, so a row that
// predates the migration heals on its first write. Once a backfill shows no
// drift, reads move to the minor columns and the float becomes the derived one.
// ============================================

/** Currencies with no minor unit. Everything else is treated as 2 decimal places. */
const ZERO_DECIMAL = new Set(["RWF", "UGX", "JPY", "XAF", "XOF", "GNF"]);

export function minorExponent(currency: string): number {
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? 0 : 2;
}

/** A decimal amount as whole minor units, rounded half away from zero. */
export function toMinor(amount: number, currency: string): bigint {
  if (!Number.isFinite(amount)) throw new Error(`Cannot convert ${amount} to minor units`);
  const scaled = Math.abs(amount) * 10 ** minorExponent(currency);
  const rounded = Math.round(scaled);
  return BigInt(amount < 0 ? -rounded : rounded);
}

export function fromMinor(minor: bigint | number, currency: string): number {
  return Number(minor) / 10 ** minorExponent(currency);
}

/**
 * Add `amountMinor` to a Transaction about to be created, from its amount and
 * currency (the column's default, NGN, when none is given). Leaves an explicit
 * `amountMinor`, and data with no numeric amount, alone.
 */
export function withTransactionMinor<T extends { amount?: unknown; currency?: unknown; amountMinor?: unknown }>(data: T): T {
  if (data && typeof data.amount === "number" && data.amountMinor === undefined && Number.isFinite(data.amount)) {
    const currency = typeof data.currency === "string" ? data.currency : "NGN";
    return { ...data, amountMinor: toMinor(data.amount, currency) };
  }
  return data;
}
