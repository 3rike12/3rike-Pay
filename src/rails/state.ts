import type { IntentState } from "@/rails/types";

// ============================================
// Payment state machine
//
// Webhooks and pollers both report, and can report the same thing twice or
// out of order. This table is the single rule for which reports are allowed
// to move a payment, so a duplicate is a no-op and a contradiction (the bank
// says "completed" after we already refunded the user) is refused instead of
// double-spending.
// ============================================

const FINAL: IntentState[] = ["settled", "refunded", "failed"];

const ALLOWED: Record<IntentState, IntentState[]> = {
  created: ["awaiting_funds", "processing", "settled", "refunded", "failed", "expired"],
  awaiting_funds: ["processing", "settled", "refunded", "failed", "expired"],
  processing: ["settled", "refunded", "failed"],
  // Money can still arrive for a deposit address minted before the window
  // closed, and that is a real payment. Expiry is therefore not final.
  expired: ["awaiting_funds", "processing", "settled", "refunded", "failed"],
  settled: [],
  refunded: [],
  failed: [],
};

/** No further report can change this payment. */
export function isFinal(state: IntentState): boolean {
  return FINAL.includes(state);
}

export type Transition =
  | { kind: "advance"; from: IntentState; to: IntentState }
  /** Same state again: a duplicate webhook or a poll that saw nothing new. */
  | { kind: "duplicate"; state: IntentState }
  /** A report the current state does not allow, e.g. "failed" after "settled". */
  | { kind: "conflict"; from: IntentState; to: IntentState };

/** Decide what a report does to a payment currently in `from`. Pure. */
export function transition(from: IntentState, to: IntentState): Transition {
  if (from === to) return { kind: "duplicate", state: from };
  if (ALLOWED[from].includes(to)) return { kind: "advance", from, to };
  return { kind: "conflict", from, to };
}

/**
 * Our `Transaction.status` strings, as written by the existing flows, in
 * canonical terms. `awaiting_signature` is a payout that is debited but not
 * yet sent: nothing has left the treasury, so it is still `created`.
 */
export function fromTransactionStatus(status: string): IntentState {
  switch (status) {
    case "completed":
      return "settled";
    case "failed":
      return "failed";
    case "refunded":
      return "refunded";
    case "expired":
      return "expired";
    case "processing":
      return "processing";
    case "awaiting_signature":
    case "pending":
    default:
      return "created";
  }
}
