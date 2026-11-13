import dotenv from "dotenv";
dotenv.config();

/**
 * True when FLUTTERWAVE_PRODUCTION=true - drives both the v3 SDK and the
 * v4 (OAuth) API base URL.
 */
const isFlutterwaveProduction = process.env.FLUTTERWAVE_PRODUCTION === "true";

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
    baseUrl: process.env.NEAR_INTENTS_BASE_URL || "https://1click.chaindefuser.com",
    apiKey: process.env.NEAR_INTENTS_API_KEY || "",
    /** Platform-controlled address that receives the swapped funds. */
    recipient: process.env.NEAR_INTENTS_RECIPIENT || "",
    /**
     * How `recipient` is interpreted. INTENTS = an account inside NEAR
     * Intents (e.g. treasury.near) - cheapest, no withdrawal fee, and it makes
     * the treasury NEAR-native. DESTINATION_CHAIN = an address on the
     * destination asset's own chain (e.g. an EVM address on Base).
     * Defaults to INTENTS for NEAR-style accounts, DESTINATION_CHAIN for 0x.
     */
    recipientType: (process.env.NEAR_INTENTS_RECIPIENT_TYPE ||
      (/^0x/i.test(process.env.NEAR_INTENTS_RECIPIENT || "") || !process.env.NEAR_INTENTS_RECIPIENT
        ? "DESTINATION_CHAIN"
        : "INTENTS")) as "INTENTS" | "DESTINATION_CHAIN",
    /** Where refunds go if a swap fails (defaults to the recipient). */
    refundTo: process.env.NEAR_INTENTS_REFUND_TO || process.env.NEAR_INTENTS_RECIPIENT || "",
    /** Default asset the buyer pays with (USDC on Base). */
    originAsset:
      process.env.NEAR_INTENTS_ORIGIN_ASSET ||
      "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    /** Asset the platform receives (USDC on Base). */
    destinationAsset:
      process.env.NEAR_INTENTS_DESTINATION_ASSET ||
      "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    /** Decimals of destinationAsset (USDC = 6). */
    destinationDecimals: parseInt(process.env.NEAR_INTENTS_DESTINATION_DECIMALS || "6", 10),
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

  app: {
    name: process.env.APP_NAME || "3rike Pay",
    /** Public origin used to build buyer pay links, e.g. https://pay.example.com */
    baseUrl: (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, ""),
    currency: process.env.APP_CURRENCY || "NGN",
    merchantEmail: process.env.MERCHANT_EMAIL || "",
    merchantName: process.env.MERCHANT_NAME || "",
  },

  /**
   * Toden identity verification (basic KYC): a hosted link the merchant opens
   * on their phone (ID document + selfie + liveness). Set TODEN_SECRET_KEY and
   * TODEN_WORKFLOW_ID to turn it on; payouts then require a verified merchant.
   * Use https://sandbox-api.toden.co with sandbox keys while testing.
   */
  toden: {
    baseUrl: (process.env.TODEN_API_URL || "https://api.toden.co").replace(/\/$/, ""),
    secretKey: process.env.TODEN_SECRET_KEY || "",
    workflowId: process.env.TODEN_WORKFLOW_ID || "",
    webhookSecret: process.env.TODEN_WEBHOOK_SECRET || "",
    /** Previous webhook secret, accepted during a rotation. */
    webhookSecretPrevious: process.env.TODEN_WEBHOOK_SECRET_PREVIOUS || "",
    enabled: !!(process.env.TODEN_SECRET_KEY && process.env.TODEN_WORKFLOW_ID),
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
     * Mobile money (Flutterwave) invoice collection. OFF by default: new
     * invoices are issued as crypto payments instead. Flutterwave webhooks
     * stay live regardless, so charges already in flight still settle.
     */
    mobileMoneyEnabled: process.env.MOBILE_MONEY_ENABLED === "true",
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
} as const;
