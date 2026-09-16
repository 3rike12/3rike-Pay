import { prisma } from "@/db/prisma";
import { whatsapp } from "./whatsapp";
import { createLogger } from "@/utils/logger";
import { redactPhone } from "@/utils/helpers";

const logger = createLogger("notifications");
import { formatAmount, cleanPhone } from "@/utils/helpers";
import { TEMPLATES } from "@/config/constants";
import { logWebhookEvent } from "./database";

// ============================================
// Notification Service
// External services call this to notify users
// ============================================

export interface NotifyParams {
  phone: string;
  message: string;
  type?: "text" | "payment" | "kyc" | "alert";
  reference?: string;
  metadata?: Record<string, unknown>;
}

export interface BulkNotifyParams {
  phones: string[];
  message: string;
  type?: "text" | "payment" | "kyc" | "alert";
  metadata?: Record<string, unknown>;
}

// Send notification to a single user
export async function notifyUser(params: NotifyParams): Promise<boolean> {
  try {
    const sent = await whatsapp.sendTextMessage(params.phone, params.message);

    // Log notification in DB
    const user = await prisma.user.findUnique({ where: { phone: params.phone } });
    if (user) {
      await prisma.webhookEvent.create({
        data: {
          source: "notification",
          eventType: params.type || "text",
          reference: params.reference,
          payload: {
            phone: params.phone,
            message: params.message,
            type: params.type,
            sent,
            ...params.metadata,
          } as any,
        },
      });
    }

    logger.info("Notification sent", { phone: redactPhone(params.phone), type: params.type, sent });
    return sent;
  } catch (error: any) {
    logger.error("Notification failed", { phone: redactPhone(params.phone), error: error.message });
    return false;
  }
}

// Send notification to multiple users
export async function notifyBulk(params: BulkNotifyParams): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;

  for (const phone of params.phones) {
    const ok = await notifyUser({
      phone,
      message: params.message,
      type: params.type,
      metadata: params.metadata,
    });
    if (ok) sent++;
    else failed++;
  }

  logger.info("Bulk notification complete", { total: params.phones.length, sent, failed });
  return { sent, failed };
}

// Send payment notification
export async function notifyPayment(
  phone: string,
  params: {
    type: "received" | "sent" | "failed" | "completed";
    amount: number;
    reference: string;
    name?: string;
    bank?: string;
  }
): Promise<boolean> {
  const messages: Record<string, string> = {
    received: `*Payment Received*\n\nAmount: ${formatAmount(params.amount)}\nFrom: ${params.name || "Unknown"}\nRef: ${params.reference}`,
    sent: `*Payment Sent*\n\nAmount: ${formatAmount(params.amount)}\nTo: ${params.name || "Unknown"}\nBank: ${params.bank || "N/A"}\nRef: ${params.reference}`,
    completed: `*Transfer Completed*\n\nAmount: ${formatAmount(params.amount)}\nTo: ${params.name || "Unknown"}\nRef: ${params.reference}`,
    failed: `*Payment Failed*\n\nAmount: ${formatAmount(params.amount)}\nRef: ${params.reference}\n\nPlease try again or contact support.`,
  };

  return notifyUser({
    phone,
    message: messages[params.type] || messages.completed,
    type: "payment",
    reference: params.reference,
  });
}

/**
 * Proactive new-user intro ("Hi {name}! Welcome ... Tap Create wallet").
 *
 * Meta-compliant business-initiated send:
 * - TEMPLATE ONLY (no text fallback). Free text outside the 24h window is
 *   rejected (131047) and attempting it looks like policy evasion.
 * - CALLER must confirm opt-in (POST /welcome requires optIn: true): the
 *   user gave you this number (web form with consent checkbox, click-to-chat,
 *   ad, or messaged you first). Never cold-message scraped numbers.
 * - SEND ONCE: deduped on notification/welcome_create_wallet/{phone} so a
 *   retry or double-submit can't spam the user.
 *
 * The "Create wallet" button lives on the approved template in Meta
 * dashboard, not in the API payload. Tapping it opens the 24h
 * customer-service window and arrives as a button_reply the bot maps to
 * the KYC/wallet flow.
 */
export async function notifyWelcomeCreateWallet(
  phone: string,
  name: string = "there"
): Promise<{ sent: boolean; alreadySent: boolean; optedOut?: boolean }> {
  const cleanName = name.trim() || "there";
  // Dedup keys must match the bot's in-chat welcome check, which uses the
  // local format from cleanPhone(msg.from). An un-normalised number here
  // (234803... vs 0803...) misses that check and the user gets welcomed twice.
  const phoneKey = cleanPhone(phone);

  // Marketing-category template: honor STOP/unsubscribe immediately.
  const optOut = await prisma.webhookEvent.findFirst({
    where: { source: "notification", eventType: "marketing_opt_out", reference: phoneKey },
  });
  if (optOut) {
    logger.info("Welcome blocked: number opted out of marketing", { phone: redactPhone(phoneKey) });
    return { sent: false, alreadySent: false, optedOut: true };
  }

  const existing = await prisma.webhookEvent.findFirst({
    where: { source: "notification", eventType: "welcome_create_wallet", reference: phoneKey },
  });
  if (existing) {
    logger.info("Welcome already sent, skipping", { phone: redactPhone(phoneKey) });
    return { sent: true, alreadySent: true };
  }

  try {
    const sent = await whatsapp.sendTemplate(
      phoneKey,
      TEMPLATES.WELCOME_CREATE_WALLET.NAME,
      [cleanName],
      TEMPLATES.WELCOME_CREATE_WALLET.LANGUAGE
    );

    await logWebhookEvent(
      "notification",
      "welcome_create_wallet",
      { phone: phoneKey, name: cleanName, sent },
      phoneKey
    ).catch(() => {});

    logger.info("Welcome template sent", { phone: redactPhone(phoneKey), sent });
    return { sent, alreadySent: false };
  } catch (error: any) {
    logger.error("Welcome template failed", { phone: redactPhone(phone), error: error.message });
    return { sent: false, alreadySent: false };
  }
}

// Send KYC notification
export async function notifyKyc(
  phone: string,
  status: "verified" | "rejected" | "pending"
): Promise<boolean> {
  const messages: Record<string, string> = {
    verified: `*KYC Verified*\n\nYour identity has been verified. You can now use all features of 3rike Pay.`,
    rejected: `*KYC Rejected*\n\nYour verification was not successful. Please try again or contact support.`,
    pending: `*KYC Pending*\n\nYour verification is being processed. We'll notify you when it's complete.`,
  };

  return notifyUser({
    phone,
    message: messages[status],
    type: "kyc",
  });
}
