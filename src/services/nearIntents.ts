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
  // fee (about 0.2%). Only the recipient is required.
  return Boolean(config.nearIntents?.recipient);
}

async function call<T>(path: string, init: RequestInit & { query?: Record<string, string> } = {}): Promise<T> {
  const { query, ...rest } = init;
  const qs = query ? `?${new URLSearchParams(query).toString()}` : "";
  // A hung upstream must fail fast, not leave a customer on a spinner.
  const res = await fetch(`${config.nearIntents.baseUrl}${path}${qs}`, {
    signal: AbortSignal.timeout(15_000),
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
  /** ERC-20 contract on the token's chain; absent for the native coin (ETH). */
  contractAddress?: string | null;
}

/** EVM chain ids for the origin chains we accept (wallet network switching). */
export const EVM_CHAIN_IDS: Record<string, number> = {
  eth: 1,
  base: 8453,
  arb: 42161,
  op: 10,
  pol: 137,
  avax: 43114,
  gnosis: 100,
};

/** Testnet EVM ids used by Tidepool. Its blockchain labels stay `base`, `arb`, and `eth`. */
export const TIDEPOOL_EVM_CHAIN_IDS: Record<string, number> = {
  eth: 11155111,
  base: 84532,
  arb: 421614,
  bsc: 97,
  aurora: 1313161555,
};

export function evmChainIdFor(blockchain: string): number | null {
  const ids = config.nearIntents.network === "tidepool" ? TIDEPOOL_EVM_CHAIN_IDS : EVM_CHAIN_IDS;
  return ids[blockchain] ?? null;
}

export function walletChainIds(): number[] {
  return config.nearIntents.network === "tidepool" ? [84532, 421614, 11155111, 97, 1313161555] : [8453, 1, 10, 137, 42161, 43114, 100];
}

export const CHAIN_NAMES: Record<string, string> = {
  eth: "Ethereum",
  base: "Base",
  arb: "Arbitrum",
  op: "Optimism",
  pol: "Polygon",
  avax: "Avalanche",
  gnosis: "Gnosis",
  stellar: "Stellar",
};

/** "USDC on base" -> "USDC on Base". */
export function prettyOrigin(label?: string | null): string {
  if (!label) return "";
  const [token, chain] = label.split(" on ");
  return chain ? `${token} on ${CHAIN_NAMES[chain] ?? chain}` : label;
}

export const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

/**
 * Origin chains we accept. A quote's `refundTo` must be a valid address on
 * the buyer's origin chain; one platform refund address is valid on every
 * EVM chain but not on Solana/BTC/etc, so non-EVM origins are out until we
 * collect the buyer's own refund address.
 */
// bsc is excluded: 1Click enforces a $1,000 minimum on BNB Chain swaps (and a
// live $2 BSC quote returned "No liquidity"), far above typical invoices.
export const EVM_ORIGIN_CHAINS = ["eth", "base", "arb", "op", "pol", "avax", "gnosis"];
/** Stellar: no per-payment address. The payer sends to one address with a memo (1Click "MEMO" deposit mode). */
export const STELLAR_CHAIN = "stellar";
export const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;
export const isStellarAddress = (value: string) => STELLAR_ADDRESS_RE.test(value);
/** How a payer on this chain deposits. Undefined leaves 1Click's default (a fresh address per payment). */
export const depositModeFor = (blockchain?: string | null): "MEMO" | undefined => (blockchain === STELLAR_CHAIN ? "MEMO" : undefined);
const PAYABLE_SYMBOLS = ["USDC", "USDT", "ETH"];
const STELLAR_SYMBOLS = ["USDC", "XLM"];

let tokenCache: { at: number; tokens: PayableToken[] } | null = null;

export async function listPayableTokens(): Promise<PayableToken[]> {
  if (tokenCache && Date.now() - tokenCache.at < 10 * 60 * 1000) return tokenCache.tokens;
  const res = await fetch(`${config.nearIntents.baseUrl}/v0/tokens`);
  if (!res.ok) throw new Error(`NEAR Intents tokens failed (${res.status})`);
  const all = (await res.json()) as PayableToken[];
  const tokens = all.filter(
    (t) =>
      ((EVM_ORIGIN_CHAINS.includes(t.blockchain) && PAYABLE_SYMBOLS.includes(t.symbol.toUpperCase())) ||
        (t.blockchain === STELLAR_CHAIN && STELLAR_SYMBOLS.includes(t.symbol.toUpperCase()))) &&
      // NEAR Intents rejects same-asset swaps. Don't offer an input token
      // that is also configured as the destination asset.
      t.assetId !== config.nearIntents.destinationAsset
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
 * What a payment is pre-prepared in when the payer has not chosen yet, best first. A stablecoin on Base is preferred
 * (USDT on Base exists on the testnet and may appear on mainnet), then ETH on Base (on mainnet it is the only thing a
 * Base payer can use: USDC on Base is the treasury's own asset, which 1Click refuses, and USDT on Base is not offered),
 * then stablecoins on other chains. Whatever 1Click offers first in this list is used.
 */
export const DEFAULT_ORIGIN_PREFERENCE: ReadonlyArray<readonly [symbol: string, chain: string]> = [
  ["USDT", "base"],
  ["ETH", "base"],
  ["USDC", "arb"],
  ["USDC", "op"],
  ["USDC", "eth"],
  ["USDT", "eth"],
];

/** The token to pre-prepare a payment in: the first of the preferences that is on offer, else anything that is, else none. */
export async function resolveDefaultOrigin(): Promise<PayableToken | null> {
  const tokens = await listPayableTokens();
  for (const [symbol, chain] of DEFAULT_ORIGIN_PREFERENCE) {
    const hit = tokens.find((t) => t.symbol.toUpperCase() === symbol && t.blockchain === chain);
    if (hit) return hit;
  }
  return tokens[0] ?? null;
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
  /** Chains such as Stellar have no per-payment address: the payer sends to one address with a memo. */
  depositMode?: "SIMPLE" | "MEMO";
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
      ...(params.depositMode ? { depositMode: params.depositMode } : {}),
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

export const nearIntents = { isNearIntentsEnabled, requestQuote, getStatus, submitDepositTx, fiatToDestinationUnits, listPayableTokens, resolveOriginAsset, resolveDefaultOrigin };
