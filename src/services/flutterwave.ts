import Flutterwave, { FlutterwaveInstance } from "flutterwave-node-v3";
import crypto from "crypto";
import { config } from "@/config";
import { FLUTTERWAVE_SPLIT } from "@/config/constants";
import { prisma } from "@/db/prisma";
import { toRwandaPhone } from "@/utils/helpers";
import { createLogger } from "@/utils/logger";

const logger = createLogger("flutterwave");

// ============================================
// Flutterwave Service
// Wrapper around flutterwave-node-v3 SDK.
// Subaccounts are the source of truth for merchant wallets.
// ============================================

class FlutterwaveService {
  private client: FlutterwaveInstance | null = null;

  constructor() {
    const { publicKey, secretKey, isProduction } = config.flutterwave ?? {};

    if (!publicKey || !secretKey) {
      logger.warn("Flutterwave keys are not configured");
      return;
    }

    this.client = new Flutterwave(publicKey, secretKey, isProduction);
  }

  private ensureClient() {
    if (!this.client) {
      throw new Error("Flutterwave client is not configured");
    }
    return this.client;
  }

  // ------- Subaccounts -------

  /**
   * Create a Flutterwave subaccount for a merchant.
   * The subaccount_id returned becomes the merchant's wallet reference.
   */
  async createSubaccount(params: {
    userId: string;
    currency?: string;
    accountBank: string;
    accountNumber: string;
    businessName: string;
    businessEmail: string;
    businessContact?: string;
    businessContactMobile?: string;
    businessMobile?: string;
    country?: string;
    splitType?: "percentage" | "flat";
    splitValue?: number;
    meta?: Record<string, string>;
  }) {
    const client = this.ensureClient();
    const currency = (params.currency || "RWF").toUpperCase();

    const existing = await prisma.flutterwaveSubaccount.findUnique({
      where: { userId_currency: { userId: params.userId, currency } },
    });
    if (existing) {
      logger.info("Subaccount already exists for user + currency", {
        userId: params.userId,
        currency,
        subaccountId: existing.subaccountId,
      });
      return existing;
    }

    const payload: any = {
      account_bank: params.accountBank,
      account_number: params.accountNumber,
      business_name: params.businessName,
      business_email: params.businessEmail,
      business_contact: params.businessContact,
      business_contact_mobile: params.businessContactMobile,
      business_mobile: params.businessMobile,
      country: params.country || "RW",
      split_type: params.splitType || FLUTTERWAVE_SPLIT.TYPE,
      split_value: params.splitValue ?? FLUTTERWAVE_SPLIT.VALUE,
      meta: params.meta
        ? Object.entries(params.meta).map(([meta_name, meta_value]) => ({
            meta_name,
            meta_value,
          }))
        : undefined,
    };

    try {
      const response: any = await client.Subaccount.create(payload);
      const remoteId = response?.data?.id ?? response?.id;
      if (!remoteId) {
        throw new Error("Flutterwave returned no subaccount id");
      }

      const saved = await prisma.flutterwaveSubaccount.create({
        data: {
          userId: params.userId,
          subaccountId: String(remoteId),
          accountBank: params.accountBank,
          accountNumber: params.accountNumber,
          businessName: params.businessName,
          businessEmail: params.businessEmail,
          currency,
          country: params.country || "RW",
          splitType: params.splitType || FLUTTERWAVE_SPLIT.TYPE,
          splitValue: params.splitValue ?? FLUTTERWAVE_SPLIT.VALUE,
        },
      });
      logger.info("Subaccount created and stored", {
        userId: params.userId,
        currency,
        subaccountId: saved.subaccountId,
      });
      return saved;
    } catch (error: any) {
      logger.error("Failed to create Flutterwave subaccount", {
        error: error?.message || error,
      });
      throw error;
    }
  }

  /** Get a stored subaccount for a user by currency (default RWF). */
  async getSubaccount(userId: string, currency = "RWF") {
    return prisma.flutterwaveSubaccount.findUnique({
      where: { userId_currency: { userId, currency: currency.toUpperCase() } },
    });
  }

