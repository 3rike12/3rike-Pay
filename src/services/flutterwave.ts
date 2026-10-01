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
      // The SDK resolves Flutterwave error bodies instead of rejecting them
      // (rave.base.js only logs telemetry), so a rejected charge arrives here
      // looking like a success - and no transaction ever gets created. Verify
      // then answers "No transaction was found for this id".
      const envelope = String(response?.status ?? "").toLowerCase().trim();
      if (envelope !== "success") {
        const message =
          response?.message || "Flutterwave rejected the mobile money charge";
        logger.error("Rwanda mobile money charge rejected by Flutterwave", {
          txRef: params.txRef,
          code: response?.code ?? null,
          message,
        });
        throw new Error(message);
      }
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

  // ------- v4 API (OAuth client credentials, push charges) -------
  //
  // The v4 API is what can push a payment prompt straight to the buyer's
  // handset (`next_action.type: "payment_instruction"`) instead of handing
  // back a link they have to open. It authenticates with an OAuth token
  // minted from FLUTTERWAVE_CLIENT_ID/SECRET, not the v3 secret key.

  private v4Token: { value: string; expiresAt: number } | null = null;

  /** True when the v4 OAuth credentials are configured. */
  isV4Enabled(): boolean {
    const { clientId, clientSecret } = config.flutterwave;
    return Boolean(clientId && clientSecret);
  }

  /** Fetch (and cache) a v4 access token. Valid for 10 minutes. */
  private async v4AccessToken(): Promise<string> {
    const { clientId, clientSecret, tokenUrl } = config.flutterwave;
    if (!clientId || !clientSecret) {
      throw new Error("Flutterwave v4 credentials are not configured");
    }

    const now = Date.now();
    if (this.v4Token && this.v4Token.expiresAt > now) return this.v4Token.value;

    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "client_credentials",
      }),
    });

    const body: any = await response.json().catch(() => null);
    if (!response.ok || !body?.access_token) {
      throw new Error(
        body?.error_description ||
          body?.error ||
          `Flutterwave token request failed (${response.status})`
      );
    }

    // Tokens live 10 minutes; refresh a minute early so a request that
    // starts just before expiry is not sent on a dead token.
    const ttlSeconds = Number(body.expires_in ?? 600);
    this.v4Token = {
      value: body.access_token,
      expiresAt: now + Math.max(ttlSeconds - 60, 30) * 1000,
    };
    return this.v4Token.value;
  }

  /**
   * One v4 API call: bearer token, required X-Trace-Id, and a single retry
   * with a freshly minted token when the cached one has been invalidated
   * server-side before its local expiry.
   */
  private async v4Request<T = any>(
    path: string,
    options: {
      method?: "GET" | "POST" | "PUT";
      body?: unknown;
      idempotencyKey?: string;
    } = {}
  ): Promise<T> {
    const { apiBase } = config.flutterwave;
    const method = options.method || "GET";

    const send = async () => {
      const token = await this.v4AccessToken();
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        // Flutterwave requires 12-255 chars; a UUID fits.
        "X-Trace-Id": crypto.randomUUID(),
      };
      if (options.idempotencyKey) {
        headers["X-Idempotency-Key"] = options.idempotencyKey;
      }
      return fetch(`${apiBase}${path}`, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
    };

    let response = await send();
    if (response.status === 401) {
      this.v4Token = null;
      response = await send();
    }

    const body: any = await response.json().catch(() => null);
    if (!response.ok || body?.status === "failed") {
      const validation = Array.isArray(body?.error?.validation_errors)
        ? body.error.validation_errors
            .map((v: any) => `${v?.field_name}: ${v?.message}`)
            .join("; ")
        : "";
      const message =
        body?.error?.message ||
        body?.message ||
        `Flutterwave v4 request failed (${response.status})`;
      logger.error("Flutterwave v4 request failed", {
        path,
        method,
        status: response.status,
        message,
        validation: validation || undefined,
      });
      throw new Error(validation ? `${message} (${validation})` : message);
    }

    return body as T;
  }

  /** Create a v4 customer. `email` is the only required field. */
  async createV4Customer(params: {
    email: string;
    name?: string;
    phoneNumber?: string;
  }) {
    const payload: Record<string, unknown> = { email: params.email };
    if (params.name) {
      // The API wants structured names; buyers are anonymous, so the whole
      // label goes in `first` (matches the 2-50 char pattern).
      payload.name = { first: params.name.slice(0, 50) };
    }
    if (params.phoneNumber) {
      const phone = this.toV4Phone(params.phoneNumber);
      if (phone) payload.phone = phone;
    }

    const response = await this.v4Request("/customers", {
      method: "POST",
      body: payload,
      idempotencyKey: crypto.randomUUID(),
    });
    const customerId = response?.data?.id;
    if (!customerId) {
      throw new Error("Flutterwave returned no customer id");
    }
    return { id: customerId as string, response };
  }

  /**
   * Create the mobile-money payment method a charge is made against.
   * `network` is mandatory on v4 (the v3 endpoint inferred it from the
   * number), so Rwanda's prefixes are mapped to the carrier here.
   */
  async createV4MobileMoneyPaymentMethod(params: {
    phoneNumber: string;
    network?: string;
    countryCode?: string;
  }) {
    const phone = this.toV4Phone(params.phoneNumber);
    if (!phone) {
      throw new Error(`Not a valid mobile number: ${params.phoneNumber}`);
    }

    const payload = {
      type: "mobile_money",
      mobile_money: {
        country_code: phone.country_code,
        network: params.network || this.rwandaNetwork(phone.number),
        // No leading zero, matching Flutterwave's examples (233 + 9012345678).
        phone_number: phone.number.replace(/^0/, ""),
      },
    };

    const response = await this.v4Request("/payment-methods", {
      method: "POST",
      body: payload,
      idempotencyKey: crypto.randomUUID(),
    });
    const paymentMethodId = response?.data?.id;
    if (!paymentMethodId) {
      throw new Error("Flutterwave returned no payment method id");
    }
    return { id: paymentMethodId as string, response };
  }

  /** Create a v4 charge. Returns the raw charge body (data.*). */
  async createV4Charge(params: {
    reference: string;
    amount: number;
    currency?: string;
    customerId: string;
    paymentMethodId: string;
    redirectUrl?: string;
    meta?: Record<string, unknown>;
  }) {
    const payload: Record<string, unknown> = {
      reference: params.reference,
      amount: Number(params.amount),
      currency: (params.currency || "RWF").toUpperCase(),
      customer_id: params.customerId,
      payment_method_id: params.paymentMethodId,
    };
    if (params.redirectUrl) payload.redirect_url = params.redirectUrl;
    if (params.meta) payload.meta = params.meta;

    const response = await this.v4Request("/charges", {
      method: "POST",
      body: payload,
      // Same invoice retried => same idempotency key => one charge.
      idempotencyKey: params.reference,
    });
    if (!response?.data?.id) {
      throw new Error("Flutterwave returned no charge id");
    }
    return response.data;
  }

  /** Retrieve a v4 charge by its id (`chg_...`). */
  async retrieveV4Charge(chargeId: string) {
    const response = await this.v4Request(`/charges/${chargeId}`);
    return response?.data ?? null;
  }

  /** Redirect URL out of a v4 charge's next_action, if it has one. */
  extractV4PaymentUrl(charge: any): string | null {
    const nextAction = charge?.next_action;
    if (nextAction?.type === "redirect_url") {
      return nextAction?.redirect_url?.url || null;
    }
    return null;
  }

  /** The human-readable instruction Flutterwave wants relayed to the payer. */
  extractV4PaymentInstruction(charge: any): string | null {
    const nextAction = charge?.next_action;
    if (nextAction?.type === "payment_instruction") {
      return nextAction?.payment_instruction?.note || null;
    }
    return null;
  }

  /** Networks Flutterwave supports for a country (probe/diagnostics). */
  async listV4MobileNetworks(countryCode = "RW") {
    const response = await this.v4Request(
      `/mobile-networks?country=${encodeURIComponent(countryCode)}`
    );
    return (response?.data ?? []) as Array<{ id: string; network: string; name: string }>;
  }

  /** Split a Rwanda number into the v4 country_code/national-number shape. */
  private toV4Phone(raw: string): { country_code: string; number: string } | null {
    const digits = raw.replace(/\D/g, "");
    const national = digits.startsWith("250")
      ? digits.slice(3)
      : digits.replace(/^0/, "");
    if (national.length < 7 || national.length > 10) return null;
    return { country_code: "250", number: national };
  }

  /**
   * Which Rwandan carrier a number belongs to. v4 requires `network`
   * explicitly; the prefixes are MTN (078/079), Airtel (072/073) and KTRN
   * (077). Unknown prefixes fall back to MTN - the largest network - and
   * Flutterwave rejects the charge loudly if that is wrong.
   */
  private rwandaNetwork(nationalNumber: string): string {
    const prefix = nationalNumber.replace(/^0/, "").slice(0, 2);
    switch (prefix) {
      case "78":
      case "79":
        return "MTN";
      case "72":
      case "73":
        return "AIRTEL";
      default:
        return "MTN";
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
      // Log the verdict, not just the call: "verified but never settled" and
      // "settled but never notified" are two different bugs.
      const body = response as any;
      logger.info("Transaction verified by tx_ref", {
        txRef,
        status: body?.data?.status ?? body?.status ?? "unknown",
        message: body?.message ?? null,
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
