import type { StockToken } from "@/services/stocks";

/** What a venue needs to know about a token. An order row stores only these. */
export type VenueToken = Pick<StockToken, "address" | "decimals">;

// ============================================
// Where the treasury trades stock tokens
//
// The treasury turns USDC into a stock token (a buy) and back (a sell) at a
// venue: an exchange or pool on Base. Tokens cannot be minted by us, so there is
// no way to hold one without trading for it.
//
// A venue is a plug-in. None is configured yet, so until one is registered
// buying and selling are refused with a clear message, rather than faked.
//
// The contract a venue MUST honour, because order safety depends on it:
//   - `reference` is a client order id and the venue is IDEMPOTENT on it:
//     submitting the same reference twice trades once.
//   - `status(reference)` tells the truth about what happened to an order, so a
//     timeout (outcome unknown) can be resolved later without guessing.
//   - the minimum (`minTokenUnits` / `minUsdcUnits`) is enforced by the venue: a
//     trade that would fill below it must be rejected, not partially filled.
// ============================================

export interface BuyQuote {
  /** Raw token units the venue would deliver for the USDC. */
  tokenUnits: bigint;
  /** How far the price moves because of this order's size, in basis points. */
  priceImpactBps: number;
}

export interface SellQuote {
  /** Raw USDC units (6 decimals) the venue would pay. */
  usdcUnits: bigint;
  priceImpactBps: number;
}

export type VenueResult =
  | { status: "filled"; tokenUnits: bigint; usdcUnits: bigint; txHash?: string }
  /** A definite refusal: nothing traded. Safe to refund. */
  | { status: "rejected"; reason: string };

export type VenueStatus =
  | { state: "filled"; tokenUnits: bigint; usdcUnits: bigint; txHash?: string }
  | { state: "rejected"; reason: string }
  | { state: "pending" }
  /** The venue has no record of this reference: it never received it. */
  | { state: "not_found" };

export interface StockVenue {
  id: string;
  quoteBuy(token: VenueToken, usdcUnits: bigint): Promise<BuyQuote>;
  quoteSell(token: VenueToken, tokenUnits: bigint): Promise<SellQuote>;
  buy(req: { reference: string; token: VenueToken; usdcUnits: bigint; minTokenUnits: bigint }): Promise<VenueResult>;
  sell(req: { reference: string; token: VenueToken; tokenUnits: bigint; minUsdcUnits: bigint }): Promise<VenueResult>;
  status(reference: string): Promise<VenueStatus>;
}

let venue: StockVenue | null = null;

export function setStockVenue(v: StockVenue | null) {
  venue = v;
}

/** The configured venue, or null when none is registered yet. */
export function getStockVenue(): StockVenue | null {
  return venue;
}
