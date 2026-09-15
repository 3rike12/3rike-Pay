import { whatsapp } from "@/services/whatsapp";
import { autoramp } from "@/services/autoramp";
import {
  findOrCreateUser,
  getSession,
  updateSession,
  resetSession,
  createTransaction,
  updateTransaction,
  logWebhookEvent,
  prisma,
} from "@/services/database";
import { generateReference, formatAmount, extractAmount, redactSensitiveText } from "@/utils/helpers";
import { createLogger } from "@/utils/logger";
import { TRIGGERS, MESSAGES, FLOWS, TEMPLATES, LIMITS } from "@/config/constants";

const logger = createLogger("bot");

type FlowData = Record<string, unknown>;

// ============================================
// Build bank list rows (live from AutoRamp)
// ============================================

// WhatsApp interactive list limits - a message breaching any of these is
// rejected outright. See developers.facebook.com interactive-list-messages.
const LIST_MAX_ROWS = 10;
const LIST_MAX_TITLE = 24;
const LIST_MAX_DESCRIPTION = 72;

/** Wrong codes happen; a typo shouldn't force the user to re-enter their BVN. */
const KYC_OTP_MAX_ATTEMPTS = 3;

/**
 * States where the user's message body is a secret (BVN, one-time code).
 *
 * Logs get shipped, tailed and pasted into tickets, so these must never be
 * written out verbatim - a BVN is the single most sensitive identifier a
 * Nigerian user has.
 */
const SENSITIVE_STATES = new Set(["kyc_verify", "kyc_otp", "kyc_flow"]);

function redactForLog(state: string, text: string): string {
  if (SENSITIVE_STATES.has(state)) return `[redacted ${text.trim().length} chars]`;
  // Catch a BVN typed outside those states too.
  return redactSensitiveText(text);
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max - 1) + "…";
}

/** "Chibuikem", or "there" when we don't know their name. Never blank. */
function displayNameOf(user: any, fallback = "there"): string {
  return (user.name || fallback).trim() || "there";
}

/** Typed trigger-list check (TRIGGERS entries are readonly tuples). */
function matchesTrigger(list: readonly string[], value: string): boolean {
  return list.includes(value);
}

/**
 * Find banks matching what the user typed.
 *
 * AutoRamp returns ~360 banks, far past the 10-row list cap, so the whole set
 * can never be shown at once - the user searches instead. Exact and
 * starts-with matches rank above substring ones so "gtb" surfaces GTBank
 * rather than an unrelated bank that merely contains the letters.
 */
async function searchBanks(
  query: string
): Promise<Array<{ code: string; name: string }>> {
  const banks = await autoramp.listBanks();
  const source = banks.length
    ? banks.map((b: any) => ({
        code: String(b.code || b.bankCode || ""),
        name: String(b.name || b.bankName || b.code || ""),
      }))
    : MESSAGES.BANKS.FALLBACK.map((b) => ({ code: b.code, name: b.title }));

  const q = query.trim().toLowerCase();
  if (!q) return [];

  // AutoRamp codes are 6-digit NIP institution codes (GTBank = 000013), not
  // the legacy 3-digit CBN ones. Pad so someone dropping leading zeros still
  // matches; a legacy code simply won't hit and falls through to name search.
  if (/^\d{1,6}$/.test(q)) {
    const padded = q.padStart(6, "0");
    const byCode = source.filter((b) => b.code === q || b.code === padded);
    if (byCode.length) return byCode;
  }

  return source
    .map((b) => {
      const name = b.name.toLowerCase();
      let rank = -1;
      if (name === q) rank = 0;
      else if (name.startsWith(q)) rank = 1;
      else if (name.includes(q)) rank = 2;
      return { ...b, rank };
    })
    .filter((b) => b.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))
    .map(({ code, name }) => ({ code, name }));
}

function bankResultsToSections(banks: Array<{ code: string; name: string }>) {
  return [
    {
      title: "Matching Banks",
      rows: banks.slice(0, LIST_MAX_ROWS).map((b) => ({
        id: `bank_${b.code}`,
        title: truncate(b.name, LIST_MAX_TITLE),
        description: truncate(b.name.length > LIST_MAX_TITLE ? b.name : `Code ${b.code}`, LIST_MAX_DESCRIPTION),
      })),
    },
  ];
}

