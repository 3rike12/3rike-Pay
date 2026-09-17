import messagesJson from "./messages.json";

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
// WhatsApp Flow IDs (from Meta Business Manager)
// ============================================
export const FLOWS = {
  KYC_ONBOARDING: process.env.WHATSAPP_FLOW_KYC_ID || "",
  SEND_MONEY: process.env.WHATSAPP_FLOW_SEND_MONEY_ID || "",
  BUY_AIRTIME: process.env.WHATSAPP_FLOW_AIRTIME_ID || "",
} as const;

// ============================================
// WhatsApp Template Names (pre-approved in Meta Business Manager)
// Variables: {{1}} = username, {{2}} = link
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
    NAME: "onboarding_message",
    LANGUAGE: "en",
    // {{1}} = user name
  },
  KYC_OTP: {
    NAME: "kyc_otp",
    LANGUAGE: "en",
    // {{1}} = OTP code
    getOtp: (otp: string) => ({ otp }),
  },
  KYC_APPROVED: {
    NAME: "kyc_approved",
    LANGUAGE: "en",
    // {{1}} = user name
  },
  KYC_REJECTED: {
    NAME: "kyc_rejected",
    LANGUAGE: "en",
    // {{1}} = user name, {{2}} = reason
  },
  ACCOUNT_CREATED: {
    NAME: "account_created",
    LANGUAGE: "en",
    // {{1}} = user name, {{2}} = bank, {{3}} = account number, {{4}} = account name
  },
  PAYMENT_RECEIVED: {
    NAME: "payment_received",
    LANGUAGE: "en",
    // {{1}} = user name, {{2}} = amount, {{3}} = from, {{4}} = reference
  },
  TRANSFER_COMPLETE: {
    NAME: "transfer_complete",
    LANGUAGE: "en",
    VARIABLES: ["amount", "recipient_name", "recipient_bank", "recipient_account", "reference"],
  },
  TRANSFER_FAILED: {
    NAME: "transfer_failed",
    LANGUAGE: "en",
    // {{1}} = user name, {{2}} = amount, {{3}} = to, {{4}} = reason
  },
} as const;

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
    ACCOUNT_CREATED: (bank: string, account: string, dryRun = false) =>
      render(
        dryRun ? messagesJson.FLOW.ACCOUNT_CREATED_DRY_RUN : messagesJson.FLOW.ACCOUNT_CREATED,
        { bank, account }
      ),
  },
} as const;
