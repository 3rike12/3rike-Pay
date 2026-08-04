import { whatsapp } from "./whatsapp";
import { autoramp } from "./autoramp";
import {
  findOrCreateUser,
  getSession,
  updateSession,
  resetSession,
  createTransaction,
  updateTransaction,
  prisma,
} from "./database";
import { generateReference, formatAmount, cleanPhone, extractAmount } from "../utils/helpers";
import { logger } from "../utils/logger";

type FlowData = Record<string, unknown>;

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

  // Mark incoming as read
  logger.info("Incoming message", { phone, state, text: messageText });

  // Handle button/list replies
  const action = buttonReply?.id || listReply?.id;

  // ---- Global commands ----
  if (messageText.toLowerCase() === "menu" || messageText.toLowerCase() === "start") {
    await resetSession(user.id);
    // First time - send welcome with buttons
    const isNew = Date.now() - user.createdAt.getTime() < 5 * 60 * 1000;
    if (isNew && messageText.toLowerCase() === "start") {
      return whatsapp.sendButtonsMessage(
        phone,
        `Welcome to *3rike Pay*! 👋\n\nYour WhatsApp payment assistant.\nSend money, buy airtime, and more — all from here.`,
        [
          { id: "send_money", title: "Send Money" },
          { id: "buy_airtime", title: "Buy Airtime" },
          { id: "check_balance", title: "Check Balance" },
        ]
      );
    }
    return sendMainMenu(phone);
  }

  if (messageText.toLowerCase() === "cancel") {
    await resetSession(user.id);
    return whatsapp.sendTextMessage(phone, "Session cancelled. Send *start* to begin again.");
  }

  if (messageText.toLowerCase() === "help") {
    return sendHelp(phone);
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

    case "confirm_transfer":
      return handleConfirmTransfer(phone, user, flowData, action);

    case "buy_airtime_network":
      return handleBuyAirtimeNetwork(phone, user, flowData, action);

    case "buy_airtime_amount":
      return handleBuyAirtimeAmount(phone, user, flowData, messageText);

    case "check_balance":
      return handleCheckBalance(phone, user);

    case "kyc_verify":
      return handleKycVerify(phone, user, messageText);

    default:
      await resetSession(user.id);
      return sendMainMenu(phone);
  }
}

// ============================================
// Idle - show main menu
// ============================================

async function handleIdle(
  phone: string,
  user: any,
  action?: string,
  text?: string
) {
  if (action === "send_money") {
    if (!user.bankAccount) {
      return whatsapp.sendButtonsMessage(
        phone,
        "You need to set up your bank account first. Please register with your BVN.",
        [
          { id: "register", title: "Register BVN" },
          { id: "menu", title: "Main Menu" },
        ]
      );
    }
    await updateSession(user.id, "send_money", {});
    return whatsapp.sendTextMessage(phone, "Enter the amount to send (e.g. 5000):");
  }

  if (action === "buy_airtime") {
    await updateSession(user.id, "buy_airtime_network", {});
    return whatsapp.sendListMessage(
      phone,
      "Select your network provider:",
      "Choose Network",
      [
        {
          title: "Networks",
          rows: [
            { id: "network_mtn", title: "MTN", description: "MTN Nigeria" },
            { id: "network_airtel", title: "Airtel", description: "Airtel Nigeria" },
            { id: "network_glo", title: "Glo", description: "Globacom" },
            { id: "network_9mobile", title: "9mobile", description: "9mobile (Etisalat)" },
          ],
        },
      ]
    );
  }

  if (action === "check_balance") {
    return handleCheckBalance(phone, user);
  }

  if (action === "kyc") {
    if (user.kycStatus === "verified") {
      return whatsapp.sendTextMessage(phone, "Your KYC is already verified. You're all set!");
    }
    await updateSession(user.id, "kyc_verify", {});
    return whatsapp.sendTextMessage(phone, "Enter your BVN (11 digits) for verification:");
  }

  if (action === "register") {
    await updateSession(user.id, "register_bvn", {});
    return whatsapp.sendTextMessage(phone, "Enter your BVN (11 digits) to set up your account:");
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

  await updateSession(user.id, "confirm_register", {
    ...flowData,
    email,
  });

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
      // Create AutoRamp sub-account
      const subAccount = await autoramp.createSubAccount({
        phoneNumber: phone,
        emailAddress: flowData.email as string,
        externalReference: generateReference("reg"),
        identityType: "BVN",
        identityNumber: flowData.bvn as string,
      });

      // Update user in DB
      await prisma.user.update({
        where: { id: user.id },
        data: {
          bvn: flowData.bvn as string,
          email: flowData.email as string,
          autorampSubId: subAccount?.id,
          kycStatus: "pending",
        },
      });

      await resetSession(user.id);
      return whatsapp.sendTextMessage(
        phone,
        "Registration submitted! Your account is being set up. You'll receive a confirmation once verified.\n\nType *menu* to continue."
      );
    } catch (error: any) {
      await resetSession(user.id);
      return whatsapp.sendTextMessage(
        phone,
        `Registration failed: ${error.message || "Unknown error"}\n\nPlease try again or contact support.`
      );
    }
  }

  await resetSession(user.id);
  return whatsapp.sendTextMessage(phone, "Registration cancelled. Type *start* to try again.");
}