// ============================================
// Main conversation handler
// ============================================

export async function handleMessage(
  phone: string,
  name: string,
  messageText: string,
  buttonReply?: { id: string; title: string },
  listReply?: { id: string; title: string; description: string }
) {
  const user = await findOrCreateUser(phone, name);
  const session = await getSession(user.id);
  const state = session.state;
  const flowData = (session.flowData as FlowData) || {};

  logger.info("Incoming message", { phone, state, text: redactForLog(state, messageText) });

  const action = buttonReply?.id || listReply?.id;
  const lower = messageText.toLowerCase().trim();
  const actionLower = (action || "").toLowerCase();
  const buttonTitleLower = (buttonReply?.title || "").toLowerCase();

  // ---- Marketing opt-out (required: welcome_create_wallet is Marketing) ----
  // STOP / UNSUBSCRIBE must immediately stop promos. Logged so
  // notifyWelcomeCreateWallet refuses future sends to this number.
  if (["stop", "unsubscribe", "opt out", "opt-out", "stop promotions"].includes(lower)) {
    await logWebhookEvent(
      "notification",
      "marketing_opt_out",
      { phone, text: lower },
      phone
    ).catch(() => {});
    await resetSession(user.id).catch(() => {});
    return whatsapp.sendTextMessage(
      phone,
      "You've been opted out of 3rike Pay promotions. You won't receive marketing messages again. If you still need help, reply Hi."
    );
  }

  // ---- "Create wallet" taps ----
  // Two different buttons share the text "Create wallet":
  // 1. Our in-chat welcome's plain button (id exactly "create_wallet"). A
  //    plain-button tap cannot open a Flow by itself, so the bot must send
  //    the Flow invite message (startKyc) - otherwise the tap does nothing.
  // 2. The approved welcome_create_wallet TEMPLATE button, now configured in
  //    WhatsApp Manager to open the Flow directly on the phone. The form is
  //    already open, so sending the Flow invite again would be a duplicate
  //    message: just park the session in kyc_flow and stay silent. The
  //    Flow endpoint (INIT / data_exchange) owns the steps from here.
  const isCreateWalletTap =
    (actionLower.includes("create") && actionLower.includes("wallet")) ||
    buttonTitleLower.includes("create wallet") ||
    lower.includes("create wallet");
  if (isCreateWalletTap) {
    logger.debug("Create wallet tap", {
      phone,
      action: action || null,
      title: buttonReply?.title || listReply?.title || null,
    });
    if (action === "create_wallet") {
      // In-chat button: bot must send the Flow invite (single message).
      return startKyc(phone, user);
    }
    if (action) {
      // Template button tap (some other payload id): Flow already opened
      // client-side. Silent ack only - no message back.
      await updateSession(user.id, "kyc_flow", {}).catch(() => {});
      return true;
    }
    // Plain typed text ("create wallet" with no button tap): nothing is open
    // on the phone, so the bot still has to send the Flow invite.
    return startKyc(phone, user);
  }

  // ---- New-user intro: first message gets the welcome ----
  // Sent via the approved onboarding_message TEMPLATE only. The button on
  // that template is configured in WhatsApp Manager to open the KYC Flow
  // directly. Tapping it opens the form with no further bot message needed.
  // Sent once per number: logged as notification/welcome_create_wallet/{phone}
  // (kept for dedup compatibility), shared with the POST /welcome endpoint
  // so a number never gets both.
  const isNewUser = Date.now() - user.createdAt.getTime() < 5 * 60 * 1000;
  if (isNewUser) {
    const alreadyWelcomed = await prisma.webhookEvent
      .findFirst({
        where: { source: "notification", eventType: "welcome_create_wallet", reference: phone },
      })
      .catch(() => null);
    if (!alreadyWelcomed) {
      await resetSession(user.id).catch(() => {});
      const displayName = displayNameOf(user, name || "there");

      // Marketing-category template: never fire it at someone who tapped STOP.
      const optedOut = await prisma.webhookEvent
        .findFirst({
          where: { source: "notification", eventType: "marketing_opt_out", reference: phone },
        })
        .catch(() => null);
      if (optedOut) {
        return whatsapp.sendTextMessage(
          phone,
          "You've been opted out of 3rike Pay promotions. You won't receive marketing messages again. If you still need help, reply Hi."
        );
      }

      const sent = await whatsapp.sendTemplate(
        phone,
        TEMPLATES.WELCOME_CREATE_WALLET.NAME,
        [displayName],
        TEMPLATES.WELCOME_CREATE_WALLET.LANGUAGE,
        undefined,
        user.id
      );

      await logWebhookEvent(
        "notification",
        "welcome_create_wallet",
        { phone, name: displayName, sent, template: TEMPLATES.WELCOME_CREATE_WALLET.NAME },
        phone
      ).catch(() => {});

      if (!sent) {
        logger.warn("Onboarding template failed, no fallback sent", { phone });
      }
      return true;
    }
  }

  // ---- Global triggers ----
  if (matchesTrigger(TRIGGERS.START, lower)) {
    await resetSession(user.id);
    // No account yet -> the "safe" info message, not the menu. The menu's
    // options (send money, balance, ...) all dead-end without an account.
    return sendMenuForUser(phone, user);
  }

  if (matchesTrigger(TRIGGERS.CANCEL, lower)) {
    await resetSession(user.id);
    return whatsapp.sendTextMessage(phone, MESSAGES.CANCEL);
  }

  if (matchesTrigger(TRIGGERS.HELP, lower)) {
    return whatsapp.sendTextMessage(phone, MESSAGES.HELP.TEXT);
  }

  // ---- State machine ----
  // Anything thrown below would otherwise be swallowed by the webhook's catch,
  // leaving the user silently stuck mid-flow with no way to tell. Reset and say
  // so instead.
  try {
    switch (state) {
      case "idle":
        return await handleIdle(phone, user, action, messageText);
      case "send_money":
        return await handleSendMoney(phone, user, flowData, messageText);
      case "select_bank":
        return await handleSelectBank(phone, user, flowData, action, messageText);
      case "enter_account":
        return await handleEnterAccount(phone, user, flowData, messageText);
      case "confirm_transfer":
        return await handleConfirmTransfer(phone, user, flowData, action);
      case "buy_airtime_network":
        return await handleBuyAirtimeNetwork(phone, user, action);
      case "buy_airtime_amount":
        return await handleBuyAirtimeAmount(phone, user, flowData, messageText);
      case "buy_airtime_confirm":
        return await handleBuyAirtimeConfirm(phone, user);
      case "kyc_choose_id":
        return await handleKycChooseId(phone, user, action, messageText);
      case "kyc_verify":
        return await handleKycVerify(phone, user, flowData, messageText);
      case "kyc_otp":
        return await handleKycOtp(phone, user, flowData, messageText);
      case "kyc_flow":
        // Form is open on the user's phone; the Flow endpoint owns the steps.
        // Nudge back to the form - never reset, never re-send the menu.
        return whatsapp.sendTextMessage(phone, MESSAGES.KYC_FLOW_WAITING.TEXT);
      default:
        await resetSession(user.id);
        return await sendMenuForUser(phone, user);
    }
  } catch (error: any) {
    logger.error("Unhandled error in conversation handler", {
      phone,
      state,
      error: error.message,
      stack: error.stack,
    });
    await resetSession(user.id).catch(() => {});
    return whatsapp.sendTextMessage(phone, MESSAGES.ERROR.GENERIC);
  }
}

