import { Router, Request, Response } from "express";
import { autoramp } from "@/services/autoramp";
import { prisma } from "@/db/prisma";
import { generateReference } from "@/utils/helpers";
import { logger } from "@/utils/logger";
import { validate } from "./middleware/validate";
import { kycLimiter } from "./middleware/rateLimit";
import {
  initiateKycSchema,
  validateKycSchema,
  completeKycSchema,
  resendKycSchema,
} from "./middleware/schemas";

const router = Router();

// Apply rate limiting to all KYC routes
router.use(kycLimiter);

// ============================================
// POST /api/kyc/initiate - Start BVN verification
// ============================================
router.post(
  "/initiate",
  validate(initiateKycSchema),
  async (req: Request, res: Response) => {
    try {
      const { phone, email, bvn } = req.body;

      const result = await autoramp.initiateIdentityVerification({
        type: "BVN",
        number: bvn,
      });

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
  }
);

// ============================================
// POST /api/kyc/validate - Complete with OTP
// ============================================
router.post(
  "/validate",
  validate(validateKycSchema),
  async (req: Request, res: Response) => {
    try {
      const { identityId, bvn, otp } = req.body;

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
  }
);

// ============================================
// POST /api/kyc/complete - Create sub-account after KYC
// ============================================
router.post(
  "/complete",
  validate(completeKycSchema),
  async (req: Request, res: Response) => {
    try {
      const { phone, email, bvn, identityId } = req.body;

      const subAccount = await autoramp.createSubAccount({
        phoneNumber: phone,
        emailAddress: email,
        externalReference: generateReference("kyc"),
        identityType: "BVN",
        identityNumber: bvn,
      });

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
  }
);

// ============================================
// POST /api/kyc/resend - Resend OTP
// ============================================
router.post(
  "/resend",
  validate(resendKycSchema),
  async (req: Request, res: Response) => {
    try {
      const { bvn } = req.body;

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
  }
);

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
