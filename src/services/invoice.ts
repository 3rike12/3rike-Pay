import { Prisma } from "@prisma/client";
import { prisma } from "@/db/prisma";
import { flutterwave } from "@/services/flutterwave";
import { ledger } from "@/services/ledger";
import { whatsapp } from "@/services/whatsapp";
import { withIdempotencyKey } from "@/utils/idempotency";
import { FLUTTERWAVE_SPLIT, MESSAGES } from "@/config/constants";
import {
  formatCurrency,
  generateTransactionReference,
  redactPhone,
  toRwandaPhone,
} from "@/utils/helpers";
import { createLogger } from "@/utils/logger";

const logger = createLogger("invoice");

// ============================================
// Invoice / payment-request service
//
// Roles: Merchant (has an account) + anonymous Buyer.
// The buyer authorises the debit from their own mobile-money handset - a
// Flutterwave push prompt or a link the merchant forwards. We never message
// the buyer ourselves; only the merchant hears from us.
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

export interface InvoicePage {
  items: Awaited<ReturnType<typeof prisma.invoice.findMany>>;
  total: number;
  limit: number;
  offset: number;
}

/**
 * Paged invoice list, newest first. Never returns the whole history in one
 * call - the hard cap on `limit` is what keeps a single request from pulling
 * every invoice a merchant has ever raised.
 */
export async function listInvoices(
  merchantId: string,
  options: { status?: InvoiceStatus; limit?: number; offset?: number } = {}
): Promise<InvoicePage> {
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);
  const offset = Math.max(options.offset ?? 0, 0);
  const where = {
    merchantId,
    ...(options.status ? { status: options.status } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.invoice.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    }),
    prisma.invoice.count({ where }),
  ]);

  return { items, total, limit, offset };
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
 * Render a charge failure the way the merchant should read it.
 *
 * Flutterwave blames "the merchant", which on our platform is the payment
 * account we hold - not the person holding the phone - so its raw text
 * would send them looking for a setting they don't have. Logs keep the
 * original message; only the merchant-facing text goes through this.
 */
export function humanizeChargeError(error: unknown): string {
  const message =
    error instanceof Error ? error.message : String((error as any)?.message ?? error ?? "");
  if (/not enabled to use this payment method/i.test(message)) {
    return "our payment provider hasn't enabled mobile money payments for this account yet - we're on it";
  }
  return message || "unknown error";
}

/**
 * Charge an invoice through Flutterwave.
 *
 * Ordering matters:
 *  1. Persist the Transaction FIRST. The charge webhook looks the payment
 *     up by reference - a charge that lands before we write the row would
 *     be dropped as "unknown transaction".
 *  2. Fire the charge - v4 push first (the payment prompt lands on the
 *     buyer's handset), falling back to the v3 link charge when v4 is not
 *     configured or rejects the payment.
 *  3. Record what came back (push instruction, link, charge id) and move
 *     the invoice to pending_payment.
 *
 * `reference` doubles as both tx_ref and the v4 charge reference, so
 * retrying the same invoice reaches Flutterwave as the same order rather
 * than a new one.
 *
 * On the v3 path `network` is deliberately NOT passed: the SDK only allows
 * MTN/AIRTEL for RWF and Rwanda also has KTRN (077). Flutterwave infers it
 * from the number. v4 makes `network` mandatory, so the client maps it from
 * the phone prefix instead.
 */