// ============================================
// Idle - show main menu
// ============================================

async function handleIdle(phone: string, user: any, action?: string, text?: string) {
  const t = (text || "").toLowerCase();

  if (action === "btn_kyc" || action === "kyc") {
    return startKyc(phone, user);
  }

  if (action === "send_money") {
    if (!user.bankAccount) {
      return whatsapp.sendButtonsMessage(phone, MESSAGES.KYC_PROMPT.TEXT, [
        { id: "btn_kyc", title: "Verify Now" },
        { id: "btn_menu", title: "Main Menu" },
      ]);
    }
    await updateSession(user.id, "send_money", {});
    return whatsapp.sendTextMessage(phone, MESSAGES.SEND_MONEY.PROMPT_AMOUNT);
  }

  // Kept reachable for anyone tapping an old menu message, but it answers
  // honestly instead of walking them into a flow that can't complete.
  if (action === "buy_airtime" || action === "buy_data") {
    return whatsapp.sendTextMessage(phone, MESSAGES.BUY_AIRTIME.COMING_SOON);
  }

  if (action === "check_balance" || action === "btn_balance") {
    return handleCheckBalance(phone, user);
  }

  // The main-menu list has a Transactions row. Answer honestly instead of
  // falling through and re-sending the same menu (looks like a loop).
  if (action === "transactions") {
    return handleTransactions(phone, user);
  }

  if (action === "btn_help") {
    return whatsapp.sendTextMessage(phone, MESSAGES.HELP.TEXT);
  }

  if (action === "btn_menu") {
    return sendMenuForUser(phone, user);
  }

  // Check for trigger words in free text
  if (TRIGGERS.SEND_MONEY.some((kw) => t.includes(kw))) {
    if (!user.bankAccount) {
      return startKyc(phone, user);
    }
    await updateSession(user.id, "send_money", {});
    return whatsapp.sendTextMessage(phone, MESSAGES.SEND_MONEY.PROMPT_AMOUNT);
  }

  if (TRIGGERS.AIRTIME.some((kw) => t.includes(kw))) {
    return whatsapp.sendTextMessage(phone, MESSAGES.BUY_AIRTIME.COMING_SOON);
  }

  if (TRIGGERS.BALANCE.some((kw) => t.includes(kw))) {
    return handleCheckBalance(phone, user);
  }

  if (t.includes("transaction") || t.includes("history")) {
    return handleTransactions(phone, user);
  }

  if (TRIGGERS.KYC.some((kw) => t.includes(kw))) {
    return startKyc(phone, user);
  }

  return sendMenuForUser(phone, user);
}

