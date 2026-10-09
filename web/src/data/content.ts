/**
 * Page content.
 *
 * Every factual claim here is traceable to the backend. `source` fields are
 * kept as maintenance provenance — if the code moves, the copy is wrong — and
 * are not rendered.
 */

/* --- Banks. From messages.json BANKS.FALLBACK, display-tidied. The live list
       comes from AutoRamp (~360 NIP institutions); these are the names people
       recognise. ---------------------------------------------------------- */
export const BANKS = [
  "GTBank", "Access Bank", "Zenith Bank", "First Bank", "UBA", "Opay",
  "PalmPay", "Kuda", "Moniepoint", "Fidelity Bank", "Union Bank", "Sterling Bank",
  "Wema Bank", "Ecobank", "Stanbic IBTC", "Polaris Bank", "Providus Bank",
  "Keystone Bank", "Heritage Bank", "Unity Bank", "Safe Haven MFB", "Diamond Bank",
] as const;

/* --- The three beats of a transfer. Each shows real message text, and each
       `note` is the one-line claim the panel beside it is evidence for. ---- */
export const BEATS = [
  {
    label: "Talk",
    title: "Say it how you'd say it",
    body: "No amount field, no bank dropdown. One sentence is the whole form.",
    note: "One line, any Nigerian bank",
    lines: [
      { from: "user" as const, text: "Hi", at: "9:40" },
      { from: "bot" as const, text: "What would you like to do?", at: "9:40" },
      { from: "user" as const, text: "Send 5k to 1234567890 GTBank", at: "9:41" },
    ],
  },
  {
    label: "Confirm",
    title: "See the name before you send",
    body: "3rike Pay resolves the account and shows you who you're about to pay.",
    note: "Nothing moves until you tap",
    lines: [
      {
        from: "bot" as const,
        text: "Confirm transfer:\n\nAmount: *₦5,000.00*\nRecipient: *ADAEZE OKONKWO*\nBank: GTBank",
        at: "9:41",
        buttons: ["Yes, send it", "No, cancel"],
      },
    ],
  },
  {
    label: "Done",
    title: "A receipt, not a spinner",
    body: "The money moves on the NIP rails and the reference lands in the thread.",
    note: "Every transfer gets a reference",
    lines: [
      {
        from: "bot" as const,
        text: "Transfer of ₦5,000.00 to ADAEZE OKONKWO initiated!",
        at: "9:42",
      },
      {
        from: "bot" as const,
        text: "",
        at: "9:42",
        receipt: {
          label: "Transfer complete",
          tone: "success" as const,
          rows: [
            ["Amount", "₦5,000.00"],
            ["Reference", "TRF-8C41E2"],
          ] as [string, string][],
        },
      },
    ],
  },
];

/* --- Capabilities. The tab list that drives the live thread.
       Personal, and therefore Nigeria: sending runs on NIP and the account
       issued at KYC is a Nigerian one. Invoicing lives on the business page
       because it is the Rwanda product — see BUSINESS_STEPS below. -------- */
export const CAPABILITIES = [
  {
    id: "send",
    label: "Send money",
    headline: "To any bank, by name or by number.",
    body: "Type the amount, the account and the bank in one line. Every institution on the NIP network is reachable — banks, microfinance banks and wallets like Opay, PalmPay and Moniepoint.",
    source: "src/bot/index.ts searchBanks()",
  },
  {
    id: "balance",
    label: "Check balance",
    headline: "One word, both balances.",
    body: "Your 3rike wallet and the bank account issued to you when you verified, returned together. No dashboard to open.",
    source: "src/config/messages.json CHECK_BALANCE",
  },
  {
    id: "account",
    label: "Get an account",
    headline: "A real account number, in two minutes.",
    body: "Verify with your NIN or BVN inside an encrypted WhatsApp Flow and a Nigerian bank account is issued to you in the thread.",
    source: "src/config/messages.json KYC_PROMPT, FALLBACK.ACCOUNT_CREATED",
  },
] as const;

/* --- Security. Every line verified against the file named. --------------- */
export const SECURITY = [
  {
    title: "Identity is verified before money moves",
    body: "Every account starts with an 11-digit NIN or BVN check and a one-time code sent to the phone number registered against that ID.",
    detail: "NIN / BVN + OTP",
    source: "src/config/messages.json KYC_CHOOSE_ID, KYC_OTP",
  },
  {
    title: "Your ID never travels in a chat message",
    body: "Verification happens inside an encrypted WhatsApp Flow — a sealed form, not a message in the thread anyone could scroll back to.",
    detail: "WhatsApp Flow",
    source: "src/config/messages.json KYC_PROMPT.FLOW_BUTTON",
  },
  {
    title: "Your PIN is hashed, never stored",
    body: "PINs are hashed with bcrypt before they touch the database. Nobody at 3rike can read yours back — not support, not an engineer.",
    detail: "bcrypt · cost 10",
    source: "src/utils/pin.ts",
  },
  {
    title: "Attempts are rate limited",
    body: "PIN entry and every sensitive endpoint sit behind per-device limits, so a stolen phone number cannot be brute-forced.",
    detail: "60 attempts / 15 min",
    source: "src/api/middleware/rateLimit.ts",
  },
] as const;

