import { Router, Request, Response } from "express";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { createLogger } from "@/utils/logger";
import { autoramp } from "@/services/autoramp";
import { prisma, updateSession, resetSession } from "@/services/database";
import { generateReference } from "@/utils/helpers";
import { MESSAGES } from "@/config/constants";

const logger = createLogger("flow");

const router = Router();

const PRIVATE_KEY_PATH =
  process.env.FLOW_PRIVATE_KEY_PATH || path.resolve(process.cwd(), "secrets/flow_private.pem");

let privateKey: crypto.KeyObject | null = null;
function getPrivateKey(): crypto.KeyObject {
  if (!privateKey) {
    privateKey = crypto.createPrivateKey({
      key: fs.readFileSync(PRIVATE_KEY_PATH, "utf8"),
      passphrase: process.env.FLOW_PRIVATE_KEY_PASSPHRASE || undefined,
    });
  }
  return privateKey;
}

const GCM_TAG_LENGTH = 16;

/**
 * Flows use hybrid encryption: an AES key sealed with our RSA public key, and
 * the payload itself under AES-GCM. The response must reuse the same AES key
 * with a bitwise-inverted IV - that inversion is not optional, WhatsApp will
 * reject anything else.
 */
function decryptRequest(body: any) {
  const { encrypted_flow_data, encrypted_aes_key, initial_vector } = body;

  const aesKey = crypto.privateDecrypt(
    { key: getPrivateKey(), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(encrypted_aes_key, "base64")
  );

  const flowData = Buffer.from(encrypted_flow_data, "base64");
  const iv = Buffer.from(initial_vector, "base64");
  const body_ = flowData.subarray(0, -GCM_TAG_LENGTH);
  const tag = flowData.subarray(-GCM_TAG_LENGTH);

  const decipher = crypto.createDecipheriv(`aes-${aesKey.length * 8}-gcm` as any, aesKey, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(body_), decipher.final()]).toString("utf8");

  return { decrypted: JSON.parse(decrypted), aesKey, iv };
}

function encryptResponse(response: any, aesKey: Buffer, iv: Buffer): string {
  const flippedIv = Buffer.from(iv.map((b) => ~b));
  const cipher = crypto.createCipheriv(`aes-${aesKey.length * 8}-gcm` as any, aesKey, flippedIv);
  return Buffer.concat([
    cipher.update(JSON.stringify(response), "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64");
}

/** Screen payloads. `error_message` renders inline so the user can correct and retry. */
function screen(name: string, data: Record<string, unknown> = {}) {
  return { screen: name, data };
}

async function handleIdentity(userId: string, data: any) {
  const idType = String(data.id_type || "").toUpperCase();
  const idNumber = String(data.id_number || "").replace(/[^0-9]/g, "");
  logger.info("Flow IDENTITY received", { userId, idType, idNumber: idNumber ? "[redacted]" : "empty" });

  if (!["NIN", "BVN"].includes(idType)) {
    return screen("IDENTITY", { error_message: "Choose either NIN or BVN." });
  }
  if (idNumber.length !== 11) {
    return screen("IDENTITY", { error_message: "That number must be exactly 11 digits." });
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
      return screen("IDENTITY", {
        error_message: "We couldn't verify that ID. Please check the number and try again.",
      });
    }

    // Held server-side for the OTP step. The number never travels back to the
    // client and never appears in the chat transcript.
    await updateSession(userId, "kyc_flow", {
      identityId: result.identityId,
      idType,
      idNumber,
    });
    logger.info("Session updated for OTP", { userId });

    return screen("OTP", {
      message: `We sent a code to the phone number registered to your ${idType}. Enter it below to finish.`,
    });
  } catch (error: any) {
    logger.error("Flow IDENTITY failed", { userId, idType, error: error.message });

    const apiMessage = error.response?.data?.message || error.response?.data?.error || error.message;
    let errorMessage = "Could not start verification. Try again.";

    if (apiMessage && typeof apiMessage === "string") {
      if (apiMessage.toLowerCase().includes("unable to fetch record")) {
        errorMessage = "We couldn't fetch that record. Please check the number and try again.";
      } else if (apiMessage.toLowerCase().includes("missing phone")) {
        errorMessage = "The phone number on this ID doesn't match. Please use the phone number linked to your ID.";
      } else {
        errorMessage = apiMessage.slice(0, 120);
      }
    }

    return screen("IDENTITY", { error_message: errorMessage });
  }
}

async function handleOtp(userId: string, data: any) {
  const otp = String(data.otp || "").replace(/[^0-9]/g, "");
  logger.info("Flow OTP received", { userId, otpLength: otp.length });
  if (otp.length < 4 || otp.length > 8) {
    return screen("OTP", { message: "Enter the code we sent you.", error_message: "That code looks too short." });
  }

  const session = await prisma.userSession.findFirst({
    where: { userId },
    orderBy: { updatedAt: "desc" },
  });
  const flowData = (session?.flowData as any) || {};
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !flowData.identityId) {
    logger.warn("Flow OTP missing session", { userId, hasUser: !!user });
    return screen("IDENTITY", { error_message: "Session expired. Re-enter your ID to continue." });
  }

  const attempts = (flowData.otpAttempts || 0) + 1;

  try {
    logger.info("Validating identity OTP", { userId, idType: flowData.idType });
    const validationResult = await autoramp.validateIdentityVerification({
      identityId: flowData.identityId,
      type: flowData.idType,
      otp,
    });
    logger.info("Identity OTP validated", { userId });

    // Use the verified identityId if the API returned one.
    const verifiedIdentityId = validationResult?.identityId || flowData.identityId;

    logger.info("Creating AutoRamp sub-account", { userId, idType: flowData.idType });
    const subAccount = await autoramp.createSubAccount({
      phoneNumber: user.phone,
      emailAddress: user.email || `${user.phone}@3rike.xyz`,
      externalReference: generateReference("kyc"),
      identityType: flowData.idType,
      identityNumber: flowData.idNumber,
      identityId: verifiedIdentityId,
    });
    logger.info("AutoRamp sub-account created", { userId, subAccount: JSON.stringify(subAccount) });

    logger.info("Updating user record", { userId });
    const updated = await prisma.user.update({
      where: { id: userId },
      data: {
        ...(flowData.idType === "BVN" ? { bvn: flowData.idNumber } : { nin: flowData.idNumber }),
        kycStatus: "verified",
        autorampSubId: subAccount?.id || subAccount?.accountId,
        bankAccount: subAccount?.accountNumber || subAccount?.bankAccount,
        bankCode: subAccount?.bankCode,
        bankName: subAccount?.bankName || subAccount?.provider,
      },
    });

    await resetSession(userId);
    logger.info("User verified and session reset", { userId, bankAccount: updated.bankAccount });

    return screen("SUCCESS", {
      heading: "Your 3rike Pay account is ready",
      details: `Bank: ${updated.bankName || "Safe Haven MFB"}\nAccount number: ${updated.bankAccount || "being created"}\nName: ${updated.name || "-"}`,
    });
  } catch (error: any) {
    const apiMessage = error.response?.data?.message || error.response?.data?.error || error.message;

    if (String(apiMessage).toLowerCase().includes("already verified")) {
      logger.info("Identity already verified, retrying sub-account creation", { userId });
      try {
        const subAccount = await autoramp.createSubAccount({
          phoneNumber: user.phone,
          emailAddress: user.email || `${user.phone}@3rike.xyz`,
          externalReference: generateReference("kyc"),
          identityType: flowData.idType,
          identityNumber: flowData.idNumber,
          identityId: flowData.identityId,
        });
        logger.info("AutoRamp sub-account created", { userId, subAccount: JSON.stringify(subAccount) });

        const updated = await prisma.user.update({
          where: { id: userId },
          data: {
            ...(flowData.idType === "BVN" ? { bvn: flowData.idNumber } : { nin: flowData.idNumber }),
            kycStatus: "verified",
            autorampSubId: subAccount?.id || subAccount?.accountId,
            bankAccount: subAccount?.accountNumber || subAccount?.bankAccount,
            bankCode: subAccount?.bankCode,
            bankName: subAccount?.bankName || subAccount?.provider,
          },
        });

        await resetSession(userId);
        return screen("SUCCESS", {
          heading: "Your 3rike Pay account is ready",
          details: `Bank: ${updated.bankName || "Safe Haven MFB"}\nAccount number: ${updated.bankAccount || "being created"}\nName: ${updated.name || "-"}`,
        });
      } catch (retryError: any) {
        logger.error("Flow sub-account retry failed", { userId, error: retryError.message });
      }
    }

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
      await updateSession(userId, "kyc_flow", { ...flowData, otpAttempts: attempts });
      return screen("OTP", {
        message: MESSAGES.KYC_OTP.PROMPT,
        error_message: errorMessage,
      });
    }

    await resetSession(userId);
    return screen("OTP", {
      message: MESSAGES.KYC_OTP.PROMPT,
      error_message: "Too many failed attempts. Type kyc to restart.",
    });
  }
}

