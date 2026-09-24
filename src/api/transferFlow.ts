import { config } from "@/config";
import { Router, Request, Response } from "express";
import { createLogger } from "@/utils/logger";
import { autoramp } from "@/services/autoramp";
import { whatsapp } from "@/services/whatsapp";
import { MESSAGES, TEMPLATES } from "@/config/constants";
import { prisma, getSession, updateSession, resetSession, updateTransaction, getTransactionByReference } from "@/services/database";
import { verifyPin } from "@/utils/pin";
import { formatAmount, generateTransactionReference } from "@/utils/helpers";
import { decryptFlowRequest, encryptFlowResponse, screen } from "@/utils/flowCrypto";

const logger = createLogger("transfer-flow");

const router = Router();

const MAX_PIN_ATTEMPTS = 3;
const LOCKOUT_MINUTES = 15;

interface PendingTransfer {
  reference?: string;
  amount: number;
  bankCode: string;
  bankName: string;
  accountNumber: string;
  accountName: string;
  pinAttempts?: number;
  pinLockedUntil?: string;
}

async function getPendingTransfer(userId: string): Promise<PendingTransfer | null> {
  const session = await getSession(userId);
  const data = (session.flowData as any)?.pendingTransfer;
  if (!data) return null;
  return data as PendingTransfer;
}

async function setPendingTransfer(userId: string, transfer: PendingTransfer | null) {
  const session = await getSession(userId);
  const flowData = (session.flowData as any) || {};
  if (transfer) {
    flowData.pendingTransfer = transfer;
  } else {
    delete flowData.pendingTransfer;
  }
  await updateSession(userId, session.state, flowData);
}

function isLocked(transfer: PendingTransfer): boolean {
  if (!transfer.pinLockedUntil) return false;
  return new Date(transfer.pinLockedUntil) > new Date();
}

function summaryOf(transfer: PendingTransfer): string {
  return `Amount: ${formatAmount(transfer.amount)}\nTo: ${transfer.accountName}\nAccount: ${transfer.accountNumber} - ${transfer.bankName}`;
}

/** PIN verified successfully — route to the terminal close screen. */
function closeFlow() {
  return screen("AUTHORIZED");
}

/** Stay on PIN screen so the user can retry after a validation error. */
function pinScreen(data: Record<string, unknown> = {}) {
  return screen("VERIFY_PIN", data);
}

/**
 * Result goes to chat, never inside the Flow.
 * Template-only sends (no free-text fallback) — params must match the
 * approved bodies in src/config/templates.json exactly.
 * Never blocks the Flow response — failures only log.
 */
async function notifyText(userId: string, text: string) {
  try {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user?.phone) return;
    await whatsapp.sendTextMessage(user.phone, text);
  } catch (error: any) {
    logger.error("Failed to send transfer result message", { userId, error: error.message });
  }
}

async function notifyTransferSuccess(userId: string, transfer: PendingTransfer, reference: string) {
  try {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user?.phone) return;
    const sent = await whatsapp.sendTemplate(
      user.phone,
      TEMPLATES.TRANSFER_COMPLETE.NAME,
      [
        formatAmount(transfer.amount),
        transfer.accountName,
        transfer.bankName,
        transfer.accountNumber,
        reference,
      ],
      TEMPLATES.TRANSFER_COMPLETE.LANGUAGE
    );
    if (!sent) {
      logger.warn("transfer_complete template send failed", { userId, reference });
    }
  } catch (error: any) {
    logger.error("Failed to send transfer success message", { userId, error: error.message });
  }
}

async function notifyTransferInitiated(userId: string, transfer: PendingTransfer, reference: string) {
  try {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user?.phone) return;
    await whatsapp.sendTextMessage(
      user.phone,
      `Transfer of ${formatAmount(transfer.amount)} to ${transfer.accountName} has been initiated. Reference: ${reference}. You will receive a confirmation shortly.`
    );
  } catch (error: any) {
    logger.error("Failed to send transfer initiated message", { userId, error: error.message });
  }
}

