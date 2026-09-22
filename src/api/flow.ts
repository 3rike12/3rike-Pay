import { Router, Request, Response } from "express";
import { createLogger } from "@/utils/logger";
import { autoramp } from "@/services/autoramp";
import {
  prisma,
  updateSession,
  resetSession,
  createUserProfile,
  createBankAccount,
  createUserCredential,
  getUserWithDetails,
} from "@/services/database";
import { generateReference, toWhatsAppPhone, redactPhone } from "@/utils/helpers";
import { handleDryRunFlow } from "@/services/dryRunFlow";
import { sendAccountCreatedMessage } from "@/services/accountNotification";
import { hashPin } from "@/utils/pin";
import { MESSAGES, KYC_STATUS } from "@/config/constants";
import { decryptFlowRequest, encryptFlowResponse, screen } from "@/utils/flowCrypto";

const logger = createLogger("flow");

const router = Router();

async function getLatestFlowData(userId: string) {
  const session = await prisma.userSession.findFirst({
    where: { userId },
    orderBy: { updatedAt: "desc" },
  });
  return (session?.flowData as any) || {};
}

async function saveFlowData(userId: string, data: Record<string, unknown>) {
  const existing = await getLatestFlowData(userId);
  await updateSession(userId, "kyc_flow", { ...existing, ...data });
}

async function handleIdentity(userId: string, data: any) {
  const idType = String(data.id_type || "").toUpperCase();
  const idNumber = String(data.id_number || "").replace(/[^0-9]/g, "");
  const email = String(data.email || "").trim();
  logger.info("Flow IDENTITY received", { userId, idType, idNumber: idNumber ? "[redacted]" : "empty", hasEmail: !!email });

  if (!["NIN", "BVN"].includes(idType)) {
    return screen("IDENTITY", { error_message: "Choose either NIN or BVN." });
  }
  if (idNumber.length !== 11) {
    return screen("IDENTITY", { error_message: "That number must be exactly 11 digits." });
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return screen("IDENTITY", { error_message: "Enter a valid email address." });
  }

  try {
    logger.info("Initiating identity verification", { userId, idType });
    const result = await autoramp.initiateIdentityVerification({
      type: idType as "NIN" | "BVN",
      number: idNumber,
    });
    logger.info("Identity verification initiated", { userId, idType });

    if (!result.identityId) {
      logger.error("Identity verification returned no identityId", { userId, idType });
      return screen("IDENTITY", { error_message: "Could not start verification. Try again or use a different ID." });
    }

    if (result.status === "FAILED") {
      logger.error("Identity verification failed", { userId, idType, result: JSON.stringify(result) });
      return screen("IDENTITY", { error_message: "We couldn't verify that ID. Please check the number and try again." });
    }

    await saveFlowData(userId, { identityId: result.identityId, idType, idNumber, email });
    logger.info("Session updated for OTP", { userId });

    return screen("NAME");
  } catch (error: any) {
    logger.error("Flow IDENTITY failed", { userId, idType, error: error.message });

    const apiMessage = error.response?.data?.message || error.response?.data?.error || error.message;
    let errorMessage = "Could not start verification. Try again.";

    if (apiMessage && typeof apiMessage === "string") {
      if (apiMessage.toLowerCase().includes("unable to fetch record")) {
        errorMessage = "We couldn't fetch that record. Please check the number and try again.";
      } else if (apiMessage.toLowerCase().includes("missing phone")) {
        errorMessage = "The phone number on this ID doesn't match. Please use the phone number linked to your ID.";
      } else if (apiMessage.toLowerCase().includes("timeout") || apiMessage.toLowerCase().includes("timed out")) {
        errorMessage = "Verification is taking too long. Please try again.";
      } else {
        errorMessage = apiMessage.slice(0, 120);
      }
    }

    return screen("IDENTITY", { error_message: errorMessage });
  }
}

async function handleName(userId: string, data: any) {
  const firstName = String(data.first_name || "").trim();
  const lastName = String(data.last_name || "").trim();
  logger.info("Flow NAME received", { userId, hasFirstName: !!firstName, hasLastName: !!lastName });

  if (!firstName || !lastName) {
    return screen("NAME", { error_message: "Enter both first and last name." });
  }

  await saveFlowData(userId, { firstName, lastName });
  return screen("OTP", { message: "We sent a code to the phone number registered to your ID. Enter it below to finish." });
}

