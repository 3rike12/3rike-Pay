import { Router, Request, Response } from "express";
import crypto from "crypto";
import { config } from "@/config";
import { logger } from "@/utils/logger";
import { handleMessage } from "@/bot";
import { prisma, logWebhookEvent } from "@/services/database";
import { autoramp } from "@/services/autoramp";
import { cleanPhone } from "@/utils/helpers";
import { formatAmount } from "@/utils/helpers";
import { TEMPLATES } from "@/config/constants";

const router = Router();

// ============================================
// WhatsApp Webhook - Verification (GET)
// ============================================
router.get("/whatsapp", (req: Request, res: Response) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === config.whatsapp.verifyToken) {
    logger.info("WhatsApp webhook verified");
    res.status(200).send(challenge);
  } else {
    logger.warn("WhatsApp webhook verification failed", { mode, token });
    res.sendStatus(403);
  }
});

// ============================================
// WhatsApp Webhook - Messages (POST)
// ============================================
router.post("/whatsapp", async (req: Request, res: Response) => {
  // Respond immediately
  res.sendStatus(200);

  try {
    const body = req.body;

    if (body.object !== "whatsapp_business_account") return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== "messages") continue;

        const value = change.value;

        // Handle incoming messages
        if (value.messages) {
          for (const msg of value.messages) {
            const phone = cleanPhone(msg.from);
            const contact = value.contacts?.[0];
            const name = contact?.profile?.name || "";

            // Check for button/list replies
            const buttonReply = msg.interactive?.button_reply;
            const listReply = msg.interactive?.list_reply;

            let text = "";
            if (msg.type === "text") {
              text = msg.text?.body || "";
            } else if (buttonReply) {
              text = buttonReply.title;
            } else if (listReply) {
              text = listReply.title;
            }

            // Log webhook event for idempotency
            await logWebhookEvent("whatsapp", "message", {
              messageId: msg.id,
              from: phone,
              type: msg.type,
              text,
            }, msg.id);

            // Process message
            await handleMessage(
              phone,
              name,
              text,
              buttonReply ? { id: buttonReply.id, title: buttonReply.title } : undefined,
              listReply ? { id: listReply.id, title: listReply.title, description: listReply.description } : undefined
            );
          }
        }

        // Handle status updates
        if (value.statuses) {
          for (const status of value.statuses) {
            logger.info("WhatsApp status update", {
              messageId: status.id,
              status: status.status,
              recipientId: status.recipient_id,
            });
          }
        }
      }
    }
  } catch (error: any) {
    logger.error("WhatsApp webhook processing error", { error: error.message });
  }
});

// ============================================
// AutoRamp Webhook (POST)
// ============================================
router.post("/autoramp", async (req: Request, res: Response) => {
  // Verify signature
  const signature = req.headers["x-webhook-signature"] as string;
  const eventType = req.headers["x-webhook-event"] as string;

  if (!signature) {
    logger.warn("AutoRamp webhook missing signature");
    return res.status(401).json({ error: "Missing signature" });
  }

  const rawBody = JSON.stringify(req.body);

  try {
    const isValid = autoramp.verifyWebhookSignature(rawBody, signature);
    if (!isValid) {
      logger.error("AutoRamp webhook invalid signature", { eventType });
      return res.status(401).json({ error: "Invalid signature" });
    }
  } catch (error: any) {
    logger.error("AutoRamp webhook signature verification error", { error: error.message });
    return res.status(401).json({ error: "Signature verification failed" });
  }

  // Acknowledge immediately
  res.status(200).json({ received: true });

  // Process async
  try {
    const payload = req.body;
    const { event, data } = payload;

    await logWebhookEvent("autoramp", event, payload, data?.reference);

    logger.info("AutoRamp webhook received", { event, reference: data?.reference });

    switch (event) {
      case "account.created":
        await handleAccountCreated(data);
        break;
      case "onramp.completed":
      case "onramp.updated":
      case "onramp.failed":
        await handleOnrampEvent(event, data);
        break;
      case "offramp.completed":
      case "offramp.updated":
      case "offramp.failed":
        await handleOfframpEvent(event, data);
        break;
      case "transfer.completed":
      case "transfer.failed":
        await handleTransferEvent(event, data);
        break;
      default:
        logger.info("Unhandled AutoRamp event", { event });
    }
  } catch (error: any) {
    logger.error("AutoRamp webhook processing error", { error: error.message });
  }
});

