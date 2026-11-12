import { Prisma } from "@prisma/client";
import { config } from "@/config";
import { prisma } from "@/db/prisma";
import { nearIntents } from "@/services/nearIntents";
import {
  INVOICE_STATUS,
  INVOICE_TTL_MINUTES,
  getInvoiceById,
  getInvoiceByReference,
  issueInvoice,
  markPendingPayment,
  settleInvoicePayment,
  failInvoicePayment,
} from "@/services/invoice";
import { createLogger } from "@/utils/logger";

const logger = createLogger("crypto-invoice");

/**
 * Create a crypto payment for an invoice via NEAR Intents.
 *
 * Same ordering rule as the Flutterwave path: persist the Transaction row
 * BEFORE anything can settle it. The buyer pays `quote.amountInFormatted` of
 * the origin asset to `depositAddress`; the platform receives the invoice's
 * USD value. Calling again on an invoice that already has a live deposit
 * address returns it instead of minting a second quote.
 */
export async function createCryptoPayment(params: {
  merchantId: string;
  invoiceId: string;
  originAsset?: string;
  /** Human label for messages, e.g. "USDC on Base". */
  originLabel?: string;
}) {
  if (!nearIntents.isNearIntentsEnabled()) {
    throw new Error("Crypto payments are not enabled yet.");
  }

  const invoice = await getInvoiceById(params.invoiceId, params.merchantId);
  if (!invoice) throw new Error("Invoice not found.");
  if (invoice.status === INVOICE_STATUS.PAID) throw new Error("This invoice is already paid.");
  if (!["draft", "sent", "pending_payment"].includes(invoice.status)) {
    throw new Error(`This invoice is ${invoice.status} and cannot be paid.`);
  }

  const reference = invoice.reference;
  let transaction = await prisma.transaction.findUnique({ where: { reference } });

  const existing = (transaction?.metadata as any)?.nearIntents;
  const wantedOrigin = params.originAsset ?? config.nearIntents.originAsset;
  if (
    existing?.depositAddress &&
    existing.originAsset === wantedOrigin &&
    existing.deadline &&
    new Date(existing.deadline) > new Date()
  ) {
    return { invoice, reference, ...existing };
  }

  if (!transaction) {
    transaction = await prisma.transaction.create({
      data: {
        userId: invoice.merchantId,
        reference,
        type: "invoice",
        amount: invoice.amount,
        currency: invoice.currency,
        status: "pending",
        description: "Crypto payment request",
        recipientPhone: invoice.buyerPhone,
        metadata: { invoiceId: invoice.id },
      },
    });
  }

  const deadline = new Date(Date.now() + INVOICE_TTL_MINUTES * 60 * 1000);
  const amountOut = nearIntents.fiatToDestinationUnits(invoice.amount, invoice.currency);
  const { quote } = await nearIntents.requestQuote({
    amountOut,
    originAsset: params.originAsset,
    deadline,
  });

  if (!quote.depositAddress) throw new Error("NEAR Intents returned no deposit address.");

  const details = {
    depositAddress: quote.depositAddress,
    depositMemo: quote.depositMemo ?? null,
    amountIn: quote.amountIn,
    amountInFormatted: quote.amountInFormatted ?? null,
    amountOut: quote.amountOut,
    originAsset: params.originAsset ?? config.nearIntents.originAsset,
    originLabel: params.originLabel ?? null,
    // The invoice's own TTL, not 1Click's quote lifetime (which can be days).
    deadline: deadline.toISOString(),
  };

  if (invoice.status === INVOICE_STATUS.DRAFT) {
    await issueInvoice(invoice.id, params.merchantId);
  }
  const pending = await markPendingPayment(invoice.id, params.merchantId);

  await prisma.transaction.update({
    where: { id: transaction.id },
    data: {
      status: "processing",
      metadata: {
        ...((transaction.metadata as Record<string, unknown>) || {}),
        invoiceId: invoice.id,
        provider: "near-intents",
        nearIntents: details,
      } as Prisma.InputJsonValue,
    },
  });

  logger.info("Crypto payment created", { invoiceId: invoice.id, reference, amountOut });
  return { invoice: pending, reference, ...details };
}

