import { prisma } from "@/services/database";
import { whatsapp } from "@/services/whatsapp";
import { MESSAGES } from "@/config/constants";
import { createLogger } from "@/utils/logger";

const logger = createLogger("account-notification");

/**
 * Send the user a WhatsApp message with their new account details.
 * Fires after the account has been created so the account number is
 * available in the chat transcript (and copyable).
 */
export async function sendAccountCreatedMessage(
  userId: string,
  bank: string,
  accountNumber: string,
  dryRun = false
) {
  try {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return;

    const message = MESSAGES.FLOW.ACCOUNT_CREATED(bank, accountNumber, dryRun);
    await whatsapp.sendTextMessage(user.phone, message);
  } catch (error: any) {
    logger.error("Failed to send account created message", { userId, error: error.message });
  }
}
