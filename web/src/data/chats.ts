/**
 * Conversation scripts.
 *
 * Every line here is traceable to the bot's real copy in
 * `src/config/messages.json`, lightly trimmed for length. Nothing claims a
 * capability the backend does not have — notably airtime and data, which are
 * still behind BUY_AIRTIME.COMING_SOON and therefore never appear as a
 * working flow.
 */

export type Tick = "sent" | "delivered" | "read";

export type ChatLine = {
  from: "user" | "bot";
  text: string;
  at: string;
  /** How long the typing indicator dwells before this line lands. */
  typingMs?: number;
  /** Beat after the previous line before typing even starts. */
  gapMs?: number;
  buttons?: string[];
  flowButton?: string;
  /** Renders as a receipt/status card rather than a plain bubble. */
  receipt?: { label: string; rows: [string, string][]; tone?: "success" };
};

export type ChatScript = {
  lines: ChatLine[];
  /** Shown under the contact name while the script plays. */
  presence?: string;
};

/* ------------------------------------------------------------------------ *
 * Hero — the 12-beat sequence. Send money, end to end.
 * ------------------------------------------------------------------------ */
export const heroScript: ChatScript = {
  presence: "online",
  lines: [
    { from: "user", text: "Send 5k to 1234567890 GTBank", at: "9:41", gapMs: 300 },
    {
      from: "bot",
      text: "Confirm transfer:\n\nAmount: *₦5,000.00*\nRecipient: *ADAEZE OKONKWO*\nBank: GTBank · 1234567890",
      at: "9:41",
      typingMs: 1250,
      gapMs: 420,
      buttons: ["Yes, send it", "No, cancel"],
    },
    { from: "user", text: "Yes, send it", at: "9:41", gapMs: 900 },
    {
      from: "bot",
      text: "Transfer of ₦5,000.00 to ADAEZE OKONKWO initiated!",
      at: "9:42",
      typingMs: 900,
      gapMs: 380,
    },
    {
      from: "bot",
      text: "",
      at: "9:42",
      gapMs: 700,
      receipt: {
        label: "Transfer complete",
        tone: "success",
        rows: [
          ["Amount", "₦5,000.00"],
          ["To", "ADAEZE OKONKWO"],
          ["Reference", "TRF-8C41E2"],
        ],
      },
    },
  ],
};

/* ------------------------------------------------------------------------ *
 * Onboarding — four messages to an account.
 * ------------------------------------------------------------------------ */
export const onboardingScript: ChatScript = {
  lines: [
    { from: "user", text: "Hi", at: "09:12" },
    {
      from: "bot",
      text: "To start using 3rike Pay, we need to verify your identity.\n\nThis takes less than 2 minutes. Tap the button below to begin.",
      at: "09:12",
      typingMs: 900,
      flowButton: "Verify Identity",
    },
    {
      from: "bot",
      text: "Which ID would you like to verify with?",
      at: "09:13",
      typingMs: 700,
      gapMs: 500,
      buttons: ["NIN", "BVN"],
    },
    { from: "user", text: "NIN", at: "09:13", gapMs: 700 },
    {
      from: "bot",
      text: "We've sent a code to the phone number registered to your ID.\n\nEnter the code here to finish setting up your account.",
      at: "09:13",
      typingMs: 800,
    },
    { from: "user", text: "402913", at: "09:14", gapMs: 800 },
    {
      from: "bot",
      text: "Identity verified successfully!\n\nYour account details:\nBank: *Wema Bank*\nAccount Number: *7041558392*",
      at: "09:14",
      typingMs: 1100,
    },
  ],
};

/* ------------------------------------------------------------------------ *
 * Balance — one word, both balances.
 * ------------------------------------------------------------------------ */
export const balanceScript: ChatScript = {
  lines: [
    { from: "user", text: "balance", at: "12:04" },
    {
      from: "bot",
      text: "*Your Balance*\n\n*Wallet*\n₦12,480.00\n\n*Bank Account*\nBank: Wema Bank\nAccount: 7041558392\nBalance: ₦86,200.00",
      at: "12:04",
      typingMs: 750,
    },
  ],
};

/* ------------------------------------------------------------------------ *
 * Business — catalogue to invoice to settlement.
 * ------------------------------------------------------------------------ */
export const invoiceScript: ChatScript = {
  lines: [
    { from: "user", text: "New invoice", at: "13:20" },
    {
      from: "bot",
      text: "What is the customer buying? One item per line, like:\n\n2 x Jollof Rice 4500",
      at: "13:20",
      typingMs: 700,
    },
    {
      from: "user",
      text: "1 x Jollof Rice 4500\n1 x Chicken 3000\n1 x Drinks 1000",
      at: "13:21",
      gapMs: 900,
    },
    {
      from: "bot",
      text: "*Invoice summary*\n\n- 1 x Jollof Rice: ₦4,500.00\n- 1 x Chicken: ₦3,000.00\n- 1 x Drinks: ₦1,000.00\n\n*Total: ₦8,500.00*\nStatus: Pending\nExpires: in 30 minutes",
      at: "13:21",
      typingMs: 1000,
      buttons: ["Send to customer"],
    },
    {
      from: "bot",
      text: "I've sent the payment request to the customer. Their phone is showing a payment prompt to approve.",
      at: "13:22",
      typingMs: 800,
      gapMs: 700,
    },
  ],
};

export const settledScript: ChatScript = {
  lines: [
    {
      from: "bot",
      text: "",
      at: "13:24",
      receipt: {
        label: "Invoice paid",
        tone: "success",
        rows: [
          ["Invoice total", "₦8,500.00"],
          ["Platform fee (5%)", "−₦425.00"],
          ["Flutterwave charge", "−₦119.00"],
          ["Credited to wallet", "₦7,956.00"],
          ["New balance", "₦20,436.00"],
        ],
      },
    },
  ],
};

/**
 * The same transfer, compacted for the capabilities panel — where the surface
 * is half the hero's height and the "initiated" beat would push the opening
 * message off the top of the thread.
 */
export const sendScript: ChatScript = {
  lines: [
    heroScript.lines[0],
    heroScript.lines[1],
    heroScript.lines[2],
    heroScript.lines[4],
  ],
};

/** Catalogue through to settlement, as one continuous thread. The business
 *  page steps through this by index rather than replaying separate scripts. */
export const businessScript: ChatScript = {
  lines: [...invoiceScript.lines, ...settledScript.lines],
};

/** Which line the thread has reached at each step of the business flow. */
export const BUSINESS_CUES = [2, 4, 5, 6];

/** The same instruction, written six ways. All of them parse. */
export const transferPhrasings = [
  "Send 5k to 1234567890 GTBank",
  "send 5000 to 1234567890 gtb",
  "transfer five thousand to 1234567890 guaranty trust",
  "1234567890 opay 5k",
  "pay 5k to 1234567890 moniepoint",
  "send ₦5,000 to 1234567890 zenith",
];