// ============================================
// Send Money flow
// ============================================

async function handleSendMoney(
  phone: string,
  user: any,
  flowData: FlowData,
  text: string,
  action?: string
) {
  if (!flowData.amount) {
    const amount = extractAmount(text);
    if (!amount || amount < 100) {
      return whatsapp.sendTextMessage(
        phone,
        "Please enter a valid amount (minimum ₦100). Example: 5000"
      );
    }

    await updateSession(user.id, "select_bank", { amount });
    return whatsapp.sendListMessage(
      phone,
      `Send ${formatAmount(amount)}\n\nSelect the recipient's bank:`,
      "Choose Bank",
      [
        {
          title: "Popular Banks",
          rows: [
            { id: "bank_044", title: "Access Bank", description: "044" },
            { id: "bank_063", title: "Diamond Bank", description: "063" },
            { id: "bank_050", title: "Ecobank", description: "050" },
            { id: "bank_011", title: "First Bank", description: "011" },
            { id: "bank_214", title: "FCMB", description: "214" },
            { id: "bank_070", title: "Fidelity Bank", description: "070" },
            { id: "bank_058", title: "GTBank", description: "058" },
            { id: "bank_030", title: "Heritage Bank", description: "030" },
            { id: "bank_082", title: "Keystone Bank", description: "082" },
            { id: "bank_014", title: "UBA", description: "014" },
            { id: "bank_232", title: "Sterling Bank", description: "232" },
            { id: "bank_032", title: "Union Bank", description: "032" },
            { id: "bank_033", title: "Unity Bank", description: "033" },
            { id: "bank_035", title: "Wema Bank", description: "035" },
            { id: "bank_057", title: "Zenith Bank", description: "057" },
          ],
        },
        {
          title: "Other Banks",
          rows: [
            { id: "bank_090286", title: "Safe Haven MFB", description: "090286" },
            { id: "bank_090123", title: "Pulse MFB", description: "090123" },
          ],
        },
      ]
    );
  }

  return sendMainMenu(phone);
}

async function handleSelectBank(
  phone: string,
  user: any,
  flowData: FlowData,
  action?: string,
  text?: string
) {
  if (action?.startsWith("bank_")) {
    const bankCode = action.replace("bank_", "");
    const bankNames: Record<string, string> = {
      "044": "Access Bank", "063": "Diamond Bank", "050": "Ecobank",
      "011": "First Bank", "214": "FCMB", "070": "Fidelity Bank",
      "058": "GTBank", "030": "Heritage Bank", "082": "Keystone Bank",
      "014": "UBA", "232": "Sterling Bank", "032": "Union Bank",
      "033": "Unity Bank", "035": "Wema Bank", "057": "Zenith Bank",
      "090286": "Safe Haven MFB", "090123": "Pulse MFB",
    };

    await updateSession(user.id, "enter_account", {
      ...flowData,
      bankCode,
      bankName: bankNames[bankCode] || bankCode,
    });

    return whatsapp.sendTextMessage(
      phone,
      `Enter the recipient's account number (10 digits):`
    );
  }

  // User typed a phone number or account number
  if (text && text.replace(/[^0-9]/g, "").length === 10) {
    const accountNumber = text.replace(/[^0-9]/g, "");
    const session = await getSession(user.id);
    const fd = (session.flowData as FlowData) || {};

    try {
      // Resolve account name
      const resolved = await autoramp.nameEnquiry(fd.bankCode as string, accountNumber);
      const accountName = resolved.accountName || "Unknown";

      await updateSession(user.id, "confirm_transfer", {
        ...fd,
        accountNumber,
        accountName,
      });

      return whatsapp.sendButtonsMessage(
        phone,
        `Confirm transfer:\n\nAmount: ${formatAmount(fd.amount as number)}\nBank: ${fd.bankName}\nAccount: ${accountNumber}\nName: ${accountName}`,
        [
          { id: "confirm_transfer_yes", title: "Confirm" },
          { id: "cancel", title: "Cancel" },
        ]
      );
    } catch (error: any) {
      return whatsapp.sendTextMessage(
        phone,
        `Could not verify account: ${error.message}\nPlease check and try again.`
      );
    }
  }

  return whatsapp.sendTextMessage(phone, "Please enter a valid 10-digit account number:");
}

