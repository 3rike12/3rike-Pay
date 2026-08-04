import dotenv from "dotenv";
dotenv.config();

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

  app: {
    name: process.env.APP_NAME || "3rike Pay",
    currency: process.env.APP_CURRENCY || "NGN",
    merchantEmail: process.env.MERCHANT_EMAIL || "",
    merchantName: process.env.MERCHANT_NAME || "",
  },

  logLevel: process.env.LOG_LEVEL || "debug",
} as const;
