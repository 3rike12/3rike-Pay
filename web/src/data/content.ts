/**
 * Site copy. Every product claim here is backed by code in this repo —
 * see docs/superpowers/specs/2026-10-06-marketing-site-design.md.
 *
 * Airtime and data are deliberately absent. messages.json still says
 * "coming soon" for them, so they are not advertised as working.
 */

/* ------------------------------------------------------------------
   Banks — the real BANKS.FALLBACK list from src/config/messages.json,
   tidied for display only. Nothing added.
   ------------------------------------------------------------------ */
export const BANKS = [
  "Access Bank",
  "GTBank",
  "Zenith Bank",
  "First Bank",
  "UBA",
  "Opay",
  "Kuda",
  "Moniepoint",
  "PalmPay",
  "Fidelity Bank",
  "Ecobank",
  "Sterling Bank",
  "Union Bank",
  "Wema Bank",
  "Stanbic IBTC",
  "Polaris Bank",
  "Providus Bank",
  "Keystone Bank",
  "Heritage Bank",
  "Unity Bank",
  "Safe Haven MFB",
  "Diamond Bank",
] as const;

/* ------------------------------------------------------------------
   How it works — a real four-step sequence, so the steps are ordered.
   The timestamps carry the order rather than 01/02/03 markers.
   ------------------------------------------------------------------ */
export const STEPS = [
  {
    at: "09:12",
    from: "user" as const,
    title: "Say hi",
    body: "Message 3rike Pay on WhatsApp. No download, no sign-up form, no app store.",
  },
  {
    at: "09:13",
    from: "bot" as const,
    title: "Verify once",
    body: "Enter your NIN or BVN inside an encrypted WhatsApp form, then the code sent to the phone registered to that ID.",
  },
  {
    at: "09:14",
    from: "bot" as const,
    title: "Set your PIN",
    body: "Four digits that authorise every transfer. It is hashed before it is stored, so nobody can read it back — not even us.",
  },
  {
    at: "09:14",
    from: "bot" as const,
    title: "Get your account number",
    body: "Your own Nigerian account number arrives in the chat. Fund it from any bank and start sending.",
  },
] as const;

/* ------------------------------------------------------------------
   Features. Sizes are deliberately uneven — this is a bento, not a
   row of identical cards.
   ------------------------------------------------------------------ */
export type Feature = {
  title: string;
  body: string;
  span: "wide" | "tall" | "normal";
  tone: "paper" | "tint" | "lime" | "ink";
};

export const FEATURES: Feature[] = [
  {
    title: "Type it the way you'd say it",
    body: "“send 5k to 1234567890 gtbank” is a complete instruction. 3rike Pay reads the amount, the account and the bank out of one line — no menus, no forms, no fields.",
    span: "wide",
    tone: "lime",
  },
  {
    title: "See the name before the money moves",
    body: "Every transfer runs a name enquiry first and shows you who actually owns that account. You confirm a person, not a number.",
    span: "normal",
    tone: "paper",
  },
  {
    title: "Your own account number",
    body: "Issued the moment you verify. Fund it from any Nigerian bank, and it is yours to receive into.",
    span: "normal",
    tone: "paper",
  },
  {
    title: "Balance and history in the thread",
    body: "Ask for your balance and it is a reply, not a login. Your recent transactions sit in the same conversation as everything else.",
    span: "normal",
    tone: "tint",
  },
  {
    title: "Nothing to install, nothing to lose",
    body: "It is WhatsApp. It works on the phone you already have, on the data you already pay for, in the app you already keep open.",
    span: "wide",
    tone: "ink",
  },
];

/* ------------------------------------------------------------------
   Security — each line maps to real code.
   ------------------------------------------------------------------ */
export const SECURITY = [
  {
    title: "Your PIN is hashed, never stored",
    body: "The four digits you set are put through bcrypt before they touch the database. There is no copy of your PIN anywhere, so there is nothing to read back.",
    source: "src/utils/pin.ts",
  },
  {
    title: "Identity forms are end-to-end encrypted",
    body: "Your NIN or BVN is typed into a WhatsApp Flow, encrypted on your handset and decrypted only by our server. It never travels as a chat message.",
    source: "src/utils/flowCrypto.ts",
  },
  {
    title: "Verified against the ID's own phone number",
    body: "After your NIN or BVN we send a code to the number registered to that ID. Someone with your details but not your line cannot finish the step.",
    source: "src/api/flow.ts",
  },
  {
    title: "PIN attempts are rate limited",
    body: "Repeated wrong PINs are throttled and then locked out for a window, so a stolen phone cannot be brute-forced through the keypad.",
    source: "src/api/middleware/rateLimit.ts",
  },
] as const;

/* ------------------------------------------------------------------
   Business.
   ------------------------------------------------------------------ */