router.post("/", async (req: Request, res: Response) => {
  let aesKey: Buffer;
  let iv: Buffer;
  let payload: any;

  try {
    const decoded = decryptRequest(req.body);
    payload = decoded.decrypted;
    aesKey = decoded.aesKey;
    iv = decoded.iv;
  } catch (error: any) {
    // 421 tells WhatsApp our key is stale so it re-fetches instead of retrying
    // the same undecryptable payload forever.
    logger.error("Flow request decryption failed", { error: error.message });
    return res.status(421).send();
  }

  const { action, screen: currentScreen, data, flow_token } = payload;
  logger.info("Flow request decoded", { action, screen: currentScreen, flow_token: flow_token ? "set" : "missing" });

  try {
    // Health check - must answer or WhatsApp marks the endpoint unhealthy.
    if (action === "ping") {
      return res.send(encryptResponse({ data: { status: "active" } }, aesKey, iv));
    }

    if (data?.error_message) {
      logger.warn("Flow client error", { error: data.error_message });
      return res.send(encryptResponse({ data: { acknowledged: true } }, aesKey, iv));
    }

    const userId = String(flow_token || "");
    if (!userId || userId === "unused") {
      return res.send(
        encryptResponse(screen("IDENTITY", { error_message: "Session expired. Type kyc to restart." }), aesKey, iv)
      );
    }

    if (action === "INIT") {
      return res.send(encryptResponse(screen("IDENTITY"), aesKey, iv));
    }

    if (action === "data_exchange") {
      const next =
        currentScreen === "IDENTITY"
          ? await handleIdentity(userId, data || {})
          : currentScreen === "OTP"
          ? await handleOtp(userId, data || {})
          : screen("IDENTITY");
      logger.info("Flow data_exchange response", { userId, currentScreen, nextScreen: next.screen });
      return res.send(encryptResponse(next, aesKey, iv));
    }

    return res.send(encryptResponse(screen("IDENTITY"), aesKey, iv));
  } catch (error: any) {
    // Surface the real reason on the current screen instead of dead-ending -
    // "BVN not found" is actionable, a blank screen is not.
    logger.error("Flow handler error", { action, screen: currentScreen, error: error.message });
    const failing = currentScreen === "OTP" ? "OTP" : "IDENTITY";
    return res.send(
      encryptResponse(
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
