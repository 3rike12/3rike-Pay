import { whatsapp } from "@/services/whatsapp";
import { autoramp } from "@/services/autoramp";
import {
  findOrCreateUser,
  getSession,
  updateSession,
  resetSession,
  createTransaction,
  updateTransaction,
  prisma,
} from "@/services/database";
import { generateReference, formatAmount, extractAmount } from "@/utils/helpers";
import { logger } from "@/utils/logger";
import { TRIGGERS, MESSAGES, FLOWS, TEMPLATES, LIMITS } from "@/config/constants";

type FlowData = Record<string, unknown>;

// ============================================
// Build bank list rows (live from AutoRamp)
// ============================================

// WhatsApp interactive list limits - a message breaching any of these is
// rejected outright. See developers.facebook.com interactive-list-messages.
const LIST_MAX_ROWS = 10;
const LIST_MAX_TITLE = 24;
const LIST_MAX_DESCRIPTION = 72;

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max - 1) + "…";
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

  logger.info("Incoming message", { phone, state, text: messageText });

  const action = buttonReply?.id || listReply?.id;
  const lower = messageText.toLowerCase().trim();

  // ---- Global triggers ----
  if (TRIGGERS.START.includes(lower as any)) {
    await resetSession(user.id);

    // First time user (created within last 5 min) - show welcome with buttons
    const isNew = Date.now() - user.createdAt.getTime() < 5 * 60 * 1000;
    if (isNew) {
      return whatsapp.sendButtonsMessage(
        phone,
        MESSAGES.WELCOME.TEXT,
        [...MESSAGES.WELCOME.BUTTONS]
      );
    }
    return sendMainMenu(phone);
  }

  if (TRIGGERS.CANCEL.includes(lower as any)) {
    await resetSession(user.id);
    return whatsapp.sendTextMessage(phone, MESSAGES.CANCEL);
  }

  if (TRIGGERS.HELP.includes(lower as any)) {
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
      case "register_bvn":
        return await handleRegisterBVN(phone, user, messageText);
      case "register_email":
        return await handleRegisterEmail(phone, user, messageText);
      case "confirm_register":
        return await handleConfirmRegister(phone, user, action);
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
      case "kyc_verify":
        return await handleKycVerify(phone, user, messageText);
      case "kyc_otp":
        return await handleKycOtp(phone, user, flowData, messageText);
      default:
        await resetSession(user.id);
        return await sendMainMenu(phone);
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
  if (action === "btn_kyc" || action === "kyc") {
    if (user.kycStatus === "verified") {
      return whatsapp.sendTextMessage(phone, MESSAGES.KYC_COMPLETE.TEXT);
    }
    // Send KYC prompt with WhatsApp Flow button
    if (FLOWS.KYC_ONBOARDING) {
      return whatsapp.sendFlowMessage(
        phone,
        MESSAGES.KYC_PROMPT.TEXT,
        FLOWS.KYC_ONBOARDING,
        MESSAGES.KYC_PROMPT.FLOW_BUTTON
      );
    }
    // Fallback: manual BVN entry
    await updateSession(user.id, "kyc_verify", {});
    return whatsapp.sendTextMessage(phone, MESSAGES.KYC_PROMPT.TEXT + "\n\nEnter your BVN (11 digits):");
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

  if (action === "btn_help") {
    return whatsapp.sendTextMessage(phone, MESSAGES.HELP.TEXT);
  }

  if (action === "btn_menu") {
    return sendMainMenu(phone);
  }

  // Check for trigger words in free text
  if (TRIGGERS.SEND_MONEY.some((t) => (text || "").toLowerCase().includes(t))) {
    if (!user.bankAccount) {
      await updateSession(user.id, "kyc_verify", {});
      return whatsapp.sendTextMessage(phone, MESSAGES.KYC_PROMPT.TEXT + "\n\nEnter your BVN (11 digits):");
    }
    await updateSession(user.id, "send_money", {});
    return whatsapp.sendTextMessage(phone, MESSAGES.SEND_MONEY.PROMPT_AMOUNT);
  }

  if (TRIGGERS.AIRTIME.some((t) => (text || "").toLowerCase().includes(t))) {
    return whatsapp.sendTextMessage(phone, MESSAGES.BUY_AIRTIME.COMING_SOON);
  }

  if (TRIGGERS.BALANCE.some((t) => (text || "").toLowerCase().includes(t))) {
    return handleCheckBalance(phone, user);
  }

  if (TRIGGERS.KYC.some((t) => (text || "").toLowerCase().includes(t))) {
    if (user.kycStatus === "verified") {
      return whatsapp.sendTextMessage(phone, MESSAGES.KYC_COMPLETE.TEXT);
    }
    await updateSession(user.id, "kyc_verify", {});
    return whatsapp.sendTextMessage(phone, "Enter your BVN (11 digits) for verification:");
  }

  return sendMainMenu(phone);
}

// ============================================
// Registration flow
// ============================================

async function handleRegisterBVN(phone: string, user: any, text: string) {
  const bvn = text.replace(/[^0-9]/g, "");
  if (bvn.length !== 11) {
    return whatsapp.sendTextMessage(phone, "Invalid BVN. Please enter exactly 11 digits:");
  }
  await updateSession(user.id, "register_email", { bvn });
  return whatsapp.sendTextMessage(phone, "Enter your email address:");
}

async function handleRegisterEmail(phone: string, user: any, text: string) {
  const email = text.trim();
  if (!email.includes("@") || !email.includes(".")) {
    return whatsapp.sendTextMessage(phone, "Invalid email. Please enter a valid email address:");
  }
  const session = await getSession(user.id);
  const flowData = (session.flowData as FlowData) || {};
  await updateSession(user.id, "confirm_register", { ...flowData, email });

  return whatsapp.sendButtonsMessage(
    phone,
    `Confirm your registration:\n\nBVN: ${flowData.bvn}\nEmail: ${email}\nPhone: ${phone}`,
    [
      { id: "confirm_yes", title: "Confirm" },
      { id: "cancel", title: "Cancel" },
    ]
  );
}

async function handleConfirmRegister(phone: string, user: any, action?: string) {
  if (action !== "confirm_yes") {
    await resetSession(user.id);
    return whatsapp.sendTextMessage(phone, MESSAGES.CANCEL);
  }

  const session = await getSession(user.id);
  const flowData = (session.flowData as FlowData) || {};

  try {
    // Keep what the user entered, but stay unverified. The AutoRamp
    // sub-account is only created once the BVN OTP passes in handleKycOtp.
    await prisma.user.update({
      where: { id: user.id },
      data: {
        bvn: flowData.bvn as string,
        email: flowData.email as string,
        kycStatus: "pending",
      },
    });

    // BVN must be verified by OTP before an account exists
    const result = await autoramp.initiateIdentityVerification({
      type: "BVN",
      number: flowData.bvn as string,
    });

    await updateSession(user.id, "kyc_otp", {
      identityId: result.identityId,
      bvn: flowData.bvn,
    });

    const kycUrl = `${process.env.KYC_BASE_URL || "http://localhost:3000"}/kyc?ref=${result.identityId}`;
    const userName = (flowData.email as string).split("@")[0] || "there";

    await whatsapp.sendTemplateOrText(
      phone,
      TEMPLATES.KYC_VERIFY_LINK.NAME,
      [userName],
      TEMPLATES.KYC_VERIFY_LINK.LANGUAGE,
      MESSAGES.FALLBACK.KYC_VERIFY_LINK(kycUrl),
      result.identityId
    );

    return whatsapp.sendTextMessage(
      phone,
      `We've sent you a verification link. You can also enter the OTP sent to your BVN phone number below:`
    );
  } catch (error: any) {
    await resetSession(user.id);
    return whatsapp.sendTextMessage(phone, `Registration failed: ${error.message}\n\nPlease try again or contact support.`);
  }
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
  return sendMainMenu(phone);
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
  // every user who typed "balance".
  if (!user.bankAccount) {
    return whatsapp.sendTextMessage(phone, MESSAGES.CHECK_BALANCE.NO_ACCOUNT);
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

// ============================================
// KYC Verification
// ============================================

async function handleKycVerify(phone: string, user: any, text: string) {
  const bvn = text.replace(/[^0-9]/g, "");
  if (bvn.length !== 11) {
    return whatsapp.sendTextMessage(phone, "Invalid BVN. Please enter exactly 11 digits:");
  }
  try {
    const result = await autoramp.initiateIdentityVerification({ type: "BVN", number: bvn });
    await updateSession(user.id, "kyc_otp", { identityId: result.identityId, bvn });

    // Send KYC link via template
    const kycUrl = `${process.env.KYC_BASE_URL || "http://localhost:3000"}/kyc?ref=${result.identityId}`;
    const userName = user.name || "there";

    // The template's body takes only the name; the link is the dynamic suffix
    // on its "Verify Now" URL button.
    await whatsapp.sendTemplateOrText(
      phone,
      TEMPLATES.KYC_VERIFY_LINK.NAME,
      [userName],
      TEMPLATES.KYC_VERIFY_LINK.LANGUAGE,
      MESSAGES.FALLBACK.KYC_VERIFY_LINK(kycUrl),
      result.identityId
    );

    return whatsapp.sendTextMessage(
      phone,
      `We've sent you a verification link. You can also enter the OTP sent to your BVN phone number below:`
    );
  } catch (error: any) {
    await resetSession(user.id);
    return whatsapp.sendTextMessage(phone, MESSAGES.ERROR.KYC_FAILED + `\n${error.message}`);
  }
}

async function handleKycOtp(phone: string, user: any, flowData: FlowData, text: string) {
  const otp = text.replace(/[^0-9]/g, "");
  if (otp.length < 4 || otp.length > 6) {
    return whatsapp.sendTextMessage(phone, "Invalid OTP. Please enter the code sent to your phone:");
  }
  try {
    // Step 1: Verify OTP
    await autoramp.validateIdentityVerification({
      identityId: flowData.identityId as string,
      type: "BVN",
      otp,
    });

    // Step 2: Create sub-account on AutoRamp
    const subAccount = await autoramp.createSubAccount({
      phoneNumber: phone,
      emailAddress: user.email || `${phone}@3rikepay.com`,
      externalReference: generateReference("kyc"),
      identityType: "BVN",
      identityNumber: flowData.bvn as string,
    });

    // Step 3: Update user in DB
    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: {
        bvn: flowData.bvn as string,
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
    await resetSession(user.id);
    return whatsapp.sendTextMessage(phone, MESSAGES.ERROR.KYC_FAILED + `\n${error.message}`);
  }
}

// ============================================
// Main menu
// ============================================

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
