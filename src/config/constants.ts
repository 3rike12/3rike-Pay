import messagesJson from "./messages.json";
import flowsJson from "./flows.json";
import templatesJson from "./templates.json";

// ============================================
// User KYC Status
// ============================================
export const KYC_STATUS = {
  PENDING: "pending",
  VERIFIED: "verified",
  REJECTED: "rejected",
} as const;

export type KycStatus = (typeof KYC_STATUS)[keyof typeof KYC_STATUS];

// ============================================
// Dry-run Flow Commands
// ============================================
export const DRY_RUN_FLOWS = {
  KYC_ONBOARDING: "kyc_onboarding",
  SEND_MONEY: "send_money",
  BUY_AIRTIME: "buy_airtime",
} as const;

export type DryRunFlow = (typeof DRY_RUN_FLOWS)[keyof typeof DRY_RUN_FLOWS];

// ============================================
// Triggers & Keywords
// ============================================
export const TRIGGERS = {
  START: ["start", "hi", "hello", "hey", "menu"],
  HELP: ["help", "commands", "how"],
  CANCEL: ["cancel", "stop", "exit", "quit"],
  BALANCE: ["balance", "bal", "check balance"],
  SEND_MONEY: ["send", "transfer", "pay", "send money"],
  AIRTIME: ["airtime", "recharge", "top up", "data"],
  KYC: ["kyc", "verify", "verification", "identity"],
} as const;

// ============================================
// WhatsApp Flows (source of truth: src/config/flows.json)
// ============================================
// Design flow IDs + metadata in flows.json. Env vars below are optional
// overrides (handy for staging/prod without editing the file).
export const FLOW_DEFS = {
  KYC_ONBOARDING: {
    ...flowsJson.KYC_ONBOARDING,
    id: process.env.WHATSAPP_FLOW_KYC_ID || flowsJson.KYC_ONBOARDING.id || "",
  },
  SEND_MONEY: {
    ...flowsJson.SEND_MONEY,
    id: process.env.WHATSAPP_FLOW_SEND_MONEY_ID || flowsJson.SEND_MONEY.id || "",
  },
  BUY_AIRTIME: {
    ...flowsJson.BUY_AIRTIME,
    id: process.env.WHATSAPP_FLOW_AIRTIME_ID || flowsJson.BUY_AIRTIME.id || "",
  },
} as const;

export type FlowKey = keyof typeof FLOW_DEFS;

/** Plain id map (kept so existing FLOWS.X call sites keep working). */
export const FLOWS = {
  KYC_ONBOARDING: FLOW_DEFS.KYC_ONBOARDING.id,
  SEND_MONEY: FLOW_DEFS.SEND_MONEY.id,
  BUY_AIRTIME: FLOW_DEFS.BUY_AIRTIME.id,
} as const;