export async function chargeInvoice(params: {
  merchantId: string;
  invoiceId: string;
  redirectUrl?: string;
}) {
  const invoice = await getInvoiceById(params.invoiceId, params.merchantId);
  if (!invoice) {
    throw new Error("Invoice not found.");
  }
  if (invoice.status === INVOICE_STATUS.PAID) {
    throw new Error("This invoice is already paid.");
  }
  if (!OPEN_STATUSES.includes(invoice.status as InvoiceStatus)) {
    throw new Error(`This invoice is ${invoice.status} and cannot be charged.`);
  }

  const reference = invoice.reference;

  // 1. Transaction row, idempotent on the unique reference.
  let transaction = await prisma.transaction.findUnique({ where: { reference } });
  if (!transaction) {
    transaction = await prisma.transaction.create({
      data: {
        userId: invoice.merchantId,
        reference,
        type: "invoice",
        amount: invoice.amount,
        currency: invoice.currency,
        status: "pending",
        description: `Payment request to ${invoice.buyerPhone}`,
        recipientPhone: invoice.buyerPhone,
        metadata: { invoiceId: invoice.id },
      },
    });
  }

  // 2. Charge. Push when v4 is on; otherwise the v3 link charge.
  let paymentUrl: string | null = null;
  let paymentNote: string | null = null;
  let chargeId: string | null = null;
  let chargedViaV4 = false;

  if (flutterwave.isV4Enabled()) {
    try {
      const charge = await flutterwave.chargeRwandaMobileMoneyV4({
        reference,
        amount: invoice.amount,
        currency: invoice.currency,
        phoneNumber: invoice.buyerPhone,
        redirectUrl: params.redirectUrl,
        meta: { invoice_id: invoice.id, merchant_id: invoice.merchantId },
      });
      paymentUrl = flutterwave.extractV4PaymentUrl(charge);
      paymentNote = flutterwave.extractV4PaymentInstruction(charge);
      chargeId = typeof charge?.id === "string" ? charge.id : null;
      chargedViaV4 = true;
    } catch (error: any) {
      logger.error("v4 push charge failed; retrying with the v3 link charge", {
        invoiceId: invoice.id,
        reference,
        error: error?.message || error,
      });
    }
  }

  if (!chargedViaV4) {
    const response = await flutterwave.chargeRwandaMobileMoney({
      txRef: reference,
      orderId: reference,
      amount: invoice.amount,
      currency: invoice.currency,
      phoneNumber: invoice.buyerPhone,
      redirectUrl: params.redirectUrl,
      meta: { invoice_id: invoice.id, merchant_id: invoice.merchantId },
    });
    paymentUrl = flutterwave.extractPaymentUrl(response);
  }

  // 3. Persist the outcome.
  if (invoice.status === INVOICE_STATUS.DRAFT) {
    await issueInvoice(invoice.id, params.merchantId, { paymentUrl });
  }
  const pending = await markPendingPayment(invoice.id, params.merchantId, paymentUrl);

  await prisma.transaction.update({
    where: { id: transaction.id },
    data: {
      status: "processing",
      metadata: {
        invoiceId: invoice.id,
        paymentUrl,
        paymentNote,
        chargeId,
        buyerPhone: invoice.buyerPhone,
      } as Prisma.InputJsonValue,
    },
  });

  logger.info("Invoice charged", {
    invoiceId: invoice.id,
    reference,
    amount: invoice.amount,
    channel: chargedViaV4 ? "v4-push" : "v3-link",
    hasPaymentUrl: Boolean(paymentUrl),
    hasPaymentNote: Boolean(paymentNote),
  });

  return { invoice: pending, txRef: reference, paymentUrl, paymentNote, chargeId };
}

// ============================================
// Collection split
//
// Flutterwave collects the gross payment into the platform account - it
// never splits on our charges (the mobile-money payload has no subaccount
// field), so the merchant/platform split is booked in our own ledger.
//
// The merchant wallet is credited the gross and then debited the platform
// fee as a separate entry, so every fee taken off a merchant is a distinct,
// inspectable deduction on their statement rather than a number that was
// quietly never credited. The platform wallet is credited the same fee -
// one debit, one credit, same reference.
// ============================================

/** Reserved user that owns the platform-fee wallet. Not a real phone. */
const PLATFORM_PHONE = "system:platform";

/**
 * Split a collected amount into the merchant share and the platform fee.
 * The two parts always add back to the gross amount (no rounding leak).
 */
