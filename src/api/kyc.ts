import { Router, Request, Response } from "express";
import { autoramp } from "@/services/autoramp";
import { prisma } from "@/db/prisma";
import { generateReference } from "@/utils/helpers";
import { logger } from "@/utils/logger";

const router = Router();

// ============================================
// POST /api/kyc/initiate - Start BVN verification
// ============================================
router.post("/initiate", async (req: Request, res: Response) => {
  try {
    const { phone, email, bvn } = req.body;

    if (!phone || !email || !bvn) {
      return res.status(400).json({ error: "phone, email, and bvn are required" });
    }

    if (bvn.length !== 11) {
      return res.status(400).json({ error: "BVN must be 11 digits" });
    }

    // Initiate identity verification via AutoRamp
    const result = await autoramp.initiateIdentityVerification({
      type: "BVN",
      number: bvn,
    });

    // Store pending KYC data in a temp record or session
    // For now we return the identityId to the frontend
    logger.info("KYC initiated", { phone, bvn: bvn.slice(0, 3) + "****" });

    res.status(200).json({
      success: true,
      identityId: result.identityId,
      status: result.status,
    });
  } catch (error: any) {
    logger.error("KYC initiate error", { error: error.message });
    res.status(400).json({ error: error.message || "Failed to initiate verification" });
  }
});

// ============================================
// POST /api/kyc/validate - Complete with OTP
// ============================================
router.post("/validate", async (req: Request, res: Response) => {
  try {
    const { identityId, bvn, otp } = req.body;

    if (!identityId || !bvn || !otp) {
      return res.status(400).json({ error: "identityId, bvn, and otp are required" });
    }

    // Validate OTP via AutoRamp
    const result = await autoramp.validateIdentityVerification({
      identityId,
      type: "BVN",
      otp,
    });

    logger.info("KYC validated", { identityId });

    res.status(200).json({
      success: true,
      status: result.status,
      identityId: result.identityId,
    });
  } catch (error: any) {
    logger.error("KYC validate error", { error: error.message });
    res.status(400).json({ error: error.message || "Verification failed" });
  }
});

// ============================================
// POST /api/kyc/complete - Create sub-account after KYC
// ============================================
router.post("/complete", async (req: Request, res: Response) => {
  try {
    const { phone, email, bvn, identityId } = req.body;

    if (!phone || !email || !bvn) {
      return res.status(400).json({ error: "phone, email, and bvn are required" });
    }

    // Create AutoRamp sub-account
    const subAccount = await autoramp.createSubAccount({
      phoneNumber: phone,
      emailAddress: email,
      externalReference: generateReference("kyc"),
      identityType: "BVN",
      identityNumber: bvn,
    });

    // Save or update user in DB
    const user = await prisma.user.upsert({
      where: { phone },
      update: {
        email,
        bvn,
        autorampSubId: subAccount?.id || subAccount?.accountId,
        kycStatus: "verified",
      },
      create: {
        phone,
        email,
        bvn,
        autorampSubId: subAccount?.id || subAccount?.accountId,
        kycStatus: "verified",
      },
    });

    logger.info("Sub-account created", { phone, userId: user.id });

    res.status(200).json({
      success: true,
      userId: user.id,
      accountId: subAccount?.id || subAccount?.accountId,
    });
  } catch (error: any) {
    logger.error("KYC complete error", { error: error.message });
    res.status(400).json({ error: error.message || "Failed to create account" });
  }
});

// ============================================
// POST /api/kyc/resend - Resend OTP
// ============================================
router.post("/resend", async (req: Request, res: Response) => {
  try {
    const { bvn } = req.body;

    if (!bvn) {
      return res.status(400).json({ error: "bvn is required" });
    }

    // Re-initiate verification
    const result = await autoramp.initiateIdentityVerification({
      type: "BVN",
      number: bvn,
    });

    res.status(200).json({
      success: true,
      identityId: result.identityId,
    });
  } catch (error: any) {
    logger.error("KYC resend error", { error: error.message });
    res.status(400).json({ error: error.message || "Failed to resend OTP" });
  }
});

// ============================================
// GET /api/kyc/status/:phone - Check KYC status
// ============================================
router.get("/status/:phone", async (req: Request, res: Response) => {
  try {
    const { phone } = req.params;

    const user = await prisma.user.findUnique({ where: { phone } });

    res.status(200).json({
      exists: !!user,
      kycStatus: user?.kycStatus || "none",
      hasAccount: !!user?.autorampSubId,
    });
  } catch (error: any) {
    res.status(500).json({ error: "Failed to check status" });
  }
});

export default router;