// ============================================
// WhatsApp Message Templates (source of truth: src/config/templates.json)
// ============================================
// Design template names + language + params in templates.json (must match
// what is approved in Meta Business Manager). Env vars below are optional
// overrides (handy for staging/prod without editing the file).
//
// WELCOME_CREATE_WALLET is the business-initiated intro (new users only).
// Create it in Meta Business Manager as UTILITY, e.g. body:
//   "Hi {{1}}! Welcome to 3rike Pay. Send, receive, and manage your money
//    with ease. Tap *Create Wallet* to get started."
// Then add ONE Flow button that opens the KYC Flow directly.
// The API payload sends the body param + a button component with sub_type
// "flow" so Meta renders the button. Tapping it opens the Flow form on the
// phone - no bot message needed (silent ack).
// Do NOT send this as free text: outside the 24h customer-service window
// only approved templates deliver (Meta policy, error 131047 otherwise).
// ============================================
export const TEMPLATES = {
  WELCOME_CREATE_WALLET: {
    NAME: process.env.WHATSAPP_TEMPLATE_WELCOME || templatesJson.WELCOME_CREATE_WALLET.name,
    LANGUAGE: process.env.WHATSAPP_TEMPLATE_LANG || templatesJson.WELCOME_CREATE_WALLET.language,
    // {{1}} = user name
  },
  KYC_OTP: {
    NAME: process.env.WHATSAPP_TEMPLATE_KYC_OTP || templatesJson.KYC_OTP.name,
    LANGUAGE: process.env.WHATSAPP_TEMPLATE_LANG || templatesJson.KYC_OTP.language,
    // {{1}} = OTP code
  },
  KYC_APPROVED: {
    NAME: process.env.WHATSAPP_TEMPLATE_KYC_APPROVED || templatesJson.KYC_APPROVED.name,
    LANGUAGE: process.env.WHATSAPP_TEMPLATE_LANG || templatesJson.KYC_APPROVED.language,
    // {{1}} = user name
  },
  KYC_REJECTED: {
    NAME: process.env.WHATSAPP_TEMPLATE_KYC_REJECTED || templatesJson.KYC_REJECTED.name,
    LANGUAGE: process.env.WHATSAPP_TEMPLATE_LANG || templatesJson.KYC_REJECTED.language,
    // {{1}} = user name, {{2}} = reason
  },
  ACCOUNT_CREATED: {
    NAME: process.env.WHATSAPP_TEMPLATE_ACCOUNT_CREATED || templatesJson.ACCOUNT_CREATED.name,
    LANGUAGE: process.env.WHATSAPP_TEMPLATE_LANG || templatesJson.ACCOUNT_CREATED.language,
    // {{1}} = user name, {{2}} = bank, {{3}} = account number, {{4}} = account name
  },
  PAYMENT_RECEIVED: {
    NAME: process.env.WHATSAPP_TEMPLATE_PAYMENT_RECEIVED || templatesJson.PAYMENT_RECEIVED.name,
    LANGUAGE: process.env.WHATSAPP_TEMPLATE_LANG || templatesJson.PAYMENT_RECEIVED.language,
    // {{1}} = user name, {{2}} = amount, {{3}} = from, {{4}} = reference
  },
  TRANSFER_COMPLETE: {
    NAME: process.env.WHATSAPP_TEMPLATE_TRANSFER_COMPLETE || templatesJson.TRANSFER_COMPLETE.name,
    LANGUAGE: process.env.WHATSAPP_TEMPLATE_LANG || templatesJson.TRANSFER_COMPLETE.language,
    VARIABLES: templatesJson.TRANSFER_COMPLETE.params,
  },
  TRANSFER_FAILED: {
    NAME: process.env.WHATSAPP_TEMPLATE_TRANSFER_FAILED || templatesJson.TRANSFER_FAILED.name,
    LANGUAGE: process.env.WHATSAPP_TEMPLATE_LANG || templatesJson.TRANSFER_FAILED.language,
    VARIABLES: templatesJson.TRANSFER_FAILED.params,
  },
  LOGIN_OTP: {
    NAME: process.env.WHATSAPP_TEMPLATE_LOGIN_OTP || templatesJson.LOGIN_OTP.name,
    LANGUAGE: process.env.WHATSAPP_TEMPLATE_LANG || templatesJson.LOGIN_OTP.language,
    // {{1}} = OTP code
  },
  LOW_BALANCE: {
    NAME: process.env.WHATSAPP_TEMPLATE_LOW_BALANCE || templatesJson.LOW_BALANCE.name,
    LANGUAGE: process.env.WHATSAPP_TEMPLATE_LANG || templatesJson.LOW_BALANCE.language,
    // {{1}} = user name, {{2}} = balance
  },
  WELCOME_PROMO: {
    NAME: process.env.WHATSAPP_TEMPLATE_WELCOME_PROMO || templatesJson.WELCOME_PROMO.name,
    LANGUAGE: process.env.WHATSAPP_TEMPLATE_LANG || templatesJson.WELCOME_PROMO.language,
    // {{1}} = user name
  },
  REFERRAL_PROMO: {
    NAME: process.env.WHATSAPP_TEMPLATE_REFERRAL_PROMO || templatesJson.REFERRAL_PROMO.name,
    LANGUAGE: process.env.WHATSAPP_TEMPLATE_LANG || templatesJson.REFERRAL_PROMO.language,
    // {{1}} = user name, {{2}} = amount, {{3}} = link
  },
} as const;

export type TemplateKey = keyof typeof TEMPLATES;

// ============================================
// Limits
// ============================================
export const LIMITS = {
  /** Below this most Nigerian banks reject the transfer outright. */
  MIN_TRANSFER: 100,
  /** Guard against a fat-fingered amount draining an account in one go. */
  MAX_TRANSFER: 1_000_000,
} as const;

// ============================================
// Message rendering helpers
// ============================================
function render(template: string, vars: Record<string, string | number> = {}) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    return key in vars ? String(vars[key]) : `{{${key}}}`;
  });
}

