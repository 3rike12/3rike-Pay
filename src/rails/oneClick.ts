import { nearIntents, type NearIntentsQuote, type NearIntentsStatus, type NearIntentsStatusResponse } from "@/services/nearIntents";
import { configuredLimits } from "@/rails/limitConfig";
import type { IntentState, Rail, RailEventInput, RailInstruction, RailQuote, RailRequest, SwapRequest } from "@/rails/types";

// ============================================
// 1Click (NEAR Intents) as a rail
//
// 1Click has no webhooks, so completion is learned by polling
// GET /v0/status. Every quote mints its own deposit address and money sent to
// ANY of them is a real payment, so a payment is judged by all of its
// addresses together (`summariseQuoteStatuses`).
// ============================================

/** 1Click's status vocabulary in canonical terms. */
export function mapOneClickStatus(status: NearIntentsStatus | string): IntentState {
  switch (status) {
    case "SUCCESS":
      return "settled";
    case "REFUNDED":
      return "refunded";
    case "FAILED":
      return "failed";
    case "PROCESSING":
    case "KNOWN_DEPOSIT_TX":
      return "processing";
    // A partial deposit is still waiting for the rest of the money.
    case "INCOMPLETE_DEPOSIT":
    case "PENDING_DEPOSIT":
    default:
      return "awaiting_funds";
  }
}

export interface QuoteStatusSummary {
  /** The payment's state across all its deposit addresses. Never "created" or "expired". */
  state: IntentState;
  /** The 1Click status that decided it (for display and audit). */
  providerStatus?: string;
  /** Index (into the quotes that were polled) of the address that was paid. Only when settled. */
  paidIndex?: number;
}

/**
 * Combine the status of every deposit address a payment ever minted.
 *
 * `results` is aligned with the quotes that were polled; `null` means that
 * poll failed. Order of precedence:
 *   1. any address settled          -> settled (that address is `paidIndex`)
 *   2. any address mid-swap          -> processing
 *   3. every address answered and every one is dead -> refunded if any was
 *      refunded, otherwise failed. One unused or expired quote must never
 *      fail a payment that still has a live address, and a failed poll is not
 *      evidence of anything.
 *   4. otherwise                     -> awaiting_funds
 */
export function summariseQuoteStatuses(results: Array<NearIntentsStatusResponse | null>): QuoteStatusSummary {
  const paidIndex = results.findIndex((r) => r?.status === "SUCCESS");
  if (paidIndex >= 0) return { state: "settled", providerStatus: "SUCCESS", paidIndex };

  const answered = results.filter((r): r is NearIntentsStatusResponse => r !== null);

  const inFlight = answered.find((r) => mapOneClickStatus(r.status) === "processing");
  if (inFlight) return { state: "processing", providerStatus: inFlight.status };

  const allDead =
    answered.length > 0 &&
    answered.length === results.length &&
    answered.every((r) => r.status === "REFUNDED" || r.status === "FAILED");
  if (allDead) {
    const refunded = answered.some((r) => r.status === "REFUNDED");
    return { state: refunded ? "refunded" : "failed", providerStatus: refunded ? "REFUNDED" : "FAILED" };
  }

  return { state: "awaiting_funds", providerStatus: answered[answered.length - 1]?.status };
}

/** One canonical event for a single deposit address's status. */
export function oneClickEvent(status: NearIntentsStatusResponse, dedupeKey?: string): RailEventInput {
  return {
    type: mapOneClickStatus(status.status),
    providerStatus: status.status,
    dedupeKey,
    detail: status.swapDetails ? { swapDetails: status.swapDetails } : undefined,
  };
}

const ORIGIN_CHAINS = ["eth", "base", "arb", "op", "pol", "avax", "gnosis", "stellar"];

function asSwap(req: RailRequest): SwapRequest {
  if (req.kind !== "swap") throw new Error("1Click swaps crypto; it cannot make a bank payout.");
  return req;
}

function quoteFrom(q: NearIntentsQuote): RailQuote {
  return {
    rail: "1click",
    amountIn: q.amountIn,
    amountInFormatted: q.amountInFormatted ?? null,
    amountOut: q.amountOut,
    deadline: q.deadline,
  };
}

function swapBody(req: SwapRequest, dry: boolean) {
  return {
    dry,
    swapType: req.swapType,
    amount: req.amount,
    originAsset: req.originAsset,
    destinationAsset: req.destinationAsset,
    recipient: req.recipient,
    recipientType: req.recipientType,
    refundTo: req.refundTo,
    depositMode: req.depositMode,
    deadline: req.deadline,
  };
}

async function quoteSwap(req: RailRequest): Promise<RailQuote> {
  const { quote } = await nearIntents.requestQuote(swapBody(asSwap(req), true));
  return quoteFrom(quote);
}

async function initiateSwap(req: RailRequest, id: string): Promise<RailInstruction> {
  const { quote } = await nearIntents.requestQuote(swapBody(asSwap(req), false));
  if (!quote.depositAddress) throw new Error("NEAR Intents returned no deposit address.");
  return {
    ...quoteFrom(quote),
    rail: id,
    railRef: quote.depositAddress,
    depositAddress: quote.depositAddress,
    depositMemo: quote.depositMemo ?? null,
    raw: quote,
  };
}

/** Money in: a customer pays from any chain and token, the treasury receives USDC. */
export const oneClickRail: Rail = {
  id: "1click",
  direction: "in",
  priority: 10,
  capabilities: () => ({ kinds: ["swap"], chains: ORIGIN_CHAINS, ...configuredLimits("1click") }),
  quote: quoteSwap,
  initiate: (req) => initiateSwap(req, "1click"),
};

/** Money out to a crypto address: the treasury's USDC is swapped to the user's chosen token and chain. */
export const oneClickPayoutRail: Rail = {
  id: "1click-payout",
  direction: "out",
  priority: 20,
  capabilities: () => ({ kinds: ["swap"], chains: ORIGIN_CHAINS, requiresKyc: true, ...configuredLimits("1click-payout") }),
  quote: quoteSwap,
  initiate: (req) => initiateSwap(req, "1click-payout"),
};
