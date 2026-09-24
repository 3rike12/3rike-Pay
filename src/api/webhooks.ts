import { Router, Request, Response } from "express";
import { config } from "@/config";
import { createLogger } from "@/utils/logger";

const logger = createLogger("webhook");
import { handleMessage } from "@/bot";
import { whatsapp } from "@/services/whatsapp";
import { prisma, logWebhookEvent } from "@/services/database";
import { autoramp } from "@/services/autoramp";
import { cleanPhone, formatAmount, redactSensitiveText } from "@/utils/helpers";
import { TEMPLATES, KYC_STATUS } from "@/config/constants";

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

            // Idempotency: Meta retries deliveries (same msg.id). Without this
            // guard a retried "Hi" or a retried "Create wallet" tap is
            // processed twice - the user gets the welcome / flow message twice.
            if (msg.id) {
              const duplicate = await prisma.webhookEvent
                .findFirst({
                  where: { source: "whatsapp", eventType: "message", reference: msg.id },
                })
                .catch(() => null);
              if (duplicate) {
                logger.info("Skipping duplicate WhatsApp delivery", { messageId: msg.id });
                continue;
              }
            }

            // Log webhook event for idempotency. The body is scrubbed first -
            // this row is persisted, and a KYC step puts a BVN in it.
            await logWebhookEvent("whatsapp", "message", {
              messageId: msg.id,
              from: phone,
              type: msg.type,
              text: redactSensitiveText(text),
            }, msg.id);

            // Blue ticks + "typing..." while the bot works. One request does
            // both (read receipt carrying the typing indicator).
            // Fire-and-forget: the reply must never depend on this succeeding,
            // and the indicator auto-dismisses when the reply lands (or after
            // 25s).
            void whatsapp.markAsRead(msg.id).catch(() => {});

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
            const error = status.errors?.[0];
            logger.info("WhatsApp status update", {
              messageId: status.id,
              status: status.status,
              recipientId: status.recipient_id,
              errorCode: error?.code,
              errorTitle: error?.title,
              errorMessage: error?.message,
              errorDetails: error?.error_data?.details,
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

  // express.raw() gives us the untouched bytes AutoRamp signed
  const rawBody: Buffer = Buffer.isBuffer(req.body)
    ? req.body
    : Buffer.from(JSON.stringify(req.body));

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
    const payload = JSON.parse(rawBody.toString("utf8"));
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
      case "subaccount.inflow":
      case "account.credit":
        await handleInflow(data);
        break;
      case "bank_transfer.completed":
      case "transfer.completed":
      case "transfer.failed":
        await handleBankTransfer(event, data);
        break;
      case "swap.updated":
      case "vas.updated":
        await handleTransactionUpdated(data);
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

  const accountNumber = String(data.accountNumber ?? "").replace(/[^0-9]/g, "");
  const reference = data.reference as string | undefined;

  if (!accountNumber && !reference) return;

  const bankAccount = await prisma.bankAccount.findFirst({
    where: {
      OR: [
        ...(accountNumber ? [{ accountNumber }] : []),
        ...(reference ? [{ reference }] : []),
      ],
    },
  });

  if (!bankAccount) {
    logger.warn("account.created for unknown account", { accountNumber, reference });
    return;
  }

  await prisma.bankAccount.update({
    where: { id: bankAccount.id },
    data: {
      accountNumber: data.accountNumber ?? bankAccount.accountNumber,
      accountName: data.accountName ?? bankAccount.accountName,
      bankCode: data.bankCode ?? bankAccount.bankCode,
      bankName: data.bankName ?? bankAccount.bankName,
    },
  });
  await prisma.user.update({
    where: { id: bankAccount.userId },
    data: { kycStatus: KYC_STATUS.VERIFIED },
  });
}

/**
 * Fires when money lands in an account:
 * - `subaccount.inflow` (SafeHaven) uses `data.accountNumber`
 * - `account.credit` uses `data.creditAccountNumber`
 * Notify the account holder in chat.
 */
async function handleInflow(data: any) {
  const accountNumber = String(data.accountNumber ?? data.creditAccountNumber ?? "").replace(/[^0-9]/g, "");
  if (!accountNumber) {
    logger.warn("inflow event missing account number", { data: JSON.stringify(data) });
    return;
  }

  const bankAccount = await prisma.bankAccount.findFirst({
    where: { accountNumber },
    include: { user: true },
  });

  if (!bankAccount?.user) {
    logger.warn("inflow event for unknown account", { accountNumber });
    return;
  }

  const amount = Number(data.amount);
  const sender = data.debitAccountName || data.debitAccountNumber || "Bank deposit";

  await whatsapp.sendTextMessage(
    bankAccount.user.phone,
    `*Deposit Received*\n\nAmount: ${Number.isFinite(amount) ? formatAmount(amount) : "—"}\nFrom: ${sender}\nAccount: ${accountNumber}`
  );
}

/** Normalise AutoRamp statuses (PENDING/PROCESSING/COMPLETED/FAILED/CANCELLED) to our lowercase values. */
function normalizeStatus(event: string, data: any): string {
  const raw = String(data.status || "").toLowerCase();
  if (["pending", "processing", "completed", "failed", "cancelled"].includes(raw)) {
    return raw;
  }
  if (event.endsWith(".completed")) return "completed";
  if (event.endsWith(".failed")) return "failed";
  return "processing";
}

async function handleOnrampEvent(event: string, data: any) {
  logger.info("Onramp event", { event, reference: data.reference, status: data.status });

  if (data.reference) {
    const transaction = await prisma.transaction.findFirst({
      where: { reference: data.reference },
    });

    if (transaction) {
      const newStatus = normalizeStatus(event, data);
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
        if (newStatus === "completed") {
          await whatsapp.sendTextMessage(
            transaction.recipientPhone,
            `Your payment of ${formatAmount(transaction.amount)} has been completed!`
          );
        } else if (newStatus === "failed") {
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
      await prisma.transaction.update({
        where: { id: transaction.id },
        data: {
          status: normalizeStatus(event, data),
          metadata: { ...((transaction.metadata as any) || {}), autorampData: data },
        },
      });
    }
  }
}

/** Generic status sync for *.updated events we don't otherwise special-case. */
async function handleTransactionUpdated(data: any) {
  const reference = data.reference;
  if (!reference) return;

  const transaction = await prisma.transaction.findFirst({ where: { reference } });
  if (!transaction) return;

  await prisma.transaction.update({
    where: { id: transaction.id },
    data: {
      status: normalizeStatus("", data),
      metadata: { ...((transaction.metadata as any) || {}), autorampData: data },
    },
  });
}

async function handleBankTransfer(event: string, data: any) {
  logger.info("Transfer event", { event, reference: data.reference, status: data.status });

  // AutoRamp's `reference` ("bnk_…") is stored at initiation time on the
  // transaction as autorampRef. Fall back to our own reference for any
  // transaction that wasn't linked.
  const ref = data.reference as string | undefined;
  if (!ref) return;

  const transaction = await prisma.transaction.findFirst({
    where: { OR: [{ autorampRef: ref }, { reference: ref }] },
  });

  if (transaction) {
      const newStatus = normalizeStatus(event, data);
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
        if (newStatus === "completed") {
          const amount = formatAmount(transaction.amount);
          const recipient = transaction.accountName || "Recipient";
          const bank = transaction.bankName || "Bank";
          const account = transaction.bankAccount || "";

          const sent = await whatsapp.sendTemplate(
            user.phone,
            TEMPLATES.TRANSFER_COMPLETE.NAME,
            [amount, recipient, bank, account, transaction.reference],
            TEMPLATES.TRANSFER_COMPLETE.LANGUAGE
          );
          if (!sent) {
            logger.warn("transfer_complete template send failed", { reference: transaction.reference });
          }
        } else {
          const name = (user.name || "there").trim() || "there";
          const sent = await whatsapp.sendTemplate(
            user.phone,
            TEMPLATES.TRANSFER_FAILED.NAME,
            [name, formatAmount(transaction.amount), transaction.accountName || "Recipient", "AutoRamp transfer failed"],
            TEMPLATES.TRANSFER_FAILED.LANGUAGE
          );
          if (!sent) {
            logger.warn("transfer_failed template send failed", { reference: transaction.reference });
          }
        }
      }
    }
}

export default router;