// ============================================
// Messages (loaded from messages.json)
// ============================================
export const MESSAGES = {
  KYC_PROMPT: messagesJson.KYC_PROMPT,
  KYC_COMPLETE: messagesJson.KYC_COMPLETE,

  KYC_CHOOSE_ID: {
    ...messagesJson.KYC_CHOOSE_ID,
    PROMPT_NUMBER: (idType: string) => render(messagesJson.KYC_CHOOSE_ID.PROMPT_NUMBER, { idType }),
    INVALID_NUMBER: (idType: string) => render(messagesJson.KYC_CHOOSE_ID.INVALID_NUMBER, { idType }),
  },

  KYC_OTP: {
    ...messagesJson.KYC_OTP,
    RETRY: (left: number) =>
      render(messagesJson.KYC_OTP.RETRY, {
        left,
        leftPlural: left === 1 ? "attempt" : "attempts",
      }),
    FAILED: (reason: string) => render(messagesJson.KYC_OTP.FAILED, { reason }),
  },

  KYC_FLOW_WAITING: messagesJson.KYC_FLOW_WAITING,

  FALLBACK: {
    ACCOUNT_CREATED: (bank: string, account: string) =>
      render(messagesJson.FALLBACK.ACCOUNT_CREATED, { bank, account }),
    TRANSFER_COMPLETE: (amount: string, name: string, bank: string, account: string, ref: string) =>
      render(messagesJson.FALLBACK.TRANSFER_COMPLETE, { amount, name, bank, account, ref }),
  },

  MAIN_MENU: messagesJson.MAIN_MENU,

  SEND_MONEY: {
    PROMPT_AMOUNT: messagesJson.SEND_MONEY.PROMPT_AMOUNT,
    PROMPT_BANK: messagesJson.SEND_MONEY.PROMPT_BANK,
    PROMPT_ACCOUNT: messagesJson.SEND_MONEY.PROMPT_ACCOUNT,
    INVALID_AMOUNT: (min: number | string) =>
      render(messagesJson.SEND_MONEY.INVALID_AMOUNT, { min }),
    AMOUNT_TOO_LARGE: (max: string) => render(messagesJson.SEND_MONEY.AMOUNT_TOO_LARGE, { max }),
    NO_BANK_MATCH: (query: string) => render(messagesJson.SEND_MONEY.NO_BANK_MATCH, { query }),
    BANK_MATCHES: (count: number) =>
      render(messagesJson.SEND_MONEY.BANK_MATCHES, {
        count,
        plural: count === 1 ? "" : "s",
      }),
    TOO_MANY_MATCHES: (count: number) =>
      render(messagesJson.SEND_MONEY.TOO_MANY_MATCHES, { count }),
    CONFIRM: (amount: string, bank: string, account: string, name: string) =>
      render(messagesJson.SEND_MONEY.CONFIRM, { amount, bank, account, name }),
    CANCELLED: messagesJson.SEND_MONEY.CANCELLED,
    SUCCESS: (amount: string, name: string, ref: string) =>
      render(messagesJson.SEND_MONEY.SUCCESS, { amount, name, ref }),
    FAILED: (reason: string) => render(messagesJson.SEND_MONEY.FAILED, { reason }),
  },

  BUY_AIRTIME: {
    COMING_SOON: messagesJson.BUY_AIRTIME.COMING_SOON,
    PROMPT_NETWORK: messagesJson.BUY_AIRTIME.PROMPT_NETWORK,
    PROMPT_PHONE: messagesJson.BUY_AIRTIME.PROMPT_PHONE,
    PROMPT_AMOUNT: messagesJson.BUY_AIRTIME.PROMPT_AMOUNT,
    SUCCESS: (amount: string, phone: string) =>
      render(messagesJson.BUY_AIRTIME.SUCCESS, { amount, phone }),
  },

  CHECK_BALANCE: {
    TEXT: (bank: string, account: string, balance: string) =>
      render(messagesJson.CHECK_BALANCE.TEXT, { bank, account, balance }),
    NO_BALANCE: (bank: string, account: string) =>
      render(messagesJson.CHECK_BALANCE.NO_BALANCE, { bank, account }),
    ERROR: messagesJson.CHECK_BALANCE.ERROR,
  },

  TRANSACTIONS: messagesJson.TRANSACTIONS,

  HELP: messagesJson.HELP,

  CANCEL: messagesJson.CANCEL,

  ERROR: messagesJson.ERROR,

  BANKS: messagesJson.BANKS,

  NETWORKS: messagesJson.NETWORKS,

  FLOW: {
    ACCOUNT_CREATED: (bank: string, account: string, accountName: string, dryRun = false) =>
      render(
        dryRun ? messagesJson.FLOW.ACCOUNT_CREATED_DRY_RUN : messagesJson.FLOW.ACCOUNT_CREATED,
        { bank, account, accountName }
      ),
  },
} as const;
