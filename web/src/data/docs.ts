/**
 * The user manual, as data.
 *
 * Lifted from 3rike Pay User Manual revision 1 (October 2026) rather than
 * rewritten, so the wording a reader sees here is the wording support will
 * use. Every bot message quoted below is the real string the bot sends.
 *
 * Currencies follow the product, not a house style: transfers are Nigerian
 * and quoted in NGN, payment requests are Rwandan and quoted in RWF.
 */

export type Block =
  | { k: "p"; text: string }
  | { k: "h3"; text: string }
  | { k: "ul"; items: string[] }
  | { k: "note"; title: string; text: string; tone?: "green" | "amber" | "blue" }
  | { k: "steps"; items: { title: string; text: string }[] }
  | { k: "chat"; lines: { from: "you" | "bot"; text: string }[] }
  | { k: "table"; head: [string, string] | [string, string, string]; rows: string[][] }
  | { k: "ledger"; rows: [string, string][]; total: [string, string] };

export type DocSection = {
  id: string;
  n: number;
  title: string;
  /** Sidebar label — shorter than the heading where the heading is long. */
  short: string;
  lede?: string;
  blocks: Block[];
};

export const DOC_SECTIONS: DocSection[] = [
  {
    id: "what",
    n: 1,
    title: "What 3rike Pay is",
    short: "What it is",
    lede: "A payment service you use entirely inside WhatsApp. There is no app to download and no website to log into. You message the 3rike Pay number, it replies, and you reply back — that is the whole product.",
    blocks: [
      {
        k: "table",
        head: ["As a customer", "As a business (merchant)"],
        rows: [
          ["Open a verified account", "Keep a small product catalogue"],
          ["Check your balance", "Request payment from a customer (an invoice)"],
          ["Send money to any bank account", "Track paid, unpaid and expired requests"],
          ["See your recent transactions", "See exactly what fees were taken out"],
          ["Pay a business when they request money from you", "Check your balance and history"],
        ],
      },
      {
        k: "note",
        title: "One account does both",
        text: "Anyone who can be a customer can also send payment requests. You do not sign up twice — once you are verified, type /invoice and you are a business.",
      },
      {
        k: "note",
        tone: "blue",
        title: "Where each half works",
        text: "Sending money reaches Nigerian bank accounts and is quoted in naira. Payment requests are collected from Rwandan mobile-money numbers and are quoted in Rwandan francs. Your balance is kept per currency, so both can sit in one account.",
      },
    ],
  },
  {
    id: "before",
    n: 2,
    title: "Before you begin",
    short: "Before you begin",
    blocks: [
      {
        k: "table",
        head: ["You need", "Why"],
        rows: [
          ["A WhatsApp number", "It is your account. 3rike Pay recognises you by the number you message from."],
          ["Your NIN or BVN", "Identity verification. Both are 11 digits."],
          ["A phone that can receive an SMS code", "The verification code goes to the number registered with your ID."],
          ["A 4-digit PIN you choose", "Confirms every money-out action. You choose it during setup."],
        ],
      },
      {
        k: "note",
        tone: "green",
        title: "Getting started",
        text: "Save the 3rike Pay number in your contacts and send Hi or /start. New numbers get a welcome message with a Create wallet button — tap it to begin.",
      },
    ],
  },
  {
    id: "setup",
    n: 3,
    title: "Setting up your account",
    short: "Setting up",
    blocks: [
      {
        k: "steps",
        items: [
          { title: "Tap Create wallet, or type /kyc", text: "A verification form opens inside the chat. You do not leave WhatsApp." },
          { title: "Choose your ID", text: "NIN or BVN, then the 11-digit number. Add your name and an email address when asked." },
          { title: "Enter the SMS code", text: "It is sent to the phone number registered against your ID. The code is valid for a short time; if it expires, type /kyc to start again." },
          { title: "Choose a 4-digit PIN", text: "This is what authorises your transfers later. It must be exactly 4 digits and the two entries must match." },
          { title: "You're in", text: "The bot sends your account details — a real account number other people can pay into by ordinary bank transfer." },
        ],
      },
      {
        k: "chat",
        lines: [
          { from: "bot", text: "Your 3rike Pay account is ready\n\nAccount Name: Chibuikem O.\nBank: Safehaven Microfinance Bank\nAccount Number: 0123456789" },
        ],
      },
      { k: "h3", text: "If something goes wrong during setup" },
      {
        k: "table",
        head: ["You see", "Do this"],
        rows: [
          ['"We couldn\'t verify that ID"', "Re-check the 11 digits, or try your other ID. Type /kyc to start over."],
          ['"That code doesn\'t look right"', "Use the code from the latest SMS. Type /kyc to restart if it expired."],
          ['"PINs do not match"', "Enter the same 4 numbers twice."],
          ['"Too many failed attempts"', "Wait for the lockout to lift, then type /kyc."],
          ['"Session expired. Re-enter your ID"', "The form timed out. Run it again from the top."],
        ],
      },
      {
        k: "note",
        title: "Any time you're stuck",
        text: "Type /cancel to clear whatever you are in the middle of, then /start to get back to the menu.",
      },
    ],
  },
  {
    id: "menu",
    n: 4,
    title: "The menu and commands",
    short: "Menu & commands",
    lede: "Type /start at any time to open the main menu. It is a tap-through list — but you can always type a command instead.",
    blocks: [
      {
        k: "table",
        head: ["Type this", "Result"],
        rows: [
          ["/start", "Main menu (also /menu)"],
          ["/balance", "Check balance (also /check_balance, /bal)"],
          ["/send", "Start a transfer (also /transfer)"],
          ["/transactions", "Recent history (also /history)"],
          ["/invoice", "Request payment (also /newinvoice)"],
          ["/invoices", "Your invoice list"],
          ["/product Batteries 1000", "Add a product (also /products to view)"],
          ["/business", "Business profile"],
          ["/kyc", "Verification or re-verification"],
          ["/help", "All commands"],
          ["/cancel", "Stop whatever you're doing"],
        ],
      },
      {
        k: "note",
        tone: "blue",
        title: "Spelling doesn't matter",
        text: "/check_balance, /check-balance and /balance are the same command. Dashes, underscores and capitals are all ignored.",
      },
    ],
  },
  {
    id: "balance",
    n: 5,
    title: "Checking your balance",
    short: "Your balance",
    lede: "Type /balance. The reply has two blocks, and they are two separate pots.",
    blocks: [
      {
        k: "chat",
        lines: [
          { from: "you", text: "/balance" },
          { from: "bot", text: "*Your Balance*\n\n*Wallet*\nRWF 89\n\n*Bank Account*\nBank: Safehaven Microfinance Bank\nAccount: 0123456789\nBalance: ₦12,400" },
        ],
      },
      {
        k: "table",
        head: ["Block", "What it means"],
        rows: [
          ["Wallet", "Money your business has collected — what your paid invoices landed in, kept per currency. This is the figure that moves when a customer pays you."],
          ["Bank Account", "Your real bank balance, fetched live from the bank. This is what sends money out for you."],
        ],
      },
      {
        k: "note",
        tone: "amber",
        title: "They are two separate pots",
        text: "Getting paid into your Wallet does not top up your bank balance, and a transfer always spends from the Bank Account. If a transfer says insufficient balance, the message shows you both figures so you can see which one is short.",
      },
      {
        k: "p",
        text: "If the bank side cannot be reached you will see Unavailable — the wallet figure still shows. If you have not linked an account yet, both bank lines read Not linked.",
      },
    ],
  },
  {
    id: "send",
    n: 6,
    title: "Sending money",
    short: "Sending money",
    lede: "Type /send, or tap Send Money in the menu, and answer four questions: amount, bank, account, confirm — then your PIN.",
    blocks: [
      {
        k: "chat",
        lines: [
          { from: "bot", text: "Enter the amount to send (e.g. 5000):" },
          { from: "you", text: "5000" },
          { from: "bot", text: "Type the recipient's bank name.\n\nExamples: *GTBank*, *Opay*, *Moniepoint*, *Kuda*" },
          { from: "you", text: "gtbank" },
          { from: "bot", text: "Enter the recipient's account number (10 digits):" },
          { from: "you", text: "0123456789" },
          { from: "bot", text: "Confirm transfer:\n\nAmount: ₦5,000\nRecipient: Ada Obi\nBank: GTBank\nAccount: 0123456789\n\nTap *Yes* to continue or *No* to cancel." },
          { from: "you", text: "Yes → (PIN form opens)" },
          { from: "bot", text: "Transfer of ₦5,000 to Ada Obi initiated!\n\nReference: TRF-...\nYou'll receive a confirmation shortly." },
        ],
      },
      { k: "h3", text: "The rules" },
      {
        k: "ul",
        items: [
          "Minimum per transfer is ₦100. Maximum is ₦1,000,000.",
          "Money comes out of your Bank Account, not your Wallet.",
          "Your PIN is required. Three wrong PINs lock transfers for 15 minutes.",
          "Type /cancel at the confirm screen and nothing is moved.",
        ],
      },
      { k: "h3", text: "When a transfer doesn't go through" },
      {
        k: "table",
        head: ["Message", "What it means"],
        rows: [
          ['"That doesn\'t look like a valid amount"', "Enter a number, no commas or words — e.g. 5000."],
          ['"That amount is above the 1,000,000 per-transfer limit"', "Send it in smaller chunks."],
          ['"Insufficient balance"', "Top up your bank account, or send a smaller amount. Both pots are shown."],
          ['"No bank matched …"', "Type a shorter bank name — zenith, kuda, opay."],
          ['"Found N matching banks"', "Pick the right one from the list."],
          ['"Transfer failed: …"', "Check the reason, fix it and retry. Nothing was debited for a failed transfer."],
          ['"Could not fetch balance"', "The bank didn't answer. Try again in a moment."],
        ],
      },
    ],
  },
  {
    id: "receiving",
    n: 7,
    title: "Getting money in",
    short: "Getting money in",
    blocks: [
      { k: "h3", text: "Bank transfer into your account" },
      {
        k: "p",
        text: "Share the account details from setup and anyone can pay you by ordinary bank transfer. When money lands you get a WhatsApp note.",
      },
      {
        k: "chat",
        lines: [{ from: "bot", text: "*Deposit Received*\n\nAmount: ₦10,000\nFrom: Ada Obi\nAccount: 0123456789" }],
      },
      { k: "h3", text: "Payment requests" },
      {
        k: "p",
        text: "When a customer approves an invoice you raised, the money shows up in your Wallet and you get the receipt shown in section 12.",
      },
    ],
  },
  {
    id: "catalogue",
    n: 8,
    title: "Your product catalogue",
    short: "Product catalogue",
    lede: "Optional — but if you sell the same things repeatedly, catalogue prices get filled in automatically when you build an invoice.",
    blocks: [
      {
        k: "chat",
        lines: [
          { from: "you", text: "/product Batteries 1000" },
          { from: "bot", text: "Added *Batteries* - RWF 1,000 to your catalogue.\n\n• /products - see your catalogue\n• /invoice - request payment" },
          { from: "you", text: "/products" },
          { from: "bot", text: "*Your Catalogue*\n1. Batteries - RWF 1,000\n\nType /invoice to request payment." },
        ],
      },
      {
        k: "p",
        text: "You can also add items one question at a time: type /product with no arguments and it asks for the name, then the price.",
      },
    ],
  },
  {
    id: "invoice",
    n: 9,
    title: "Requesting payment",
    short: "Requesting payment",
    lede: "The core business feature: you ask a customer to pay for something, and 3rike Pay collects it from them over Rwandan mobile money.",
    blocks: [
      { k: "h3", text: "Way 1 — everything in one line" },
      { k: "chat", lines: [{ from: "you", text: "/invoice 3 batteries for 0781234567" }] },
      { k: "h3", text: "Way 2 — guided, question by question" },
      {
        k: "chat",
        lines: [
          { from: "you", text: "/invoice" },
          { from: "bot", text: "What should the customer pay for?\n\nExample:\n*3 batteries and 2 water*\n\nInclude the customer's number if you have it:\n*3 batteries for 0781234567*" },
          { from: "you", text: "3 batteries and 2 water" },
          { from: "bot", text: "How much is *batteries*?\n\nReply with a number, e.g. *1500*." },
          { from: "you", text: "1500" },
          { from: "bot", text: "How much is *water*?" },
          { from: "you", text: "300" },
          { from: "bot", text: "What's the customer's Rwanda mobile number?\n\nExample: *0781234567* or *+250781234567*" },
          { from: "you", text: "0781234567" },
          { from: "bot", text: "*Confirm invoice*\n\n- 3 x batteries: RWF 4,500\n- 2 x water: RWF 600\n\n*Total: RWF 5,100*\nBuyer: 0781234567\n\nTap *Yes* to send the payment request, or *No* to stop." },
          { from: "you", text: "Yes" },
          { from: "bot", text: "*Payment request issued*\n\n*Invoice summary*\n- 3 x batteries: RWF 4,500\n- 2 x water: RWF 600\n\n*Total: RWF 5,100*\nBuyer: 0781234567\nStatus: pending_payment\nExpires: 5 Oct 2026, 14:32 UTC\n\nI've sent the payment request to the customer. Their phone is showing a payment prompt to approve." },
        ],
      },
      { k: "h3", text: "Way 3 — from the menu" },
      { k: "p", text: "Menu → Business → New Invoice. The same guided conversation as Way 2." },
      {
        k: "note",
        tone: "green",
        title: "Prices are looked up for you",
        text: "If an item matches something in your catalogue, the bot skips the price question entirely — that is why Way 1 can be one message end to end.",
      },
      { k: "h3", text: "Things worth knowing" },
      {
        k: "ul",
        items: [
          "You only ever pay for an invoice if the customer actually pays. Raising a request costs nothing.",
          "Requests expire after 30 minutes if nobody approves them.",
          "If the charge fails you stay on the confirm screen with a Yes / Cancel button. Yes retries the same invoice, so no duplicate is created.",
          "The bot does not message your customer for you. You get the link or the push note and pass it on.",
        ],
      },
    ],
  },
  {
    id: "customer",
    n: 10,
    title: "What your customer does",
    short: "Your customer's side",
    blocks: [
      {
        k: "table",
        head: ["What they see", "Where it appears", "Your part"],
        rows: [
          [
            "A payment prompt (most common)",
            "Pushed straight to their phone by their mobile-money network. It looks like the usual approve or decline prompt.",
            "Nothing — just tell them to watch for it and approve.",
          ],
          [
            "A payment link (fallback)",
            "Returned as a web link, under Fallback link in the invoice details.",
            "Forward the link to them yourself.",
          ],
        ],
      },
      {
        k: "p",
        text: "After the customer approves, they get the confirmation from their own network — 3rike Pay deliberately does not message them. You get the paid receipt.",
      },
      {
        k: "note",
        tone: "blue",
        title: "Keep it inside the 30 minutes",
        text: "If the request expires, just run /invoice again to raise a fresh one.",
      },
    ],
  },
  {
    id: "statuses",
    n: 11,
    title: "Invoice statuses",
    short: "Invoice statuses",
    blocks: [
      {
        k: "table",
        head: ["Status", "What it means", "What you do"],
        rows: [
          ["draft", "Being built — items and price not all confirmed.", "Answer the prompts."],
          ["sent", "Issued, and the 30-minute clock has started.", "Hand the prompt or link to your customer."],
          ["pending_payment", "Waiting for the customer to approve.", "Wait — you'll get a message either way."],
          ["paid", "Money collected and credited to your Wallet.", "Nothing — see your receipt."],
          ["expired", "The 30 minutes ran out with no payment.", "Send a new one if they still want to buy."],
          ["failed", "The payment was rejected by the provider or declined.", "Ask them to try again with a new request."],
          ["cancelled", "You stopped it.", "Start over if needed."],
        ],
      },
      { k: "p", text: "In chat the list shows these as friendly labels — for example, RWF 5,100 · Awaiting payment." },
    ],
  },
  {
    id: "paid",
    n: 12,
    title: "When you get paid",
    short: "When you get paid",
    lede: "The moment a payment settles you receive a receipt with both fees itemised and your new balance.",
    blocks: [
      {
        k: "chat",
        lines: [
          { from: "bot", text: "*Payment Received*\n\n- 1 x water: RWF 100\n\n*Total: RWF 100*\nBuyer: 0781234567\n\n*Fees*\n- Platform fee: RWF 5\n- Flutterwave fee: RWF 6\n\n*New balance: RWF 89*" },
        ],
      },
      {
        k: "table",
        head: ["Line", "Meaning"],
        rows: [
          ["Platform fee", "3rike Pay's cut — 5% of the amount by default. A RWF 100 payment leaves you with RWF 95."],
          ["Flutterwave fee", "What the payment provider charges to collect mobile money. Their fee includes tax. On that same RWF 100 payment it was RWF 5.92."],
        ],
      },
      {
        k: "ledger",
        rows: [
          ["Customer pays", "RWF 100.00"],
          ["less platform fee", "RWF 5.00"],
          ["less Flutterwave fee", "RWF 5.92"],
        ],
        total: ["You keep", "RWF 89.08"],
      },
      {
        k: "p",
        text: "Amounts in chat messages are rounded to whole units; the figures above are the exact ones behind them.",
      },
      {
        k: "note",
        title: "Only lines that actually applied appear",
        text: "If a fee could not be confirmed, it is not printed — you will never be shown a charge that was not made. If no fees applied at all, the Fees block is left out entirely. The New balance line is your Wallet after everything above, so it always matches what /balance will tell you.",
      },
    ],
  },
  {
    id: "invoice-list",
    n: 13,
    title: "Your invoice list",
    short: "Your invoice list",
    blocks: [
      {
        k: "chat",
        lines: [
          { from: "you", text: "/invoices" },
          { from: "bot", text: "*Your invoices*\nShowing 1-5 of 23\n\nTap a row to see the full invoice.\n\n  RWF 5,100 · Paid\n    3 x batteries, 2 x water · 0781234567\n  RWF 900 · Awaiting payment\n    2 x water · 07887654321\n  …\n  Next page — Older invoices" },
        ],
      },
      {
        k: "ul",
        items: [
          "Tap any row for that invoice's full detail — items, total, buyer, status, expiry and, if there is one, the fallback link to forward.",
          "Use Next page to reach older requests.",
          "If you have none yet: \"You have no invoices yet. Type /invoice to request payment from a customer.\"",
        ],
      },
    ],
  },
  {
    id: "history",
    n: 14,
    title: "Transaction history",
    short: "Transaction history",
    blocks: [
      {
        k: "chat",
        lines: [
          { from: "you", text: "/transactions" },
          { from: "bot", text: "*Your Transactions*\n\n1. ₦5,000 - Transfer to Ada Obi\n   Status: COMPLETED\n   Ref: TRF-...\n   Date: 10/4/2026\n\n2. ₦2,300 - Transfer to Kelechi Umeh\n   Status: COMPLETED\n   Ref: TRF-...\n   Date: 10/2/2026" },
        ],
      },
      {
        k: "p",
        text: "The 10 most recent transactions, newest first. Each shows the amount, what it was for, status, reference and date. Payment requests appear here too, alongside your transfers.",
      },
    ],
  },
  {
    id: "profile",
    n: 15,
    title: "Your business profile",
    short: "Business profile",
    blocks: [
      {
        k: "p",
        text: "Type /business, or tap Business Profile in the menu, to open a short form for your shop details. These are the details that identify your shop on payment requests.",
      },
      {
        k: "chat",
        lines: [{ from: "bot", text: "Your business profile is saved.\n\n[the details you entered]\n\nType /invoice to request payment." }],
      },
      { k: "p", text: "If business setup is not open for your account yet, the bot says it will message you when it is." },
    ],
  },
  {
    id: "help",
    n: 16,
    title: "Everyday questions and fixes",
    short: "Questions & fixes",
    blocks: [
      {
        k: "table",
        head: ["Question or message", "Answer"],
        rows: [
          ['"I didn\'t catch that."', "The bot didn't understand your text. It suggests the four most useful commands."],
          ['"Session cancelled. Send /start to begin again."', "You typed /cancel, or the flow was reset. Send /start."],
          ['"Something went wrong. Please try again…"', "An unexpected error. Your progress in that step is cleared on purpose so you are never stuck — just start the step again."],
          ['"Your verification form is still open"', "You are mid-verification but typed in the chat. Finish in the form, or type /cancel and redo it with /kyc."],
          ['"Could not start the payment: …"', "The provider refused the charge. Your invoice is saved — reply yes to retry or cancel to stop."],
          ['"…hasn\'t enabled mobile money payments for this account yet"', "A provider-side setting on our account, not something you can fix. Try again shortly or contact support."],
          ["My customer says nothing arrived", "Check the invoice detail for a fallback link and forward it. Ask them to look for a mobile-money approval prompt as well."],
          ["My invoice expired", "Requests last 30 minutes. Raise a new one with /invoice."],
          ["Can I get the same invoice back later?", "Yes — /invoices, tap it, and the detail shows everything including the link."],
          ["My balance shows Unavailable", "The bank didn't respond in time. Try again in a moment; the Wallet figure still tells you what you've collected."],
          ["Will I be told the fee before I send?", "The receipt after payment shows both fees and your new balance. Raising a request is free."],
          ["Does the customer get messages from 3rike Pay?", "No. Only their own network's payment prompt and confirmation. Anything else is forwarded by you."],
        ],
      },
    ],
  },
  {
    id: "safety",
    n: 17,
    title: "Staying safe",
    short: "Staying safe",
    blocks: [
      {
        k: "note",
        tone: "amber",
        title: "Nobody from 3rike Pay will ever ask for your PIN",
        text: "That goes for your verification code too. If someone asks, it is not us — hang up and message the official number.",
      },
      {
        k: "ul",
        items: [
          "Three wrong PINs lock transfers for 15 minutes. That is deliberate protection, not a bug.",
          "Check the confirm screen. Amount, recipient name, bank and account are all shown before anything moves; /cancel or No stops it cold.",
          "Stop promotional messages by replying STOP. Marketing messages stop while support messages continue.",
          "Verification codes expire, and the bot only ever asks for one inside the verification form.",
          "Your account is your number. Don't forward your WhatsApp verification codes to anyone — that would hand them your account.",
        ],
      },
    ],
  },
  {
    id: "reference",
    n: 18,
    title: "Quick reference",
    short: "Quick reference",
    blocks: [
      { k: "h3", text: "Message glossary" },
      {
        k: "table",
        head: ["Message", "Means"],
        rows: [
          ["Your 3rike Pay account is ready", "Verification finished — your bank details are inside."],
          ["Deposit Received", "Money arrived in your bank account."],
          ["Payment request issued", "Your invoice was sent — hand the prompt or link to your customer."],
          ["Payment Received", "A customer paid you; fees and new balance are listed."],
          ["Confirm invoice", "Review the totals, then tap Yes to send it."],
          ["Confirm transfer", "Review the recipient, then tap Yes and enter your PIN."],
          ["Insufficient balance", "Your bank balance is short — the Wallet figure is shown for reference."],
          ["Transfer of … initiated!", "Handed to the bank; a confirmation follows."],
          ["Could not start the payment", "Charge refused — reply yes to retry."],
          ["I didn't catch that.", "Unreadable input — try one of the suggested commands."],
        ],
      },
      {
        k: "note",
        title: "Limits at a glance",
        text: "Transfers ₦100 – ₦1,000,000 per transaction · payment requests expire after 30 minutes · platform fee 5% by default · every figure is shown in its own currency.",
      },
    ],
  },
];
