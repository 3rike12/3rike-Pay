import { Prisma } from "@prisma/client";
import { prisma } from "@/db/prisma";
import { ledger } from "@/services/ledger";
import { withIdempotencyKey } from "@/utils/idempotency";
import {
  formatCurrency,
  generateTransactionReference,
  toRwandaPhone,
} from "@/utils/helpers";
import { createLogger } from "@/utils/logger";

const logger = createLogger("invoice");

// ============================================
// Invoice / payment-request service
//
// Roles: Merchant (has an account) + anonymous Buyer (never messaged by us).
// The buyer authorises the debit from their own mobile-money handset; we
// only ever talk to the merchant.
//
// Draft -> sent -> pending_payment -> paid
//                       |-> failed
//                       |-> expired
//
// `reference` is the join key to Transaction.reference and doubles as the
// Flutterwave tx_ref. It is INTERNAL trace only - buyers never see it.
// ============================================

export const INVOICE_TTL_MINUTES = 30;

export const INVOICE_STATUS = {
  DRAFT: "draft",
  SENT: "sent",
  PENDING: "pending_payment",
  PAID: "paid",
  EXPIRED: "expired",
  FAILED: "failed",
  CANCELLED: "cancelled",
} as const;

export type InvoiceStatus = (typeof INVOICE_STATUS)[keyof typeof INVOICE_STATUS];

export interface InvoiceItem {
  name: string;
  qty: number;
  unitPrice: number;
}

/** Statuses that can still turn into a payment. */
const OPEN_STATUSES: InvoiceStatus[] = [
  INVOICE_STATUS.DRAFT,
  INVOICE_STATUS.SENT,
  INVOICE_STATUS.PENDING,
];

/** Statuses that should be swept to expired when past expiresAt. */
const EXPIRABLE_STATUSES: InvoiceStatus[] = [
  INVOICE_STATUS.SENT,
  INVOICE_STATUS.PENDING,
];

// --------------------------------------------
// Items
// --------------------------------------------

/**
 * Validate and normalise a line-item list, returning the grand total.
 * RWF has no practical subunit, so the total is rounded to an integer -
 * Flutterwave rejects fractional RWF amounts in practice.
 */
export function totalInvoiceItems(items: InvoiceItem[]): number {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("Invoice needs at least one item");
  }

  let total = 0;
  for (const item of items) {
    const qty = Number(item.qty);
    const unitPrice = Number(item.unitPrice);
    if (!Number.isFinite(qty) || qty <= 0) {
      throw new Error(`Invalid quantity for ${item.name}`);
    }
    if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
      throw new Error(`Invalid price for ${item.name}`);
    }
    total += qty * unitPrice;
  }

  return Math.round(total);
}

// --------------------------------------------
// Products (merchant catalogue)
// --------------------------------------------

export async function listProducts(merchantId: string) {
  return prisma.product.findMany({
    where: { merchantId, active: true },
    orderBy: { createdAt: "asc" },
  });
}

export async function createProduct(params: {
  merchantId: string;
  name: string;
  price: number;
  currency?: string;
  description?: string;
}) {
  const price = Number(params.price);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`Invalid price for ${params.name}`);
  }

  const product = await prisma.product.create({
    data: {
      merchantId: params.merchantId,
      name: params.name.trim(),
      price,
      currency: (params.currency || "RWF").toUpperCase(),
      description: params.description?.trim() || null,
    },
  });

  logger.info("Product created", {
    productId: product.id,
    merchantId: params.merchantId,
    name: product.name,
  });
  return product;
}

/** Soft-delete: the product disappears from the catalogue. */
export async function deactivateProduct(id: string, merchantId: string) {
  const result = await prisma.product.updateMany({
    where: { id, merchantId, active: true },
    data: { active: false },
  });
  return result.count > 0;
}

// --------------------------------------------
// Invoice lifecycle
// --------------------------------------------

/**
 * Create a draft invoice. Normalises the buyer's phone up front so a bad
 * number never reaches Flutterwave.
 */
