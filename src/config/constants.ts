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
// Messages
// ============================================
export const MESSAGES = {
  WELCOME: {
    TEXT: `Welcome to *3rike Pay*!\n\nYour WhatsApp payment assistant.\nSend money, buy airtime, and more - all from here.`,
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
    TEXT: `Identity verified successfully!\n\nYou can now:\n- Send money to any bank\n- Buy airtime & data\n- Check your balance\n\nTap *Start* to begin.`,
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
      {
        title: "Payments",
        rows: [
          { id: "send_money", title: "Send Money", description: "Transfer to any bank account" },
          { id: "buy_airtime", title: "Buy Airtime", description: "Recharge any network" },
          { id: "buy_data", title: "Buy Data", description: "Purchase data bundle" },
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
    PROMPT_BANK: `Select the recipient's bank:`,
    PROMPT_ACCOUNT: `Enter the recipient's account number (10 digits):`,
    CONFIRM: (amount: string, bank: string, account: string, name: string) =>
      `Confirm transfer:\n\nAmount: ${amount}\nBank: ${bank}\nAccount: ${account}\nName: ${name}`,
    SUCCESS: (amount: string, name: string, ref: string) =>
      `Transfer of ${amount} to ${name} initiated!\n\nReference: ${ref}\nYou'll receive a confirmation shortly.`,
    FAILED: (reason: string) =>
      `Transfer failed: ${reason}\n\nPlease try again or contact support.`,
  },

  BUY_AIRTIME: {
    PROMPT_NETWORK: `Select your network provider:`,
    PROMPT_PHONE: `Enter the phone number to recharge:`,
    PROMPT_AMOUNT: `Enter the airtime amount (e.g. 500):`,
    SUCCESS: (amount: string, phone: string) =>
      `Airtime of ${amount} sent to ${phone}!\n\nYou'll receive a confirmation shortly.`,
  },

  CHECK_BALANCE: {
    TEXT: (bank: string, account: string, balance: string) =>
      `*Your Balance*\n\nBank: ${bank}\nAccount: ${account}\nBalance: ${balance}`,
    ERROR: `Could not fetch balance. Please try again later.`,
  },

  HELP: {
    TEXT: `*3rike Pay Commands*\n\n• *start* - Open main menu\n• *help* - Show this help\n• *cancel* - Cancel current action\n\n*Features:*\n• Send money to any Nigerian bank\n• Buy airtime & data\n• Check balance\n• KYC verification`,
  },

  CANCEL: `Session cancelled. Send *start* to begin again.`,

  ERROR: {
    GENERIC: `Something went wrong. Please try again or type *start* to restart.`,
    KYC_FAILED: `Verification failed. Please try again or contact support.`,
  },

  BANKS: {
    // Fallback list - bot also fetches live from autoramp.listBanks()
    FALLBACK: [
      { id: "bank_044", title: "Access Bank", code: "044" },
      { id: "bank_063", title: "Diamond Bank", code: "063" },
      { id: "bank_050", title: "Ecobank", code: "050" },
      { id: "bank_011", title: "First Bank", code: "011" },
      { id: "bank_214", title: "FCMB", code: "214" },
      { id: "bank_070", title: "Fidelity Bank", code: "070" },
      { id: "bank_058", title: "GTBank", code: "058" },
      { id: "bank_030", title: "Heritage Bank", code: "030" },
      { id: "bank_082", title: "Keystone Bank", code: "082" },
      { id: "bank_014", title: "UBA", code: "014" },
      { id: "bank_232", title: "Sterling Bank", code: "232" },
      { id: "bank_032", title: "Union Bank", code: "032" },
      { id: "bank_033", title: "Unity Bank", code: "033" },
      { id: "bank_035", title: "Wema Bank", code: "035" },
      { id: "bank_057", title: "Zenith Bank", code: "057" },
      { id: "bank_090286", title: "Safe Haven MFB", code: "090286" },
    ],
  } as const,

  NETWORKS: [
    { id: "network_mtn", title: "MTN", code: "mtn" },
    { id: "network_airtel", title: "Airtel", code: "airtel" },
    { id: "network_glo", title: "Glo", code: "glo" },
    { id: "network_9mobile", title: "9mobile", code: "9mobile" },
  ],
} as const;
