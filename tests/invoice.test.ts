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
const ledgerDebit = vi.fn();
const ledgerListBalances = vi.fn(async () => [{ currency: "RWF", balance: 2850 }]);

vi.mock("@/services/ledger", () => ({
  ledger: {
    credit: (...args: any[]) => ledgerCredit(...args),
    debit: (...args: any[]) => ledgerDebit(...args),
    listBalances: (...args: any[]) => ledgerListBalances(...args),
  },
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
    user: {
      findUnique: vi.fn(async () => ({ id: "platform_user_1", phone: "system:platform" })),
      create: vi.fn(async (args: any) => ({ id: "platform_user_1", ...args.data })),
    },
  },
}));

import {
  chargeInvoice,
  humanizeChargeError,
  scheduleInvoiceVerification,
  settleInvoicePayment,
  verifyInvoicePayment,
  renderPaidInvoiceMessage,
} from "@/services/invoice";
import { flutterwave } from "@/services/flutterwave";
import { prisma } from "@/db/prisma";

const charge = vi.mocked(chargeRwandaMobileMoney as any);
const extract = vi.mocked(extractPaymentUrl as any);
const verify = vi.mocked(verifyTransactionByTxRef as any);
const notify = vi.mocked(sendTextMessage as any);
const credit = vi.mocked(ledgerCredit as any);
const debit = vi.mocked(ledgerDebit as any);
const listBalances = vi.mocked(ledgerListBalances as any);
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
  it("flips to paid, credits the gross, then debits the platform fee as its own entry", async () => {
    seedInvoice({ status: "pending_payment" });

    const first = await settleInvoicePayment("3RIKE-20260930-ABC123");
    expect(first.settled).toBe(true);
    expect(invoiceRow.status).toBe("paid");
    expect(invoiceRow.paidAt).toBeInstanceOf(Date);

    // The merchant wallet takes the gross, not the net.
    expect(credit).toHaveBeenCalledTimes(2);
    expect(credit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "merch_1",
        amount: 3000,
        currency: "RWF",
        reference: "3RIKE-20260930-ABC123",
        idempotencyKey: "fw-charge-credit:3RIKE-20260930-ABC123",
      })
    );

    // ...and the fee comes back off it as a separate, inspectable deduction.
    expect(debit).toHaveBeenCalledTimes(1);
    expect(debit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "merch_1",
        amount: 150,
        currency: "RWF",
        reference: "3RIKE-20260930-ABC123",
        idempotencyKey: "fw-fee-debit:3RIKE-20260930-ABC123",
        allowNegative: true,
        metadata: expect.objectContaining({
          type: "platform_fee",
          split: { gross: 3000, merchantShare: 2850, platformFee: 150, type: "percentage", value: 0.95 },
        }),
      })
    );

    // ...and the platform wallet takes the same fee.
    expect(credit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "platform_user_1",
        amount: 150,
        currency: "RWF",
        reference: "3RIKE-20260930-ABC123",
        idempotencyKey: "fw-fee-credit:3RIKE-20260930-ABC123",
        metadata: expect.objectContaining({
          type: "platform_fee",
          split: { gross: 3000, merchantShare: 2850, platformFee: 150, type: "percentage", value: 0.95 },
        }),
      })
    );

    // Gross credited, fee debited - the merchant nets the 95% share.
    expect(3000 - 150).toBe(2850);
    expect(2850 + 150).toBe(invoiceRow.amount);

    const second = await settleInvoicePayment("3RIKE-20260930-ABC123");
    expect(second.settled).toBe(false);
    expect(credit).toHaveBeenCalledTimes(2);
    expect(debit).toHaveBeenCalledTimes(1);
    // The merchant is messaged exactly once - and only the merchant.
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toBe("0771234567");
    expect(notify.mock.calls[0][1]).toContain("Payment Received");
    expect(notify.mock.calls[0][1]).toContain("RWF 3,000");
    // The merchant's new balance is quoted, not hand-waved.
    expect(listBalances).toHaveBeenCalledWith("merch_1");
    expect(notify.mock.calls[0][1]).toContain("New balance: RWF 2,850");
    expect(notify.mock.calls[0][1]).not.toContain("Your balance has been updated");
    // The internal reference must never reach a message.
    expect(notify.mock.calls[0][1]).not.toContain("3RIKE-20260930-ABC123");
    // The buyer gets nothing from us, paid or not.
    expect(notify).not.toHaveBeenCalledWith("0781234567", expect.anything());
  });

  it("still settles and tells the merchant the balance when the fee debit fails", async () => {
    seedInvoice({ status: "pending_payment" });
    debit.mockRejectedValueOnce(new Error("lock timeout"));

    const result = await settleInvoicePayment("3RIKE-20260930-ABC123");

    expect(result.settled).toBe(true);
    expect(invoiceRow.status).toBe("paid");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][1]).toContain("New balance: RWF 2,850");
    // Nothing came off them, so nothing is claimed as a deduction.
    expect(notify.mock.calls[0][1]).not.toContain("*Fees*");
    expect(notify.mock.calls[0][1]).not.toContain("- Platform fee");
  });

  it("records the split on the transaction row, keeping existing metadata", async () => {
    seedInvoice({ status: "pending_payment" });
    transactionRow = {
      id: "tx_1",
      reference: "3RIKE-20260930-ABC123",
      metadata: { chargeId: "chg_9" },
    };

    await settleInvoicePayment("3RIKE-20260930-ABC123");

    expect(transactionRow.metadata).toEqual({
      chargeId: "chg_9",
      split: { gross: 3000, merchantShare: 2850, platformFee: 150, type: "percentage", value: 0.95 },
    });
  });

  it("returns settled=false for an unknown reference", async () => {
    invoiceRow = null;
    const result = await settleInvoicePayment("does-not-exist");
    expect(result.settled).toBe(false);
    expect(credit).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("still settles when the invoice has no buyer phone", async () => {
    seedInvoice({ status: "pending_payment", buyerPhone: "" });

    const result = await settleInvoicePayment("3RIKE-20260930-ABC123");

    expect(result.settled).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1); // merchant only
    expect(notify.mock.calls[0][0]).toBe("0771234567");
  });

  it("debits the Flutterwave charge fee alongside the platform fee, VAT included", async () => {
    seedInvoice({ status: "pending_payment" });

    await settleInvoicePayment("3RIKE-20260930-ABC123", {
      flutterwave: { amount: 3000, charged_amount: 3000, amount_settled: 2841.97, app_fee: 147 },
    });

    // 3000 - 2841.97, not the 147 app_fee that excludes VAT.
    expect(debit).toHaveBeenCalledTimes(2);
    expect(debit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "merch_1",
        amount: 158.03,
        currency: "RWF",
        reference: "3RIKE-20260930-ABC123",
        idempotencyKey: "fw-provider-fee-debit:3RIKE-20260930-ABC123",
        allowNegative: true,
        metadata: expect.objectContaining({ type: "flutterwave_fee", fee: 158.03 }),
      })
    );
    expect(debit).not.toHaveBeenCalledWith(expect.objectContaining({ amount: 147 }));
    // An exact figure is in hand, so nothing else is worth asking Flutterwave.
    expect(verify).not.toHaveBeenCalled();
    // The merchant is debited both fees, so their balance reflects real cash.
    expect(invoiceRow.status).toBe("paid");
  });

  it("itemises both fees in the message that tells the merchant they got paid", async () => {
    seedInvoice({ status: "pending_payment" });

    await settleInvoicePayment("3RIKE-20260930-ABC123", {
      flutterwave: { amount: 3000, amount_settled: 2841.97 },
    });

    const message = notify.mock.calls[0][1] as string;
    expect(message).toContain("*Fees*");
    expect(message).toContain("- Platform fee: RWF 150");
    expect(message).toContain("- Flutterwave fee: RWF 158");
    // The balance follows the breakdown, not the other way round.
    expect(message.indexOf("*Fees*")).toBeLessThan(message.indexOf("*New balance"));
  });

  it("omits the Flutterwave line when its fee could not be determined", async () => {
    seedInvoice({ status: "pending_payment" });
    // The lookup answers, but carries no fee figures at all.
    verify.mockResolvedValue({ data: { status: "successful" } });

    await settleInvoicePayment("3RIKE-20260930-ABC123");

    const message = notify.mock.calls[0][1] as string;
    expect(message).toContain("- Platform fee: RWF 150");
    // Guessing a number would be worse than showing none.
    expect(message).not.toContain("Flutterwave fee");
  });

  it("asks Flutterwave for the settlement figure when the webhook only carries app_fee", async () => {
    seedInvoice({ status: "pending_payment" });
    verify.mockResolvedValue({
      data: { status: "successful", amount: 3000, charged_amount: 3000, amount_settled: 2841.97 },
    });

    await settleInvoicePayment("3RIKE-20260930-ABC123", {
      flutterwave: { amount: 3000, charged_amount: 3000, app_fee: 147 },
    });

    // app_fee alone would under-debit the merchant by the VAT component.
    expect(verify).toHaveBeenCalledWith("3RIKE-20260930-ABC123");
    expect(debit).toHaveBeenCalledWith(expect.objectContaining({ amount: 158.03 }));
  });

  it("falls back to app_fee when Flutterwave never reports a settlement figure", async () => {
    seedInvoice({ status: "pending_payment" });
    verify.mockResolvedValue({ data: { status: "successful", amount: 3000, app_fee: 147 } });

    const result = await settleInvoicePayment("3RIKE-20260930-ABC123", {
      flutterwave: { amount: 3000, app_fee: 147 },
    });

    expect(result.settled).toBe(true);
    expect(debit).toHaveBeenCalledWith(expect.objectContaining({ amount: 147 }));
  });

  it("does not re-ask Flutterwave when the verify poller already supplied the payload", async () => {
    seedInvoice({ status: "pending_payment" });

    await settleInvoicePayment("3RIKE-20260930-ABC123", {
      source: "verify_poll",
      flutterwave: { status: "successful" },
    });

    // The poller just made that exact call - asking again buys nothing.
    expect(verify).not.toHaveBeenCalled();
    // No usable figure, so only the platform fee is booked.
    expect(debit).toHaveBeenCalledTimes(1);
    expect(invoiceRow.status).toBe("paid");
  });

  it("books no Flutterwave fee when there is nothing to deduct", async () => {
    seedInvoice({ status: "pending_payment" });
    verify.mockResolvedValue({ data: { status: "successful", amount: 3000, amount_settled: 3000 } });

    await settleInvoicePayment("3RIKE-20260930-ABC123");

    expect(debit).toHaveBeenCalledTimes(1); // the platform fee, and nothing else
  });

  it("still settles when the Flutterwave fee debit fails", async () => {
    seedInvoice({ status: "pending_payment" });
    debit
      .mockRejectedValueOnce(new Error("lock timeout"))
      .mockRejectedValueOnce(new Error("lock timeout"));

    const result = await settleInvoicePayment("3RIKE-20260930-ABC123", {
      flutterwave: { amount: 3000, amount_settled: 2841.97 },
    });

    expect(result.settled).toBe(true);
    expect(invoiceRow.status).toBe("paid");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][1]).toContain("New balance");
  });
});