// ============================================
// Event handlers
// ============================================

async function handleAccountCreated(data: any) {
  logger.info("Account created webhook", { data });

  // Find user by reference and update
  if (data.reference) {
    const user = await prisma.user.findFirst({
      where: { autorampSubId: data.reference },
    });
    if (user) {
      await prisma.user.update({
        where: { id: user.id },
        data: {
          bankAccount: data.accountNumber,
          bankCode: data.bankCode,
          bankName: data.bankName,
          kycStatus: "verified",
        },
      });
    }
  }
}

async function handleOnrampEvent(event: string, data: any) {
  logger.info("Onramp event", { event, reference: data.reference, status: data.status });

  if (data.reference) {
    const statusMap: Record<string, string> = {
      "onramp.completed": "completed",
      "onramp.failed": "failed",
      "onramp.updated": "processing",
    };

    const transaction = await prisma.transaction.findFirst({
      where: { reference: data.reference },
    });

    if (transaction) {
      const newStatus = statusMap[event] || data.status?.toLowerCase() || "processing";
      await prisma.transaction.update({
        where: { id: transaction.id },
        data: {
          status: newStatus,
          metadata: { ...((transaction.metadata as any) || {}), autorampData: data },
        },
      });

      // Notify user via WhatsApp
      if (transaction.recipientPhone) {
        const { whatsapp } = await import("../services/whatsapp");
        if (event === "onramp.completed") {
          await whatsapp.sendTextMessage(
            transaction.recipientPhone,
            `Your payment of ${formatAmount(transaction.amount)} has been completed!`
          );
        } else if (event === "onramp.failed") {
          await whatsapp.sendTextMessage(
            transaction.recipientPhone,
            `Your payment could not be processed. Please try again or contact support.`
          );
        }
      }
    }
  }
}

async function handleOfframpEvent(event: string, data: any) {
  logger.info("Offramp event", { event, reference: data.reference, status: data.status });

  if (data.reference) {
    const transaction = await prisma.transaction.findFirst({
      where: { reference: data.reference },
    });

    if (transaction) {
      const statusMap: Record<string, string> = {
        "offramp.completed": "completed",
        "offramp.failed": "failed",
        "offramp.updated": "processing",
      };

      await prisma.transaction.update({
        where: { id: transaction.id },
        data: {
          status: statusMap[event] || "processing",
          metadata: { ...((transaction.metadata as any) || {}), autorampData: data },
        },
      });
    }
  }
}

async function handleTransferEvent(event: string, data: any) {
  logger.info("Transfer event", { event, reference: data.reference, status: data.status });

  if (data.reference) {
    const transaction = await prisma.transaction.findFirst({
      where: { reference: data.reference },
    });

    if (transaction) {
      const newStatus = event === "transfer.completed" ? "completed" : "failed";
      await prisma.transaction.update({
        where: { id: transaction.id },
        data: {
          status: newStatus,
          metadata: { ...((transaction.metadata as any) || {}), autorampData: data },
        },
      });

      const { whatsapp } = await import("../services/whatsapp");
      const user = await prisma.user.findUnique({ where: { id: transaction.userId } });
      if (user) {
        if (event === "transfer.completed") {
          await whatsapp.sendTemplate(
            user.phone,
            TEMPLATES.TRANSFER_COMPLETE.NAME,
            [
              formatAmount(transaction.amount),
              `${transaction.accountName} - ${transaction.bankAccount}`,
              transaction.bankName || "Bank",
              transaction.reference,
            ],
            TEMPLATES.TRANSFER_COMPLETE.LANGUAGE
          );
        } else {
          await whatsapp.sendTextMessage(
            user.phone,
            `Transfer of ${formatAmount(transaction.amount)} to ${transaction.accountName} failed. Please try again.`
          );
        }
      }
    }
  }
}

export default router;