// ============================================
// Send Money flow
// ============================================

async function handleSendMoney(phone: string, user: any, flowData: FlowData, text: string) {
  if (!flowData.amount) {
    const amount = extractAmount(text);
    if (!amount || amount < LIMITS.MIN_TRANSFER) {
      return whatsapp.sendTextMessage(phone, MESSAGES.SEND_MONEY.INVALID_AMOUNT);
    }
    if (amount > LIMITS.MAX_TRANSFER) {
      return whatsapp.sendTextMessage(phone, MESSAGES.SEND_MONEY.AMOUNT_TOO_LARGE(formatAmount(LIMITS.MAX_TRANSFER)));
    }
    await updateSession(user.id, "select_bank", { amount });
    return whatsapp.sendTextMessage(phone, `Send ${formatAmount(amount)}\n\n${MESSAGES.SEND_MONEY.PROMPT_BANK}`);
  }
  // Unreachable in practice (an amount always moves to select_bank), but never
  // show the full menu to someone without an account.
  return sendMenuForUser(phone, user);
}

async function handleSelectBank(phone: string, user: any, flowData: FlowData, action?: string, text?: string) {
  if (action?.startsWith("bank_")) {
    const bankCode = action.replace("bank_", "");

    // Names come from the search results we stashed when the list was sent, so
    // the untruncated name survives even if AutoRamp is unreachable right now.
    const offered = (flowData.bankChoices as Array<{ code: string; name: string }>) || [];
    const bankName =
      offered.find((b) => b.code === bankCode)?.name ||
      (await autoramp.getBankByCode(bankCode))?.name ||
      MESSAGES.BANKS.FALLBACK.find((b) => b.code === bankCode)?.title ||
      bankCode;

    await updateSession(user.id, "enter_account", {
      ...flowData,
      bankCode,
      bankName,
      bankChoices: undefined,
    });
    return whatsapp.sendTextMessage(
      phone,
      `Bank: ${bankName}\n\n${MESSAGES.SEND_MONEY.PROMPT_ACCOUNT}`
    );
  }

  // Typed text is a bank search - the full list is far past WhatsApp's 10-row cap
  const query = (text || "").trim();
  if (query.length < 2) {
    return whatsapp.sendTextMessage(phone, MESSAGES.SEND_MONEY.PROMPT_BANK);
  }

  const matches = await searchBanks(query);
  if (matches.length === 0) {
    return whatsapp.sendTextMessage(phone, MESSAGES.SEND_MONEY.NO_BANK_MATCH(query));
  }

  const shown = matches.slice(0, LIST_MAX_ROWS);
  await updateSession(user.id, "select_bank", { ...flowData, bankChoices: shown });

  const body =
    matches.length > LIST_MAX_ROWS
      ? MESSAGES.SEND_MONEY.TOO_MANY_MATCHES(matches.length)
      : MESSAGES.SEND_MONEY.BANK_MATCHES(matches.length);

  return whatsapp.sendListMessage(phone, body, "Choose Bank", bankResultsToSections(shown));
}

