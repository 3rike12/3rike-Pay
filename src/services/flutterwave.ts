import Flutterwave, { FlutterwaveInstance } from "flutterwave-node-v3";
import crypto from "crypto";
import { config } from "@/config";
import { FLUTTERWAVE_SPLIT } from "@/config/constants";
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
      const response = await client.Subaccount.create(payload);
      logger.info("Subaccount created", { businessName: params.businessName });
      return response;
    } catch (error: any) {
      logger.error("Failed to create Flutterwave subaccount", {
        error: error?.message || error,
      });
      throw error;
    }
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
   * Charge a customer's Rwanda mobile money wallet.
   * Customer authorizes via redirect/callback flow.
   */
  async chargeRwandaMobileMoney(params: {
    txRef: string;
    amount: string;
    currency?: string;
    email: string;
    phoneNumber: string;
    fullname?: string;
    orderId?: string;
    redirectUrl?: string;
    meta?: Record<string, unknown>;
  }) {
    const client = this.ensureClient();

    const payload: any = {
      tx_ref: params.txRef,
      order_id: params.orderId,
      amount: params.amount,
      currency: params.currency || "RWF",
      email: params.email,
      phone_number: params.phoneNumber,
      fullname: params.fullname,
      redirect_url: params.redirectUrl,
      meta: params.meta,
    };

    try {
      const response = await client.MobileMoney.rwanda(payload);
      logger.info("Rwanda mobile money charge initiated", {
        txRef: params.txRef,
        amount: params.amount,
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
      logger.info("Transaction verified by tx_ref", { txRef });
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