async function notifyTransferFailed(userId: string, transfer: PendingTransfer, reason: string) {
  try {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user?.phone) return;
    const name = (user.name || "there").trim() || "there";
    const sent = await whatsapp.sendTemplate(
      user.phone,
      TEMPLATES.TRANSFER_FAILED.NAME,
      [name, formatAmount(transfer.amount), transfer.accountName, reason.slice(0, 120)],
      TEMPLATES.TRANSFER_FAILED.LANGUAGE
    );
    if (!sent) {
      logger.warn("transfer_failed template send failed (template may not be approved yet)", { userId });
    }
  } catch (error: any) {
    logger.error("Failed to send transfer failure message", { userId, error: error.message });
  }
}

async function handleVerifyPin(userId: string, data: any) {
  const pin = String(data.pin || "").replace(/[^0-9]/g, "");
  logger.info("Transfer PIN received", { userId, pinLength: pin.length });

  const transfer = await getPendingTransfer(userId);

  if (!transfer) {
    logger.warn("No pending transfer for PIN verification", { userId });
    await notifyText(userId, MESSAGES.SEND_MONEY.FAILED("No pending transfer. Please start again."));
    await resetSession(userId).catch(() => {});
    return closeFlow();
  }

  if (isLocked(transfer)) {
    logger.warn("Transfer PIN locked", { userId });
    await notifyTransferFailed(
      userId,
      transfer,
      `Too many failed PIN attempts. Try again in ${LOCKOUT_MINUTES} minutes.`
    );
    return closeFlow();
  }

  if (pin.length !== 4) {
    return pinScreen( {
      transfer_summary: summaryOf(transfer),
      error_message: "Enter a 4-digit PIN.",
    });
  }

  const credentials = await prisma.userCredential.findUnique({
    where: { userId },
  });

  if (!credentials?.pin && !config.features.dryRun) {
    logger.warn("User has no PIN set", { userId });
    await notifyTransferFailed(userId, transfer, "You have not set a PIN. Please complete setup first.");
    await setPendingTransfer(userId, null);
    await resetSession(userId).catch(() => {});
    return closeFlow();
  }

  if (!config.features.dryRun && !verifyPin(pin, credentials?.pin || "")) {
    const attempts = (transfer.pinAttempts || 0) + 1;
    const remaining = MAX_PIN_ATTEMPTS - attempts;

    if (remaining <= 0) {
      const lockedUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000).toISOString();
      await setPendingTransfer(userId, { ...transfer, pinAttempts: attempts, pinLockedUntil: lockedUntil });
      if (transfer.reference) {
        await updateTransaction(transfer.reference, {
          status: "failed",
          metadata: { failureReason: "pin_lockout" },
        });
      }
      logger.warn("Transfer PIN max attempts reached", { userId, reference: transfer.reference });
      await notifyTransferFailed(
        userId,
        transfer,
        `Too many failed PIN attempts. Try again in ${LOCKOUT_MINUTES} minutes.`
      );
      return closeFlow();
    }

    await setPendingTransfer(userId, { ...transfer, pinAttempts: attempts });
    return pinScreen( {
      transfer_summary: summaryOf(transfer),
      error_message: `Incorrect PIN. ${remaining} ${remaining === 1 ? "attempt" : "attempts"} left.`,
    });
  }

  // PIN correct — execute the transfer, notify in chat, close the form.
  const reference = transfer.reference || generateTransactionReference();
  transfer.reference = reference;

  try {
    // Guard against authorizing a transaction that was already cancelled or completed.
    const existing = await getTransactionByReference(reference);
    if (existing && existing.status !== "pending_pin") {
      logger.warn("Transfer authorization attempted on non-pending transaction", { userId, reference, status: existing.status });
      await notifyTransferFailed(userId, transfer, "This transaction was already cancelled or completed.");
      await setPendingTransfer(userId, null);
      await resetSession(userId).catch(() => {});
      return closeFlow();
    }

    await updateTransaction(reference, { status: "processing" });

    if (config.features.dryRun) {
      logger.info("Transfer dry-run: skipping AutoRamp, mocking completion", { userId, reference });
      await updateTransaction(reference, { status: "completed" });
      await setPendingTransfer(userId, null);
      await resetSession(userId).catch(() => {});
      await notifyTransferSuccess(userId, transfer, reference);
      return closeFlow();
    }

    // Real mode: submit to AutoRamp, tell the user it is in progress,
    // then let the AutoRamp webhook send the final success/failure message.
    // Debit the user's own sub-account, never the merchant's main account.
    const debitAccount = await prisma.bankAccount.findUnique({ where: { userId } });
    await autoramp.transfer({
      beneficiaryBankCode: transfer.bankCode,
      beneficiaryAccountNumber: transfer.accountNumber,
      amount: transfer.amount,
      narration: `3rike Pay - ${transfer.accountName}`,
      paymentReference: reference,
      ...(debitAccount?.accountNumber ? { debitAccountNumber: debitAccount.accountNumber } : {}),
    });

    logger.info("Transfer submitted to AutoRamp", { userId, reference });
    await setPendingTransfer(userId, null);
    await resetSession(userId).catch(() => {});
    await notifyTransferInitiated(userId, transfer, reference);
    return closeFlow();
  } catch (error: any) {
    logger.error("Transfer execution failed", { userId, reference, error: error.message });
    await updateTransaction(reference, { status: "failed" });
    await setPendingTransfer(userId, null);
    await resetSession(userId).catch(() => {});

    await notifyTransferFailed(
      userId,
      transfer,
      error.message?.slice(0, 120) || "Transfer could not be completed. Please try again."
    );
    return closeFlow();
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
    logger.error("Transfer flow request decryption failed", { error: error.message });
    return res.status(421).send();
  }

  const { action, screen: currentScreen, data, flow_token } = payload;
  logger.info("Transfer flow request decoded", { action, screen: currentScreen, flow_token: flow_token ? "set" : "missing" });

  try {
    if (action === "ping") {
      return res.send(encryptFlowResponse({ data: { status: "active" } }, aesKey, iv));
    }

    if (data?.error_message) {
      logger.warn("Transfer flow client error", { error: data.error_message });
      return res.send(encryptFlowResponse({ data: { acknowledged: true } }, aesKey, iv));
    }

    const userId = String(flow_token || "");
    if (!userId || userId === "unused") {
      return res.send(
        encryptFlowResponse(
          pinScreen( { error_message: "Session expired. Please start again." }),
          aesKey,
          iv
        )
      );
    }

    if (action === "INIT") {
      const transfer = await getPendingTransfer(userId);
      if (!transfer) {
        return res.send(
          encryptFlowResponse(
            pinScreen( { error_message: "No pending transfer. Please start again." }),
            aesKey,
            iv
          )
        );
      }
      return res.send(
        encryptFlowResponse(
          pinScreen( { transfer_summary: summaryOf(transfer) }),
          aesKey,
          iv
        )
      );
    }

    if (action === "data_exchange") {
      const safePayload = { ...data };
      if (safePayload.pin) safePayload.pin = "[redacted]";
      logger.debug("Transfer flow data_exchange", { userId, currentScreen, payloadData: safePayload });

      if (currentScreen === "VERIFY_PIN") {
        const next = await handleVerifyPin(userId, data || {});
        logger.info("Transfer flow response", { userId, currentScreen, nextScreen: next.screen });
        return res.send(encryptFlowResponse(next, aesKey, iv));
      }

      return res.send(encryptFlowResponse(screen("VERIFY_PIN"), aesKey, iv));
    }

    if (action === "complete") {
      logger.info("Transfer flow complete", { userId, currentScreen });
      return res.send(encryptFlowResponse(screen("AUTHORIZED"), aesKey, iv));
    }

    return res.send(encryptFlowResponse(pinScreen(), aesKey, iv));
  } catch (error: any) {
    logger.error("Transfer flow handler error", { action, screen: currentScreen, error: error.message });
    try {
      const userId = String(flow_token || "");
      if (userId && userId !== "unused") {
        await notifyText(userId, MESSAGES.SEND_MONEY.FAILED("Something went wrong. Try again."));
      }
    } catch {}
    return res.send(encryptFlowResponse(screen("VERIFY_PIN"), aesKey, iv));
  }
});

export default router;
