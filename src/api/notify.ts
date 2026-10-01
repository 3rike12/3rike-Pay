import { Router, Request, Response } from "express";
import { createLogger } from "@/utils/logger";

const logger = createLogger("notify");
import { notifyUser, notifyBulk, notifyPayment, notifyKyc, notifyWelcomeCreateWallet } from "@/services/notifications";
import { prisma } from "@/db/prisma";
import { requireApiKey } from "@/api/middleware/auth";

const router = Router();

router.use(requireApiKey);

// ============================================
// POST /webhook/notify - Send single notification
// ============================================
router.post("/", async (req: Request, res: Response) => {
  try {
    const { phone, message, type, reference, metadata } = req.body;

    if (!phone || !message) {
      return res.status(400).json({ error: "phone and message are required" });
    }

    const sent = await notifyUser({ phone, message, type, reference, metadata });

    res.status(200).json({
      success: sent,
      message: sent ? "Notification sent" : "Failed to send notification",
    });
  } catch (error: any) {
    logger.error("Notify webhook error", { error: error.message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// ============================================
// POST /webhook/notify/bulk - Send bulk notifications
// ============================================
router.post("/bulk", async (req: Request, res: Response) => {
  try {
    const { phones, message, type, metadata } = req.body;

    if (!phones?.length || !message) {
      return res.status(400).json({ error: "phones array and message are required" });
    }

    const result = await notifyBulk({ phones, message, type, metadata });

    res.status(200).json({
      success: true,
      sent: result.sent,
      failed: result.failed,
      total: phones.length,
    });
  } catch (error: any) {
    logger.error("Bulk notify webhook error", { error: error.message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// ============================================
// POST /webhook/notify/payment - Payment notification
// ============================================
router.post("/payment", async (req: Request, res: Response) => {
  try {
    const { phone, type, amount, reference, name, bank } = req.body;

    if (!phone || !type || !amount || !reference) {
      return res.status(400).json({ error: "phone, type, amount, and reference are required" });
    }

    const sent = await notifyPayment(phone, { type, amount, reference, name, bank });

    res.status(200).json({
      success: sent,
      message: sent ? "Payment notification sent" : "Failed to send notification",
    });
  } catch (error: any) {
    logger.error("Payment notify webhook error", { error: error.message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// ============================================
// POST /webhook/notify/kyc - KYC notification
// ============================================
router.post("/kyc", async (req: Request, res: Response) => {
  try {
    const { phone, status } = req.body;

    if (!phone || !status) {
      return res.status(400).json({ error: "phone and status are required" });
    }

    const sent = await notifyKyc(phone, status);

    res.status(200).json({
      success: sent,
      message: sent ? "KYC notification sent" : "Failed to send notification",
    });
  } catch (error: any) {
    logger.error("KYC notify webhook error", { error: error.message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// ============================================
// POST /webhook/notify/welcome - New-user intro with "Create wallet" button
// Body: { "phone": "234803...", "name": "Chibuikem", "optIn": true }
// Meta rules enforced: optIn must be true (user gave you this number with
// consent - web form checkbox, click-to-chat, ad, or messaged first), and
// the send is template-only + deduped so each number gets it once.
// Auth: x-api-key header.
// ============================================
router.post("/welcome", async (req: Request, res: Response) => {
  try {
    const { phone, name, optIn } = req.body;

    if (!phone) {
      return res.status(400).json({ error: "phone is required" });
    }
    if (optIn !== true) {
      return res.status(400).json({
        error: "optIn: true is required - user must have consented to WhatsApp messages (Meta policy)",
      });
    }

    const result = await notifyWelcomeCreateWallet(phone, name || "there");

    if (result.optedOut) {
      return res.status(200).json({
        success: false,
        alreadySent: false,
        optedOut: true,
        message: "Number opted out of marketing messages - welcome not sent",
      });
    }

    res.status(200).json({
      success: result.sent,
      alreadySent: result.alreadySent,
      message: result.alreadySent
        ? "Welcome already sent to this number"
        : result.sent
          ? "Welcome message sent"
          : "Failed to send welcome message (check template name/language/params match the approved version)",
    });
  } catch (error: any) {
    logger.error("Welcome notify webhook error", { error: error.message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// ============================================
// POST /webhook/notify/user-by-vendor - Notify by vendor_data (user ID)
// ============================================
router.post("/user-by-vendor", async (req: Request, res: Response) => {
  try {
    const { vendorData, message, type, reference, metadata } = req.body;

    if (!vendorData || !message) {
      return res.status(400).json({ error: "vendorData and message are required" });
    }

    // Find user by BankAccount autorampSubId or user ID
    const bankAccount = await prisma.bankAccount.findFirst({
      where: { autorampSubId: vendorData },
      include: { user: true },
    });
    const user = bankAccount?.user || (await prisma.user.findUnique({ where: { id: vendorData } }));

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const sent = await notifyUser({
      phone: user.phone,
      message,
      type,
      reference,
      metadata,
    });

    res.status(200).json({
      success: sent,
      message: sent ? "Notification sent" : "Failed to send notification",
    });
  } catch (error: any) {
    logger.error("Vendor notify webhook error", { error: error.message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// ============================================
// GET /webhook/notify/health - Health check
// ============================================
router.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    service: "3rike-pay-notification-webhook",
    timestamp: new Date().toISOString(),
  });
});

export default router;
