import { Router, Request, Response } from "express";
import { createLogger } from "@/utils/logger";
import { prisma } from "@/services/database";
import { whatsapp } from "@/services/whatsapp";
import { flutterwave } from "@/services/flutterwave";
import { MESSAGES } from "@/config/constants";
import { toRwandaPhone } from "@/utils/helpers";
import { decryptFlowRequest, encryptFlowResponse, screen } from "@/utils/flowCrypto";

const logger = createLogger("business-flow");

const router = Router();

const FIRST_SCREEN = "BUSINESS_DETAILS";
const SAVED_SCREEN = "SAVED";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The Flow UI reports its own validation failures back to us; ack them so the
 * client stops retrying the same payload.
 */
function ack(payload: any) {
  const error = payload?.data?.error_message || payload?.error_message;
  if (error) {
    logger.warn("Business flow client error", { error });
    return { data: { acknowledged: true } };
  }
  return null;
}

async function notifyBusinessSaved(userId: string, text: string) {
  try {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user?.phone) return;
    await whatsapp.sendTextMessage(user.phone, text);
  } catch (error: any) {
    logger.error("Failed to send business saved message", { userId, error: error.message });
  }
}

interface BusinessInput {
  name: string;
  email: string;
  phone: string;
  registrationNumber?: string;
}

function parseBusinessInput(data: any): { input?: BusinessInput; error?: string } {
  const name = String(data?.business_name || "").trim();
  const email = String(data?.business_email || "").trim();
  const rawPhone = String(data?.business_phone || "").trim();
  const registrationNumber = String(data?.registration_number || "").trim() || undefined;

  if (name.length < 2 || name.length > 80) {
    return { error: "Enter a business name of at least 2 characters." };
  }
  if (!EMAIL_RE.test(email) || email.length > 120) {
    return { error: "That email address doesn't look right." };
  }
  const phone = toRwandaPhone(rawPhone);
  if (!phone) {
    return { error: "Use a Rwanda mobile number, e.g. 0781234567." };
  }

  return { input: { name, email, phone, registrationNumber } };
}

/**
 * Saves the merchant's business profile. Upserts, so re-running the Flow
 * simply updates the existing record.
 */
async function handleBusinessDetails(userId: string, data: any) {
  const { input, error } = parseBusinessInput(data);
  if (error || !input) {
    return screen(FIRST_SCREEN, { error_message: error || "Please check your details." });
  }

  try {
    await flutterwave.ensureBusiness({
      userId,
      name: input.name,
      email: input.email,
      phone: input.phone,
      country: "RW",
      registrationNumber: input.registrationNumber,
    });
  } catch (error: any) {
    logger.error("Failed to save business profile", { userId, error: error.message });
    return screen(FIRST_SCREEN, { error_message: "Could not save that. Please try again." });
  }

  const details = [
    `• *${input.name}*`,
    `• ${input.phone}`,
    `• ${input.email}`,
    ...(input.registrationNumber ? [`• RDB: ${input.registrationNumber}`] : []),
  ].join("\n");

  await notifyBusinessSaved(userId, MESSAGES.BUSINESS.PROFILE.SAVED(details));
  logger.info("Business profile saved", { userId, name: input.name });

  return screen(SAVED_SCREEN);
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
    logger.error("Business flow request decryption failed", { error: error.message });
    return res.status(421).send();
  }

  const { action, screen: currentScreen, data, flow_token } = payload;
  logger.info("Business flow request decoded", {
    action,
    screen: currentScreen,
    flow_token: flow_token ? "set" : "missing",
  });

  try {
    const clientError = ack(payload);
    if (clientError) {
      return res.send(encryptFlowResponse(clientError, aesKey, iv));
    }

    if (action === "ping") {
      return res.send(encryptFlowResponse({ data: { status: "active" } }, aesKey, iv));
    }

    const userId = String(flow_token || "");
    if (!userId || userId === "unused") {
      return res.send(
        encryptFlowResponse(
          screen(FIRST_SCREEN, { error_message: "Session expired. Type /business to restart." }),
          aesKey,
          iv
        )
      );
    }

    if (action === "INIT") {
      return res.send(encryptFlowResponse(screen(FIRST_SCREEN, { error_message: "" }), aesKey, iv));
    }

    if (action === "data_exchange") {
      if (currentScreen === FIRST_SCREEN) {
        const next = await handleBusinessDetails(userId, data || {});
        return res.send(encryptFlowResponse(next, aesKey, iv));
      }
      return res.send(encryptFlowResponse(screen(FIRST_SCREEN, { error_message: "" }), aesKey, iv));
    }

    if (action === "complete") {
      return res.send(encryptFlowResponse(screen(currentScreen || SAVED_SCREEN), aesKey, iv));
    }

    return res.send(encryptFlowResponse(screen(FIRST_SCREEN, { error_message: "" }), aesKey, iv));
  } catch (error: any) {
    logger.error("Business flow request failed", { action, error: error.message });
    return res.send(
      encryptFlowResponse(
        screen(FIRST_SCREEN, { error_message: "Something went wrong. Try again." }),
        aesKey,
        iv
      )
    );
  }
});

export default router;
