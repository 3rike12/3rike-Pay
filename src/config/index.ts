import dotenv from "dotenv";
dotenv.config();

/**
 * True when FLUTTERWAVE_PRODUCTION=true - drives both the v3 SDK and the
 * v4 (OAuth) API base URL.
 */
const isFlutterwaveProduction = process.env.FLUTTERWAVE_PRODUCTION === "true";

import todenJson from "./toden.json";

/** Sandbox keys need the sandbox workflow; everything else uses the production one. */
const todenWorkflowId = /sandbox/i.test(process.env.TODEN_API_URL || "")
  ? todenJson.sandboxWorkflowId
  : todenJson.workflowId;

/**
 * Where customers' payments land. NEAR_INTENTS_RECIPIENT wins; otherwise the
 * treasury address is used, so setting TREASURY_ADDRESS alone is enough to
 * turn crypto payments on (the treasury is the recipient).
 */
const nearRecipient = process.env.NEAR_INTENTS_RECIPIENT || process.env.TREASURY_ADDRESS || "";
const requestedNearIntentsNetwork = (process.env.NEAR_INTENTS_NETWORK || "mainnet").toLowerCase();
const nearIntentsNetwork = requestedNearIntentsNetwork === "near" ? "mainnet" : requestedNearIntentsNetwork;
const tidepool = nearIntentsNetwork === "tidepool";
if (!["mainnet", "tidepool"].includes(nearIntentsNetwork)) {
  throw new Error('NEAR_INTENTS_NETWORK must be "near", "mainnet", or "tidepool".');
}
const tidepoolRecipient = process.env.TREASURY_ADDRESS || process.env.NEAR_INTENTS_RECIPIENT || "";
const nearIntentsBaseUrl = tidepool
  ? "https://www.usetidepool.tech"
  : (process.env.NEAR_INTENTS_BASE_URL || "https://1click.chaindefuser.com").replace(/\/$/, "");

