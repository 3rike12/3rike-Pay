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
    baseUrl: process.env.AUTORAMP_BASE_URL || "https://autoramp-api.thebuidl.org",
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
  },

  app: {
    name: process.env.APP_NAME || "3rike Pay",
    currency: process.env.APP_CURRENCY || "NGN",
    merchantEmail: process.env.MERCHANT_EMAIL || "",
    merchantName: process.env.MERCHANT_NAME || "",
  },

  features: {
    /**
     * Global dry-run mode.
     * When true, KYC and transfer flows skip real third-party calls and
     * database side effects, returning mocked success responses.
     * KYC_DRY_RUN is still accepted as a legacy alias.
     */
    dryRun: process.env.DRY_RUN === "true" || process.env.KYC_DRY_RUN === "true",
  },

  logLevel: process.env.LOG_LEVEL || "debug",
} as const;