async function handleEnterAccount(phone: string, user: any, flowData: FlowData, text: string) {
  const accountNumber = text.replace(/[^0-9]/g, "");
  if (accountNumber.length !== 10) {
    return whatsapp.sendTextMessage(phone, "Please enter a valid 10-digit account number:");
  }

  try {
    const resolved = await autoramp.nameEnquiry(flowData.bankCode as string, accountNumber);
    const accountName = resolved.accountName || "Unknown";

    await updateSession(user.id, "confirm_transfer", { ...flowData, accountNumber, accountName });
    return whatsapp.sendButtonsMessage(
      phone,
      MESSAGES.SEND_MONEY.CONFIRM(formatAmount(flowData.amount as number), flowData.bankName as string, accountNumber, accountName),
      [
        { id: "confirm_transfer_yes", title: "Confirm" },
        { id: "cancel", title: "Cancel" },
      ]
    );
  } catch (error: any) {
    return whatsapp.sendTextMessage(phone, `Could not verify account: ${error.message}\nPlease check and try again.`);
  }
}

async function handleConfirmTransfer(phone: string, user: any, flowData: FlowData, action?: string) {
  if (action === "confirm_transfer_yes") {
    const reference = generateReference("txn");
    try {
      await createTransaction({
        userId: user.id,
        reference,
        type: "transfer",
        amount: flowData.amount as number,
        description: `Transfer to ${flowData.accountName}`,
        bankCode: flowData.bankCode as string,
        bankAccount: flowData.accountNumber as string,
        bankName: flowData.bankName as string,
        accountName: flowData.accountName as string,
      });
      await autoramp.transfer({
        beneficiaryBankCode: flowData.bankCode as string,
        beneficiaryAccountNumber: flowData.accountNumber as string,
        amount: flowData.amount as number,
        narration: `3rike Pay - ${flowData.accountName}`,
        paymentReference: reference,
      });
      await resetSession(user.id);
      return whatsapp.sendTextMessage(phone, MESSAGES.SEND_MONEY.SUCCESS(formatAmount(flowData.amount as number), flowData.accountName as string, reference));
    } catch (error: any) {
      await updateTransaction(reference, { status: "failed" });
      await resetSession(user.id);
      return whatsapp.sendTextMessage(phone, MESSAGES.SEND_MONEY.FAILED(error.message));
    }
  }
  await resetSession(user.id);
  return whatsapp.sendTextMessage(phone, MESSAGES.CANCEL);
}

// ============================================
// Buy Airtime flow
// ============================================

async function handleBuyAirtimeNetwork(phone: string, user: any, action?: string) {
  if (action?.startsWith("network_")) {
    const network = action.replace("network_", "");
    await updateSession(user.id, "buy_airtime_amount", { network });
    return whatsapp.sendTextMessage(phone, MESSAGES.BUY_AIRTIME.PROMPT_PHONE);
  }
  return whatsapp.sendTextMessage(phone, "Please select a network provider:");
}