/* --- FAQ. ---------------------------------------------------------------- */
export const FAQS = [
  {
    q: "Do I need to download anything?",
    a: "No. 3rike Pay runs entirely inside WhatsApp. If you have WhatsApp, you already have everything you need.",
  },
  {
    q: "How do I get an account?",
    a: "Message the number and verify your identity with your NIN or BVN. It takes under two minutes, and a Nigerian bank account number is issued to you in the chat.",
  },
  {
    q: "Which banks can I send to?",
    a: "Every institution on the NIP network — the commercial banks, the microfinance banks, and wallets like Opay, PalmPay, Kuda and Moniepoint. Short names work: type gtb, zenith or opay.",
  },
  {
    q: "How much can I send?",
    a: "Between ₦100 and ₦1,000,000 per transfer.",
  },
  {
    q: "Can I buy airtime and data?",
    a: "Not yet. The integration is being finished — right now 3rike Pay handles transfers, balances and accounts.",
  },
  {
    q: "What happens if I lose my phone?",
    a: "Nothing moves without your PIN, and your PIN is hashed so it cannot be read out of our database. Contact support and we will lock the account.",
  },
  {
    q: "What does it cost?",
    a: "Transfers carry the standard processing charge from our payment partner, shown on the receipt. There is no 3rike fee on a personal transfer.",
  },
  {
    q: "Is my money held by 3rike?",
    a: "Funds sit in an account issued through our licensed payment partner, and your wallet balance is reconciled against real settlement — not an internal number we maintain by hand.",
  },
  {
    q: "Can I bill my customers with this?",
    a: "Invoicing is live for merchants in Rwanda, who collect over mobile money in RWF. It is on the business page. Sending money, on this page, runs on Nigeria's NIP network.",
  },
] as const;

/* --- Business page. ------------------------------------------------------ */
export const BUSINESS_STEPS = [
  {
    label: "Catalogue",
    title: "Add what you sell, once",
    body: "Your products live in the chat. Add an item and it is there the next time you bill someone.",
  },
  {
    label: "Invoice",
    title: "List the order in plain text",
    body: "Type the items and quantities. 3rike Pay prices them, totals them and gives the invoice a 30-minute expiry.",
  },
  {
    label: "Request",
    title: "The customer gets a prompt",
    body: "They approve the payment on their own phone. No account number to copy, no screenshot to send you.",
  },
  {
    label: "Settle",
    title: "Money lands, fees itemised",
    body: "The platform fee and the processor's charge are shown separately, with your new balance, on every paid invoice.",
  },
] as const;

export const BUSINESS_FAQS = [
  {
    q: "Where does this work?",
    a: "Rwanda. Invoices are raised and collected in RWF over mobile money, and your customer's network — MTN, Airtel or KTRN — is read from their number. Sending money to a bank account is a separate, Nigerian feature on the personal page.",
  },
  {
    q: "What does 3rike take?",
    a: "A 5% platform fee on collected invoices. It is listed on the receipt next to the payment processor's charge, so you can see exactly what reached you.",
  },
  {
    q: "How long is an invoice valid?",
    a: "30 minutes. After that it expires and you issue a new one — which keeps stale payment links from floating around.",
  },
  {
    q: "Do my customers need 3rike Pay?",
    a: "No, and they do not need WhatsApp either. The prompt arrives on their mobile money and they approve it on their own phone.",
  },
  {
    q: "Where does the money go?",
    a: "Into your 3rike wallet, reconciled against real settlement from our payment partner rather than an internally maintained figure.",
  },
  {
    q: "Can I see past invoices?",
    a: "Yes — ask for your invoices in the chat and the recent ones come back with their status.",
  },
] as const;

/* --- Testimonials. PLACEHOLDER: replace with real, attributable quotes
       before launch. ------------------------------------------------------ */
export const TESTIMONIALS = [
  {
    quote: "I stopped opening my bank app. I just type what I want to send and it's gone.",
    name: "Tunde A.",
    role: "Lagos",
  },
  {
    quote: "My customers pay before they leave the shop now. No more 'I'll send it later'.",
    name: "Blessing O.",
    role: "Runs a food business, Ibadan",
  },
  {
    quote: "The part that got me is seeing the account name before I send. That alone.",
    name: "Chidi N.",
    role: "Abuja",
  },
] as const;