  /** All subaccounts a user owns (one per currency). */
  async listSubaccounts(userId: string) {
    return prisma.flutterwaveSubaccount.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
    });
  }

  /** One business per user. Returns the existing profile or creates it. */
  async ensureBusiness(params: {
    userId: string;
    name: string;
    email?: string;
    phone?: string;
    country?: string;
    registrationNumber?: string;
  }) {
    const existing = await prisma.business.findUnique({
      where: { userId: params.userId },
    });
    if (existing) return existing;

    return prisma.business.create({
      data: {
        userId: params.userId,
        name: params.name,
        email: params.email,
        phone: params.phone,
        country: params.country || "RW",
        registrationNumber: params.registrationNumber,
      },
    });
  }

  async getBusiness(userId: string) {
    return prisma.business.findUnique({ where: { userId } });
  }

  async fetchSubaccount(id: string | number) {
    const client = this.ensureClient();

    try {
      const response = await client.Subaccount.fetch({ id });
      logger.info("Subaccount fetched", { id });
      return response;
    } catch (error: any) {
      logger.error("Failed to fetch Flutterwave subaccount", {
        id,
        error: error?.message || error,
      });
      throw error;
    }
  }

  async fetchSubaccounts(page = 1, limit = 50) {
    const client = this.ensureClient();

    try {
      const response = await client.Subaccount.fetch_all({ page, limit });
      logger.info("Subaccounts fetched", { page, limit });
      return response;
    } catch (error: any) {
      logger.error("Failed to fetch Flutterwave subaccounts", {
        error: error?.message || error,
      });
      throw error;
    }
  }

  async updateSubaccount(
    id: string | number,
    params: Partial<{
      accountBank: string;
      accountNumber: string;
      businessName: string;
      businessEmail: string;
      businessContact: string;
      businessContactMobile: string;
      businessMobile: string;
      country: string;
      splitType: "percentage" | "flat";
      splitValue: string | number;
      meta: Record<string, string>;
    }>
  ) {
    const client = this.ensureClient();

    const payload: any = {
      id,
    };

    if (params.accountBank) payload.account_bank = params.accountBank;
    if (params.accountNumber) payload.account_number = params.accountNumber;
    if (params.businessName) payload.business_name = params.businessName;
    if (params.businessEmail) payload.business_email = params.businessEmail;
    if (params.businessContact) payload.business_contact = params.businessContact;
    if (params.businessContactMobile) payload.business_contact_mobile = params.businessContactMobile;
    if (params.businessMobile) payload.business_mobile = params.businessMobile;
    if (params.country) payload.country = params.country;
    if (params.splitType) payload.split_type = params.splitType;
    if (params.splitValue !== undefined) payload.split_value = params.splitValue;
    if (params.meta) {
      payload.meta = Object.entries(params.meta).map(([meta_name, meta_value]) => ({
        meta_name,
        meta_value,
      }));
    }

    try {
      const response = await client.Subaccount.update(payload);
      logger.info("Subaccount updated", { id });
      return response;
    } catch (error: any) {
      logger.error("Failed to update Flutterwave subaccount", {
        id,
        error: error?.message || error,
      });
      throw error;
    }
  }

  // ------- Collections (Rwanda mobile money) -------

  /**
   * Generate an order_id. Flutterwave's SDK validator hard-requires
   * `order_id` whenever currency is RWF (create.js), even though the
   * published docs omit it - without this every RWF charge throws.
   */
  private generateOrderId(): string {
    const ts = Date.now().toString(36);
    const rand = crypto.randomBytes(5).toString("hex");
    return `3RIKE-ORD-${ts}-${rand}`.slice(0, 100);
  }

  /**
   * Flutterwave requires an email on every charge, but our buyers are
   * anonymous. Synthesise a syntactically valid, non-deliverable one from
   * the payer's number so we never have to ask for it.
   */
  private syntheticBuyerEmail(phoneDigits: string): string {
    return `buyer-${phoneDigits}@pay.3rike.app`;
  }

  /**
   * Charge a customer's Rwanda mobile money wallet.
   *
   * The carrier pushes an authorization prompt to the handset; the
   * `meta.authorization.redirect` URL in the response is the fallback
   * confirmation page. We store it on the invoice and let the merchant
   * forward it if the customer never sees a prompt - we never message the
   * buyer ourselves.
   *
   * Returns the raw Flutterwave response; callers read
   * `meta.authorization.redirect` from it.
   */
  async chargeRwandaMobileMoney(params: {
    txRef: string;
    amount: number;
    currency?: string;
    email?: string;
    phoneNumber: string;
    fullname?: string;
    orderId?: string;
    redirectUrl?: string;
    meta?: Record<string, unknown>;
  }) {
    const client = this.ensureClient();

    const phone = toRwandaPhone(params.phoneNumber);
    if (!phone) {
      throw new Error(`Not a valid Rwanda mobile number: ${params.phoneNumber}`);
    }

    const amount = Number(params.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error(`Invalid charge amount: ${params.amount}`);
    }

    const payload: any = {
      tx_ref: params.txRef,
      order_id: params.orderId || this.generateOrderId(),
      amount,
      currency: (params.currency || "RWF").toUpperCase(),
      email: params.email || this.syntheticBuyerEmail(phone),
      phone_number: phone,
      fullname: params.fullname,
      redirect_url: params.redirectUrl,
      meta: params.meta,
    };

    try {
      const response: any = await client.MobileMoney.rwanda(payload);
      logger.info("Rwanda mobile money charge initiated", {
        txRef: params.txRef,
        amount,
        phone,
        paymentUrl: response?.meta?.authorization?.redirect || null,
      });
      return response;
    } catch (error: any) {
      logger.error("Failed to initiate Rwanda mobile money charge", {
        txRef: params.txRef,
        error: error?.message || error,
      });
      throw error;
    }
  }

  /** Pull the authorization/redirect URL out of a charge response. */
  extractPaymentUrl(response: any): string | null {
    return response?.meta?.authorization?.redirect || null;
  }

  // ------- Transaction Verification -------

  async verifyTransaction(id: string | number) {
    const client = this.ensureClient();

    try {
      const response = await client.Transaction.verify({ id });
      logger.info("Transaction verified", { id });
      return response;
    } catch (error: any) {
      logger.error("Failed to verify Flutterwave transaction", {
        id,
        error: error?.message || error,
      });
      throw error;
    }
  }

  async verifyTransactionByTxRef(txRef: string) {
    const client = this.ensureClient();

    try {
      const response = await client.Transaction.verify_by_tx({ tx_ref: txRef });
      // Log the verdict, not just the call: "verified but never settled" and
      // "settled but never notified" are two different bugs.
      const body = response as any;
      logger.info("Transaction verified by tx_ref", {
        txRef,
        status: body?.data?.status ?? body?.status ?? "unknown",
      });
      return response;
    } catch (error: any) {
      logger.error("Failed to verify Flutterwave transaction by tx_ref", {
        txRef,
        error: error?.message || error,
      });
      throw error;
    }
  }

  // ------- Transfers / Payouts -------

  async initiateTransfer(params: {
    accountBank: string;
    accountNumber: string;
    amount: number;
    narration: string;
    currency?: string;
    reference: string;
    callbackUrl?: string;
    debitCurrency?: string;
    beneficiaryName?: string;
    meta?: Record<string, unknown>;
  }) {
    const client = this.ensureClient();

    const payload: any = {
      account_bank: params.accountBank,
      account_number: params.accountNumber,
      amount: params.amount,
      narration: params.narration,
      currency: params.currency || "RWF",
      reference: params.reference,
      callback_url: params.callbackUrl,
      debit_currency: params.debitCurrency,
      beneficiary_name: params.beneficiaryName,
      meta: params.meta,
    };

    try {
      const response = await client.Transfer.initiate(payload);
      logger.info("Transfer initiated", { reference: params.reference });
      return response;
    } catch (error: any) {
      logger.error("Failed to initiate Flutterwave transfer", {
        reference: params.reference,
        error: error?.message || error,
      });
      throw error;
    }
  }

  // ------- Balances -------

  async getBalances() {
    const client = this.ensureClient();

    try {
      const response = await client.Misc.bal();
      logger.info("Wallet balances fetched");
      return response;
    } catch (error: any) {
      logger.error("Failed to fetch Flutterwave balances", {
        error: error?.message || error,
      });
      throw error;
    }
  }

  async getBalanceByCurrency(currency: string) {
    const client = this.ensureClient();

    try {
      const response = await client.Misc.bal_currency({ currency });
      logger.info("Wallet balance fetched", { currency });
      return response;
    } catch (error: any) {
      logger.error("Failed to fetch Flutterwave balance by currency", {
        currency,
        error: error?.message || error,
      });
      throw error;
    }
  }

  // ------- Settlements -------

  async fetchSettlements(page = 1) {
    const client = this.ensureClient();

    try {
      const response = await client.Settlement.fetch_all({ page });
      logger.info("Settlements fetched", { page });
      return response;
    } catch (error: any) {
      logger.error("Failed to fetch Flutterwave settlements", {
        error: error?.message || error,
      });
      throw error;
    }
  }

  async fetchSettlement(id: string | number, from?: string, to?: string) {
    const client = this.ensureClient();

    const payload: any = { id };
    if (from) payload.from = from;
    if (to) payload.to = to;

    try {
      const response = await client.Settlement.fetch(payload);
      logger.info("Settlement fetched", { id });
      return response;
    } catch (error: any) {
      logger.error("Failed to fetch Flutterwave settlement", {
        id,
        error: error?.message || error,
      });
      throw error;
    }
  }

  // ------- Transaction History -------

  async fetchTransactions(params?: {
    from?: string;
    to?: string;
    page?: number;
    subaccount_id?: string;
    status?: string;
  }) {
    const client = this.ensureClient();

    try {
      const response = await client.Transaction.fetch(params);
      logger.info("Transactions fetched", { params });
      return response;
    } catch (error: any) {
      logger.error("Failed to fetch Flutterwave transactions", {
        error: error?.message || error,
      });
      throw error;
    }
  }

  // ------- Transfer History -------

  async fetchTransfers(params?: { status?: string; page?: number }) {
    const client = this.ensureClient();

    try {
      const response = await client.Transfer.fetch(params);
      logger.info("Transfers fetched", { params });
      return response;
    } catch (error: any) {
      logger.error("Failed to fetch Flutterwave transfers", {
        error: error?.message || error,
      });
      throw error;
    }
  }

  async getTransfer(id: string | number) {
    const client = this.ensureClient();

    try {
      const response = await client.Transfer.get_a_transfer({ id });
      logger.info("Transfer fetched", { id });
      return response;
    } catch (error: any) {
      logger.error("Failed to fetch Flutterwave transfer", {
        id,
        error: error?.message || error,
      });
      throw error;
    }
  }

  // ------- Banks -------

  async getBanksByCountry(country = "RW") {
    const client = this.ensureClient();

    try {
      const response = await client.Bank.country({ country });
      logger.info("Banks fetched", { country });
      return response;
    } catch (error: any) {
      logger.error("Failed to fetch Flutterwave banks", {
        country,
        error: error?.message || error,
      });
      throw error;
    }
  }

  // ------- Webhook Verification -------

  /**
   * Verify a Flutterwave webhook signature.
   * Flutterwave sends the configured secret hash in the `verif-hash` header.
   */
  verifyWebhookSignature(signature: string): boolean {
    const expected = config.flutterwave.webhookSecret;

    if (!expected) {
      logger.warn("FLUTTERWAVE_WEBHOOK_SECRET is not set; webhook verification will fail");
      return false;
    }

    try {
      const received = Buffer.from(signature, "utf8");
      const computed = Buffer.from(expected, "utf8");

      if (received.length !== computed.length) return false;
      return crypto.timingSafeEqual(received, computed);
    } catch (error: any) {
      logger.error("Webhook signature verification failed", { error: error.message });
      return false;
    }
  }
}

export const flutterwave = new FlutterwaveService();