export function splitCollection(amount: number): {
  merchantShare: number;
  platformFee: number;
} {
  const round = (n: number) => Math.round(n * 100) / 100;

  let platformFee: number;
  if (FLUTTERWAVE_SPLIT.TYPE === "flat") {
    // Flat: the merchant gets the configured fixed amount per collection.
    platformFee = round(amount - Math.min(amount, Math.max(0, FLUTTERWAVE_SPLIT.VALUE)));
  } else {
    platformFee = round(amount * (1 - FLUTTERWAVE_SPLIT.VALUE));
  }

  platformFee = Math.min(amount, Math.max(0, platformFee));
  return { merchantShare: round(amount - platformFee), platformFee };
}

/** Lazily create the reserved user that owns the platform-fee wallet. */
async function ensurePlatformUserId(): Promise<string> {
  const existing = await prisma.user.findUnique({ where: { phone: PLATFORM_PHONE } });
  if (existing) return existing.id;

  try {
    const created = await prisma.user.create({
      data: { phone: PLATFORM_PHONE, name: "Platform fees" },
    });
    return created.id;
  } catch (error: any) {
    if (error?.code === "P2002") {
      // Lost a first-boot race: the winner's row is there now.
      const winner = await prisma.user.findUnique({ where: { phone: PLATFORM_PHONE } });
      if (winner) return winner.id;
    }
    throw error;
  }
}

/**
 * The merchant's post-settlement ledger balance in the invoice currency.
 *
 * Read after every credit/debit leg has run, so the figure quoted to the
 * merchant is what their ledger actually says. Falls back to a zero line in
 * the invoice currency if the lookup fails - a missing number must never
 * cost us the "you got paid" message.
 */
async function readMerchantBalance(
  merchantId: string,
  currency: string
): Promise<{ currency: string; amount: number }> {
  try {
    const balances = await ledger.listBalances(merchantId);
    const match = balances.find((row) => row.currency === currency);
    return { currency, amount: Number(match?.balance ?? 0) };
  } catch (error: any) {
    logger.warn("Could not read the merchant balance for the paid message", {
      merchantId,
      currency,
      error: error?.message,
    });
    return { currency, amount: 0 };
  }
}

const roundMoney = (n: number) => Math.round(n * 100) / 100;

/**
 * The merchant-borne Flutterwave fee found on a payload, flagged `exact` or
 * not.
 *
 * `app_fee` is deliberately not treated as exact: it is the fee *before* VAT,
 * so it understates what actually leaves the settlement. A RWF 3,000 charge
 * reports `app_fee: 147` but settles `2841.97` - a real cost of 158.03.
 * Debiting `app_fee` alone leaves the merchant credited for money Flutterwave
 * never sent us, so `charged_amount - amount_settled` wins whenever both are
 * present, and `app_fee` only ever answers as a last resort.
 */
function feeCandidateFromPayload(payload: unknown): { fee: number; exact: boolean } | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const num = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;

  const settled = num(p.amount_settled) ?? num(p.settled_amount);
  const charged = num(p.charged_amount) ?? num(p.amount);
  if (settled !== null && charged !== null && charged >= settled) {
    return { fee: roundMoney(charged - settled), exact: true };
  }

  const totalFee = num(p.total_fee);
  if (totalFee !== null && totalFee >= 0) return { fee: roundMoney(totalFee), exact: true };

  const fee = num(p.fee);
  if (fee !== null && fee >= 0) return { fee: roundMoney(fee), exact: true };

  const appFee = num(p.app_fee);
  if (appFee !== null && appFee >= 0) return { fee: roundMoney(appFee), exact: false };

  return null;
}

/** Single-payload view of the fee: exact figure when present, else `app_fee`. */
export function flutterwaveFeeFromPayload(payload: unknown): number | null {
  return feeCandidateFromPayload(payload)?.fee ?? null;
}