describe("verifyInvoicePayment", () => {
  it("settles when Flutterwave reports success", async () => {
    seedInvoice({ status: "pending_payment" });
    verify.mockResolvedValue({ data: { status: "successful" } });

    const result = await verifyInvoicePayment("3RIKE-20260930-ABC123");

    expect(result).toBe("settled");
    expect(invoiceRow.status).toBe("paid");
    expect(credit).toHaveBeenCalledTimes(2); // merchant share + platform fee
    expect(notify).toHaveBeenCalledTimes(1); // merchant only - never the buyer
    expect((prisma.transaction.updateMany as any).mock.calls[0][0]).toEqual({
      where: { reference: "3RIKE-20260930-ABC123" },
      data: { status: "completed" },
    });
  });

  it("settles with the payload it just fetched, so the fee needs no second lookup", async () => {
    seedInvoice({ status: "pending_payment" });
    verify.mockResolvedValue({
      data: { status: "successful", amount: 3000, charged_amount: 3000, amount_settled: 2841.97 },
    });

    const result = await verifyInvoicePayment("3RIKE-20260930-ABC123");

    expect(result).toBe("settled");
    // One call established the status, and the same payload priced the fee.
    expect(verify).toHaveBeenCalledTimes(1);
    expect(debit).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 158.03,
        metadata: expect.objectContaining({ type: "flutterwave_fee" }),
      })
    );
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
  it("is currency aware, omits the internal reference and quotes the new balance", () => {
    const message = renderPaidInvoiceMessage(
      {
        items: [{ name: "batteries", qty: 3, unitPrice: 1000 }],
        amount: 3000,
        currency: "RWF",
        buyerPhone: "0781234567",
      },
      { currency: "RWF", amount: 2850 }
    );

    expect(message).toContain("RWF 3,000");
    expect(message).toContain("3 x batteries: RWF 3,000");
    expect(message).toContain("Buyer: 0781234567");
    expect(message).toContain("New balance: RWF 2,850");
    expect(message).not.toContain("Your balance has been updated");
  });

  it("formats the new balance in its own currency", () => {
    const message = renderPaidInvoiceMessage(
      { items: [], amount: 5000, currency: "RWF", buyerPhone: "0781234567" },
      { currency: "NGN", amount: 1200 }
    );

    expect(message).toContain("New balance: NGN 1,200");
  });

  it("itemises each fee on its own line, in the invoice currency", () => {
    const message = renderPaidInvoiceMessage(
      { items: [], amount: 3000, currency: "RWF", buyerPhone: "0781234567" },
      { currency: "RWF", amount: 2692 },
      { platform: 150, flutterwave: 158.03 }
    );

    expect(message).toContain("*Fees*");
    expect(message).toContain("- Platform fee: RWF 150");
    expect(message).toContain("- Flutterwave fee: RWF 158");
    // The breakdown sits between the total and the balance it produced.
    expect(message.indexOf("*Fees*")).toBeGreaterThan(message.indexOf("*Total"));
    expect(message.indexOf("*Fees*")).toBeLessThan(message.indexOf("*New balance"));
    // A single lump sum would hide which of the two moved.
    expect(message).not.toMatch(/- Fees:/);
  });

  it("drops a zero or unknown fee line instead of printing RWF 0", () => {
    const message = renderPaidInvoiceMessage(
      { items: [], amount: 3000, currency: "RWF", buyerPhone: "0781234567" },
      { currency: "RWF", amount: 2850 },
      { platform: 150, flutterwave: null }
    );

    expect(message).toContain("- Platform fee: RWF 150");
    expect(message).not.toContain("Flutterwave fee");
    expect(message).not.toContain("RWF 0");
  });

  it("omits the fees block entirely when there is nothing to charge", () => {
    const message = renderPaidInvoiceMessage(
      { items: [], amount: 3000, currency: "RWF", buyerPhone: "0781234567" },
      { currency: "RWF", amount: 3000 },
      { platform: 0, flutterwave: 0 }
    );

    expect(message).not.toContain("*Fees*");
    expect(message).toContain("*Total: RWF 3,000*");
    expect(message).toContain("*New balance: RWF 3,000*");
  });
});

describe("humanizeChargeError", () => {
  it("translates the provider's channel-not-enabled message for the merchant", () => {
    const reason = humanizeChargeError(
      new Error("Merchant is not enabled to use this payment method.")
    );

    expect(reason).toMatch(/payment provider hasn't enabled mobile money/);
    // The merchant is not "the merchant" Flutterwave means - never blame them.
    expect(reason).not.toMatch(/^Merchant/);
  });

  it("passes other provider messages through untouched", () => {
    expect(humanizeChargeError(new Error("provider unavailable"))).toBe("provider unavailable");
  });

  it("falls back to a generic reason when there is no message", () => {
    expect(humanizeChargeError(undefined)).toBe("unknown error");
  });
});
