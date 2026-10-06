/**
 * Scripted conversations for the phone frames.
 *
 * Every bot line here is the real string the bot sends, copied from
 * src/config/messages.json. If you change the bot's copy, change it here too —
 * the whole point of this site is that what you see is what you get.
 *
 * `*text*` renders bold, the way WhatsApp renders it.
 */

export type ChatLine = {
  from: "user" | "bot";
  text: string;
  at: string;
  /** How long the typing indicator sits there before this bot line lands. */
  typingMs?: number;
  /** Quick-reply buttons attached under a bot bubble. */
  buttons?: string[];
  /** A WhatsApp Flow call-to-action button. */
  flowButton?: string;
};

export type ChatScript = {
  id: string;
  lines: ChatLine[];
};

/** The hero. A transfer, start to finish, in four messages. */
export const sendMoneyScript: ChatScript = {
  id: "send-money",
  lines: [
    { from: "user", text: "send 5k to 1234567890 gtbank", at: "12:04" },
    {
      from: "bot",
      at: "12:04",
      typingMs: 900,
      text: "Confirm transfer:\n\nAmount: ₦5,000\nRecipient: ADA OKOYE\nBank: GTBank\nAccount: 1234567890\n\nTap *Yes* to continue or *No* to cancel.",
      buttons: ["Yes", "No"],
    },
    { from: "user", text: "Yes", at: "12:05" },
    {
      from: "bot",
      at: "12:05",
      typingMs: 1100,
      text: "Transfer of ₦5,000 to ADA OKOYE initiated!\n\nReference: 3RK-8F2K91\nYou'll receive a confirmation shortly.",
    },
  ],
};

/** Onboarding, as it actually happens. */
export const onboardingScript: ChatScript = {
  id: "onboarding",
  lines: [
    { from: "user", text: "Hi", at: "09:12" },
    {
      from: "bot",
      at: "09:12",
      typingMs: 700,
      text: "To start using 3rike Pay, we need to verify your identity.\n\nThis takes less than 2 minutes. Tap the button below to begin.",
      flowButton: "Verify Identity",
    },
    {
      from: "bot",
      at: "09:13",
      typingMs: 800,
      text: "Which ID would you like to verify with?",
      buttons: ["NIN", "BVN"],
    },
    {
      from: "bot",
      at: "09:14",
      typingMs: 900,
      text: "Identity verified successfully!\n\nYour account details:\nBank: Safe Haven MFB\nAccount Number: 0094271583\n\nTap *Start* to begin.",
    },
  ],
};

/** Balance, for the features section. */
export const balanceScript: ChatScript = {
  id: "balance",
  lines: [
    { from: "user", text: "balance", at: "18:31" },
    {
      from: "bot",
      at: "18:31",
      typingMs: 650,
      text: "*Your Balance*\n\n*Wallet*\n₦12,480.00\n\n*Bank Account*\nBank: Safe Haven MFB\nAccount: 0094271583\nBalance: ₦48,200.00",
    },
  ],
};

/** The business page hero: an invoice going out and coming back paid. */
export const invoiceScript: ChatScript = {
  id: "invoice",
  lines: [
    { from: "user", text: "invoice 3 batteries and 2 water", at: "14:20" },
    {
      from: "bot",
      at: "14:20",
      typingMs: 850,
      text: "*Invoice summary*\n- 3 x batteries: ₦1,500\n- 2 x water: ₦600\n\n*Total: ₦2,100*\nBuyer: 0812 345 6789\nStatus: draft\nExpires: in 30 minutes\n\nTap *Yes* to send the payment request, or *No* to stop.",
      buttons: ["Yes", "No"],
    },
    { from: "user", text: "Yes", at: "14:21" },
    {
      from: "bot",
      at: "14:21",
      typingMs: 950,
      text: "I've sent the payment request to the customer. Their phone is showing a payment prompt to approve.",
    },
    {
      from: "bot",
      at: "14:23",
      typingMs: 1200,
      text: "*Paid* — ₦2,100 from 0812 345 6789\n\nNew wallet balance: ₦186,340.00",
    },
  ],
};

/** The phrasings the parser actually accepts, for the language section. */
export const transferPhrasings = [
  "send 5k to 1234567890 gtbank",
  "transfer 4k to 1234567890 opay",
  "pay five thousand naira to 1234567890 access bank",
  "send 2500 naira to 1234567890 kuda",
] as const;
