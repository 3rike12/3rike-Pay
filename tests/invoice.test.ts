import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/config", () => ({
  config: {
    logLevel: "debug",
    redis: {},
    flutterwave: {},
  },
}));

vi.mock("@/services/redis", () => ({
  redis: null,
}));

const chargeRwandaMobileMoney = vi.fn();
const extractPaymentUrl = vi.fn();
const verifyTransactionByTxRef = vi.fn();
const sendTextMessage = vi.fn().mockResolvedValue(true);
const isV4Enabled = vi.fn(() => false);
const chargeV4 = vi.fn();
const extractV4PaymentUrl = vi.fn(() => null);
const extractV4PaymentInstruction = vi.fn(() => null);
const retrieveV4Charge = vi.fn(() => null);

vi.mock("@/services/flutterwave", () => ({
  flutterwave: {
    chargeRwandaMobileMoney: (...args: any[]) => chargeRwandaMobileMoney(...args),
    extractPaymentUrl: (...args: any[]) => extractPaymentUrl(...args),
    verifyTransactionByTxRef: (...args: any[]) => verifyTransactionByTxRef(...args),
    isV4Enabled: (...args: any[]) => isV4Enabled(...args),
    chargeRwandaMobileMoneyV4: (...args: any[]) => chargeV4(...args),
    extractV4PaymentUrl: (...args: any[]) => extractV4PaymentUrl(...args),
    extractV4PaymentInstruction: (...args: any[]) => extractV4PaymentInstruction(...args),
    retrieveV4Charge: (...args: any[]) => retrieveV4Charge(...args),
  },
}));

vi.mock("@/services/whatsapp", () => ({
  whatsapp: {
    sendTextMessage: (...args: any[]) => sendTextMessage(...args),
  },
}));

const ledgerCredit = vi.fn();

vi.mock("@/services/ledger", () => ({
  ledger: { credit: (...args: any[]) => ledgerCredit(...args) },
}));

type Row = Record<string, any>;
const callOrder: string[] = [];
let invoiceRow: Row | null = null;
let transactionRow: Row | null = null;

