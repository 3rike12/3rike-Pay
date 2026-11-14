import { Prisma } from "@prisma/client";
import { config } from "@/config";
import { prisma } from "@/db/prisma";
import { nearIntents, evmChainIdFor, prettyOrigin, type PayableToken } from "@/services/nearIntents";
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
 * Every quote mints its own deposit address, and money sent to ANY of them is
 * a real payment. Quotes are therefore kept as a history and all polled; this
 * caps how many one invoice may mint (also stops quote-spam).
 */
const MAX_QUOTES_PER_INVOICE = 8;

/** What a wallet needs to build the transfer for a token. */
export function originMetaFor(token: PayableToken) {
  return {
    symbol: token.symbol,
    chain: token.blockchain,
    chainId: evmChainIdFor(token.blockchain),
    tokenAddress: token.contractAddress ?? null,
    decimals: token.decimals,
  };
}

/** Default payment (USDC on Base) so a customer opening the link finds it ready. */
export async function createDefaultCryptoPayment(merchantId: string, invoiceId: string) {
  if (config.nearIntents.network === "tidepool") {
    // A Tidepool quote needs the payer's wallet as refundTo. The pay page
    // creates it after the buyer connects, rather than pre-quoting here.
    throw new Error("Tidepool quotes are created after the buyer connects a wallet.");
  }
  const token = await nearIntents.resolveOriginAsset("USDC", "base");
  if (!token) throw new Error("The default payment token is unavailable.");
  return createCryptoPayment({
    merchantId,
    invoiceId,
    originAsset: token.assetId,
    originLabel: `${token.symbol} on ${token.blockchain}`,
    originMeta: originMetaFor(token),
  });
}

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
  /** Where a failed swap's refund goes: the buyer's own wallet when known. */
  refundTo?: string;
  /** Token/chain details a wallet needs to build the transfer. */
  originMeta?: Record<string, unknown>;
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
    (existing.refundTo ?? null) === (params.refundTo ?? null) &&
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

  const prior: Array<Record<string, unknown>> =
    (transaction.metadata as any)?.nearQuotes ??
    (existing?.depositAddress
      ? [{ depositAddress: existing.depositAddress, depositMemo: existing.depositMemo ?? null }]
      : []);
  if (prior.length >= MAX_QUOTES_PER_INVOICE) {
    throw new Error("Too many payment changes for this invoice. Please reload the page and keep your current choice.");
  }

  const deadline = new Date(Date.now() + INVOICE_TTL_MINUTES * 60 * 1000);
  const amountOut = nearIntents.fiatToDestinationUnits(invoice.amount, invoice.currency);
  const { quote } = await nearIntents.requestQuote({
    amountOut,
    originAsset: params.originAsset,
    refundTo: params.refundTo,
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
    refundTo: params.refundTo ?? null,
    origin: params.originMeta ?? null,
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
        nearQuotes: [
          ...prior,
          {
            depositAddress: details.depositAddress,
            depositMemo: details.depositMemo,
            originLabel: details.originLabel,
            amountInFormatted: details.amountInFormatted,
            createdAt: new Date().toISOString(),
          },
        ],
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

async function recordReceipt(reference: string, receipt: Record<string, unknown>) {
  const tx = await prisma.transaction.findUnique({ where: { reference } });
  if (!tx) return;
  await prisma.transaction.update({
    where: { reference },
    data: { metadata: { ...((tx.metadata as Record<string, unknown>) || {}), receipt } as Prisma.InputJsonValue },
  });
}

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
  // An expired invoice is NOT final: money may still arrive for a deposit
  // address minted before it expired, and that is a real payment. Fall through
  // and poll; only report "expired" once we know nothing was paid.
  const wasExpired = invoice.status === INVOICE_STATUS.EXPIRED;
  if (invoice.status === INVOICE_STATUS.CANCELLED) return { state: "failed" };

  const transaction = await prisma.transaction.findUnique({ where: { reference } });
  const meta = (transaction?.metadata as any) || {};

  if (invoice.status === INVOICE_STATUS.FAILED) {
    return { state: meta.nearStatus === "REFUNDED" ? "refunded" : "failed", nearStatus: meta.nearStatus };
  }

  const quotes: Array<{ depositAddress: string; depositMemo?: string | null }> =
    meta.nearQuotes ?? (meta.nearIntents?.depositAddress ? [meta.nearIntents] : []);
  if (quotes.length === 0) return { state: "unknown" };

  // Poll every deposit address this invoice ever minted: the customer may
  // have paid an earlier one before changing their selection.
  const results = await Promise.allSettled(
    quotes.map((q) => nearIntents.getStatus(q.depositAddress, q.depositMemo ?? undefined))
  );
  const statuses = results.map((r) => (r.status === "fulfilled" ? r.value : null));
  const answered = statuses.filter((r): r is NonNullable<typeof r> => r !== null);

  const successIdx = statuses.findIndex((r) => r?.status === "SUCCESS");
  if (successIdx >= 0) {
    const success = statuses[successIdx]!;
    // What was actually paid, and the proof - shown to the customer and the merchant.
    const sd: any = (success as any).swapDetails || {};
    const paidQuote: any = quotes[successIdx] || {};
    const tx = sd.originChainTxHashes?.[0];
    const crypto = {
      paidAt: new Date().toISOString(),
      paidWith:
        `${sd.amountInFormatted ?? paidQuote.amountInFormatted ?? ""} ${prettyOrigin(paidQuote.originLabel)}`.trim() ||
        null,
      txHash: tx?.hash ?? null,
      txUrl: typeof tx?.explorerUrl === "string" && tx.explorerUrl.startsWith("https://") ? tx.explorerUrl : null,
    };
    if (wasExpired) logger.warn("Late payment on an expired invoice - settling it", { reference });
    await settleInvoicePayment(reference, { source: "near_poll", provider: "near-intents", nearIntents: success, crypto });
    await prisma.transaction.updateMany({ where: { reference }, data: { status: "completed" } });
    await recordReceipt(reference, crypto);
    return { state: "paid", nearStatus: success.status };
  }

  const inFlight = answered.find((r) => r.status === "PROCESSING" || r.status === "KNOWN_DEPOSIT_TX");
  if (inFlight) return { state: "processing", nearStatus: inFlight.status };

  if (wasExpired) return { state: "expired" };

  // Refunded/failed only when EVERY address is dead - one unused or expired
  // quote must not fail an invoice that still has a live one.
  const allDead =
    answered.length === quotes.length && answered.every((r) => r.status === "REFUNDED" || r.status === "FAILED");
  if (allDead) {
    const nearStatus = answered.some((r) => r.status === "REFUNDED") ? "REFUNDED" : "FAILED";
    await recordNearStatus(reference, nearStatus);
    await failInvoicePayment(reference, nearStatus);
    await prisma.transaction.updateMany({ where: { reference }, data: { status: "failed" } });
    return { state: nearStatus === "REFUNDED" ? "refunded" : "failed", nearStatus };
  }

  // Nothing paid and the window has closed.
  if (invoice.expiresAt && invoice.expiresAt.getTime() < Date.now()) {
    await prisma.invoice.updateMany({
      where: { id: invoice.id, status: { in: [INVOICE_STATUS.SENT, INVOICE_STATUS.PENDING] } },
      data: { status: INVOICE_STATUS.EXPIRED },
    });
    return { state: "expired" };
  }

  return { state: "awaiting_payment", nearStatus: answered[answered.length - 1]?.status };
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

/**
 * When a durable queue (BullMQ over Redis) is running it registers itself
 * here, and polling is handed to it. Without Redis this stays null and the
 * in-process timer chain below is used instead.
 */
let queueScheduler: ((reference: string) => Promise<void>) | null = null;
export function setVerificationScheduler(fn: ((reference: string) => Promise<void>) | null) {
  queueScheduler = fn;
}

/** Start tracking a payment: the durable queue if available, else an in-process timer chain. */
export function scheduleCryptoVerification(reference: string, delaysMs: number[] = POLL_DELAYS_MS): void {
  if (queueScheduler) {
    // Never let a slow or unreachable Redis hang the caller or lose the payment:
    // fall back to timers if the queue does not accept the job quickly.
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("queue timeout")), 5_000).unref?.());
    Promise.race([queueScheduler(reference), timeout]).catch((error: any) => {
      logger.warn("Queue unavailable, tracking with in-process timers", { reference, error: error?.message });
      startTimerChain(reference, delaysMs);
    });
    return;
  }
  startTimerChain(reference, delaysMs);
}

function startTimerChain(reference: string, delaysMs: number[]): void {
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