export const BUSINESS_FEATURES = [
  {
    title: "Bill in one message",
    body: "“invoice 3 batteries and 2 water” becomes an itemised invoice with a total. Reply yes and it goes out.",
  },
  {
    title: "The prompt lands on their phone",
    body: "Your customer gets a payment prompt to approve on their handset. If their bank cannot take a push, 3rike Pay falls back to a link you can forward.",
  },
  {
    title: "Keep a catalogue",
    body: "Save what you sell with its price once. After that you bill by name and the amounts fill themselves in.",
  },
  {
    title: "Invoices expire on their own",
    body: "An unpaid request closes after thirty minutes, so your list stays honest and nobody pays against a stale price.",
  },
  {
    title: "Settlement you can read",
    body: "When money lands you get the amount, who paid, the platform fee and the processor's charge as separate lines, then your new wallet balance.",
  },
  {
    title: "No terminal, no store page",
    body: "No POS to rent, no checkout to build, no app for your customer to install. The shop is the conversation.",
  },
] as const;

/* ------------------------------------------------------------------
   FAQ
   ------------------------------------------------------------------ */
export const FAQS = [
  {
    q: "What is 3rike Pay?",
    a: "A way to move money from inside WhatsApp. You message it like you would message a person — “send 5k to 1234567890 gtbank” — and it sends to any Nigerian bank account. There is no separate app.",
  },
  {
    q: "Do I need to download anything?",
    a: "No. If you have WhatsApp you already have everything. 3rike Pay is a contact you message, so it works on the phone and the data plan you already have.",
  },
  {
    q: "How do I start?",
    a: "Say hi. 3rike Pay will ask you to verify your identity with your NIN or BVN inside an encrypted WhatsApp form, then to set a four-digit PIN. It takes under two minutes, and your own account number arrives at the end of it.",
  },
  {
    q: "Which banks can I send to?",
    a: "Any Nigerian bank account, including the ones people actually use day to day — Opay, Kuda, Moniepoint, PalmPay — alongside GTBank, Access, Zenith, First Bank, UBA and the rest.",
  },
  {
    q: "What stops someone sending money from my phone?",
    a: "Your PIN. Every transfer needs it, it is entered in an encrypted form rather than the chat, and it is hashed before storage so there is no readable copy of it. Wrong attempts are rate limited and then locked out.",
  },
  {
    q: "What if I send to the wrong account?",
    a: "3rike Pay looks the account up before anything moves and shows you the real name on it. You confirm that name, so a wrong digit shows up as a stranger's name instead of a lost transfer.",
  },
  {
    q: "Can I use it for my business?",
    a: "Yes. You can keep a product catalogue, raise an itemised invoice in one message, and have the payment prompt pushed straight to your customer's phone. When it settles you see the fees and your new balance.",
  },
  {
    q: "Can I buy airtime and data?",
    a: "Not yet. That integration is still being finished, so for now 3rike Pay does transfers, balances, invoices and your account number. We will say so in the chat the day it goes live.",
  },
] as const;

/* ------------------------------------------------------------------
   Testimonials.
   ------------------------------------------------------------------ */
export const TESTIMONIALS = [
  {
    name: "Chidinma A.",
    handle: "Lagos",
    quote:
      "I sent money while standing in a queue. No app loading, no OTP email, no logging in. I just typed it.",
  },
  {
    name: "Tunde O.",
    handle: "Ibadan",
    quote:
      "The part that got me is it showed me the account name before it sent. I had typed one digit wrong.",
  },
  {
    name: "Blessing E.",
    handle: "Port Harcourt",
    quote:
      "I run a provisions shop. I bill customers from the same chat I use to talk to them, and I can see what came in.",
  },
  {
    name: "Ifeanyi N.",
    handle: "Enugu",
    quote:
      "My phone is full. Deleting a banking app and still being able to send money is the whole reason I use this.",
  },
  {
    name: "Aisha M.",
    handle: "Abuja",
    quote: "“transfer 4k to my sister's opay” and it was done before I put the phone down.",
  },
] as const;

export const BUSINESS_FAQS = [
  {
    q: "How do I raise an invoice?",
    a: "Type what the customer is paying for — “invoice 3 batteries and 2 water”. 3rike Pay itemises it, totals it, and shows you the summary. Reply yes and the request goes out.",
  },
  {
    q: "How does my customer pay?",
    a: "A payment prompt appears on their phone for them to approve. If their provider can't take a push, 3rike Pay gives you a payment link instead, which you forward to them in the chat.",
  },
  {
    q: "Does my customer need 3rike Pay?",
    a: "No. They don't need an account, an app, or anything installed. They only need to approve the prompt or open the link you send.",
  },
  {
    q: "Can I save the things I sell?",
    a: "Yes. Add a product once with its price and it stays in your catalogue, so after that you bill by name and the amounts fill themselves in.",
  },
  {
    q: "What happens if nobody pays?",
    a: "An unpaid request expires after thirty minutes and closes itself. Your invoice list stays accurate, and nobody pays against a price you've since changed.",
  },
  {
    q: "What do you charge?",
    a: "A percentage of each collection, taken at settlement. You see it as its own line alongside the processor's charge, with your new balance underneath, so nothing is bundled out of sight.",
  },
] as const;
