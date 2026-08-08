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
// ============================================
export const TEMPLATES = {
  KYC_VERIFY_LINK: {
    NAME: "kyc_verify_link",
    LANGUAGE: "en",
    // {{1}} = user name, {{2}} = KYC link
    getUrl: (name: string, link: string) => ({ name, link }),
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
// Messages
// ============================================
export const MESSAGES = {
  WELCOME: {
    TEXT: `Welcome to *3rike Pay*!\n\nYour WhatsApp payment assistant.\nSend money to any Nigerian bank and check your balance - all from here.`,
    BUTTONS: [
      { id: "btn_kyc", title: "Get Started" },
      { id: "btn_balance", title: "Check Balance" },
      { id: "btn_help", title: "Help" },
    ],
  },

  KYC_PROMPT: {
    TEXT: `To start using 3rike Pay, we need to verify your identity.\n\nThis takes less than 2 minutes. Tap the button below to begin.`,
    FLOW_BUTTON: "Verify Identity", // opens WhatsApp Flow form
  },

  KYC_COMPLETE: {
    TEXT: `Identity verified successfully!\n\nYou can now:\n- Send money to any bank\n- Check your balance\n\nTap *Start* to begin.`,
  },

  KYC_PENDING: {
    TEXT: `Your verification is being processed.\n\nWe'll notify you once it's complete. This usually takes a few minutes.`,
  },

  // Plain-text equivalents of the WhatsApp templates, used when a template
  // send fails (unapproved, paused, or parameter mismatch) so the user is
  // never left with no reply at all.
  FALLBACK: {
    ACCOUNT_CREATED: (bank: string, account: string) =>
      `Identity verified successfully!\n\nYour account details:\nBank: ${bank}\nAccount Number: ${account}\n\nTap *Start* to begin.`,
    KYC_VERIFY_LINK: (link: string) =>
      `To complete your registration on 3rike Pay, we need to verify your identity.\n\nOpen this link to finish your KYC:\n${link}\n\nThis link expires in 20 minutes.`,
    TRANSFER_COMPLETE: (amount: string, name: string, bank: string, account: string, ref: string) =>
      `Transfer Completed\n\nAmount: ${amount}\nTo: ${name}\nBank: ${bank}\nAccount: ${account}\nReference: ${ref}`,
  },

  MAIN_MENU: {
    TEXT: `What would you like to do?`,
    LIST_BUTTON: "Choose Action",
    SECTIONS: [
      // Airtime and data are deliberately absent: AutoRamp VAS isn't wired up
      // yet, so offering them would dead-end the user. Restore these rows once
      // handleBuyAirtimeConfirm actually buys something.
      {
        title: "Payments",
        rows: [
          { id: "send_money", title: "Send Money", description: "Transfer to any bank account" },
        ],
      },
      {
        title: "Account",
        rows: [
          { id: "check_balance", title: "Check Balance", description: "View your balance" },
          { id: "kyc", title: "KYC Verify", description: "Complete identity verification" },
          { id: "transactions", title: "Transactions", description: "View transaction history" },
        ],
      },
    ],
  },

  SEND_MONEY: {
    PROMPT_AMOUNT: `Enter the amount to send (e.g. 5000):`,
    // WhatsApp lists cap at 10 rows, and there are 360+ banks - so the user
    // types a name or code and picks from the matches instead of scrolling.
    PROMPT_BANK: `Type the recipient's bank name.\n\nExamples: *GTBank*, *Opay*, *Moniepoint*, *Kuda*`,
    PROMPT_ACCOUNT: `Enter the recipient's account number (10 digits):`,
    INVALID_AMOUNT: `That doesn't look like a valid amount. Enter a number of at least ₦${LIMITS.MIN_TRANSFER} (e.g. 5000).`,
    AMOUNT_TOO_LARGE: (max: string) =>
      `That amount is above the ${max} per-transfer limit. Enter a smaller amount.`,
    NO_BANK_MATCH: (query: string) =>
      `No bank matched "${query}".\n\nTry a shorter name - e.g. *zenith*, *kuda*, *opay*, *access*.`,
    BANK_MATCHES: (count: number) =>
      `Found ${count} matching bank${count === 1 ? "" : "s"}. Pick the right one:`,
    TOO_MANY_MATCHES: (count: number) =>
      `Found ${count} matching banks - showing the closest 10. If yours isn't here, type more of its name.`,
    CONFIRM: (amount: string, bank: string, account: string, name: string) =>
      `Confirm transfer:\n\nAmount: ${amount}\nBank: ${bank}\nAccount: ${account}\nName: ${name}`,
    SUCCESS: (amount: string, name: string, ref: string) =>
      `Transfer of ${amount} to ${name} initiated!\n\nReference: ${ref}\nYou'll receive a confirmation shortly.`,
    FAILED: (reason: string) =>
      `Transfer failed: ${reason}\n\nPlease try again or contact support.`,
  },

  BUY_AIRTIME: {
    COMING_SOON: `Airtime and data top-ups aren't live yet - we're finishing the integration.\n\nFor now you can send money and check your balance. Type *start* for the menu.`,
    PROMPT_NETWORK: `Select your network provider:`,
    PROMPT_PHONE: `Enter the phone number to recharge:`,
    PROMPT_AMOUNT: `Enter the airtime amount (e.g. 500):`,
    SUCCESS: (amount: string, phone: string) =>
      `Airtime of ${amount} sent to ${phone}!\n\nYou'll receive a confirmation shortly.`,
  },

  CHECK_BALANCE: {
    TEXT: (bank: string, account: string, balance: string) =>
      `*Your Balance*\n\nBank: ${bank}\nAccount: ${account}\nBalance: ${balance}`,
    NO_ACCOUNT: `You don't have a 3rike Pay account yet.\n\nType *kyc* to verify your identity and get your account number.`,
    NO_BALANCE: (bank: string, account: string) =>
      `*Your Account*\n\nBank: ${bank}\nAccount: ${account}\n\nYour balance isn't available right now. Please try again in a moment.`,
    ERROR: `Could not fetch balance. Please try again later.`,
  },

  HELP: {
    TEXT: `*3rike Pay Commands*\n\n• *start* - Open main menu\n• *help* - Show this help\n• *cancel* - Cancel current action\n\nYou can type *cancel* at any point to get out of a flow.\n\n*Features:*\n• Send money to any Nigerian bank\n• Check balance\n• KYC verification`,
  },

  CANCEL: `Session cancelled. Send *start* to begin again.`,

  ERROR: {
    GENERIC: `Something went wrong. Please try again or type *start* to restart.`,
    KYC_FAILED: `Verification failed. Please try again or contact support.`,
  },

  BANKS: {
    // Fallback list, used only when autoramp.listBanks() is unreachable.
    //
    // These are AutoRamp/NIP institution codes, NOT the legacy 3-digit CBN
    // codes (GTBank is 000013 here, not 058). A transfer built with a legacy
    // code is rejected, so keep these in sync with GET /misc/banks.
    FALLBACK: [
      { id: "bank_000014", title: "Access bank", code: "000014" },
      { id: "bank_000005", title: "Diamond bank", code: "000005" },
      { id: "bank_000010", title: "Ecobank Nigeria Plc", code: "000010" },
      { id: "bank_000016", title: "First bank", code: "000016" },
      { id: "bank_000007", title: "Fidelity bank", code: "000007" },
      { id: "bank_000013", title: "GTBank", code: "000013" },
      { id: "bank_000020", title: "Heritage bank", code: "000020" },
      { id: "bank_000002", title: "Keystone bank", code: "000002" },
      { id: "bank_000004", title: "United Bank For Africa Plc", code: "000004" },
      { id: "bank_000001", title: "Sterling bank", code: "000001" },
      { id: "bank_000018", title: "Union bank", code: "000018" },
      { id: "bank_000011", title: "Unity Bank Plc", code: "000011" },
      { id: "bank_000017", title: "Wema bank", code: "000017" },
      { id: "bank_000015", title: "Zenith bank", code: "000015" },
      { id: "bank_000012", title: "Stanbic IBTC Bank Ltd.", code: "000012" },
      { id: "bank_000008", title: "Polaris Bank", code: "000008" },
      { id: "bank_000023", title: "Providus Bank", code: "000023" },
      { id: "bank_100004", title: "OPAY", code: "100004" },
      { id: "bank_100033", title: "PALMPAY", code: "100033" },
      { id: "bank_090267", title: "Kuda Microfinance Bank", code: "090267" },
      { id: "bank_090405", title: "Moniepoint Microfinance Bank", code: "090405" },
      { id: "bank_090286", title: "SAFE HAVEN MICROFINANCE BANK", code: "090286" },
    ],
  } as const,

  NETWORKS: [
    { id: "network_mtn", title: "MTN", code: "mtn" },
    { id: "network_airtel", title: "Airtel", code: "airtel" },
    { id: "network_glo", title: "Glo", code: "glo" },
    { id: "network_9mobile", title: "9mobile", code: "9mobile" },
  ],
} as const;