async function handleBuyAirtimeAmount(phone: string, user: any, flowData: FlowData, text: string) {
  const phoneNum = text.replace(/[^0-9+]/g, "");
  if (phoneNum.length >= 10) {
    await updateSession(user.id, "buy_airtime_confirm", { ...flowData, phoneToRecharge: phoneNum });
    return whatsapp.sendTextMessage(phone, MESSAGES.BUY_AIRTIME.PROMPT_AMOUNT);
  }
  return whatsapp.sendTextMessage(phone, "Please enter a valid phone number:");
}

async function handleBuyAirtimeConfirm(phone: string, user: any) {
  // TODO: integrate airtime purchase via AutoRamp VAS
  await resetSession(user.id);
  return whatsapp.sendTextMessage(phone, MESSAGES.BUY_AIRTIME.COMING_SOON);
}

// ============================================
// Check Balance
// ============================================

async function handleCheckBalance(phone: string, user: any) {
  // Without an account of their own there is no balance to show. Falling back
  // to the merchant account here would leak the company's pooled balance to
  // every user who typed "balance". Same no-account prompt as the menu gate.
  if (!user.bankAccount) {
    return sendNoAccountPrompt(phone, user);
  }

  try {
    const account = await autoramp.getSubAccountByReference(user.autorampSubId || "");
    const bank = user.bankName || user.bankCode || account?.bankName || "Bank";
    const accountNumber = user.bankAccount || account?.accountNumber || "";
    const balance = account?.accountBalance ?? account?.balance;

    if (balance === undefined || balance === null) {
      return whatsapp.sendTextMessage(
        phone,
        MESSAGES.CHECK_BALANCE.NO_BALANCE(bank, accountNumber)
      );
    }

    return whatsapp.sendTextMessage(
      phone,
      MESSAGES.CHECK_BALANCE.TEXT(bank, accountNumber, formatAmount(Number(balance)))
    );
  } catch (error: any) {
    logger.error("Balance check failed", { phone, error: error.message });
    return whatsapp.sendTextMessage(phone, MESSAGES.CHECK_BALANCE.ERROR);
  }
}

async function handleTransactions(phone: string, user: any) {
  if (!user.bankAccount) {
    return sendNoAccountPrompt(phone, user);
  }

  try {
    const transactions = await prisma.transaction.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      take: 10,
    });

    if (transactions.length === 0) {
      return whatsapp.sendTextMessage(phone, MESSAGES.TRANSACTIONS.EMPTY);
    }

    const list = transactions
      .map((t, i) => {
        const amount = formatAmount(t.amount);
        const status = t.status.toUpperCase();
        const date = new Date(t.createdAt).toLocaleDateString("en-NG");
        const desc = t.description || t.type;
        return `${i + 1}. ${amount} - ${desc}\n   Status: ${status}\n   Ref: ${t.reference}\n   Date: ${date}`;
      })
      .join("\n\n");

    return whatsapp.sendTextMessage(
      phone,
      MESSAGES.TRANSACTIONS.TEXT.replace("{{list}}", list)
    );
  } catch (error: any) {
    logger.error("Transaction history failed", { phone, error: error.message });
    return whatsapp.sendTextMessage(phone, MESSAGES.TRANSACTIONS.ERROR);
  }
}

// ============================================
// KYC Verification
// ============================================

/**
 * Start identity verification.
 *
 * The Flow is the real path: the ID number is typed into WhatsApp's own
 * encrypted form and posted straight to our endpoint, so it never becomes a
 * message in the chat the way a typed reply does. Chat entry is only a
 * fallback for when the Flow can't be delivered.
 */
