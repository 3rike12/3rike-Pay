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
import { TRIGGERS, MESSAGES, FLOWS, TEMPLATES } from "@/config/constants";

type FlowData = Record<string, unknown>;

// ============================================
// Build bank list rows (live from AutoRamp)
// ============================================

async function buildBankRows(): Promise<
  Array<{ title: string; rows: Array<{ id: string; title: string; description?: string }> }>
> {
  const banks = await autoramp.listBanks();

  if (banks.length > 0) {
    // Format live banks from AutoRamp
    const formatted = banks.map((b: any) => ({
      id: `bank_${b.code || b.bankCode}`,
      title: b.name || b.bankName || b.code,
      description: b.code || b.bankCode,
    }));

    // Split into popular (first 8) and rest
    const popular = formatted.slice(0, 8);
    const rest = formatted.slice(8);

    const sections = [
      { title: "Popular Banks", rows: popular },
    ];
    if (rest.length > 0) {
      sections.push({ title: "Other Banks", rows: rest });
    }
    return sections;
  }

  // Fallback to hardcoded list
  return [
    {
      title: "Popular Banks",
      rows: MESSAGES.BANKS.FALLBACK.slice(0, 8).map((b) => ({
        id: b.id,
        title: b.title,
        description: b.code,
      })),
    },
    {
      title: "Other Banks",
      rows: MESSAGES.BANKS.FALLBACK.slice(8).map((b) => ({
        id: b.id,
        title: b.title,
        description: b.code,
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
  switch (state) {
    case "idle":
      return handleIdle(phone, user, action, messageText);
    case "register_bvn":
      return handleRegisterBVN(phone, user, messageText);
    case "register_email":
      return handleRegisterEmail(phone, user, messageText);
    case "confirm_register":
      return handleConfirmRegister(phone, user, action);
    case "send_money":
      return handleSendMoney(phone, user, flowData, messageText, action);
    case "select_bank":
      return handleSelectBank(phone, user, flowData, action, messageText);
    case "enter_account":
      return handleEnterAccount(phone, user, flowData, messageText);
    case "confirm_transfer":
      return handleConfirmTransfer(phone, user, flowData, action);
    case "buy_airtime_network":
      return handleBuyAirtimeNetwork(phone, user, flowData, action);
    case "buy_airtime_amount":
      return handleBuyAirtimeAmount(phone, user, flowData, messageText);
    case "buy_airtime_confirm":
      return handleBuyAirtimeConfirm(phone, user, flowData, action);
    case "kyc_verify":
      return handleKycVerify(phone, user, messageText);
    case "kyc_otp":
      return handleKycOtp(phone, user, flowData, messageText);
    default:
      await resetSession(user.id);
      return sendMainMenu(phone);
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

  if (action === "buy_airtime" || action === "buy_data") {
    await updateSession(user.id, "buy_airtime_network", {});
    return whatsapp.sendListMessage(
      phone,
      MESSAGES.BUY_AIRTIME.PROMPT_NETWORK,
      "Choose Network",
      [{ title: "Networks", rows: [...MESSAGES.NETWORKS] }]
    );
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
    await updateSession(user.id, "buy_airtime_network", {});
    return whatsapp.sendListMessage(
      phone,
      MESSAGES.BUY_AIRTIME.PROMPT_NETWORK,
      "Choose Network",
      [{ title: "Networks", rows: [...MESSAGES.NETWORKS] }]
    );
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
  if (action === "confirm_yes") {
    const session = await getSession(user.id);
    const flowData = (session.flowData as FlowData) || {};
    try {
      const subAccount = await autoramp.createSubAccount({
        phoneNumber: phone,
        emailAddress: flowData.email as string,
        externalReference: generateReference("reg"),
        identityType: "BVN",
        identityNumber: flowData.bvn as string,
      });

      const updatedUser = await prisma.user.update({
        where: { id: user.id },
        data: {
          bvn: flowData.bvn as string,
          email: flowData.email as string,
          autorampSubId: subAccount?.id || subAccount?.accountId,
          kycStatus: "verified",
          bankAccount: subAccount?.accountNumber || subAccount?.bankAccount,
          bankCode: subAccount?.bankCode,
          bankName: subAccount?.bankName || subAccount?.provider,
        },
      });

      // Send bank details
      const bankName = updatedUser.bankName || "Safe Haven MFB";
      const accountNumber = updatedUser.bankAccount || "Pending";
      const userName = (flowData.email as string).split("@")[0] || "there";

      await whatsapp.sendTemplate(
        phone,
        TEMPLATES.ACCOUNT_CREATED.NAME,
        [userName, bankName, accountNumber, userName],
        TEMPLATES.ACCOUNT_CREATED.LANGUAGE
      );

      await resetSession(user.id);
    } catch (error: any) {
      await resetSession(user.id);
      return whatsapp.sendTextMessage(phone, `Registration failed: ${error.message}\n\nPlease try again or contact support.`);
    }
  } else {
    await resetSession(user.id);
    return whatsapp.sendTextMessage(phone, MESSAGES.CANCEL);
  }
}

// ============================================
// Send Money flow
// ============================================

async function handleSendMoney(phone: string, user: any, flowData: FlowData, text: string, action?: string) {
  if (!flowData.amount) {
    const amount = extractAmount(text);
    if (!amount || amount < 100) {
      return whatsapp.sendTextMessage(phone, "Please enter a valid amount (minimum ₦100). Example: 5000");
    }
    // Fetch banks from AutoRamp
    const bankSections = await buildBankRows();
    await updateSession(user.id, "select_bank", { amount });
    return whatsapp.sendListMessage(phone, `Send ${formatAmount(amount)}\n\nSelect the recipient's bank:`, "Choose Bank", bankSections);
  }
  return sendMainMenu(phone);
}

async function handleSelectBank(phone: string, user: any, flowData: FlowData, action?: string, text?: string) {
  if (action?.startsWith("bank_")) {
    const bankCode = action.replace("bank_", "");
    // Resolve bank name from AutoRamp or fallback
    const bank = await autoramp.getBankByCode(bankCode);
    const bankName = bank?.name || bank?.bankName || MESSAGES.BANKS.FALLBACK.find((b) => b.code === bankCode)?.title || bankCode;

    await updateSession(user.id, "enter_account", { ...flowData, bankCode, bankName });
    return whatsapp.sendTextMessage(phone, MESSAGES.SEND_MONEY.PROMPT_ACCOUNT);
  }
  return whatsapp.sendTextMessage(phone, "Please select a bank from the list:");
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

async function handleBuyAirtimeNetwork(phone: string, user: any, flowData: FlowData, action?: string) {
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

async function handleBuyAirtimeConfirm(phone: string, user: any, flowData: FlowData, action?: string) {
  // TODO: integrate airtime purchase via AutoRamp VAS
  await resetSession(user.id);
  return whatsapp.sendTextMessage(phone, "Airtime purchase coming soon! We're integrating with AutoRamp VAS.");
}

// ============================================
// Check Balance
// ============================================

async function handleCheckBalance(phone: string, user: any) {
  try {
    const account = await autoramp.getMerchantAccount();
    if (account) {
      return whatsapp.sendTextMessage(phone, MESSAGES.CHECK_BALANCE.TEXT(account.bankName || account.bankCode, account.accountNumber, formatAmount(account.accountBalance)));
    }
    return whatsapp.sendTextMessage(phone, MESSAGES.CHECK_BALANCE.ERROR);
  } catch (error: any) {
    return whatsapp.sendTextMessage(phone, `Error: ${error.message}`);
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

    await whatsapp.sendTemplate(
      phone,
      TEMPLATES.KYC_VERIFY_LINK.NAME,
      [userName, kycUrl],
      TEMPLATES.KYC_VERIFY_LINK.LANGUAGE
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

    // Try template first, fall back to text
    const templateSent = await whatsapp.sendTemplate(
      phone,
      TEMPLATES.ACCOUNT_CREATED.NAME,
      [userName, bankName, accountNumber, userName],
      TEMPLATES.ACCOUNT_CREATED.LANGUAGE
    );

    if (!templateSent) {
      await whatsapp.sendTextMessage(
        phone,
        `✅ *Account Created!*\n\n` +
        `Hi ${userName}, your 3rike Pay sub-account is ready:\n\n` +
        `🏦 Bank: ${bankName}\n` +
        `📋 Account Number: ${accountNumber}\n` +
        `👤 Name: ${userName}\n\n` +
        `You can now send money, buy airtime, and more.\nType *start* to begin.`
      );
    }

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

// Helper: lowercase includes
function lower(s: string): string {
  return s.toLowerCase().trim();
}
