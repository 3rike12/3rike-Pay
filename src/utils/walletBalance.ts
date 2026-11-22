import { config } from "@/config";
import { fromMinor, toMinor } from "@/utils/money";
import { createLogger } from "@/utils/logger";

const logger = createLogger("wallet-balance");

// ============================================
// Which representation a balance is read from
//
// MONEY_READS=float (default): the float column, as always.
// MONEY_READS=minor: whole minor units, which cannot accumulate float error.
//
// Switch to minor only after `npm run money:minor` reports no drift. A wallet
// that still disagrees is read from the float and logged loudly, so a bad
// migration can never block a payment or show a wrong balance.
// ============================================

export interface WalletRow {
  id?: string;
  currency: string;
  balance: number;
  balanceMinor: bigint;
}

export function readsFromMinor(): boolean {
  return (config as any).money?.readsFrom === "minor";
}

/** The two representations of this wallet disagree. */
export function isDrifted(w: WalletRow): boolean {
  return w.balanceMinor !== toMinor(w.balance, w.currency);
}

/** Whether to treat the integer column as authoritative for this wallet right now. */
export function useMinor(w: WalletRow): boolean {
  if (!readsFromMinor()) return false;
  if (isDrifted(w)) {
    logger.error("Wallet float and minor balances disagree; using the float until money:minor is clean", {
      walletId: w.id,
      currency: w.currency,
      balance: w.balance,
      balanceMinor: w.balanceMinor.toString(),
    });
    return false;
  }
  return true;
}

/** The balance to show or compare against, in major units. */
export function walletBalance(w: WalletRow): number {
  return useMinor(w) ? fromMinor(w.balanceMinor, w.currency) : w.balance;
}
