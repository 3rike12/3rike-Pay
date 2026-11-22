// ============================================
// Rail vocabulary
//
// A "rail" is anything that moves money in or out of 3rike Pay: a swap
// provider, a bank partner, a mobile-money gateway, a direct on-chain
// transfer. Each provider reports progress in its own words (1Click says
// PENDING_DEPOSIT, AutoRamp says offramp.failed). Settlement must not know
// those words, so every provider maps onto the seven states below.
// ============================================

/** Where a payment is, in terms every rail shares. */
export type IntentState =
  | "created" // we hold a request; the rail has not been told, or has not answered
  | "awaiting_funds" // the rail is ready and is waiting for money to arrive
  | "processing" // money is in flight (swap running, bank transfer submitted)
  | "settled" // done: the destination has the money
  | "refunded" // the rail returned the money to the sender
  | "failed" // done: it did not work and no money reached the destination
  | "expired"; // the window closed without payment (a late payment can still arrive)

export type RailDirection = "in" | "out";

/** What a rail says happened, already translated to a canonical state. */
export interface RailEventInput {
  /** The canonical state the rail's report maps to. */
  type: IntentState;
  /** The provider's own status or event name, kept for support and audit. */
  providerStatus: string;
  /** Distinguishes two events of the same type (e.g. a deposit tx hash). Optional. */
  dedupeKey?: string;
  /** Provider-specific detail (tx hashes, amounts). Opaque to settlement. */
  detail?: Record<string, unknown>;
}

/** What a rail can do right now. Routing filters on this. All fields are optional: absent means "no restriction". */
export interface RailCapabilities {
  /** Asset ids or symbols the rail accepts (in) or can deliver (out). */
  assets?: string[];
  /** Blockchains, using the same labels as `EVM_CHAIN_IDS` (eth, base, arb...). */
  chains?: string[];
  /** Fiat currencies, ISO codes (NGN, KES...). */
  currencies?: string[];
  /** Countries, ISO 3166-1 alpha-2. */
  countries?: string[];
  minUsd?: number;
  maxUsd?: number;
  /** What the rail can be asked to do. Absent means any. */
  kinds?: Array<RailRequest["kind"]>;
  /** The rail pays out to people, so identity must be verified first. */
  requiresKyc?: boolean;
}

/** What a payment needs from a rail. Matched against `RailCapabilities`. */
export interface RailNeed {
  kind?: RailRequest["kind"];
  asset?: string;
  chain?: string;
  currency?: string;
  country?: string;
  usd?: number;
}

// --------------------------------------------
// Asking a rail to move money
// --------------------------------------------

/** Swap crypto on one chain or asset into another (1Click). Amounts are base units. */
export interface SwapRequest {
  kind: "swap";
  swapType: "EXACT_INPUT" | "EXACT_OUTPUT";
  amount: string;
  originAsset?: string;
  destinationAsset?: string;
  recipient?: string;
  recipientType?: "INTENTS" | "DESTINATION_CHAIN";
  refundTo?: string;
  deadline: Date;
}

/** Pay naira to a bank account against USDC the treasury will send (AutoRamp). */
export interface BankPayoutRequest {
  kind: "bank_payout";
  network: "base" | "bsc";
  /** What the bank receives. */
  ngn: number;
  bankCode: string;
  accountNumber: string;
}

/** A plain token transfer to the treasury, with no swap (direct USDC). The rail tags the amount so the transfer can be recognised. */
export interface DirectTransferRequest {
  kind: "direct_transfer";
  /** The invoice this pays. */
  reference: string;
  userId?: string;
  /** The untagged amount, in the token's base units. */
  baseUnits: string;
}

export type RailRequest = SwapRequest | BankPayoutRequest | DirectTransferRequest;

/** A price, with nothing created at the provider. */
export interface RailQuote {
  rail: string;
  amountIn?: string;
  amountInFormatted?: string | null;
  amountOut?: string;
  deadline?: string;
}

/** What the sender (a customer, or our treasury) must do next. */
export interface RailInstruction extends RailQuote {
  /** The provider's id for this payment: the deposit address, or the payout reference. */
  railRef: string;
  /** Where funds must be sent. */
  depositAddress: string;
  depositMemo?: string | null;
  /** The provider's untouched response, for audit and provider-specific fields. */
  raw: unknown;
}

export interface Rail {
  /** Stable id, stored on the payment ("1click", "autoramp"). */
  id: string;
  direction: RailDirection;
  /** Lower runs first when several rails fit. */
  priority?: number;
  capabilities(): RailCapabilities;
  /** Price a request without creating anything. Rails that cannot price ahead omit this. */
  quote?(req: RailRequest): Promise<RailQuote>;
  /** Create the payment at the provider and say what must be sent where. */
  initiate?(req: RailRequest): Promise<RailInstruction>;
  /**
   * Webhook path. Turns a provider notification into canonical events.
   * Returns [] for events that are not about a payment. Rails with no webhooks omit this.
   */
  parseWebhook?(event: string, payload?: unknown): RailEventInput[];
}