async function startKyc(phone: string, user: any) {
  if (user.kycStatus === "verified") {
    return whatsapp.sendTextMessage(phone, MESSAGES.KYC_COMPLETE.TEXT);
  }

  if (FLOWS.KYC_ONBOARDING) {
    const sent = await whatsapp.sendFlowMessage(
      phone,
      MESSAGES.KYC_PROMPT.TEXT,
      FLOWS.KYC_ONBOARDING,
      MESSAGES.KYC_PROMPT.FLOW_BUTTON,
      user.id,
      "IDENTITY"
    );
    if (sent) {
      // WhatsApp has no API to force-open a Flow - the CTA button on this
      // one message IS what opens the form. Park the session in kyc_flow so
      // any chat text typed while the form is open gets a gentle nudge back
      // to the form instead of a fresh main menu (which reads as the bot
      // "sending another message"). Return immediately: no second send.
      await updateSession(user.id, "kyc_flow", {}).catch(() => {});
      return true;
    }
    // Most common cause: the Flow is still in DRAFT, which Meta only delivers
    // to users with a role on the app - every real user falls through to here
    // and gets chat verification instead. Publish the Flow in WhatsApp Manager
    // and unset WHATSAPP_FLOW_DRAFT_MODE to fix it for everyone.
    logger.warn("KYC flow send failed, falling back to chat entry", {
      phone,
      draftMode: process.env.WHATSAPP_FLOW_DRAFT_MODE === "true",
    });
  }

  await updateSession(user.id, "kyc_choose_id", {});
  return whatsapp.sendButtonsMessage(phone, MESSAGES.KYC_CHOOSE_ID.TEXT, [
    ...MESSAGES.KYC_CHOOSE_ID.BUTTONS,
  ]);
}

async function handleKycChooseId(phone: string, user: any, action?: string, text?: string) {
  const choice = (action || text || "").toUpperCase();
  const idType = choice.includes("NIN") ? "NIN" : choice.includes("BVN") ? "BVN" : null;

  if (!idType) {
    return whatsapp.sendButtonsMessage(phone, MESSAGES.KYC_CHOOSE_ID.TEXT, [
      ...MESSAGES.KYC_CHOOSE_ID.BUTTONS,
    ]);
  }

  await updateSession(user.id, "kyc_verify", { idType });
  return whatsapp.sendTextMessage(phone, MESSAGES.KYC_CHOOSE_ID.PROMPT_NUMBER(idType));
}

async function handleKycVerify(phone: string, user: any, flowData: FlowData, text: string) {
  const idType = (flowData.idType as "NIN" | "BVN") || "BVN";
  const idNumber = text.replace(/[^0-9]/g, "");
  if (idNumber.length !== 11) {
    return whatsapp.sendTextMessage(phone, MESSAGES.KYC_CHOOSE_ID.INVALID_NUMBER(idType));
  }
  try {
    const result = await autoramp.initiateIdentityVerification({ type: idType, number: idNumber });
    await updateSession(user.id, "kyc_otp", { identityId: result.identityId, idType, idNumber });

    // Deliberately no web link here. Verification finishes in the chat: the
    // whole point of a WhatsApp bot is that the user never leaves WhatsApp,
    // and the kyc_verify_link template's URL is fixed to a host we don't
    // control, so its button can't be pointed at this server anyway.
    return whatsapp.sendTextMessage(phone, MESSAGES.KYC_OTP.PROMPT);
  } catch (error: any) {
    await resetSession(user.id);
    return whatsapp.sendTextMessage(phone, MESSAGES.ERROR.KYC_FAILED + `\n${error.message}`);
  }
}