async function handleOtp(userId: string, data: any) {
  const otp = String(data.otp || "").replace(/[^0-9]/g, "");
  logger.info("Flow OTP received", { userId, otpLength: otp.length });

  if (otp.length < 4 || otp.length > 8) {
    return screen("OTP", { message: "Enter the code we sent you.", error_message: "That code looks too short." });
  }

  const flowData = await getLatestFlowData(userId);
  const user = await prisma.user.findUnique({ where: { id: userId } });

  if (!user || !flowData.identityId) {
    logger.warn("Flow OTP missing session", { userId, hasUser: !!user, hasIdentityId: !!flowData.identityId });
    return screen("IDENTITY", { error_message: "Session expired. Re-enter your ID to continue." });
  }

  const attempts = (flowData.otpAttempts || 0) + 1;

  try {
    logger.info("Creating AutoRamp sub-account", { userId, idType: flowData.idType });
    const phoneNumber = `+${toWhatsAppPhone(user.phone)}`;
    const externalReference = generateReference("kyc");

    const subAccount = await autoramp.createSubAccount({
      phoneNumber,
      emailAddress: flowData.email || `${user.phone}@3rike.xyz`,
      externalReference,
      identityType: flowData.idType,
      identityNumber: flowData.idNumber,
      identityId: flowData.identityId,
      otp,
      autoSweep: false,
    });

    const safeSubAccount = { ...subAccount };
    if (safeSubAccount.accountNumber) safeSubAccount.accountNumber = "[redacted]";
    if (safeSubAccount.accountName) safeSubAccount.accountName = "[redacted]";
    logger.info("AutoRamp sub-account created", { userId, subAccount: JSON.stringify(safeSubAccount) });

    const bankName = subAccount?.bankName || subAccount?.provider || "Safe Haven MFB";
    const accountNumber = subAccount?.accountNumber || subAccount?.bankAccount || "being created";
    const accountName = subAccount?.accountName || `${flowData.firstName || ""} ${flowData.lastName || ""}`.trim() || "Account Holder";

    await Promise.all([
      createUserProfile(userId, {
        firstName: flowData.firstName,
        lastName: flowData.lastName,
        email: flowData.email,
      }),
      createBankAccount(userId, {
        autorampSubId: subAccount?.id || subAccount?.accountId,
        reference: externalReference,
        accountNumber,
        accountName,
        bankCode: subAccount?.bankCode,
        bankName,
      }),
      createUserCredential(userId, {
        bvn: flowData.idType === "BVN" ? flowData.idNumber : undefined,
        nin: flowData.idType === "NIN" ? flowData.idNumber : undefined,
        identityId: flowData.identityId,
      }),
    ]);

    await prisma.user.update({
      where: { id: userId },
      data: { name: accountName },
    });

    logger.info("User verified", { userId });

    void sendAccountCreatedMessage(userId, bankName, accountNumber, accountName, false).catch(() => {});

    return screen("PIN");
  } catch (error: any) {
    logger.error("Flow OTP/verification failed", { userId, error: error.message });

    const errMessage = error.response?.data?.message || error.response?.data?.error || error.message;
    let errorMessage = "Verification failed. Try again.";

    if (errMessage && typeof errMessage === "string") {
      const msg = errMessage.toLowerCase();
      if (msg.includes("otp") || msg.includes("code") || msg.includes("invalid")) {
        errorMessage = "The code you entered is incorrect. Please try again.";
      } else {
        errorMessage = errMessage.slice(0, 120);
      }
    }

    if (attempts < 3) {
      await saveFlowData(userId, { ...flowData, otpAttempts: attempts });
      return screen("OTP", { message: MESSAGES.KYC_OTP.PROMPT, error_message: errorMessage });
    }

    await resetSession(userId);
    return screen("OTP", { message: MESSAGES.KYC_OTP.PROMPT, error_message: "Too many failed attempts. Type /kyc to restart." });
  }
}