vi.mock("@/db/prisma", () => ({
  prisma: {
    invoice: {
      findUnique: vi.fn(async () => invoiceRow),
      findFirst: vi.fn(async (args: any) =>
        invoiceRow && args?.where?.merchantId === invoiceRow.merchantId
          ? invoiceRow
          : null
      ),
      findMany: vi.fn(async () => []),
      create: vi.fn(async (args: any) => {
        invoiceRow = { ...args.data, id: "inv_1" };
        return invoiceRow;
      }),
      update: vi.fn(async (args: any) => {
        invoiceRow = { ...invoiceRow, ...args.data };
        return invoiceRow;
      }),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    transaction: {
      findUnique: vi.fn(async () => {
        callOrder.push("transaction.findUnique");
        return transactionRow;
      }),
      create: vi.fn(async (args: any) => {
        callOrder.push("transaction.create");
        transactionRow = { ...args.data, id: "tx_1" };
        return transactionRow;
      }),
      update: vi.fn(async (args: any) => {
        callOrder.push("transaction.update");
        transactionRow = { ...transactionRow, ...args.data };
        return transactionRow;
      }),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    product: {
      findMany: vi.fn(async () => []),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

import {
  chargeInvoice,
  scheduleInvoiceVerification,
  settleInvoicePayment,
  verifyInvoicePayment,
  renderPaidInvoiceMessage,
  renderBuyerRequestMessage,
} from "@/services/invoice";
import { flutterwave } from "@/services/flutterwave";
import { prisma } from "@/db/prisma";

const charge = vi.mocked(chargeRwandaMobileMoney as any);
const extract = vi.mocked(extractPaymentUrl as any);
const verify = vi.mocked(verifyTransactionByTxRef as any);
const notify = vi.mocked(sendTextMessage as any);
const credit = vi.mocked(ledgerCredit as any);
const v4Enabled = vi.mocked(isV4Enabled as any);
const chargePush = vi.mocked(chargeV4 as any);
const extractPushUrl = vi.mocked(extractV4PaymentUrl as any);
const extractPushNote = vi.mocked(extractV4PaymentInstruction as any);
const retrievePushCharge = vi.mocked(retrieveV4Charge as any);

function seedInvoice(overrides: Row = {}) {
  invoiceRow = {
    id: "inv_1",
    merchantId: "merch_1",
    merchant: { id: "merch_1", phone: "0771234567" },
    buyerPhone: "0781234567",
    items: [{ name: "batteries", qty: 3, unitPrice: 1000 }],
    amount: 3000,
    currency: "RWF",
    reference: "3RIKE-20260930-ABC123",
    status: "draft",
    paymentUrl: null,
    expiresAt: null,
    paidAt: null,
    ...overrides,
  };
  transactionRow = null;
  callOrder.length = 0;
}

beforeEach(() => {
  vi.clearAllMocks();
  // v3 stays the default path; individual tests opt into the v4 push.
  v4Enabled.mockReturnValue(false);
  extractPushUrl.mockReturnValue(null);
  extractPushNote.mockReturnValue(null);
  retrievePushCharge.mockResolvedValue(null as any);
  seedInvoice();
});

describe("chargeInvoice", () => {
  it("writes the transaction before charging, then marks the invoice pending", async () => {
    charge.mockResolvedValue({ status: "success", meta: { authorization: { redirect: "https://checkout.flutterwave.com/v3/hosted/pay/abc" } } });
    extract.mockReturnValue("https://checkout.flutterwave.com/v3/hosted/pay/abc");

    const result = await chargeInvoice({ merchantId: "merch_1", invoiceId: "inv_1" });

    expect(callOrder.indexOf("transaction.create")).toBeLessThan(callOrder.indexOf("transaction.update"));
    expect(charge).toHaveBeenCalledTimes(1);
    expect(charge).toHaveBeenCalledWith({
      txRef: "3RIKE-20260930-ABC123",
      orderId: "3RIKE-20260930-ABC123",
      amount: 3000,
      currency: "RWF",
      phoneNumber: "0781234567",
      redirectUrl: undefined,
      meta: { invoice_id: "inv_1", merchant_id: "merch_1" },
    });
    expect(result.txRef).toBe("3RIKE-20260930-ABC123");
    expect(result.paymentUrl).toBe("https://checkout.flutterwave.com/v3/hosted/pay/abc");
    expect(invoiceRow.status).toBe("pending_payment");
    expect(invoiceRow.paymentUrl).toBe("https://checkout.flutterwave.com/v3/hosted/pay/abc");
    expect(invoiceRow.expiresAt).not.toBeNull();
    expect(transactionRow.status).toBe("processing");
    expect(transactionRow.type).toBe("invoice");
    expect(transactionRow.currency).toBe("RWF");
  });

  it("passes a numeric amount even when the invoice stores a float", async () => {
    seedInvoice({ amount: 1500.5, status: "sent" });
    charge.mockResolvedValue({});
    extract.mockReturnValue(null);

    await chargeInvoice({ merchantId: "merch_1", invoiceId: "inv_1" });

    const payload = charge.mock.calls[0][0];
    expect(typeof payload.amount).toBe("number");
    expect(payload.orderId).toBe("3RIKE-20260930-ABC123");
  });

  it("rejects an already paid invoice", async () => {
    seedInvoice({ status: "paid" });
    await expect(
      chargeInvoice({ merchantId: "merch_1", invoiceId: "inv_1" })
    ).rejects.toThrow(/already paid/i);
    expect(charge).not.toHaveBeenCalled();
  });

  it("rejects an invoice belonging to another merchant", async () => {
    seedInvoice();
    await expect(
      chargeInvoice({ merchantId: "someone_else", invoiceId: "inv_1" })
    ).rejects.toThrow(/not found/i);
    expect(charge).not.toHaveBeenCalled();
  });

  it("does not create a second transaction row on retry", async () => {
    seedInvoice({ status: "pending_payment" });
    transactionRow = { id: "tx_1", reference: "3RIKE-20260930-ABC123" };
    callOrder.length = 0;
    charge.mockResolvedValue({});
    extract.mockReturnValue(null);

    await chargeInvoice({ merchantId: "merch_1", invoiceId: "inv_1" });

    expect((prisma.transaction.create as any).mock.calls.length).toBe(0);
  });

  it("pushes the payment prompt through v4 instead of handing back a link", async () => {
    v4Enabled.mockReturnValue(true);
    chargePush.mockResolvedValue({
      id: "chg_1",
      status: "pending",
      next_action: { type: "payment_instruction", payment_instruction: { note: "Check your phone to approve." } },
    });
    extractPushNote.mockReturnValue("Check your phone to approve.");

    const result = await chargeInvoice({ merchantId: "merch_1", invoiceId: "inv_1" });

    expect(chargePush).toHaveBeenCalledWith({
      reference: "3RIKE-20260930-ABC123",
      amount: 3000,
      currency: "RWF",
      phoneNumber: "0781234567",
      redirectUrl: undefined,
      meta: { invoice_id: "inv_1", merchant_id: "merch_1" },
    });
    // The legacy link charge must not run alongside the push.
    expect(charge).not.toHaveBeenCalled();
    expect(result.paymentUrl).toBeNull();
    expect(result.paymentNote).toBe("Check your phone to approve.");
    expect(result.chargeId).toBe("chg_1");
    expect(invoiceRow.paymentUrl).toBeNull();
    expect(invoiceRow.status).toBe("pending_payment");
    expect(transactionRow.metadata).toMatchObject({ chargeId: "chg_1", paymentNote: "Check your phone to approve." });
  });

  it("stores the redirect when v4 answers with a link instead of a push", async () => {
    v4Enabled.mockReturnValue(true);
    chargePush.mockResolvedValue({
      id: "chg_2",
      next_action: { type: "redirect_url", redirect_url: { url: "https://checkout.flutterwave.com/pay/abc" } },
    });
    extractPushUrl.mockReturnValue("https://checkout.flutterwave.com/pay/abc");

    const result = await chargeInvoice({ merchantId: "merch_1", invoiceId: "inv_1" });

    expect(result.paymentUrl).toBe("https://checkout.flutterwave.com/pay/abc");
    expect(result.paymentNote).toBeNull();
    expect(invoiceRow.paymentUrl).toBe("https://checkout.flutterwave.com/pay/abc");
  });

  it("falls back to the v3 link charge when the v4 push is rejected", async () => {
    v4Enabled.mockReturnValue(true);
    chargePush.mockRejectedValue(new Error("Currency not supported for RW Mobile Money."));
    charge.mockResolvedValue({ status: "success" });
    extract.mockReturnValue("https://checkout.flutterwave.com/v3/hosted/pay/abc");

    const result = await chargeInvoice({ merchantId: "merch_1", invoiceId: "inv_1" });

    expect(chargePush).toHaveBeenCalledTimes(1);
    expect(charge).toHaveBeenCalledTimes(1);
    expect(result.paymentUrl).toBe("https://checkout.flutterwave.com/v3/hosted/pay/abc");
    expect(result.chargeId).toBeNull();
    expect(invoiceRow.status).toBe("pending_payment");
  });

  it("keeps the v3 path when v4 credentials are not configured", async () => {
    charge.mockResolvedValue({ status: "success" });
    extract.mockReturnValue(null);

    await chargeInvoice({ merchantId: "merch_1", invoiceId: "inv_1" });

    expect(chargePush).not.toHaveBeenCalled();
    expect(charge).toHaveBeenCalledTimes(1);
  });
});

describe("settleInvoicePayment", () => {
  it("flips to paid and credits the merchant exactly once", async () => {
    seedInvoice({ status: "pending_payment" });

    const first = await settleInvoicePayment("3RIKE-20260930-ABC123");
    expect(first.settled).toBe(true);
    expect(invoiceRow.status).toBe("paid");
    expect(invoiceRow.paidAt).toBeInstanceOf(Date);
    expect(credit).toHaveBeenCalledTimes(1);
    expect(credit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "merch_1",
        amount: 3000,
        currency: "RWF",
        reference: "3RIKE-20260930-ABC123",
        idempotencyKey: "fw-charge-credit:3RIKE-20260930-ABC123",
      })
    );

    const second = await settleInvoicePayment("3RIKE-20260930-ABC123");
    expect(second.settled).toBe(false);
    expect(credit).toHaveBeenCalledTimes(1);
    // Merchant first, then the buyer - one message each, sent exactly once.
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[0][0]).toBe("0771234567");
    expect(notify.mock.calls[0][1]).toContain("Payment Received");
    expect(notify.mock.calls[0][1]).toContain("RWF 3,000");
    // The internal reference must never reach a message.
    expect(notify.mock.calls[0][1]).not.toContain("3RIKE-20260930-ABC123");

    expect(notify.mock.calls[1][0]).toBe("0781234567");
    expect(notify.mock.calls[1][1]).toContain("Payment confirmed");
    expect(notify.mock.calls[1][1]).toContain("RWF 3,000");
    expect(notify.mock.calls[1][1]).not.toContain("3RIKE-20260930-ABC123");
  });

  it("returns settled=false for an unknown reference", async () => {
    invoiceRow = null;
    const result = await settleInvoicePayment("does-not-exist");
    expect(result.settled).toBe(false);
    expect(credit).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("still settles when the invoice has no buyer phone to confirm to", async () => {
    seedInvoice({ status: "pending_payment", buyerPhone: "" });

    const result = await settleInvoicePayment("3RIKE-20260930-ABC123");

    expect(result.settled).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1); // merchant only
    expect(notify.mock.calls[0][0]).toBe("0771234567");
  });
});

describe("verifyInvoicePayment", () => {
  it("settles when Flutterwave reports success", async () => {
    seedInvoice({ status: "pending_payment" });
    verify.mockResolvedValue({ data: { status: "successful" } });

    const result = await verifyInvoicePayment("3RIKE-20260930-ABC123");

    expect(result).toBe("settled");
    expect(invoiceRow.status).toBe("paid");
    expect(credit).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(2);
    expect((prisma.transaction.updateMany as any).mock.calls[0][0]).toEqual({
      where: { reference: "3RIKE-20260930-ABC123" },
      data: { status: "completed" },
    });
  });

  it("leaves the invoice pending while Flutterwave still says pending", async () => {
    seedInvoice({ status: "pending_payment" });
    verify.mockResolvedValue({ data: { status: "pending" } });

    const result = await verifyInvoicePayment("3RIKE-20260930-ABC123");

    expect(result).toBe("pending");
    expect(invoiceRow.status).toBe("pending_payment");
    expect(credit).not.toHaveBeenCalled();
  });

  it("fails the invoice when Flutterwave reports failure", async () => {
    seedInvoice({ status: "pending_payment" });
    verify.mockResolvedValue({ data: { status: "failed" } });

    const result = await verifyInvoicePayment("3RIKE-20260930-ABC123");

    expect(result).toBe("failed");
    expect(invoiceRow.status).toBe("failed");
  });

  it("does not call Flutterwave for an invoice that is already settled", async () => {
    seedInvoice({ status: "paid" });

    const result = await verifyInvoicePayment("3RIKE-20260930-ABC123");

    expect(result).toBe("settled");
    expect(verify).not.toHaveBeenCalled();
  });

  it("treats an unknown reference as unknown", async () => {
    invoiceRow = null;
    expect(await verifyInvoicePayment("nope")).toBe("unknown");
  });

  it("swallows verification errors and stays pending", async () => {
    seedInvoice({ status: "pending_payment" });
    verify.mockRejectedValue(new Error("network down"));

    expect(await verifyInvoicePayment("3RIKE-20260930-ABC123")).toBe("pending");
    expect(invoiceRow.status).toBe("pending_payment");
  });

  it("reads the v4 charge by id when the push flow recorded one", async () => {
    seedInvoice({ status: "pending_payment" });
    transactionRow = {
      id: "tx_1",
      reference: "3RIKE-20260930-ABC123",
      metadata: { chargeId: "chg_1" },
    };
    v4Enabled.mockReturnValue(true);
    retrievePushCharge.mockResolvedValue({ id: "chg_1", status: "succeeded" });

    const result = await verifyInvoicePayment("3RIKE-20260930-ABC123");

    expect(result).toBe("settled");
    expect(retrievePushCharge).toHaveBeenCalledWith("chg_1");
    expect(verify).not.toHaveBeenCalled();
    expect(invoiceRow.status).toBe("paid");
  });

  it("stays pending while the v4 charge is still pending", async () => {
    seedInvoice({ status: "pending_payment" });
    transactionRow = {
      id: "tx_1",
      reference: "3RIKE-20260930-ABC123",
      metadata: { chargeId: "chg_1" },
    };
    v4Enabled.mockReturnValue(true);
    retrievePushCharge.mockResolvedValue({ id: "chg_1", status: "PENDING" });

    expect(await verifyInvoicePayment("3RIKE-20260930-ABC123")).toBe("pending");
    expect(invoiceRow.status).toBe("pending_payment");
    expect(credit).not.toHaveBeenCalled();
  });

  it("fails the invoice when the v4 charge fails", async () => {
    seedInvoice({ status: "pending_payment" });
    transactionRow = {
      id: "tx_1",
      reference: "3RIKE-20260930-ABC123",
      metadata: { chargeId: "chg_1" },
    };
    v4Enabled.mockReturnValue(true);
    retrievePushCharge.mockResolvedValue({ id: "chg_1", status: "FAILED" });

    expect(await verifyInvoicePayment("3RIKE-20260930-ABC123")).toBe("failed");
    expect(invoiceRow.status).toBe("failed");
  });

  it("keeps polling when Flutterwave no longer knows the v4 charge", async () => {
    seedInvoice({ status: "pending_payment" });
    transactionRow = {
      id: "tx_1",
      reference: "3RIKE-20260930-ABC123",
      metadata: { chargeId: "chg_1" },
    };
    v4Enabled.mockReturnValue(true);
    retrievePushCharge.mockResolvedValue(null);

    expect(await verifyInvoicePayment("3RIKE-20260930-ABC123")).toBe("pending");
    expect(invoiceRow.status).toBe("pending_payment");
    expect(verify).not.toHaveBeenCalled();
  });
});

describe("scheduleInvoiceVerification", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops polling as soon as the invoice settles", async () => {
    vi.useFakeTimers();
    seedInvoice({ status: "pending_payment" });
    verify.mockResolvedValue({ data: { status: "successful" } });

    scheduleInvoiceVerification("3RIKE-20260930-ABC123", [10, 20, 30]);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(verify).toHaveBeenCalledTimes(1);
    expect(invoiceRow?.status).toBe("paid");
  });

  it("keeps polling while the buyer has not completed the payment", async () => {
    vi.useFakeTimers();
    seedInvoice({ status: "pending_payment" });
    verify.mockResolvedValue({ data: { status: "pending" } });

    scheduleInvoiceVerification("3RIKE-20260930-ABC123", [10, 20, 30]);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(verify).toHaveBeenCalledTimes(3);
    expect(invoiceRow?.status).toBe("pending_payment");
  });
});

describe("renderPaidInvoiceMessage", () => {
  it("is currency aware and omits the internal reference", () => {
    const message = renderPaidInvoiceMessage({
      items: [{ name: "batteries", qty: 3, unitPrice: 1000 }],
      amount: 3000,
      currency: "RWF",
      buyerPhone: "0781234567",
    });

    expect(message).toContain("RWF 3,000");
    expect(message).toContain("3 x batteries: RWF 3,000");
    expect(message).toContain("Buyer: 0781234567");
  });
});

describe("renderBuyerRequestMessage", () => {
  const invoice = {
    items: [{ name: "batteries", qty: 3, unitPrice: 1000 }],
    amount: 3000,
    currency: "RWF",
  };

  it("prefers the link when there is one", () => {
    const message = renderBuyerRequestMessage(invoice, "https://pay.example/x", "Approve it");

    expect(message).toContain("https://pay.example/x");
    expect(message).not.toContain("prompt");
  });

  it("points at the handset prompt when the charge was pushed", () => {
    const message = renderBuyerRequestMessage(invoice, null, "Approve this payment on your phone.");

    expect(message).toContain("payment prompt");
    expect(message).toContain("Approve this payment on your phone.");
    expect(message).toContain("RWF 3,000");
    expect(message).not.toContain("https://");
  });

  it("says the link is not ready when neither arrived", () => {
    const message = renderBuyerRequestMessage(invoice, null, null);

    expect(message).toContain("not ready");
    expect(message).not.toContain("https://");
  });
});
