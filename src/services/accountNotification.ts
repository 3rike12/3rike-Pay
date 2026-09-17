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
  accountName: string,
  dryRun = false
) {
  try {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return;

    const message = MESSAGES.FLOW.ACCOUNT_CREATED(bank, accountNumber, accountName, dryRun);
    await whatsapp.sendButtonsMessage(user.phone, message, [
      { id: "btn_menu", title: "Main Menu" },
      { id: "btn_balance", title: "Check Balance" },
    ]);
  } catch (error: any) {
    logger.error("Failed to send account created message", { userId, error: error.message });
  }
}