async function handleConfirmTransfer(phone: string, user: any, flowData: FlowData, action?: string) {
  if (action === "confirm_transfer_yes") {
    const reference = generateReference("txn");

    try {
      // Create pending transaction in DB
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

      // Initiate transfer via AutoRamp
      await autoramp.transfer({
        beneficiaryBankCode: flowData.bankCode as string,
        beneficiaryAccountNumber: flowData.accountNumber as string,
        amount: flowData.amount as number,
        narration: `3rike Pay - ${flowData.accountName}`,
        paymentReference: reference,
      });

      await resetSession(user.id);
      return whatsapp.sendTextMessage(
        phone,
        `Transfer of ${formatAmount(flowData.amount as number)} to ${flowData.accountName} (${flowData.bankName}) has been initiated.\n\nReference: ${reference}\n\nYou'll receive a notification when it's completed.`
      );
    } catch (error: any) {
      await updateTransaction(reference, { status: "failed" });
      await resetSession(user.id);
      return whatsapp.sendTextMessage(
        phone,
        `Transfer failed: ${error.message}\nPlease try again later.`
      );
    }
  }

  await resetSession(user.id);
  return whatsapp.sendTextMessage(phone, "Transfer cancelled. Type *menu* to start again.");
}

// ============================================
// Buy Airtime
// ============================================

async function handleBuyAirtimeNetwork(phone: string, user: any, flowData: FlowData, action?: string) {
  if (action?.startsWith("network_")) {
    const network = action.replace("network_", "");
    await updateSession(user.id, "buy_airtime_amount", { network });
    return whatsapp.sendTextMessage(phone, "Enter the phone number to recharge:");
  }
  return whatsapp.sendTextMessage(phone, "Please select a network provider:");
}

async function handleBuyAirtimeAmount(phone: string, user: any, flowData: FlowData, text: string) {
  const phoneNum = text.replace(/[^0-9+]/g, "");
  if (phoneNum.length >= 10) {
    await updateSession(user.id, "buy_airtime_confirm", {
      ...flowData,
      phoneToRecharge: phoneNum,
    });
    return whatsapp.sendTextMessage(phone, "Enter the airtime amount (e.g. 500):");
  }
  return whatsapp.sendTextMessage(phone, "Please enter a valid phone number:");
}

// ============================================
// Check Balance
// ============================================

async function handleCheckBalance(phone: string, user: any) {
  try {
    const account = await autoramp.getMerchantAccount();
    if (account) {
      return whatsapp.sendTextMessage(
        phone,
        `Your balance:\n\nBank: ${account.bankName || account.bankCode}\nAccount: ${account.accountNumber}\nBalance: ${formatAmount(account.accountBalance)}\nStatus: ${account.status}`
      );
    }
    return whatsapp.sendTextMessage(phone, "Could not fetch balance. Please try again later.");
  } catch (error: any) {
    return whatsapp.sendTextMessage(phone, `Error fetching balance: ${error.message}`);
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
    const result = await autoramp.initiateIdentityVerification({
      type: "BVN",
      number: bvn,
    });

    await updateSession(user.id, "kyc_otp", {
      identityId: result.identityId,
      bvn,
    });

    return whatsapp.sendTextMessage(
      phone,
      "An OTP has been sent to your registered phone number. Enter the OTP to complete verification:"
    );
  } catch (error: any) {
    await resetSession(user.id);
    return whatsapp.sendTextMessage(
      phone,
      `Verification failed: ${error.message}\nPlease try again later.`
    );
  }
}

// ============================================
// Main menu
// ============================================

async function sendMainMenu(phone: string) {
  return whatsapp.sendListMessage(
    phone,
    `Welcome to *3rike Pay*! 💰\n\nYour WhatsApp payment assistant.\n\nSelect an option:`,
    "Main Menu",
    [
      {
        title: "Payments",
        rows: [
          { id: "send_money", title: "Send Money", description: "Transfer to any bank account" },
          { id: "buy_airtime", title: "Buy Airtime", description: "Recharge any network" },
          { id: "check_balance", title: "Check Balance", description: "View your account balance" },
        ],
      },
      {
        title: "Account",
        rows: [
          { id: "register", title: "Register", description: "Set up your account with BVN" },
          { id: "kyc", title: "KYC Verify", description: "Complete identity verification" },
        ],
      },
    ]
  );
}

async function sendHelp(phone: string) {
  const help = `*3rike Pay Commands*\n\n` +
    `• *start* - Open main menu\n` +
    `• *help* - Show this help\n` +
    `• *cancel* - Cancel current action\n\n` +
    `*Features:*\n` +
    `• Send money to any Nigerian bank\n` +
    `• Buy airtime for MTN, Airtel, Glo, 9mobile\n` +
    `• Check your balance\n` +
    `• KYC verification\n\n` +
    `*Support:* Contact us for help with any issue.`;

  return whatsapp.sendTextMessage(phone, help);
}
