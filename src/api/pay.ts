import path from "path";
import { Router, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { prisma } from "@/db/prisma";
import { config } from "@/config";
import { nearIntents, EVM_ADDRESS_RE, STELLAR_CHAIN, isStellarAddress, walletChainIds } from "@/services/nearIntents";
import {
  createCryptoPayment,
  originMetaFor,
  getCryptoPaymentState,
  scheduleCryptoVerification,
} from "@/services/cryptoInvoice";
import { getInvoiceByReference } from "@/services/invoice";
import { checkStellarRefund } from "@/services/stellarAccount";
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

// Where the page should call the API. The backend serves its own pay page from
// the same origin, so this is empty; a separately hosted copy (Vercel) generates
// its own file at build time.
// /pay with no reference: a small holder page where a person can enter the
// reference from their link. Static; it only redirects to /pay/<reference>.
payPageRouter.get("/", (_req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, "../../public/pay-home.html"));
});

payPageRouter.get("/config.js", (_req: Request, res: Response) => {
  res.type("application/javascript").set("Cache-Control", "no-cache").send("window.PAY_CONFIG = window.PAY_CONFIG || {};\n");
});

// Brand favicon. Declared before "/:reference" so it is not read as an invoice.
payPageRouter.get("/favicon.png", (_req: Request, res: Response) => {
  res.set("Cache-Control", "public, max-age=86400").sendFile(path.join(__dirname, "../../public/favicon.png"));
});

// QR of the pay link itself (the thing a customer scans in person), as a PNG.
payPageRouter.get("/:reference/qr.png", limiter, async (req: Request, res: Response) => {
  try {
    const origin = config.app.baseUrl || `${req.protocol}://${req.get("host")}`;
    const png = await paymentQrPng(`${origin}/pay/${encodeURIComponent(req.params.reference)}`);
    res.type("png").set("Cache-Control", "public, max-age=3600").send(png);
  } catch (error: any) {
    res.status(500).json({ error: "Could not render the QR code" });
  }
});

payPageRouter.get("/:reference", limiter, (_req: Request, res: Response) => {
  res.set("Cache-Control", "no-store").sendFile(path.join(__dirname, "../../web/dist/pay.html"));
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
    // The shop details the merchant saved in their business profile - the same
    // ones an invoice carries. Never the user id, the buyer's phone, or the
    // internal invoice id.
    merchantInfo: {
      name: invoice.merchant?.business?.name || invoice.merchant?.name || null,
      country: invoice.merchant?.business?.country ?? null,
      phone: invoice.merchant?.business?.phone ?? null,
      email: invoice.merchant?.business?.email ?? null,
      registrationNumber: invoice.merchant?.business?.registrationNumber ?? null,
    },
    issuedAt: invoice.createdAt,
    amount: invoice.amount,
    currency: invoice.currency,
    items: invoice.items,
    status: invoice.status,
    expiresAt: invoice.expiresAt,
    receipt:
      invoice.status === "paid"
        ? {
            paidAt: invoice.paidAt,
            paidWith: (tx?.metadata as any)?.receipt?.paidWith ?? null,
            txUrl: (tx?.metadata as any)?.receipt?.txUrl ?? null,
          }
        : null,
    quote: quote && {
      depositAddress: quote.depositAddress,
      depositMemo: quote.depositMemo,
      amountIn: quote.amountIn,
      origin: quote.origin,
      refundTo: quote.refundTo,
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
    res.json({
      ...view,
      tokens,
      enabled: nearIntents.isNearIntentsEnabled(),
      network: config.nearIntents.network,
      walletChainIds: walletChainIds(),
      walletConnectProjectId: config.walletConnect.projectId || null,
    });
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

    // A failed swap refunds here, so it must be the buyer's own address.
    const refundTo = req.body?.refundTo ? String(req.body.refundTo).trim() : undefined;
    if (config.nearIntents.network === "tidepool" && !refundTo) {
      return res.status(400).json({ error: "Connect your wallet before preparing this payment." });
    }
    if (token.blockchain === STELLAR_CHAIN) {
      if (!refundTo || !isStellarAddress(refundTo)) {
        return res.status(400).json({ error: "Enter a valid Stellar address (it starts with G and is 56 characters). A failed payment is refunded there." });
      }
      // The refund can only land if the account is activated and, for USDC, has opted in to it. Check now, not after the money is sent.
      const refundCheck = await checkStellarRefund(refundTo, token);
      if (!refundCheck.ok) return res.status(400).json({ error: refundCheck.error });
    } else if (refundTo && !EVM_ADDRESS_RE.test(refundTo)) {
      return res.status(400).json({ error: "That refund address isn't a valid 0x address." });
    }

    await createCryptoPayment({
      merchantId: invoice.merchantId,
      invoiceId: invoice.id,
      originAsset: token.assetId,
      originLabel: `${token.symbol} on ${token.blockchain}`,
      refundTo,
      originMeta: originMetaFor(token),
    });
    scheduleCryptoVerification(invoice.reference);

    res.json(await publicView(invoice.reference));
  } catch (error: any) {
    logger.error("Pay quote failed", { error: error?.message });
    res.status(400).json({ error: error?.message || "Could not create the payment." });
  }
});

// Optional: tell 1Click the deposit tx hash so it can start verifying early.
payApiRouter.post("/:reference/submit", limiter, async (req: Request, res: Response) => {
  try {
    const txHash = String(req.body?.txHash || "");
    if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) return res.status(400).json({ error: "Invalid transaction hash" });

    const tx = await prisma.transaction.findUnique({ where: { reference: req.params.reference } });
    const quote = (tx?.metadata as any)?.nearIntents;
    if (!quote?.depositAddress) return res.status(404).json({ error: "No payment in progress" });

    await nearIntents
      .submitDepositTx({ txHash, depositAddress: quote.depositAddress, depositMemo: quote.depositMemo ?? undefined })
      .catch((e: any) => logger.warn("Deposit submit failed", { error: e?.message }));
    res.json({ ok: true });
  } catch (error: any) {
    res.status(500).json({ error: "Something went wrong" });
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
