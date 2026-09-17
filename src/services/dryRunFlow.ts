import { config } from "@/config";
import { createLogger } from "@/utils/logger";
import { updateSession } from "@/services/database";
import { sendAccountCreatedMessage } from "@/services/accountNotification";

const logger = createLogger("dry-run-flow");

type Screen = { screen: string; data: Record<string, unknown> };

function screen(name: string, data: Record<string, unknown> = {}): Screen {
  return { screen: name, data };
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
  if (!config.features.kycDryRun) return null;
  if (action !== "data_exchange") return null;

  if (currentScreen === "IDENTITY") {
    const idType = String(data.id_type || "").toUpperCase();
    const idNumber = String(data.id_number || "").replace(/[^0-9]/g, "");

    if (!["NIN", "BVN"].includes(idType)) {
      return screen("IDENTITY", { error_message: "Choose either NIN or BVN." });
    }
    if (idNumber.length !== 11) {
      return screen("IDENTITY", { error_message: "That number must be exactly 11 digits." });
    }

    logger.info("Flow IDENTITY dry-run: skipping identity verification");
    await updateSession(userId, "kyc_flow", {
      identityId: "dry-run-identity-id",
      idType,
      idNumber,
    });

    return screen("OTP", {
      message: "Dry-run mode: we will not send a real code. Enter any 6 digits to continue.",
    });
  }

  if (currentScreen === "EMAIL") {
    logger.info("Flow EMAIL dry-run: skipping");
    return screen("NAME");
  }

  if (currentScreen === "NAME") {
    logger.info("Flow NAME dry-run: skipping");
    return screen("OTP", { message: "Dry-run mode: we will not send a real code. Enter any 6 digits to continue." });
  }

  if (currentScreen === "OTP") {
    logger.info("Flow OTP dry-run: returning test account details");
    void sendAccountCreatedMessage(userId, "Safe Haven MFB", "1234567890", "Test User", true).catch(() => {});
    return screen("PIN");
  }

  if (currentScreen === "PIN") {
    logger.info("Flow PIN dry-run: skipping");
    return screen("END");
  }

  return null;
}
