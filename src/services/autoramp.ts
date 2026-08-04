import axios, { AxiosInstance } from "axios";
import crypto from "crypto";
import { config } from "../config";
import { logger } from "../utils/logger";

// ============================================
// AutoRamp API Service
// ============================================

class AutoRampService {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: config.autoramp.baseUrl,
      headers: {
        "x-api-key": config.autoramp.apiKey,
        "Content-Type": "application/json",
      },
      timeout: 30000,
    });
  }

  // ------- Merchant Account -------

  async getMerchantAccount() {
    try {
      const { data } = await this.client.get("/merchants/api/account");
      logger.info("Merchant account fetched", { accountId: data.accountId });
      return data;
    } catch (error: any) {
      logger.error("Failed to fetch merchant account", {
        error: error.response?.data || error.message,
      });
      return null;
    }
  }

  // ------- Sub-Accounts -------

  async createSubAccount(params: {
    phoneNumber: string;
    emailAddress: string;
    externalReference: string;
    identityType?: string;
    identityNumber?: string;
    otp?: string;
    callbackUrl?: string;
  }) {
    try {
      const { data } = await this.client.post("/merchants/api/sub-account", params);
      logger.info("Sub-account created", { reference: params.externalReference });
      return data;
    } catch (error: any) {
      logger.error("Failed to create sub-account", {
        error: error.response?.data || error.message,
      });
      throw error;
    }
  }

  async getSubAccounts() {
    try {
      const { data } = await this.client.get("/merchants/api/sub-accounts");
      return data;
    } catch (error: any) {
      logger.error("Failed to fetch sub-accounts", {
        error: error.response?.data || error.message,
      });
      return null;
    }
  }

  // ------- Identity Verification -------

  async initiateIdentityVerification(params: {
    type: "BVN" | "NIN" | "vNIN" | "BVNUSSD";
    number: string;
  }) {
    try {
      const { data } = await this.client.post("/merchants/api/verify-identity", params);
      logger.info("Identity verification initiated", { type: params.type });
      return data;
    } catch (error: any) {
      logger.error("Failed to initiate identity verification", {
        error: error.response?.data || error.message,
      });
      throw error;
    }
  }

  async validateIdentityVerification(params: {
    identityId: string;
    type: "BVN" | "NIN";
    otp: string;
  }) {
    try {
      const { data } = await this.client.post("/merchants/api/validate-identity", params);
      logger.info("Identity verified", { identityId: params.identityId });
      return data;
    } catch (error: any) {
      logger.error("Failed to validate identity", {
        error: error.response?.data || error.message,
      });
      throw error;
    }
  }

  // ------- Name Enquiry / Account Resolution -------

  async nameEnquiry(bankCode: string, accountNumber: string) {
    try {
      const { data } = await this.client.post("/merchants/api/name-enquiry", {
        bankCode,
        accountNumber,
      });
      logger.info("Name enquiry completed", { bankCode, accountNumber });
      return data;
    } catch (error: any) {
      logger.error("Name enquiry failed", {
        error: error.response?.data || error.message,
      });
      throw error;
    }
  }

  async resolveAccount(bankCode: string, accountNumber: string) {
    try {
      const { data } = await this.client.get("/misc/resolve-account", {
        params: { bankCode, accountNumber },
      });
      return data;
    } catch (error: any) {
      logger.error("Account resolution failed", {
        error: error.response?.data || error.message,
      });
      throw error;
    }
  }

  // ------- Transfers -------

  async transfer(params: {
    beneficiaryBankCode: string;
    beneficiaryAccountNumber: string;
    amount: number;
    narration: string;
    paymentReference: string;
    debitAccountNumber?: string;
    saveBeneficiary?: boolean;
  }) {
    try {
      const { data } = await this.client.post("/merchants/api/transfer", params);
      logger.info("Transfer initiated", {
        reference: params.paymentReference,
        amount: params.amount,
      });
      return data;
    } catch (error: any) {
      logger.error("Transfer failed", {
        error: error.response?.data || error.message,
      });
      throw error;
    }
  }

  // ------- Virtual Accounts -------

  async createVirtualAccount(params: {
    amount: number;
    externalReference: string;
    validFor?: number;
    amountControl?: "Fixed" | "UnderPayment" | "OverPayment";
  }) {
    try {
      const { data } = await this.client.post("/merchants/api/virtual-account", params);
      logger.info("Virtual account created", { reference: params.externalReference });
      return data;
    } catch (error: any) {
      logger.error("Failed to create virtual account", {
        error: error.response?.data || error.message,
      });
      throw error;
    }
  }

  // ------- On-Ramp (Fiat -> Crypto) -------

  async initializeOnRamp(params: {
    network: "base" | "bsc";
    amount: number;
    destinationAddress: string;
  }) {
    try {
      const { data } = await this.client.post("/ramp/onramp", {
        type: "on",
        network: params.network,
        amount: params.amount,
        destination: { address: params.destinationAddress },
      });
      logger.info("On-ramp initialized", { reference: data.reference });
      return data;
    } catch (error: any) {
      logger.error("On-ramp initialization failed", {
        error: error.response?.data || error.message,
      });
      throw error;
    }
  }

  // ------- Off-Ramp (Crypto -> Fiat) -------

  async initializeOffRamp(params: {
    network: "base" | "bsc";
    amount: number;
    bankCode: string;
    accountNumber: string;
  }) {
    try {
      const { data } = await this.client.post("/ramp/offramp", {
        type: "off",
        network: params.network,
        amount: params.amount,
        destination: {
          bankCode: params.bankCode,
          accountNumber: params.accountNumber,
        },
      });
      logger.info("Off-ramp initialized", { reference: data.reference });
      return data;
    } catch (error: any) {
      logger.error("Off-ramp initialization failed", {
        error: error.response?.data || error.message,
      });
      throw error;
    }
  }

  // ------- Rates -------

  async getUsdNgnRate() {
    try {
      const { data } = await this.client.get("/rates/usd-ngn-rate");
      return data;
    } catch (error: any) {
      logger.error("Failed to fetch rate", { error: error.message });
      return null;
    }
  }

  // ------- Banks -------

  private banksCache: any[] = [];
  private banksCacheExpiry = 0;

  async listBanks(forceRefresh = false): Promise<any[]> {
    const now = Date.now();
    if (!forceRefresh && this.banksCache.length > 0 && now < this.banksCacheExpiry) {
      return this.banksCache;
    }

    try {
      const { data } = await this.client.get("/misc/banks");
      this.banksCache = Array.isArray(data) ? data : data.banks || data.data || [];
      this.banksCacheExpiry = now + 24 * 60 * 60 * 1000; // cache 24h
      logger.info("Banks list refreshed", { count: this.banksCache.length });
      return this.banksCache;
    } catch (error: any) {
      logger.error("Failed to fetch banks", { error: error.message });
      return this.banksCache; // return stale cache if available
    }
  }

  async getBankByCode(code: string): Promise<any | null> {
    const banks = await this.listBanks();
    return banks.find((b: any) => b.code === code || b.bankCode === code) || null;
  }

  // ------- Webhook Verification -------

  verifyWebhookSignature(body: string, signature: string): boolean {
    const expected = crypto
      .createHmac("sha256", config.autoramp.webhookSecret)
      .update(body)
      .digest("hex");
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected)
    );
  }
}

export const autoramp = new AutoRampService();
