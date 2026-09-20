import { config } from "@/config";
import { createLogger } from "@/utils/logger";
import { getSession, updateSession } from "@/services/database";
import { sendAccountCreatedMessage } from "@/services/accountNotification";

const logger = createLogger("dry-run-flow");

type Screen = { screen: string; data: Record<string, unknown> };

function screen(name: string, data: Record<string, unknown> = {}): Screen {
  return { screen: name, data };
}

async function saveFlowData(userId: string, data: Record<string, unknown>) {
  const session = await getSession(userId);
  const existing = (session.flowData as Record<string, unknown>) || {};
  await updateSession(userId, "kyc_flow", { ...existing, ...data });
}

/**
 * Centralized dry-run handler for the KYC WhatsApp Flow.
 *
 * When KYC_DRY_RUN is enabled, this short-circuits the normal flow and returns
 * mocked next screens without calling AutoRamp or writing to the database.
 *
 * Returns `null` when dry-run is disabled or the request should be handled
 * by the real handler.
 */
export async function handleDryRunFlow(
  action: string,
  currentScreen: string,
  data: Record<string, unknown>,
  userId: string
): Promise<Screen | null> {
  if (!config.features.dryRun) return null;
  if (action !== "data_exchange") return null;

  if (currentScreen === "IDENTITY") {
    const idType = String(data.id_type || "").toUpperCase();
    const idNumber = String(data.id_number || "").replace(/[^0-9]/g, "");
    const email = String(data.email || "").trim();

    if (!["NIN", "BVN"].includes(idType)) {
      return screen("IDENTITY", { error_message: "Choose either NIN or BVN." });
    }
    if (idNumber.length !== 11) {
      return screen("IDENTITY", { error_message: "That number must be exactly 11 digits." });
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return screen("IDENTITY", { error_message: "Enter a valid email address." });
    }

    logger.info("Flow IDENTITY dry-run: skipping identity verification");
    await saveFlowData(userId, {
      identityId: "dry-run-identity-id",
      idType,
      idNumber,
      email,
    });

    return screen("NAME");
  }

  if (currentScreen === "NAME") {
    const firstName = String(data.first_name || "").trim();
    const lastName = String(data.last_name || "").trim();

    if (!firstName || !lastName) {
      return screen("NAME", { error_message: "Enter both first and last name." });
    }

    logger.info("Flow NAME dry-run: skipping");
    await saveFlowData(userId, { firstName, lastName });
    return screen("OTP", { message: "Dry-run mode: we will not send a real code. Enter any 6 digits to continue." });
  }

  if (currentScreen === "OTP") {
    const otp = String(data.otp || "").replace(/[^0-9]/g, "");

    if (otp.length < 4 || otp.length > 8) {
      return screen("OTP", {
        message: "Dry-run mode: enter any 6 digits.",
        error_message: "That code looks too short.",
      });
    }

    logger.info("Flow OTP dry-run: returning test account details");
    void sendAccountCreatedMessage(userId, "Safe Haven MFB", "1234567890", "Test User", true).catch(() => {});
    return screen("PIN");
  }

  if (currentScreen === "PIN") {
    const pin = String(data.pin || "").replace(/[^0-9]/g, "");
    const confirmPin = String(data.confirm_pin || "").replace(/[^0-9]/g, "");

    if (!/^\d{4}$/.test(pin)) {
      return screen("PIN", { error_message: "PIN must be exactly 4 digits and contain only numbers." });
    }
    if (!/^\d{4}$/.test(confirmPin)) {
      return screen("PIN", { error_message: "Confirm PIN must be exactly 4 digits and contain only numbers." });
    }
    if (pin !== confirmPin) {
      return screen("PIN", { error_message: "PINs do not match. Try again." });
    }

    logger.info("Flow PIN dry-run: skipping");
    return screen("END");
  }

  return null;
}
