import { config } from "@/config";
import { createLogger } from "@/utils/logger";

const logger = createLogger("near-intents");

// ============================================
// NEAR Intents 1Click API client
//
// Flow: POST /v0/quote (dry:false) -> unique deposit address -> buyer sends
// funds there -> poll GET /v0/status until SUCCESS / REFUNDED / FAILED.
// 1Click has no webhooks, so polling is the only completion signal.
// There is no testnet - test with small real amounts.
// ============================================

export type NearIntentsStatus =
  | "KNOWN_DEPOSIT_TX"
  | "PENDING_DEPOSIT"
  | "INCOMPLETE_DEPOSIT"
  | "PROCESSING"
  | "SUCCESS"
  | "REFUNDED"
  | "FAILED";

export interface NearIntentsQuote {
  depositAddress?: string;
  depositMemo?: string;
  amountIn: string;
  amountInFormatted?: string;
  minAmountIn?: string;
  amountOut: string;
  deadline?: string;
  timeEstimate?: number;
}

export interface NearIntentsQuoteResponse {
  correlationId?: string;
  timestamp?: string;
  quote: NearIntentsQuote;
}

export interface NearIntentsStatusResponse {
  status: NearIntentsStatus;
  updatedAt?: string;
  swapDetails?: Record<string, unknown>;
}

export function isNearIntentsEnabled(): boolean {
  // The API key is optional: unauthenticated requests work but pay an extra
  // 0.25% fee. Only the recipient is required.
  return Boolean(config.nearIntents?.recipient);
}

async function call<T>(path: string, init: RequestInit & { query?: Record<string, string> } = {}): Promise<T> {
  const { query, ...rest } = init;
  const qs = query ? `?${new URLSearchParams(query).toString()}` : "";
  const res = await fetch(`${config.nearIntents.baseUrl}${path}${qs}`, {
    ...rest,
    headers: {
      "Content-Type": "application/json",
      ...(config.nearIntents.apiKey ? { "X-API-Key": config.nearIntents.apiKey } : {}),
      ...(rest.headers || {}),
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    logger.error("NEAR Intents request failed", { path, status: res.status, body: body.slice(0, 300) });
    throw new Error(`NEAR Intents ${path} failed (${res.status}): ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

/**
 * Price a fiat amount in base units of the destination asset (USD-pegged).
 * Rounds UP so we never under-collect by a rounding hair.
 */
export function fiatToDestinationUnits(amount: number, currency: string): string {
  const { fxRates, destinationDecimals } = config.nearIntents;
  const rate = fxRates?.[currency.toUpperCase()];
  if (!Number.isFinite(rate) || !rate || rate <= 0) {
    throw new Error(`Crypto payments don't support ${currency} invoices yet.`);
  }
  return BigInt(Math.ceil((amount / rate) * 10 ** destinationDecimals)).toString();
}

// --------------------------------------------
// Token catalogue (GET /v0/tokens, public)
// --------------------------------------------

export interface PayableToken {
  assetId: string;
  symbol: string;
  blockchain: string;
  decimals: number;
  price: number;
}

/**
 * Origin chains we accept. A quote's `refundTo` must be a valid address on
 * the buyer's origin chain; one platform refund address is valid on every
 * EVM chain but not on Solana/BTC/etc, so non-EVM origins are out until we
 * collect the buyer's own refund address.
 */
// bsc is excluded: 1Click enforces a $1,000 minimum on BNB Chain swaps (and a
// live $2 BSC quote returned "No liquidity"), far above typical invoices.
export const EVM_ORIGIN_CHAINS = ["eth", "base", "arb", "op", "pol", "avax", "gnosis"];
const PAYABLE_SYMBOLS = ["USDC", "USDT", "ETH"];

let tokenCache: { at: number; tokens: PayableToken[] } | null = null;

export async function listPayableTokens(): Promise<PayableToken[]> {
  if (tokenCache && Date.now() - tokenCache.at < 10 * 60 * 1000) return tokenCache.tokens;
  const res = await fetch(`${config.nearIntents.baseUrl}/v0/tokens`);
  if (!res.ok) throw new Error(`NEAR Intents tokens failed (${res.status})`);
  const all = (await res.json()) as PayableToken[];
  const tokens = all.filter(
    (t) => EVM_ORIGIN_CHAINS.includes(t.blockchain) && PAYABLE_SYMBOLS.includes(t.symbol.toUpperCase())
  );
  tokenCache = { at: Date.now(), tokens };
  return tokens;
}

/** "usdt bsc" -> token. Chain optional; falls back to the configured default chain. */
export async function resolveOriginAsset(symbol: string, chain?: string): Promise<PayableToken | null> {
  const tokens = await listPayableTokens();
  const sym = symbol.toUpperCase();
  const matches = tokens.filter((t) => t.symbol.toUpperCase() === sym);
  if (chain) return matches.find((t) => t.blockchain === chain.toLowerCase()) ?? null;
  return matches.find((t) => t.blockchain === "base") ?? matches[0] ?? null;
}

/**
 * Request a quote.
 *
 * Default (inbound invoice payment): EXACT_OUTPUT into the platform
 * recipient - the platform receives exactly the invoice value and the
 * buyer's input absorbs slippage.
 *
 * Overrides cover payouts: EXACT_INPUT from the treasury asset to a
 * merchant-chosen token, chain and address.
 */
export async function requestQuote(params: {
  amount?: string;
  /** @deprecated use `amount`; kept for the invoice path. */
  amountOut?: string;
  swapType?: "EXACT_INPUT" | "EXACT_OUTPUT";
  originAsset?: string;
  destinationAsset?: string;
  recipient?: string;
  /** Defaults to config.nearIntents.recipientType for the platform recipient; payouts pass DESTINATION_CHAIN. */
  recipientType?: "INTENTS" | "DESTINATION_CHAIN";
  refundTo?: string;
  deadline: Date;
  dry?: boolean;
}): Promise<NearIntentsQuoteResponse> {
  const c = config.nearIntents;
  return call<NearIntentsQuoteResponse>("/v0/quote", {
    method: "POST",
    body: JSON.stringify({
      dry: params.dry ?? false,
      swapType: params.swapType ?? "EXACT_OUTPUT",
      slippageTolerance: c.slippageBps,
      originAsset: params.originAsset || c.originAsset,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: params.destinationAsset || c.destinationAsset,
      amount: params.amount ?? params.amountOut,
      refundTo: params.refundTo || c.refundTo,
      refundType: "ORIGIN_CHAIN",
      recipient: params.recipient || c.recipient,
      recipientType: params.recipientType ?? (params.recipient ? "DESTINATION_CHAIN" : c.recipientType),
      deadline: params.deadline.toISOString(),
      ...(c.referral ? { referral: c.referral } : {}),
    }),
  });
}

export async function getStatus(depositAddress: string, depositMemo?: string): Promise<NearIntentsStatusResponse> {
  return call<NearIntentsStatusResponse>("/v0/status", {
    query: { depositAddress, ...(depositMemo ? { depositMemo } : {}) },
  });
}

/** Optional: tell 1Click the deposit tx hash so it can verify early. */
export async function submitDepositTx(params: {
  txHash: string;
  depositAddress: string;
  depositMemo?: string;
}): Promise<unknown> {
  return call("/v0/deposit/submit", { method: "POST", body: JSON.stringify(params) });
}

export const nearIntents = { isNearIntentsEnabled, requestQuote, getStatus, submitDepositTx, fiatToDestinationUnits, listPayableTokens, resolveOriginAsset };
