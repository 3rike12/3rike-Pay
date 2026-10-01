import { Router, Request, Response } from "express";
import { requireApiKey } from "@/api/middleware/auth";
import { prisma } from "@/db/prisma";
import { ledger } from "@/services/ledger";
import { listInvoices, INVOICE_STATUS, InvoiceStatus } from "@/services/invoice";
import { createLogger } from "@/utils/logger";

const logger = createLogger("api");

const router = Router();
router.use(requireApiKey);

const INVOICE_STATUSES = Object.values(INVOICE_STATUS) as string[];

/** Shared guard: an unknown merchant is a 404, not an empty-but-valid page. */
async function loadMerchant(req: Request, res: Response, merchantId: string) {
  const merchant = await prisma.user.findUnique({
    where: { id: merchantId },
    select: { id: true },
  });
  if (!merchant) {
    res.status(404).json({ error: "Merchant not found", merchantId });
    return null;
  }
  return merchant;
}

// ============================================
// GET /api/balance?merchantId=&currency=RWF
// ============================================
router.get("/balance", async (req: Request, res: Response) => {
  const merchantId = String(req.query.merchantId || "").trim();
  if (!merchantId) {
    return res.status(400).json({ error: "merchantId is required" });
  }

  const currency = String(req.query.currency || "RWF").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    return res.status(400).json({ error: "currency must be a 3-letter ISO code" });
  }

  try {
    const merchant = await loadMerchant(req, res, merchantId);
    if (!merchant) return;

    const balance = await ledger.getBalance(merchantId, currency);
    return res.json({ merchantId, currency, balance });
  } catch (error: any) {
    logger.error("GET /api/balance failed", { merchantId, error: error.message });
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ============================================
// GET /api/invoices?merchantId=&status=&limit=&offset=
// ============================================
router.get("/invoices", async (req: Request, res: Response) => {
  const merchantId = String(req.query.merchantId || "").trim();
  if (!merchantId) {
    return res.status(400).json({ error: "merchantId is required" });
  }

  const statusParam = req.query.status ? String(req.query.status) : undefined;
  if (statusParam && !INVOICE_STATUSES.includes(statusParam)) {
    return res.status(400).json({
      error: "status must be one of",
      allowed: INVOICE_STATUSES,
    });
  }

  const limitRaw = req.query.limit ? Number(req.query.limit) : 20;
  const offsetRaw = req.query.offset ? Number(req.query.offset) : 0;
  if (!Number.isInteger(limitRaw) || limitRaw < 1) {
    return res.status(400).json({ error: "limit must be a positive integer" });
  }
  if (!Number.isInteger(offsetRaw) || offsetRaw < 0) {
    return res.status(400).json({ error: "offset must be a non-negative integer" });
  }

  try {
    const merchant = await loadMerchant(req, res, merchantId);
    if (!merchant) return;

    // Hard cap here as well as in the service: the response echoes `limit`,
    // so it must report what will actually be returned.
    const page = await listInvoices(merchantId, {
      status: statusParam as InvoiceStatus | undefined,
      limit: Math.min(limitRaw, 100),
      offset: offsetRaw,
    });

    return res.json({
      items: page.items.map((invoice) => ({
        id: invoice.id,
        reference: invoice.reference,
        status: invoice.status,
        amount: invoice.amount,
        currency: invoice.currency,
        buyerPhone: invoice.buyerPhone,
        items: invoice.items,
        paymentUrl: invoice.paymentUrl,
        createdAt: invoice.createdAt,
        paidAt: invoice.paidAt,
        expiresAt: invoice.expiresAt,
      })),
      total: page.total,
      limit: page.limit,
      offset: page.offset,
      hasMore: page.offset + page.items.length < page.total,
    });
  } catch (error: any) {
    logger.error("GET /api/invoices failed", { merchantId, error: error.message });
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