export async function createDraftInvoice(params: {
  merchantId: string;
  buyerPhone: string;
  items: InvoiceItem[];
  description?: string;
  currency?: string;
}) {
  const phone = toRwandaPhone(params.buyerPhone);
  if (!phone) {
    throw new Error(
      `That does not look like a Rwanda mobile number: ${params.buyerPhone}. Use e.g. 0781234567 or +250781234567.`
    );
  }

  const amount = totalInvoiceItems(params.items);

  const invoice = await prisma.invoice.create({
    data: {
      merchantId: params.merchantId,
      buyerPhone: phone,
      items: params.items as unknown as Prisma.InputJsonValue,
      amount,
      currency: (params.currency || "RWF").toUpperCase(),
      reference: generateTransactionReference(),
      status: INVOICE_STATUS.DRAFT,
      expiresAt: null,
    },
  });

  logger.info("Draft invoice created", {
    invoiceId: invoice.id,
    merchantId: params.merchantId,
    amount,
    items: params.items.length,
  });
  return invoice;
}

export async function getInvoiceById(id: string, merchantId: string) {
  return prisma.invoice.findFirst({ where: { id, merchantId } });
}

export async function getInvoiceByReference(reference: string) {
  return prisma.invoice.findUnique({ where: { reference } });
}

export async function listInvoices(merchantId: string, status?: InvoiceStatus) {
  return prisma.invoice.findMany({
    where: status ? { merchantId, status } : { merchantId },
    orderBy: { createdAt: "desc" },
    take: 25,
  });
}

/**
 * Mark an invoice as issued (pushed to the buyer / charged). Starts the
 * TTL clock and stores the Flutterwave authorization URL so the merchant
 * can forward it as a fallback link.
 */
export async function issueInvoice(
  id: string,
  merchantId: string,
  options: { paymentUrl?: string | null; ttlMinutes?: number } = {}
) {
  const invoice = await getInvoiceById(id, merchantId);
  if (!invoice) return null;

  if (invoice.status === INVOICE_STATUS.PAID) {
    throw new Error("This invoice is already paid.");
  }
  if (!OPEN_STATUSES.includes(invoice.status as InvoiceStatus)) {
    throw new Error(`This invoice is ${invoice.status} and cannot be reissued.`);
  }

  const ttlMinutes = options.ttlMinutes ?? INVOICE_TTL_MINUTES;
  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

  const updated = await prisma.invoice.update({
    where: { id: invoice.id },
    data: {
      status: INVOICE_STATUS.SENT,
      expiresAt,
      paymentUrl: options.paymentUrl ?? invoice.paymentUrl,
    },
  });

  logger.info("Invoice issued", {
    invoiceId: updated.id,
    expiresAt,
    hasPaymentUrl: Boolean(options.paymentUrl),
  });
  return updated;
}

/**
 * Mark an invoice as handed to Flutterwave (charge accepted, awaiting
 * customer confirmation).
 */
export async function markPendingPayment(
  id: string,
  merchantId: string,
  paymentUrl?: string | null
) {
  const invoice = await getInvoiceById(id, merchantId);
  if (!invoice) return null;

  if (invoice.status === INVOICE_STATUS.PAID) return invoice;

  return prisma.invoice.update({
    where: { id: invoice.id },
    data: {
      status: INVOICE_STATUS.PENDING,
      paymentUrl: paymentUrl ?? invoice.paymentUrl,
    },
  });
}

/**
 * Settle an invoice: flip to paid and credit the merchant's ledger wallet.
 *
 * Idempotent on purpose - the Flutterwave webhook may deliver more than
 * once and the verify-poller can race with it. Safe to call from both.
 *
 * The ledger credit uses key `fw-charge-credit:{reference}` so it shares
 * the same idempotency key as the existing webhook credit path - whichever
 * runs first credits, the other becomes a no-op.
 */