/**
 * Work out what Flutterwave charged on this collection so the merchant's
 * wallet can carry the deduction as its own entry.
 *
 * Sources are consulted in order - whatever the caller handed us, the payload
 * stashed on the transaction row, then the charge itself - but an *exact*
 * figure from a later source beats an `app_fee` from an earlier one. The
 * webhook payload only ever carries `app_fee`, so it is not allowed to answer
 * on its own: the settle for that reference still asks Flutterwave what it
 * actually settled.
 *
 * Returns null when the fee cannot be determined; the caller logs and moves
 * on rather than failing a settlement that already flipped to paid.
 */
export async function resolveFlutterwaveFee(
  reference: string,
  metadata: Record<string, unknown> = {}
): Promise<number | null> {
  // Held on an object rather than two `let`s: both are assigned inside
  // `consider`, and TypeScript narrows closure-assigned locals back to `null`
  // at the reads below.
  const found: {
    exact: { fee: number; source: string } | null;
    approximate: { fee: number; source: string } | null;
  } = { exact: null, approximate: null };

  const consider = (source: string, payload: unknown) => {
    if (found.exact) return;
    const candidate = feeCandidateFromPayload(payload);
    if (!candidate) return;
    if (candidate.exact) found.exact = { fee: candidate.fee, source };
    else if (!found.approximate) found.approximate = { fee: candidate.fee, source };
  };

  consider("settle_metadata", metadata.flutterwave ?? metadata.flutterwaveData);

  let transaction: any = null;
  try {
    transaction = await prisma.transaction.findUnique({ where: { reference } });
  } catch (error: any) {
    logger.warn("Could not read the transaction while resolving the fee", {
      reference,
      error: error?.message,
    });
  }
  consider("transaction_metadata", transaction?.metadata?.flutterwaveData);

  const chargeId =
    typeof transaction?.metadata?.chargeId === "string"
      ? (transaction.metadata.chargeId as string)
      : null;

  // Mirror the path `verifyInvoicePayment` uses to establish the status: when
  // the v4 charge is the source of truth a v3 lookup would only be asking a
  // different API about a charge it has never seen.
  const onV4Path = Boolean(chargeId) && flutterwave.isV4Enabled();
  // The verify-poller hands over the payload from the call it just made, so
  // repeating that same lookup buys nothing - one round trip per settle.
  const justVerified = metadata.source === "verify_poll" && !onV4Path;

  if (!found.exact && onV4Path && chargeId) {
    try {
      consider("v4_charge", await flutterwave.retrieveV4Charge(chargeId));
    } catch (error: any) {
      logger.warn("Could not read the v4 charge while resolving the fee", {
        reference,
        chargeId,
        error: error?.message,
      });
    }
  } else if (!found.exact && !justVerified) {
    try {
      const response: any = await flutterwave.verifyTransactionByTxRef(reference);
      consider("v3_verify", response?.data ?? response);
    } catch (error: any) {
      logger.warn("Could not verify the transaction while resolving the fee", {
        reference,
        error: error?.message,
      });
    }
  }

  const winner = found.exact ?? found.approximate;
  if (!winner) {
    logger.warn("Flutterwave fee unresolved, merchant not debited for it", {
      reference,
      chargeId,
      onV4Path,
    });
    return null;
  }

  if (!found.exact) {
    // Visible because this figure is known to omit VAT: the merchant will be
    // under-debited by the tax component until a settlement figure appears.
    logger.warn("Flutterwave fee taken from app_fee, which excludes VAT", {
      reference,
      fee: winner.fee,
      source: winner.source,
    });
  } else {
    logger.info("Flutterwave fee resolved", {
      reference,
      fee: winner.fee,
      source: winner.source,
    });
  }
  return winner.fee;
}

