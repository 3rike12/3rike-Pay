import path from "path";
import { Router, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { prisma } from "@/db/prisma";
import { config } from "@/config";
import { nearIntents } from "@/services/nearIntents";
import {
  createCryptoPayment,
  getCryptoPaymentState,
  scheduleCryptoVerification,
} from "@/services/cryptoInvoice";
import { getInvoiceByReference } from "@/services/invoice";
import { paymentQrPng } from "@/utils/qr";
import { createLogger } from "@/utils/logger";

const logger = createLogger("pay-page");

// ============================================
// Public buyer-facing pay page.
//
//   GET  /pay/:reference              the HTML page
//   GET  /api/pay/:reference          invoice + payable tokens (+ live quote if any)
//   POST /api/pay/:reference/quote    {symbol, chain} -> deposit address for that token
//   GET  /api/pay/:reference/status   poll -> awaiting_payment | processing | paid | refunded | failed | expired
//
// Deliberately exposes only what a buyer needs: never the merchant id, the
// buyer's phone, or the internal invoice id.
// ============================================

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 40,
  message: { error: "Too many requests. Please slow down." },
  standardHeaders: true,
  legacyHeaders: false,
});

export const payPageRouter = Router();
export const payApiRouter = Router();

payPageRouter.get("/:reference", limiter, (_req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, "../../public/pay.html"));
});

async function publicView(reference: string) {
  const invoice = await prisma.invoice.findUnique({
    where: { reference },
    include: { merchant: { include: { business: true } } },
  });
  if (!invoice) return null;

  const tx = await prisma.transaction.findUnique({ where: { reference } });
  const quote = (tx?.metadata as any)?.nearIntents ?? null;

  let qr: string | null = null;
  if (quote?.depositAddress) {
    qr = `data:image/png;base64,${(await paymentQrPng(quote.depositAddress)).toString("base64")}`;
  }

  return {
    reference: invoice.reference,
    merchant: invoice.merchant?.business?.name || invoice.merchant?.name || "Merchant",
    amount: invoice.amount,
    currency: invoice.currency,
    items: invoice.items,
    status: invoice.status,
    expiresAt: invoice.expiresAt,
    quote: quote && {
      depositAddress: quote.depositAddress,
      depositMemo: quote.depositMemo,
      amountInFormatted: quote.amountInFormatted,
      originLabel: quote.originLabel,
      deadline: quote.deadline,
      qr,
    },
  };
}

payApiRouter.get("/:reference", limiter, async (req: Request, res: Response) => {
  try {
    const view = await publicView(req.params.reference);
    if (!view) return res.status(404).json({ error: "Invoice not found" });

    let tokens: Array<{ symbol: string; chain: string; label: string }> = [];
    try {
      tokens = (await nearIntents.listPayableTokens()).map((t) => ({
        symbol: t.symbol,
        chain: t.blockchain,
        label: `${t.symbol} on ${t.blockchain}`,
      }));
    } catch (error: any) {
      logger.warn("Could not load token list", { error: error?.message });
    }
    res.json({ ...view, tokens, enabled: nearIntents.isNearIntentsEnabled() });
  } catch (error: any) {
    logger.error("Pay view failed", { error: error?.message });
    res.status(500).json({ error: "Something went wrong" });
  }
});

payApiRouter.post("/:reference/quote", limiter, async (req: Request, res: Response) => {
  try {
    const invoice = await getInvoiceByReference(req.params.reference);
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });
    if (!nearIntents.isNearIntentsEnabled()) {
      return res.status(503).json({ error: "Crypto payments are not enabled on this server." });
    }

    const symbol = String(req.body?.symbol || "");
    const chain = req.body?.chain ? String(req.body.chain) : undefined;
    const token = await nearIntents.resolveOriginAsset(symbol, chain);
    if (!token) return res.status(400).json({ error: "That token isn't supported." });

    await createCryptoPayment({
      merchantId: invoice.merchantId,
      invoiceId: invoice.id,
      originAsset: token.assetId,
      originLabel: `${token.symbol} on ${token.blockchain}`,
    });
    scheduleCryptoVerification(invoice.reference);

    res.json(await publicView(invoice.reference));
  } catch (error: any) {
    logger.error("Pay quote failed", { error: error?.message });
    res.status(400).json({ error: error?.message || "Could not create the payment." });
  }
});

payApiRouter.get("/:reference/status", limiter, async (req: Request, res: Response) => {
  try {
    const { state, nearStatus } = await getCryptoPaymentState(req.params.reference);
    if (state === "unknown") return res.status(404).json({ error: "Invoice not found" });
    res.json({ state, nearStatus });
  } catch (error: any) {
    res.status(500).json({ error: "Something went wrong" });
  }
});