export const config = {
  port: parseInt(process.env.PORT || "3000", 10),
  nodeEnv: process.env.NODE_ENV || "development",

  db: {
    url: process.env.DATABASE_URL || "",
  },

  whatsapp: {
    apiVersion: process.env.WHATSAPP_API_VERSION || "v21.0",
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || "",
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN || "",
    businessAccountId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || "",
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || "3rike_pay_verify_2024",
    get apiBase(): string {
      return `https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}`;
    },
  },

  webhook: {
    path: process.env.WEBHOOK_PATH || "/webhook/whatsapp",
    secret: process.env.WEBHOOK_SECRET || "",
  },

  autoramp: {
    apiKey: process.env.AUTORAMP_API_KEY || "",
    baseUrl: process.env.AUTORAMP_BASE_URL || "https://api-autoramp.thebuidl.xyz",
    webhookSecret: process.env.AUTORAMP_WEBHOOK_SECRET || "",
  },

  redis: {
    url: process.env.REDIS_URL || "",
  },

  flutterwave: {
    publicKey: process.env.FLUTTERWAVE_PUBLIC_KEY || "",
    secretKey: process.env.FLUTTERWAVE_SECRET_KEY || "",
    webhookSecret: process.env.FLUTTERWAVE_WEBHOOK_SECRET || "",
    /**
     * Defaults to false (sandbox). Set FLUTTERWAVE_PRODUCTION=true for live keys.
     */
    isProduction: isFlutterwaveProduction,

    /**
     * v4 API (OAuth client credentials). This is the API that can push a
     * payment prompt straight to the buyer's handset instead of sending a
     * link. The push charge flow only runs when both values are set - with
     * them missing we fall back to the v3 redirect charge.
     */
    clientId: process.env.FLUTTERWAVE_CLIENT_ID || "",
    clientSecret: process.env.FLUTTERWAVE_CLIENT_SECRET || "",
    /**
     * v4 API base URL. Sandbox for test keys; the docs call the live
     * environment "f4bexperience". Override with FLUTTERWAVE_API_BASE if
     * Flutterwave hands out a different production host.
     */
    apiBase:
      process.env.FLUTTERWAVE_API_BASE ||
      (isFlutterwaveProduction
        ? "https://f4bexperience.flutterwave.com"
        : "https://developersandbox-api.flutterwave.com"),
    /** OAuth token endpoint - same realm for sandbox and production. */
    tokenUrl:
      process.env.FLUTTERWAVE_TOKEN_URL ||
      "https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token",
    /**
     * Sandbox testing aid, sent as `X-Scenario-Key` on charge requests only.
     * `scenario:auth_redirect` makes a test charge answer with a clickable
     * link to Flutterwave's mock page, where you can approve or decline it
     * (mock numbers never authorise a push). Leave unset in production.
     */
    scenarioKey: process.env.FLUTTERWAVE_SCENARIO_KEY || "",
  },

  /**
   * NEAR Intents 1Click API - lets a buyer pay an invoice in crypto from any
   * supported chain; 1Click swaps it into `destinationAsset` at `recipient`.
   * Enabled only when apiKey and recipient are both set.
   */
  nearIntents: {
    network: nearIntentsNetwork,
    baseUrl: nearIntentsBaseUrl,
    // Never send a production 1Click API key to the community Tidepool sandbox.
    apiKey: tidepool ? "" : process.env.NEAR_INTENTS_API_KEY || "",
    /** Platform-controlled address that receives the swapped funds. */
    recipient: tidepool ? tidepoolRecipient : nearRecipient,
    /**
     * How `recipient` is interpreted. INTENTS = an account inside NEAR
     * Intents (e.g. treasury.near) - cheapest, no withdrawal fee, and it makes
     * the treasury NEAR-native. DESTINATION_CHAIN = an address on the
     * destination asset's own chain (e.g. an EVM address on Base).
     * Defaults to INTENTS for NEAR-style accounts, DESTINATION_CHAIN for 0x.
     */
    recipientType: (tidepool
      ? (/^0x/i.test(tidepoolRecipient) ? "DESTINATION_CHAIN" : "INTENTS")
      : process.env.NEAR_INTENTS_RECIPIENT_TYPE ||
      (/^0x/i.test(nearRecipient) || !nearRecipient
        ? "DESTINATION_CHAIN"
        : "INTENTS")) as "INTENTS" | "DESTINATION_CHAIN",
    /** Where refunds go if a swap fails (defaults to the recipient). */
    // Testnet quotes are requested only after the buyer connects their wallet;
    // the page supplies that wallet as refundTo for each quote.
    refundTo: tidepool ? "" : process.env.NEAR_INTENTS_REFUND_TO || nearRecipient,
    /** Default asset the buyer pays with (USDC on Base). */
    originAsset:
      (tidepool
        ? "nep141:base-0x38d81431b9f76d9699af7517040d5221d9dea252.tp-omft.testnet"
        : process.env.NEAR_INTENTS_ORIGIN_ASSET || "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near"),
    /** Asset the platform receives (USDC on Base). */
    destinationAsset:
      (tidepool
        ? "nep141:base-0x38d81431b9f76d9699af7517040d5221d9dea252.tp-omft.testnet"
        : process.env.NEAR_INTENTS_DESTINATION_ASSET || "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near"),
    /** Decimals of destinationAsset (USDC = 6). */
    destinationDecimals: tidepool ? 6 : parseInt(process.env.NEAR_INTENTS_DESTINATION_DECIMALS || "6", 10),
    /**
     * Static FX: units of each currency per 1 USD, used to price fiat
     * invoices in the (USD-pegged) destination asset. Override the whole
     * table with NEAR_INTENTS_FX_RATES='{"RWF":1450,"NGN":1550}'. Replace
     * with a live feed before production.
     */
    fxRates: {
      USD: 1,
      RWF: 1450,
      NGN: 1550,
      KES: 129,
      TZS: 2600,
      GHS: 15,
      ...(JSON.parse(process.env.NEAR_INTENTS_FX_RATES || "{}") as Record<string, number>),
    } as Record<string, number>,
    slippageBps: parseInt(process.env.NEAR_INTENTS_SLIPPAGE_BPS || "100", 10),
    /** Optional referral id registered with NEAR Intents. */
    referral: process.env.NEAR_INTENTS_REFERRAL || "",
  },

  /**
   * WalletConnect (Reown) project id for the buyer pay page's wallet picker.
   * Public by design (it is sent to browsers). Create one free at
   * https://dashboard.reown.com . Empty = the page offers installed browser
   * wallets only, with no mobile-wallet (QR / deep link) option.
   */
  walletConnect: {
    projectId: process.env.WALLETCONNECT_PROJECT_ID || "",
  },

  /**
   * Crypto treasury: the on-chain pool that backs merchant ledger balances.
   * Inbound crypto payments land here (NEAR_INTENTS_RECIPIENT should be this
   * address) and withdrawals are paid out of it.
   */
  treasury: {
    address: process.env.TREASURY_ADDRESS || process.env.NEAR_INTENTS_RECIPIENT || "",
    /** EVM JSON-RPC used to read the treasury's on-chain balance. */
    rpcUrl: process.env.TREASURY_RPC_URL || "https://mainnet.base.org",
    /** ERC-20 the treasury holds (USDC on Base). */
    tokenContract:
      process.env.TREASURY_TOKEN_CONTRACT || "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    tokenDecimals: parseInt(process.env.TREASURY_TOKEN_DECIMALS || "6", 10),
    minWithdrawUsd: Number(process.env.WITHDRAW_MIN_USD || 5),
    maxWithdrawUsd: Number(process.env.WITHDRAW_MAX_USD || 2000),
  },

  /**
   * Live FX sources. Only AutoRamp has one (USD/NGN); every other currency uses
   * the static table. FX_LIVE_SOURCES="" turns live rates off entirely.
   *   FX_CACHE_SECONDS      reuse a live rate this long (default 300)
   *   FX_MAX_AGE_SECONDS    never use a live rate older than this, even when the
   *                         source is down; fall back to the static table (default 900)
   *   FX_MAX_DEVIATION      reject a live rate this far from the static table, as a
   *                         fraction, because it is more likely bad data than a real move (default 0.25)
   */
  fx: {
    liveSources: (process.env.FX_LIVE_SOURCES ?? "autoramp").split(",").map((x) => x.trim()).filter(Boolean),
    cacheSeconds: Number(process.env.FX_CACHE_SECONDS || 300),
    maxAgeSeconds: Number(process.env.FX_MAX_AGE_SECONDS || 900),
    maxDeviation: Number(process.env.FX_MAX_DEVIATION || 0.25),
  },

  /**
   * Tokenized stocks on Base. Every country is open except the United States
   * (the Base quest excludes US trading, and the tokens' own terms are for people
   * outside the US).
   *   STOCKS_BLOCK_US=false     turn the US block off
   *   STOCKS_NAV_MAX_AGE_SECONDS  a price older than this is shown as stale (default 86400:
   *                               feeds run 24/5 and hold their last value off-hours)
   */
  /**
   * The research assistant for stocks (an AI model that explains and suggests, never trades).
   * Off unless an API key is set. Any OpenAI-compatible Chat Completions API works; the default
   * is Meta's Model API. NEVER use a model SKU that trains on your inputs (Meta's "-contributor"
   * SKUs): the client refuses to.
   *   STOCKS_LLM_API_KEY (or MODEL_API_KEY)   keep it on the server only
   *   STOCKS_LLM_BASE_URL   default https://api.meta.ai/v1
   *   STOCKS_LLM_MODEL      default muse-spark-1.3
   *   STOCKS_LLM_REASONING_EFFORT   optional: minimal | low | medium | high | xhigh (omitted if unset)
   *   STOCKS_LLM_DAILY_LIMIT   questions per person per day (default 20)
   */
  llm: ((): { provider: string; apiKey: string; baseUrl: string; model: string; reasoningEffort: string; dailyLimit: number } => {
    // STOCKS_LLM_PROVIDER picks sensible defaults; every value can still be set on its own.
    //   meta (default)  Meta's Model API. A reasoning model: "low" effort keeps its thinking within the token limit.
    //   groq            Groq's OpenAI-compatible API. gpt-oss is a reasoning model, so "low" effort keeps its thinking within the
    //                   token limit. Groq retires models often (Llama 3.3 70B went on 2026-08-16): if you see a 404 "does not
    //                   exist", set STOCKS_LLM_MODEL to one from the startup log's list of available models.
    const presets: Record<string, { baseUrl: string; model: string; reasoningEffort: string }> = {
      meta: { baseUrl: "https://api.meta.ai/v1", model: "muse-spark-1.3", reasoningEffort: "low" },
      groq: { baseUrl: "https://api.groq.com/openai/v1", model: "openai/gpt-oss-120b", reasoningEffort: "low" },
    };
    const provider = (process.env.STOCKS_LLM_PROVIDER || "meta").toLowerCase();
    const preset = presets[provider] ?? presets.meta;
    return {
      provider: presets[provider] ? provider : "meta",
      apiKey: process.env.STOCKS_LLM_API_KEY || (provider === "groq" ? process.env.GROQ_API_KEY : "") || process.env.MODEL_API_KEY || "",
      baseUrl: (process.env.STOCKS_LLM_BASE_URL || preset.baseUrl).replace(/\/$/, ""),
      model: process.env.STOCKS_LLM_MODEL || preset.model,
      reasoningEffort: process.env.STOCKS_LLM_REASONING_EFFORT ?? preset.reasoningEffort, // an explicit empty value turns it off
      dailyLimit: Number(process.env.STOCKS_LLM_DAILY_LIMIT || 20),
    };
  })(),

  /** Recent news and earnings for the research assistant (Finnhub). Off without a key; the assistant then says it cannot see news. */
  research: {
    newsApiKey: process.env.STOCKS_NEWS_API_KEY || "",
    newsBaseUrl: (process.env.STOCKS_NEWS_BASE_URL || "https://finnhub.io/api/v1").replace(/\/$/, ""),
  },

  stocks: {
    /**
     * The trading venue. Off unless STOCKS_VENUE=0x AND every one of STOCKS_0X_API_KEY and
     * STOCKS_0X_ALLOWED_TARGETS (comma-separated contract addresses the treasury may call or
     * approve, from 0x's documentation) is set, with the Privy treasury wallet configured.
     */
    venue: {
      kind: process.env.STOCKS_VENUE || "",
      zeroExApiKey: process.env.STOCKS_0X_API_KEY || "",
      zeroExAllowedTargets: (process.env.STOCKS_0X_ALLOWED_TARGETS || "").split(",").map((a) => a.trim()).filter(Boolean),
      zeroExBaseUrl: process.env.STOCKS_0X_BASE_URL || "https://api.0x.org",
    },
    /** Smallest and largest single order, in USD. */
    minOrderUsd: Number(process.env.STOCKS_MIN_ORDER_USD || 5),
    maxOrderUsd: Number(process.env.STOCKS_MAX_ORDER_USD || 500),
    /** The price a buy may fill below its quote before the venue must refuse it, in basis points (100 = 1%). */
    maxSlippageBps: Number(process.env.STOCKS_MAX_SLIPPAGE_BPS || 100),
    /** An order whose quoted price impact is above this is refused before any money moves. */
    maxPriceImpactBps: Number(process.env.STOCKS_MAX_PRICE_IMPACT_BPS || 150),
    apiUrl: process.env.STOCKS_API_URL || "https://api.coinbase.com/v1/tokenized-stocks",
    /** Where the last good stock list is kept, so the app still has stocks when Coinbase cannot be reached. Empty turns it off. */
    snapshotPath: process.env.STOCKS_SNAPSHOT_PATH ?? "data/stocks.snapshot.json",
    cacheSeconds: Number(process.env.STOCKS_CACHE_SECONDS || 300),
    navMaxAgeSeconds: Number(process.env.STOCKS_NAV_MAX_AGE_SECONDS || 86400),
    blockUs: process.env.STOCKS_BLOCK_US !== "false",
  },

  /**
   * Which column balances are read from. "float" (default) is the original
   * column; "minor" reads whole minor units, which cannot accumulate float
   * error. Switch to "minor" only after `npm run money:minor` shows no drift:
   * a wallet that still disagrees is read from the float and logged.
   */
  money: {
    readsFrom: process.env.MONEY_READS === "minor" ? ("minor" as const) : ("float" as const),
  },

  /**
   * Per-rail limits, in USD. Every rail carries its own minimum and maximum
   * (1Click has a floor below which a swap is not worth quoting; a bank
   * partner has its own). Unset means the rail's default applies: see
   * src/rails/limits.ts. Examples:
   *   RAIL_1CLICK_MIN_USD=5   RAIL_AUTORAMP_MIN_USD=7   RAIL_AUTORAMP_MAX_USD=1500
   * The id is the rail's id in upper case with `-` as `_` (1click-payout is
   * RAIL_1CLICK_PAYOUT_MIN_USD).
   */
  rails: Object.fromEntries(
    ["1click", "1click-payout", "autoramp", "direct-usdc"].map((id) => {
      const key = `RAIL_${id.toUpperCase().replace(/-/g, "_")}`;
      const read = (suffix: string) => {
        const raw = process.env[`${key}_${suffix}`];
        return raw !== undefined && raw !== "" && Number.isFinite(Number(raw)) ? Number(raw) : undefined;
      };
      return [id, { minUsd: read("MIN_USD"), maxUsd: read("MAX_USD") }];
    })
  ) as Record<string, { minUsd?: number; maxUsd?: number }>,

  /**
   * Direct USDC on Base: a customer who already holds USDC sends it straight to
   * the treasury with no swap, so there is no 1Click fee or minimum. A payment
   * is recognised by its exact amount (a unique tag in the last micro-USDC), so
   * it is OFF until DIRECT_USDC_ENABLED=true and needs TREASURY_ADDRESS to be
   * an EVM address you control.
   */
  directUsdc: {
    enabled: process.env.DIRECT_USDC_ENABLED === "true",
    /** Blocks to wait before trusting a transfer (Base blocks are about 2s). */
    confirmations: parseInt(process.env.DIRECT_USDC_CONFIRMATIONS || "3", 10),
    /** Blocks per eth_getLogs call; public RPCs cap the range. */
    chunkBlocks: parseInt(process.env.DIRECT_USDC_CHUNK_BLOCKS || "2000", 10),
    /** On first run, how far back to look (about an hour at 2s blocks). */
    lookbackBlocks: parseInt(process.env.DIRECT_USDC_LOOKBACK_BLOCKS || "1800", 10),
    /** Tags run 1..maxTag micro-USDC. Keep it under ~500 so a tagged amount cannot equal another invoice's untagged one. */
    maxTag: parseInt(process.env.DIRECT_USDC_MAX_TAG || "499", 10),
  },

  app: {
    name: process.env.APP_NAME || "3rike Pay",
    /** Public origin used to build buyer pay links, e.g. https://pay.example.com */
    baseUrl: (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, ""),
    currency: process.env.APP_CURRENCY || "NGN",
    merchantEmail: process.env.MERCHANT_EMAIL || "",
    merchantName: process.env.MERCHANT_NAME || "",
  },

  /**
   * Privy server wallet that signs treasury payouts (USDC on Base). Privy
   * holds the key; this server only holds an authorization key that lets it
   * ask Privy to send. All of PRIVY_APP_ID, PRIVY_APP_SECRET,
   * PRIVY_AUTHORIZATION_KEY and PRIVY_TREASURY_WALLET_ID turn it on; without
   * them payouts stay manual (`npm run cashout:pending`).
   */
  privy: {
    appId: process.env.PRIVY_APP_ID || "",
    appSecret: process.env.PRIVY_APP_SECRET || "",
    /** The authorization key's private key (the `wallet-auth:...` value). */
    authorizationKey: process.env.PRIVY_AUTHORIZATION_KEY || "",
    walletId: process.env.PRIVY_TREASURY_WALLET_ID || "",
    /** Let Privy pay gas (needs app-pays sponsorship + credits in the dashboard). */
    sponsorGas: process.env.PRIVY_SPONSOR_GAS === "true",
    enabled: !tidepool && !!(
      process.env.PRIVY_APP_ID &&
      process.env.PRIVY_APP_SECRET &&
      process.env.PRIVY_AUTHORIZATION_KEY &&
      process.env.PRIVY_TREASURY_WALLET_ID
    ),
  },

  /**
   * Toden identity verification (basic KYC): a hosted link the merchant opens
   * on their phone (ID document + selfie + liveness). Set TODEN_SECRET_KEY to
   * turn it on; payouts then require a verified merchant. The workflow id
   * lives in toden.json (it is not a secret).
   * Use https://sandbox-api.toden.co with sandbox keys while testing.
   */
  toden: {
    baseUrl: (process.env.TODEN_API_URL || "https://api.toden.co").replace(/\/$/, ""),
    secretKey: process.env.TODEN_SECRET_KEY || "",
    workflowId: todenWorkflowId,
    webhookSecret: process.env.TODEN_WEBHOOK_SECRET || "",
    /** Previous webhook secret, accepted during a rotation. */
    webhookSecretPrevious: process.env.TODEN_WEBHOOK_SECRET_PREVIOUS || "",
    enabled: !!(process.env.TODEN_SECRET_KEY && todenWorkflowId),
  },

  features: {
    /**
     * Global dry-run mode.
     * When true, KYC and transfer flows skip real third-party calls and
     * database side effects, returning mocked success responses.
     * KYC_DRY_RUN is still accepted as a legacy alias.
     */
    dryRun: process.env.DRY_RUN === "true" || process.env.KYC_DRY_RUN === "true",
    /**
     * Mobile money (Flutterwave) invoice collection. SWITCHED OFF for now, and no environment variable turns it
     * back on: new invoices are issued as crypto payments instead. The code is kept so it can be restored by
     * reading MOBILE_MONEY_ENABLED here again. Flutterwave webhooks stay live regardless, so charges already in
     * flight still settle.
     */
    mobileMoneyEnabled: false as boolean,
    /**
     * The original Nigerian-banking features: BVN/NIN KYC, bank sub-accounts,
     * send-money-to-bank, airtime. OFF by default - the product now starts at
     * "set up your shop" and goes straight to invoicing. Set
     * LEGACY_BANKING_ENABLED=true to bring the old onboarding back.
     */
    legacyBanking: process.env.LEGACY_BANKING_ENABLED === "true",
    /**
     * Identity verification (BVN / NIN + OTP) through AutoRamp. OFF by
     * default: no identity number is requested or checked anywhere. Set
     * KYC_REQUIRED=true to turn the check back on - needed for bank
     * sub-accounts and send-money-to-bank (LEGACY_BANKING_ENABLED).
     */
    kycRequired: process.env.KYC_REQUIRED === "true",
  },

  logLevel: process.env.LOG_LEVEL || "debug",
  /** Include what people type in the "Incoming message" log line. Off by default: it is their financial questions. */
  logMessageText: process.env.LOG_MESSAGE_TEXT === "true",
} as const;