/**
 * Settle an invoice: flip to paid and book it in the ledger - the gross to
 * the merchant's wallet, the platform fee debited straight back off it as its
 * own entry and credited to the platform-fee wallet, and the Flutterwave
 * charge fee (VAT included) debited straight off it too. The merchant then
 * hears their new balance.
 *
 * Idempotent on purpose - the Flutterwave webhook may deliver more than
 * once and the verify-poller can race with it. Safe to call from both.
 *
 * The merchant credit keeps key `fw-charge-credit:{reference}` so it shares
 * the same idempotency key as the existing webhook credit path - whichever
 * runs first credits, the other becomes a no-op. The platform-fee legs use
 * their own keys: `fw-fee-debit:{reference}` on the merchant wallet and
 * `fw-fee-credit:{reference}` on the platform wallet. The Flutterwave-fee
 * debit gets `fw-provider-fee-debit:{reference}`.
 */
export async function settleInvoicePayment(
  reference: string,
  metadata: Record<string, unknown> = {}
): Promise<{ settled: boolean; invoice?: unknown; merchantId?: string }> {
  return withIdempotencyKey(`invoice:settle:${reference}`, async () => {
    const invoice = await prisma.invoice.findUnique({
      where: { reference },
      include: { merchant: true },
    });
    if (!invoice) {
      logger.warn("Settle requested for unknown invoice", { reference });
      return { settled: false };
    }

    if (invoice.status === INVOICE_STATUS.PAID) {
      return { settled: false, invoice, merchantId: invoice.merchantId };
    }

    // Flip first so a crash between the two steps still converges on
    // "paid" once retried; the credits are independently idempotent.
    const updated = await prisma.invoice.update({
      where: { id: invoice.id },
      data: {
        status: INVOICE_STATUS.PAID,
        paidAt: new Date(),
      },
    });

    const { merchantShare, platformFee } = splitCollection(invoice.amount);
    const split = {
      gross: invoice.amount,
      merchantShare,
      platformFee,
      type: FLUTTERWAVE_SPLIT.TYPE,
      value: FLUTTERWAVE_SPLIT.VALUE,
    };

    // The merchant is credited the gross and then debited the platform fee as
    // its own entry, so each fee removed from a merchant lands in their ledger
    // as a distinct deduction. Net is identical to crediting only the share;
    // only the history differs.
    //
    // The credit keeps key `fw-charge-credit:{reference}` - it is shared with
    // the generic webhook credit path, so a race cannot double-credit. The fee
    // debit gets its own key because it is a second write against the same
    // reference, not a retry of the credit.
    if (invoice.amount > 0) {
      await ledger.credit({
        userId: invoice.merchantId,
        amount: invoice.amount,
        currency: invoice.currency,
        reference,
        description: `Payment received for invoice ${reference}`,
        metadata: { type: "invoice", invoiceId: invoice.id, split, ...metadata },
        idempotencyKey: `fw-charge-credit:${reference}`,
      });
    }

    // Only fees that actually came off the merchant are itemised below: a leg
    // that failed to book must not be presented to them as a deduction they
    // can see in their balance.
    let bookedPlatformFee = 0;

    if (platformFee > 0) {
      // allowNegative keeps this a pure bookkeeping entry: the invoice is
      // already flipped to paid above, so a balance race must never leave the
      // fee unrecorded or abort the settlement. Failures are logged loudly and
      // swallowed for the same reason the split write below is.
      try {
        await ledger.debit({
          userId: invoice.merchantId,
          amount: platformFee,
          currency: invoice.currency,
          reference,
          description: `Platform fee for invoice ${reference}`,
          metadata: { type: "platform_fee", invoiceId: invoice.id, split, ...metadata },
          allowNegative: true,
          idempotencyKey: `fw-fee-debit:${reference}`,
        });
        bookedPlatformFee = platformFee;
      } catch (error: any) {
        logger.error("Platform fee debit failed", {
          invoiceId: invoice.id,
          reference,
          amount: platformFee,
          error: error?.message,
        });
      }

      const platformUserId = await ensurePlatformUserId();
      await ledger.credit({
        userId: platformUserId,
        amount: platformFee,
        currency: invoice.currency,
        reference,
        description: `Platform fee for invoice ${reference}`,
        metadata: { type: "platform_fee", invoiceId: invoice.id, split, ...metadata },
        idempotencyKey: `fw-fee-credit:${reference}`,
      });
    }

    // What Flutterwave keeps for itself is the merchant's cost of being paid,
    // so it comes off their wallet as its own entry as well. Without this the
    // merchant is credited the full gross while only `amount_settled` ever
    // reaches us - the ledger then claims more cash than exists. Booked
    // best-effort for the same reason as the platform-fee debit above: a
    // missing fee figure must never abort a settlement already flipped paid.
    //
    // Hoisted so the merchant's message can itemise it next to the platform
    // fee; null means "could not be determined" or "did not book", either of
    // which prints no line rather than a guessed number.
    let bookedFlutterwaveFee: number | null = null;
    if (invoice.amount > 0) {
      const flutterwaveFee = await resolveFlutterwaveFee(reference, metadata);
      if (flutterwaveFee !== null && flutterwaveFee > 0) {
        try {
          await ledger.debit({
            userId: invoice.merchantId,
            amount: flutterwaveFee,
            currency: invoice.currency,
            reference,
            description: `Flutterwave fee for invoice ${reference}`,
            metadata: {
              type: "flutterwave_fee",
              invoiceId: invoice.id,
              split,
              fee: flutterwaveFee,
              ...metadata,
            },
            allowNegative: true,
            idempotencyKey: `fw-provider-fee-debit:${reference}`,
          });
          bookedFlutterwaveFee = flutterwaveFee;
        } catch (error: any) {
          logger.error("Flutterwave fee debit failed", {
            invoiceId: invoice.id,
            reference,
            amount: flutterwaveFee,
            error: error?.message,
          });
        }
      }
    }

    // Record the split on the transaction row so reconciliation can read it
    // without walking the ledger. Best effort: the credits above are the
    // source of truth and this bookkeeping write must never block a settle.
    try {
      const txRow = await prisma.transaction.findUnique({ where: { reference } });
      if (txRow) {
        await prisma.transaction.update({
          where: { reference },
          data: {
            metadata: { ...((txRow.metadata as Record<string, unknown>) || {}), split },
          },
        });
      }
    } catch (error: any) {
      logger.warn("Could not record the split on the transaction", {
        reference,
        error: error?.message,
      });
    }

    // Notify the merchant here rather than in each caller: settle is the
    // single winning path (webhook and verify-poller both funnel through it),
    // so this cannot double-message. The balance is read after every ledger
    // leg above, so the figure in the message is the real post-settlement
    // total rather than a pre-fee number, and the two fees are passed through
    // so the merchant can see what produced it.
    if (invoice.merchant?.phone) {
      const newBalance = await readMerchantBalance(invoice.merchantId, invoice.currency);
      try {
        await whatsapp.sendTextMessage(
          invoice.merchant.phone,
          renderPaidInvoiceMessage(invoice, newBalance, {
            platform: bookedPlatformFee,
            flutterwave: bookedFlutterwaveFee,
          })
        );
        logger.info("Paid-invoice notification sent", {
          reference,
          phone: redactPhone(invoice.merchant.phone),
        });
      } catch (error: any) {
        logger.warn("Paid-invoice notification failed", {
          reference,
          error: error?.message,
        });
      }
    } else {
      // Never fail the settlement over a missing number, but make the skip
      // visible - otherwise a paid invoice with no merchant message is
      // indistinguishable from a send failure.
      logger.warn("Paid-invoice notification skipped: merchant has no phone", {
        reference,
        merchantId: invoice.merchantId,
      });
    }

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

/** 2026-09-30T15:10:53.538Z -> "30 Sep 2026, 15:10 UTC" */function formatExpiry(date: Date): string {
  const iso = date.toISOString();
  const [datePart, timePart] = iso.split("T");
  const [year, month, day] = datePart.split("-");
  const monthName = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ][parseInt(month, 10) - 1];
  return `${day} ${monthName} ${year}, ${timePart.slice(0, 5)} UTC`;
}

/**
 * Invoice summary shown to the MERCHANT. Never sent to a buyer - we do not
 * message buyers at all; the merchant forwards the link themselves.
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
    lines.push(`Expires: ${formatExpiry(invoice.expiresAt)}`);
  }
  if (options.showInternalRef) {
    lines.push(`Reference (internal): ${invoice.reference}`);
  }
  if (invoice.paymentUrl) {
    lines.push("");
    lines.push("Fallback link (forward this to the buyer yourself):");
    lines.push(invoice.paymentUrl);
  }

  return lines.join("\n");
}

/** "- 2 x waters: RWF 3,000" per item, joined for message bodies. */
function invoiceItemLines(invoice: { items: unknown; currency: string }): string {
  const items = (Array.isArray(invoice.items) ? invoice.items : []) as InvoiceItem[];
  return items
    .map((item) => `- ${item.qty} x ${item.name}: ${formatCurrency(item.qty * item.unitPrice, invoice.currency)}`)
    .join("\n");
}

/**
 * Merchant-facing "you got paid" message for an invoice. Currency-aware
 * (RWF for Rwanda) and deliberately omits the internal reference - that ID
 * is trace-only and never leaves our systems.
 *
 * `newBalance` is the merchant's ledger wallet after this settlement, so the
 * merchant sees the number rather than being told something changed.
 *
 * `fees` itemises what was taken off them to produce that balance - the
 * platform's cut and Flutterwave's charge fee as separate lines, because a
 * single "fees" total hides which of the two moved. A fee that is zero, null
 * or simply not known drops its line rather than printing `RWF 0`; if nothing
 * is left the whole block disappears.
 */
export function renderPaidInvoiceMessage(
  invoice: {
    items: unknown;
    amount: number;
    currency: string;
    buyerPhone: string;
  },
  newBalance: { currency: string; amount: number },
  fees: { platform?: number | null; flutterwave?: number | null } = {}
): string {
  const lines = invoiceItemLines(invoice);

  const feeLines = [
    { label: "Platform fee", value: fees.platform },
    { label: "Flutterwave fee", value: fees.flutterwave },
  ]
    .filter((row): row is { label: string; value: number } => {
      const value = row.value;
      return typeof value === "number" && Number.isFinite(value) && value > 0;
    })
    .map((row) => `- ${row.label}: ${formatCurrency(row.value, invoice.currency)}`);

  const feeBlock = feeLines.length > 0 ? `*Fees*\n${feeLines.join("\n")}\n\n` : "";

  return (
    `*Payment Received*\n\n` +
    (lines ? `${lines}\n\n` : "") +
    `*Total: ${formatCurrency(invoice.amount, invoice.currency)}*\n` +
    `Buyer: ${invoice.buyerPhone}\n\n` +
    feeBlock +
    `*New balance: ${formatCurrency(newBalance.amount, newBalance.currency)}*`
  );
}

// --------------------------------------------
// Verify-polling fallback
// --------------------------------------------

/**
 * Ask Flutterwave what happened to a charge and settle/fail accordingly.
 *
 * The webhook is the primary signal. This is the safety net for when it
 * does not arrive - Flutterwave's own docs disagree on whether RWF charges
 * stay "pending" until the redirect completes, so we poll rather than
 * assume.
 *
 * Returns: "settled" | "failed" | "pending" | "unknown".
 */
export async function verifyInvoicePayment(
  reference: string
): Promise<"settled" | "failed" | "pending" | "unknown"> {
  const invoice = await getInvoiceByReference(reference);
  if (!invoice) return "unknown";
  if (invoice.status === INVOICE_STATUS.PAID) return "settled";
  if (
    invoice.status === INVOICE_STATUS.FAILED ||
    invoice.status === INVOICE_STATUS.EXPIRED ||
    invoice.status === INVOICE_STATUS.CANCELLED
  ) {
    return "failed";
  }

  try {
    // The v4 push flow records the charge id (`chg_...`) on the transaction
    // when it is created; with one in hand the charge itself is the source
    // of truth. Otherwise fall back to the v3 lookup by reference.
    const transaction = await prisma.transaction.findUnique({ where: { reference } });
    const chargeId =
      typeof (transaction?.metadata as any)?.chargeId === "string"
        ? ((transaction?.metadata as any).chargeId as string)
        : null;

    let status: string | null = null;
    // Whatever answered the status question also carries the fee figures, so
    // hand it straight to settle instead of making fee resolution ask the
    // same API a second time.
    let verifiedPayload: unknown = null;

    if (chargeId && flutterwave.isV4Enabled()) {
      const charge: any = await flutterwave.retrieveV4Charge(chargeId);
      if (!charge) {
        logger.warn("Flutterwave has no v4 charge for this invoice", { reference, chargeId });
        return "pending";
      }
      status = String(charge.status || "").toLowerCase().trim();
      verifiedPayload = charge;
    } else {
      const response: any = await flutterwave.verifyTransactionByTxRef(reference);
      // Top-level `status: "error"` means Flutterwave has no transaction at all
      // for this reference (data is null) - usually a charge that never got
      // created. Keep polling, but make the reason visible instead of sitting
      // on "pending" in silence.
      if (
        String(response?.status || "").toLowerCase() === "error" &&
        !response?.data
      ) {
        logger.warn("Flutterwave has no transaction for this invoice", {
          reference,
          message: response?.message ?? "unknown",
        });
        return "pending";
      }
      status = String(response?.data?.status || response?.status || "")
        .toLowerCase()
        .trim();
      verifiedPayload = response?.data ?? response;
    }

    // v3 says "successful", v4 says "succeeded".
    if (status === "successful" || status === "succeeded") {
      await settleInvoicePayment(reference, {
        source: "verify_poll",
        flutterwave: verifiedPayload,
      });
      await prisma.transaction.updateMany({
        where: { reference },
        data: { status: "completed" },
      });
      return "settled";
    }

    if (status === "failed" || status === "cancelled" || status === "abandoned") {
      await failInvoicePayment(reference, status);
      await prisma.transaction.updateMany({
        where: { reference },
        data: { status: "failed" },
      });
      return "failed";
    }

    return "pending";
  } catch (error: any) {
    logger.warn("Invoice verification poll failed", {
      reference,
      error: error?.message,
    });
    return "pending";
  }
}

/**
 * Fire-and-forget verification attempts after a charge. There is no cron in
 * this repo, so this is an in-process timer chain; `unref` keeps it from
 * holding the process open.
 *
 * The chain follows the payment page: Rwanda charges only settle once the
 * buyer opens the redirect URL and the provider authorizes it (test mode
 * auto-authorizes a few seconds after the page is opened, and a real buyer
 * may take minutes). It stops as soon as the invoice leaves "pending" so a
 * settled or expired invoice is not polled for the rest of the schedule.
 */
const POLL_DELAYS_MS = [
  15_000, // immediate safety net for the webhook
  45_000,
  90_000,
  180_000,
  300_000,
  600_000,
  1_200_000, // last check before the 30-minute invoice expiry
];

export function scheduleInvoiceVerification(
  reference: string,
  delaysMs: number[] = POLL_DELAYS_MS
): void {
  const run = (index: number) => {
    if (index >= delaysMs.length) return;
    const timer = setTimeout(() => {
      verifyInvoicePayment(reference)
        .then((result) => {
          if (result === "settled" || result === "failed" || result === "unknown") {
            return;
          }
          run(index + 1);
        })
        .catch(() => {
          run(index + 1);
        });
    }, delaysMs[index]);
    timer.unref?.();
  };
  run(0);
}
