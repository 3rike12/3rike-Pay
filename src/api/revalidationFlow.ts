import { Router, Request, Response } from "express";
import { createLogger } from "@/utils/logger";
import { autoramp } from "@/services/autoramp";
import {
  prisma,
  updateSession,
  resetSession,
  getUserWithDetails,
} from "@/services/database";
import { KYC_STATUS } from "@/config/constants";
import { decryptFlowRequest, encryptFlowResponse, screen } from "@/utils/flowCrypto";

const logger = createLogger("revalidation-flow");

const router = Router();

async function getFlowData(userId: string) {
  const session = await prisma.userSession.findFirst({
    where: { userId },
    orderBy: { updatedAt: "desc" },
  });
  return (session?.flowData as any) || {};
}

async function saveFlowData(userId: string, data: Record<string, unknown>) {
  const existing = await getFlowData(userId);
  await updateSession(userId, "revalidation_flow", { ...existing, ...data });
}

/**
 * First screen: the user re-enters the ID they originally verified with.
 * We use it to initiate verification, which triggers an OTP to their phone.
 */
async function handleIdentity(userId: string, data: any) {
  const idType = String(data.id_type || "").toUpperCase();
  const idNumber = String(data.id_number || "").replace(/[^0-9]/g, "");

  if (!["NIN", "BVN"].includes(idType)) {
    return screen("IDENTITY", { error_message: "Choose either NIN or BVN." });
  }
  if (idNumber.length !== 11) {
    return screen("IDENTITY", { error_message: "That number must be exactly 11 digits." });
  }

  try {
    logger.info("Revalidation identity received", { userId, idType });
    const result = await autoramp.initiateIdentityVerification({
      type: idType as "NIN" | "BVN",
      number: idNumber,
    });

    if (!result.identityId) {
      logger.error("Revalidation verification returned no identityId", { userId, idType });
      return screen("IDENTITY", { error_message: "Could not start verification. Try again." });
    }

    await saveFlowData(userId, { identityId: result.identityId, idType, idNumber });
    return screen("OTP", {
      message: "We sent a code to the phone number registered to your ID. Enter it below to finish.",
    });
  } catch (error: any) {
    logger.error("Revalidation identity failed", { userId, idType, error: error.message });
    return screen("IDENTITY", { error_message: "Could not start verification. Try again." });
  }
}

/**
 * Second screen: submit the OTP and finish revalidation via PATCH /sub-accounts/:id.
 */
async function handleOtp(userId: string, data: any) {
  const otp = String(data.otp || "").replace(/[^0-9]/g, "");

  if (otp.length < 4 || otp.length > 8) {
    return screen("OTP", {
      message: "Enter the code we sent you.",
      error_message: "That code looks too short.",
    });
  }

  const flowData = await getFlowData(userId);
  const user = await getUserWithDetails(userId);

  if (!user || !user.bankAccount?.autorampSubId || !flowData.identityId) {
    logger.warn("Revalidation OTP missing session", {
      userId,
      hasUser: !!user,
      hasSubId: !!user?.bankAccount?.autorampSubId,
      hasIdentityId: !!flowData.identityId,
    });
    return screen("IDENTITY", { error_message: "Session expired. Please restart." });
  }

  try {
    await autoramp.patchSubAccount(user.bankAccount.autorampSubId, {
      otp,
      identityType: flowData.idType,
      identityNumber: flowData.idNumber,
      identityId: flowData.identityId,
    });

    await prisma.user.update({
      where: { id: userId },
      data: { kycStatus: KYC_STATUS.VERIFIED },
    });
    await resetSession(userId);

    logger.info("Account revalidated", { userId });
    return screen("END");
  } catch (error: any) {
    logger.error("Revalidation OTP failed", { userId, error: error.message });
    return screen("OTP", {
      message: "Enter the code we sent you.",
      error_message: "The code you entered is incorrect. Please try again.",
    });
  }
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
    logger.error("Revalidation flow decryption failed", { error: error.message });
    return res.status(421).send();
  }

  const { action, screen: currentScreen, data, flow_token } = payload;

  try {
    if (action === "ping") {
      return res.send(encryptFlowResponse({ data: { status: "active" } }, aesKey, iv));
    }

    if (data?.error_message) {
      logger.warn("Revalidation flow client error", { error: data.error_message });
      return res.send(encryptFlowResponse({ data: { acknowledged: true } }, aesKey, iv));
    }

    const userId = String(flow_token || "");
    if (!userId || userId === "unused") {
      return res.send(
        encryptFlowResponse(screen("IDENTITY", { error_message: "Session expired." }), aesKey, iv)
      );
    }

    if (action === "INIT") {
      return res.send(encryptFlowResponse(screen("IDENTITY"), aesKey, iv));
    }

    if (action === "data_exchange") {
      const handlers: Record<string, (uid: string, d: any) => Promise<{ screen: string; data: Record<string, unknown> }>> = {
        IDENTITY: handleIdentity,
        OTP: handleOtp,
      };
      const next = await (handlers[currentScreen] || (() => screen("IDENTITY")))(userId, data || {});
      logger.info("Revalidation flow response", { userId, currentScreen, nextScreen: next.screen });
      return res.send(encryptFlowResponse(next, aesKey, iv));
    }

    if (action === "complete") {
      return res.send(encryptFlowResponse(screen(currentScreen || "END"), aesKey, iv));
    }

    return res.send(encryptFlowResponse(screen("IDENTITY"), aesKey, iv));
  } catch (error: any) {
    logger.error("Revalidation flow handler error", { action, screen: currentScreen, error: error.message });
    return res.send(
      encryptFlowResponse(
        screen("IDENTITY", { error_message: "Something went wrong. Try again." }),
        aesKey,
        iv
      )
    );
  }
});

export default router;