async function handlePin(userId: string, data: any) {
  const rawPin = String(data.pin || "").trim();
  const rawConfirmPin = String(data.confirm_pin || "").trim();
  const pin = rawPin.replace(/[^0-9]/g, "");
  const confirmPin = rawConfirmPin.replace(/[^0-9]/g, "");
  logger.info("Flow PIN received", { userId, pinLength: pin.length });

  if (!/^\d{4}$/.test(pin)) {
    return screen("PIN", { error_message: "PIN must be exactly 4 digits and contain only numbers." });
  }
  if (!/^\d{4}$/.test(confirmPin)) {
    return screen("PIN", { error_message: "Confirm PIN must be exactly 4 digits and contain only numbers." });
  }
  if (pin !== confirmPin) {
    return screen("PIN", { error_message: "PINs do not match. Try again." });
  }

  await createUserCredential(userId, { pin: hashPin(pin) });
  await prisma.user.update({ where: { id: userId }, data: { kycStatus: KYC_STATUS.VERIFIED } });
  await resetSession(userId);
  logger.info("PIN created and session reset", { userId });

  return screen("END");
}

router.post("/", async (req: Request, res: Response) => {
  let aesKey: Buffer;
  let iv: Buffer;
  let payload: any;

  try {
    const decoded = decryptFlowRequest(req.body);
    payload = decoded.decrypted;
    aesKey = decoded.aesKey;
    iv = decoded.iv;
  } catch (error: any) {
    logger.error("Flow request decryption failed", { error: error.message });
    return res.status(421).send();
  }

  const { action, screen: currentScreen, data, flow_token } = payload;
  logger.info("Flow request decoded", { action, screen: currentScreen, flow_token: flow_token ? "set" : "missing" });

  try {
    if (action === "ping") {
      return res.send(encryptFlowResponse({ data: { status: "active" } }, aesKey, iv));
    }

    if (data?.error_message) {
      logger.warn("Flow client error", { error: data.error_message });
      return res.send(encryptFlowResponse({ data: { acknowledged: true } }, aesKey, iv));
    }

    const userId = String(flow_token || "");
    if (!userId || userId === "unused") {
      return res.send(
        encryptFlowResponse(screen("IDENTITY", { error_message: "Session expired. Type /kyc to restart." }), aesKey, iv)
      );
    }

    if (action === "INIT") {
      const user = await getUserWithDetails(userId);
      if (user?.kycStatus === KYC_STATUS.VERIFIED) {
        await resetSession(userId).catch(() => {});
        return res.send(encryptFlowResponse(screen("COMPLETED"), aesKey, iv));
      }
      return res.send(encryptFlowResponse(screen("IDENTITY"), aesKey, iv));
    }

    if (action === "data_exchange") {
      const safePayload = { ...data };
      if (safePayload.id_number) safePayload.id_number = "[redacted]";
      if (safePayload.otp) safePayload.otp = "[redacted]";
      if (safePayload.pin) safePayload.pin = "[redacted]";
      if (safePayload.confirm_pin) safePayload.confirm_pin = "[redacted]";
      logger.debug("Flow data_exchange start", { userId, currentScreen, payloadData: safePayload });

      const dryRunScreen = await handleDryRunFlow(action, currentScreen, data || {}, userId);

      const handlers: Record<string, (uid: string, d: any) => Promise<{ screen: string; data: Record<string, unknown> }>> = {
        IDENTITY: handleIdentity,
        NAME: handleName,
        OTP: handleOtp,
        PIN: handlePin,
      };

      const next = dryRunScreen || (await (handlers[currentScreen] || (() => screen("IDENTITY")))(userId, data || {}));

      logger.info("Flow data_exchange response", {
        userId,
        currentScreen,
        nextScreen: next.screen,
        nextData: next.data,
        dryRun: !!dryRunScreen,
      });
      return res.send(encryptFlowResponse(next, aesKey, iv));
    }

    if (action === "complete") {
      logger.info("Flow complete", { userId, currentScreen });
      return res.send(encryptFlowResponse(screen(currentScreen || "END"), aesKey, iv));
    }

    return res.send(encryptFlowResponse(screen("IDENTITY"), aesKey, iv));
  } catch (error: any) {
    logger.error("Flow handler error", { action, screen: currentScreen, error: error.message });
    const failing = currentScreen === "OTP" ? "OTP" : "IDENTITY";
    return res.send(
      encryptFlowResponse(
        screen(failing, {
          ...(failing === "OTP" ? { message: MESSAGES.KYC_OTP.PROMPT } : {}),
          error_message: error.message?.slice(0, 120) || "Something went wrong. Try again.",
        }),
        aesKey,
        iv
      )
    );
  }
});

export default router;
