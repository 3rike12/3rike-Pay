import { prisma } from "@/db/prisma";
import { whatsapp } from "./whatsapp";
import { logger } from "@/utils/logger";

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

    logger.info("Notification sent", { phone: params.phone, type: params.type, sent });
    return sent;
  } catch (error: any) {
    logger.error("Notification failed", { phone: params.phone, error: error.message });
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
    received: `💰 *Payment Received*\n\nAmount: ₦${params.amount.toLocaleString()}\nFrom: ${params.name || "Unknown"}\nRef: ${params.reference}`,
    sent: `✅ *Payment Sent*\n\nAmount: ₦${params.amount.toLocaleString()}\nTo: ${params.name || "Unknown"}\nBank: ${params.bank || "N/A"}\nRef: ${params.reference}`,
    completed: `✅ *Transfer Completed*\n\nAmount: ₦${params.amount.toLocaleString()}\nTo: ${params.name || "Unknown"}\nRef: ${params.reference}`,
    failed: `❌ *Payment Failed*\n\nAmount: ₦${params.amount.toLocaleString()}\nRef: ${params.reference}\n\nPlease try again or contact support.`,
  };

  return notifyUser({
    phone,
    message: messages[params.type] || messages.completed,
    type: "payment",
    reference: params.reference,
  });
}

// Send KYC notification
export async function notifyKyc(
  phone: string,
  status: "verified" | "rejected" | "pending"
): Promise<boolean> {
  const messages: Record<string, string> = {
    verified: `✅ *KYC Verified*\n\nYour identity has been verified. You can now use all features of 3rike Pay.`,
    rejected: `❌ *KYC Rejected*\n\nYour verification was not successful. Please try again or contact support.`,
    pending: `⏳ *KYC Pending*\n\nYour verification is being processed. We'll notify you when it's complete.`,
  };

  return notifyUser({
    phone,
    message: messages[status],
    type: "kyc",
  });
}
