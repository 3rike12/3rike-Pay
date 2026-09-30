import { describe, it, expect, vi, beforeEach } from "vitest";

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

vi.mock("@/services/flutterwave", () => ({
  flutterwave: {
    chargeRwandaMobileMoney: (...args: any[]) => chargeRwandaMobileMoney(...args),
    extractPaymentUrl: (...args: any[]) => extractPaymentUrl(...args),
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
    },
    product: {
      findMany: vi.fn(async () => []),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

import { chargeInvoice, settleInvoicePayment } from "@/services/invoice";
import { flutterwave } from "@/services/flutterwave";
import { prisma } from "@/db/prisma";

const charge = vi.mocked(chargeRwandaMobileMoney as any);
const extract = vi.mocked(extractPaymentUrl as any);
const credit = vi.mocked(ledgerCredit as any);

function seedInvoice(overrides: Row = {}) {
  invoiceRow = {
    id: "inv_1",
    merchantId: "merch_1",
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
  });

  it("returns settled=false for an unknown reference", async () => {
    invoiceRow = null;
    const result = await settleInvoicePayment("does-not-exist");
    expect(result.settled).toBe(false);
    expect(credit).not.toHaveBeenCalled();
  });
});