async function handleKycOtp(phone: string, user: any, flowData: FlowData, text: string) {
  const otp = text.replace(/[^0-9]/g, "");
  if (otp.length < 4 || otp.length > 6) {
    return whatsapp.sendTextMessage(phone, MESSAGES.KYC_OTP.INVALID);
  }
  try {
    // Step 1: Verify OTP
    await autoramp.validateIdentityVerification({
      identityId: flowData.identityId as string,
      type: ((flowData.idType as string) || "BVN") as "BVN" | "NIN",
      otp,
    });

    // Step 2: Create sub-account on AutoRamp
    const subAccount = await autoramp.createSubAccount({
      phoneNumber: phone,
      emailAddress: user.email || `${phone}@3rikepay.com`,
      externalReference: generateReference("kyc"),
      identityType: (flowData.idType as string) || "BVN",
      identityNumber: flowData.idNumber as string,
    });

    // Step 3: Update user in DB
    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: {
        ...(flowData.idType === "NIN"
          ? { nin: flowData.idNumber as string }
          : { bvn: flowData.idNumber as string }),
        kycStatus: "verified",
        autorampSubId: subAccount?.id || subAccount?.accountId,
        bankAccount: subAccount?.accountNumber || subAccount?.bankAccount,
        bankCode: subAccount?.bankCode,
        bankName: subAccount?.bankName || subAccount?.provider,
      },
    });

    // Step 4: Send bank details to user
    const bankName = updatedUser.bankName || "Safe Haven MFB";
    const accountNumber = updatedUser.bankAccount || "Pending";
    const userName = user.name || "there";

    await whatsapp.sendTemplateOrText(
      phone,
      TEMPLATES.ACCOUNT_CREATED.NAME,
      [userName, bankName, accountNumber, userName],
      TEMPLATES.ACCOUNT_CREATED.LANGUAGE,
      MESSAGES.FALLBACK.ACCOUNT_CREATED(bankName, accountNumber)
    );

    await resetSession(user.id);
  } catch (error: any) {
    // A mistyped code shouldn't cost the user their whole session - re-entering
    // a BVN to fix one wrong digit is the kind of friction that makes people
    // give up. Keep them in the OTP state for a few tries.
    const attempts = Number(flowData.otpAttempts || 0) + 1;
    logger.warn("KYC OTP validation failed", { phone, attempts, error: error.message });

    if (attempts < KYC_OTP_MAX_ATTEMPTS) {
      await updateSession(user.id, "kyc_otp", { ...flowData, otpAttempts: attempts });
      return whatsapp.sendTextMessage(
        phone,
        MESSAGES.KYC_OTP.RETRY(KYC_OTP_MAX_ATTEMPTS - attempts)
      );
    }

    await resetSession(user.id);
    return whatsapp.sendTextMessage(phone, MESSAGES.KYC_OTP.FAILED(error.message));
  }
}

// ============================================
// Main menu (account-gated)
// ============================================

/**
 * The menu only makes sense once a bank account has been issued (KYC done).
 * Anyone without one gets the plain "you don't have an account yet" message
 * with the Create wallet button instead - every menu option would dead-end
 * for them. Once verification issues the account, this same entry point
 * starts serving them the real menu.
 */
async function sendMenuForUser(phone: string, user: any) {
  if (!user.bankAccount) {
    return sendNoAccountPrompt(phone, user);
  }
  return sendMainMenu(phone);
}

/** Personalized "you don't have an account yet" — sent as the onboarding template. */
async function sendNoAccountPrompt(phone: string, user: any) {
  const displayName = displayNameOf(user);

  const alreadySent = await prisma.webhookEvent
    .findFirst({
      where: { source: "notification", eventType: "welcome_create_wallet", reference: phone },
    })
    .catch(() => null);
  if (alreadySent) {
    logger.debug("Onboarding template already sent, skipping", { phone });
    return true;
  }

  const sent = await whatsapp.sendTemplate(
    phone,
    TEMPLATES.WELCOME_CREATE_WALLET.NAME,
    [displayName],
    TEMPLATES.WELCOME_CREATE_WALLET.LANGUAGE,
    undefined,
    user.id
  );

  await logWebhookEvent(
    "notification",
    "welcome_create_wallet",
    { phone, name: displayName, sent, template: TEMPLATES.WELCOME_CREATE_WALLET.NAME, source: "no_account_prompt" },
    phone
  ).catch(() => {});

  if (!sent) {
    logger.warn("Onboarding template failed from no-account prompt", { phone });
  }
  return true;
}

async function sendMainMenu(phone: string) {
  return whatsapp.sendListMessage(
    phone,
    MESSAGES.MAIN_MENU.TEXT,
    MESSAGES.MAIN_MENU.LIST_BUTTON,
    MESSAGES.MAIN_MENU.SECTIONS.map((s) => ({
      title: s.title,
      rows: [...s.rows],
    }))
  );
}