export async function settleInvoicePayment(
  reference: string,
  metadata: Record<string, unknown> = {}
): Promise<{ settled: boolean; invoice?: unknown; merchantId?: string }> {
  return withIdempotencyKey(`invoice:settle:${reference}`, async () => {
    const invoice = await prisma.invoice.findUnique({ where: { reference } });
    if (!invoice) {
      logger.warn("Settle requested for unknown invoice", { reference });
      return { settled: false };
    }

    if (invoice.status === INVOICE_STATUS.PAID) {
      return { settled: false, invoice, merchantId: invoice.merchantId };
    }

    // Flip first so a crash between the two steps still converges on
    // "paid" once retried; the credit is independently idempotent.
    const updated = await prisma.invoice.update({
      where: { id: invoice.id },
      data: {
        status: INVOICE_STATUS.PAID,
        paidAt: new Date(),
      },
    });

    await ledger.credit({
      userId: invoice.merchantId,
      amount: invoice.amount,
      currency: invoice.currency,
      reference,
      description: `Payment received for invoice ${reference}`,
      metadata: { type: "invoice", invoiceId: invoice.id, ...metadata },
      idempotencyKey: `fw-charge-credit:${reference}`,
    });

    logger.info("Invoice settled", {
      invoiceId: invoice.id,
      reference,
      amount: invoice.amount,
    });

    return { settled: true, invoice: updated, merchantId: invoice.merchantId };
  });
}

/**
 * Mark an invoice failed. Never downgrades a paid invoice.
 */
export async function failInvoicePayment(reference: string, reason?: string) {
  const invoice = await prisma.invoice.findUnique({ where: { reference } });
  if (!invoice) return null;
  if (invoice.status === INVOICE_STATUS.PAID) return invoice;

  const updated = await prisma.invoice.update({
    where: { id: invoice.id },
    data: { status: INVOICE_STATUS.FAILED },
  });

  logger.warn("Invoice failed", { invoiceId: invoice.id, reference, reason });
  return updated;
}

export async function cancelInvoice(id: string, merchantId: string) {
  const invoice = await getInvoiceById(id, merchantId);
  if (!invoice) return null;
  if (invoice.status === INVOICE_STATUS.PAID) {
    throw new Error("This invoice is already paid and cannot be cancelled.");
  }

  return prisma.invoice.update({
    where: { id: invoice.id },
    data: { status: INVOICE_STATUS.CANCELLED },
  });
}

/**
 * Lazy expiry sweep. There is no cron in this repo, so this runs whenever
 * the merchant next sends a message.
 */
export async function expireStaleInvoices(merchantId?: string) {
  const now = new Date();
  const result = await prisma.invoice.updateMany({
    where: {
      ...(merchantId ? { merchantId } : {}),
      status: { in: EXPIRABLE_STATUSES },
      expiresAt: { not: null, lt: now },
    },
    data: { status: INVOICE_STATUS.EXPIRED },
  });

  if (result.count > 0) {
    logger.info("Expired stale invoices", { count: result.count });
  }
  return result.count;
}

// --------------------------------------------
// Rendering
// --------------------------------------------

/**
 * Invoice summary shown to the MERCHANT. Never sent to a buyer - they
 * only ever see Flutterwave's own prompt.
 */
export function renderInvoiceSummary(
  invoice: {
    reference: string;
    amount: number;
    currency: string;
    status: string;
    buyerPhone: string;
    items: unknown;
    expiresAt?: Date | null;
    paymentUrl?: string | null;
  },
  options: { showInternalRef?: boolean } = {}
): string {
  const items = (Array.isArray(invoice.items) ? invoice.items : []) as InvoiceItem[];
  const lines: string[] = [];

  lines.push(`*Invoice${options.showInternalRef ? "" : " summary"}*`);
  for (const item of items) {
    lines.push(
      `- ${item.qty} x ${item.name}: ${formatCurrency(
        item.qty * item.unitPrice,
        invoice.currency
      )}`
    );
  }
  lines.push("");
  lines.push(`*Total: ${formatCurrency(invoice.amount, invoice.currency)}*`);
  lines.push(`Buyer: ${invoice.buyerPhone}`);
  lines.push(`Status: ${invoice.status}`);
  if (invoice.expiresAt) {
    lines.push(`Expires: ${invoice.expiresAt.toISOString()}`);
  }
  if (options.showInternalRef) {
    lines.push(`Reference (internal): ${invoice.reference}`);
  }
  if (invoice.paymentUrl) {
    lines.push("");
    lines.push(`Fallback link (forward this to the buyer yourself):`);
    lines.push(invoice.paymentUrl);
  }

  return lines.join("\n");
}
