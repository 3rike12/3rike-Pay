import { Router, Request, Response } from "express";
import crypto from "crypto";
import { config } from "@/config";
import { logger } from "@/utils/logger";
import { notifyUser, notifyBulk, notifyPayment, notifyKyc } from "@/services/notifications";
import { prisma } from "@/db/prisma";

const router = Router();

// ============================================
// Auth middleware - validate API key
// ============================================

function authenticateWebhook(req: Request, res: Response, next: Function) {
  const apiKey = req.headers["x-api-key"] as string;

  if (!apiKey) {
    return res.status(401).json({ error: "Missing x-api-key header" });
  }

  // Compare with stored webhook secret (constant-time comparison)
  const expected = config.webhook.secret;
  if (!expected) {
    logger.warn("No webhook secret configured");
    return res.status(500).json({ error: "Webhook not configured" });
  }

  const isValid = crypto.timingSafeEqual(
    Buffer.from(apiKey),
    Buffer.from(expected)
  );

  if (!isValid) {
    logger.warn("Invalid webhook API key", { ip: req.ip });
    return res.status(403).json({ error: "Invalid API key" });
  }

  next();
}

router.use(authenticateWebhook);

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
// POST /webhook/notify/user-by-vendor - Notify by vendor_data (user ID)
// ============================================
router.post("/user-by-vendor", async (req: Request, res: Response) => {
  try {
    const { vendorData, message, type, reference, metadata } = req.body;

    if (!vendorData || !message) {
      return res.status(400).json({ error: "vendorData and message are required" });
    }

    // Find user by autorampSubId or ID
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { autorampSubId: vendorData },
          { id: vendorData },
        ],
      },
    });

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