export type CryptoPayState =
  | "awaiting_payment" // quote exists, nothing deposited yet
  | "processing" // deposit seen, swap in flight
  | "paid"
  | "refunded"
  | "failed"
  | "expired"
  | "unknown";

async function recordNearStatus(reference: string, nearStatus: string) {
  const tx = await prisma.transaction.findUnique({ where: { reference } });
  if (!tx) return;
  await prisma.transaction.update({
    where: { reference },
    data: { metadata: { ...((tx.metadata as Record<string, unknown>) || {}), nearStatus } as Prisma.InputJsonValue },
  });
}

/**
 * Poll 1Click once (when the invoice is still open) and settle/fail it.
 * Returns a state precise enough for a buyer-facing page: a refund is not the
 * same as a failure.
 */
export async function getCryptoPaymentState(
  reference: string
): Promise<{ state: CryptoPayState; nearStatus?: string }> {
  const invoice = await getInvoiceByReference(reference);
  if (!invoice) return { state: "unknown" };
  if (invoice.status === INVOICE_STATUS.PAID) return { state: "paid" };
  if (invoice.status === INVOICE_STATUS.EXPIRED) return { state: "expired" };
  if (invoice.status === INVOICE_STATUS.CANCELLED) return { state: "failed" };

  const transaction = await prisma.transaction.findUnique({ where: { reference } });
  const meta = (transaction?.metadata as any) || {};

  if (invoice.status === INVOICE_STATUS.FAILED) {
    return { state: meta.nearStatus === "REFUNDED" ? "refunded" : "failed", nearStatus: meta.nearStatus };
  }

  const details = meta.nearIntents;
  if (!details?.depositAddress) return { state: "unknown" };

  try {
    const res = await nearIntents.getStatus(details.depositAddress, details.depositMemo ?? undefined);

    if (res.status === "SUCCESS") {
      await settleInvoicePayment(reference, { source: "near_poll", provider: "near-intents", nearIntents: res });
      await prisma.transaction.updateMany({ where: { reference }, data: { status: "completed" } });
      return { state: "paid", nearStatus: res.status };
    }
    if (res.status === "REFUNDED" || res.status === "FAILED") {
      await recordNearStatus(reference, res.status);
      await failInvoicePayment(reference, res.status);
      await prisma.transaction.updateMany({ where: { reference }, data: { status: "failed" } });
      return { state: res.status === "REFUNDED" ? "refunded" : "failed", nearStatus: res.status };
    }
    if (res.status === "PROCESSING" || res.status === "KNOWN_DEPOSIT_TX") {
      return { state: "processing", nearStatus: res.status };
    }
    return { state: "awaiting_payment", nearStatus: res.status };
  } catch (error: any) {
    logger.warn("Crypto verification poll failed", { reference, error: error?.message });
    return { state: "awaiting_payment" };
  }
}

/** Poll 1Click once and settle/fail the invoice. */
export async function verifyCryptoPayment(
  reference: string
): Promise<"settled" | "failed" | "pending" | "unknown"> {
  const { state } = await getCryptoPaymentState(reference);
  if (state === "paid") return "settled";
  if (state === "unknown") return "unknown";
  if (state === "failed" || state === "refunded" || state === "expired") return "failed";
  return "pending";
}

const POLL_DELAYS_MS = [20_000, 40_000, 60_000, 120_000, 180_000, 300_000, 600_000, 900_000];

/** Fire-and-forget polling chain (no cron in this repo), mirroring Flutterwave's. */
export function scheduleCryptoVerification(reference: string, delaysMs: number[] = POLL_DELAYS_MS): void {
  const run = (index: number) => {
    if (index >= delaysMs.length) return;
    const timer = setTimeout(() => {
      verifyCryptoPayment(reference)
        .then((r) => (r === "pending" ? run(index + 1) : undefined))
        .catch(() => run(index + 1));
    }, delaysMs[index]);
    timer.unref?.();
  };
  run(0);
}
