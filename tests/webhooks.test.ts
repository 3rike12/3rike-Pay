import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("@/config", () => ({
  config: {
    whatsapp: { verifyToken: "test-verify-token" },
    webhook: { secret: "" },
    logLevel: "debug",
  },
}));

vi.mock("@/bot", () => ({
  handleMessage: vi.fn(),
}));

vi.mock("@/services/whatsapp", () => ({
  whatsapp: {
    markAsRead: vi.fn().mockResolvedValue(undefined),
    sendTextMessage: vi.fn(),
    sendTemplate: vi.fn(),
  },
}));

vi.mock("@/services/autoramp", () => ({
  autoramp: {
    verifyWebhookSignature: vi.fn(),
  },
}));

vi.mock("@/services/database", () => ({
  prisma: {
    bankAccount: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    user: {
      update: vi.fn(),
      findUnique: vi.fn(),
    },
    transaction: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    webhookEvent: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
  },
  logWebhookEvent: vi.fn(),
}));

vi.mock("@/services/flutterwave", () => ({
  flutterwave: {
    verifyWebhookSignature: vi.fn(() => true),
    verifyV4WebhookSignature: vi.fn(() => true),
    verifyTransactionByTxRef: vi.fn(),
    chargeRwandaMobileMoney: vi.fn(),
    extractPaymentUrl: vi.fn(() => null),
  },
}));

vi.mock("@/services/ledger", () => ({
  ledger: { credit: vi.fn(), debit: vi.fn(), transfer: vi.fn(), getBalance: vi.fn() },
}));

vi.mock("@/services/invoice", () => ({
  getInvoiceByReference: vi.fn(),
  settleInvoicePayment: vi.fn(),
  failInvoicePayment: vi.fn(),
}));

import webhooksRouter from "@/api/webhooks";
import { autoramp } from "@/services/autoramp";
import { whatsapp } from "@/services/whatsapp";
import { flutterwave } from "@/services/flutterwave";
import { ledger } from "@/services/ledger";
import { getInvoiceByReference, settleInvoicePayment, failInvoicePayment } from "@/services/invoice";
import { prisma, logWebhookEvent } from "@/services/database";
import { handleMessage } from "@/bot";

const verifySignature = vi.mocked(autoramp.verifyWebhookSignature);
const verifyFlutterwaveSignature = vi.mocked(flutterwave.verifyWebhookSignature);
const verifyV4Signature = vi.mocked(flutterwave.verifyV4WebhookSignature);
const sendTemplate = vi.mocked(whatsapp.sendTemplate);
const sendText = vi.mocked(whatsapp.sendTextMessage);
const findBank = vi.mocked(prisma.bankAccount.findFirst);
const updateBank = vi.mocked(prisma.bankAccount.update);
const updateUser = vi.mocked(prisma.user.update);
const findUser = vi.mocked(prisma.user.findUnique);
const findTxn = vi.mocked(prisma.transaction.findFirst);
const updateTxn = vi.mocked(prisma.transaction.update);
const findEvent = vi.mocked(prisma.webhookEvent.findFirst);
const createEvent = vi.mocked(prisma.webhookEvent.create);
const logEvent = vi.mocked(logWebhookEvent);
const ledgerCredit = vi.mocked(ledger.credit);
const invoiceForRef = vi.mocked(getInvoiceByReference);
const settleInvoice = vi.mocked(settleInvoicePayment);
const failInvoice = vi.mocked(failInvoicePayment);

function buildApp() {
  const app = express();
  app.use("/webhook/autoramp", express.raw({ type: "application/json" }));
  app.use("/webhook/flutterwave", express.raw({ type: "application/json" }));
  app.use(express.json());
  app.use("/webhook", webhooksRouter);
  return app;
}

function postAutoramp(app: express.Express, payload: unknown, signature?: string) {
  const req = request(app)
    .post("/webhook/autoramp")
    .set("Content-Type", "application/json");
  if (signature !== undefined) req.set("x-webhook-signature", signature);
  return req.send(payload as any);
}

describe("AutoRamp webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifySignature.mockReturnValue(true);
  });

  describe("signature verification", () => {
    it("rejects a request with no signature header", async () => {
      const res = await postAutoramp(buildApp(), { event: "unused", data: {} });
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: "Missing signature" });
    });

    it("rejects a request with an invalid signature", async () => {
      verifySignature.mockReturnValue(false);
      const res = await postAutoramp(buildApp(), { event: "unused", data: {} }, "bad-sig");
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: "Invalid signature" });
    });

    it("rejects a request when signature verification throws", async () => {
      verifySignature.mockImplementation(() => {
        throw new Error("boom");
      });
      const res = await postAutoramp(buildApp(), { event: "unused", data: {} }, "sig");
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: "Signature verification failed" });
    });

    it("acks a request with a valid signature", async () => {
      const res = await postAutoramp(buildApp(), { event: "unknown.event", data: {} }, "sig");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true });
    });
  });

  describe("event processing", () => {
    it("account.created links the bank account and marks the user verified", async () => {
      findBank.mockResolvedValue({ id: "ba1", userId: "u1" } as any);
      const app = buildApp();
      const res = await postAutoramp(
        app,
        {
          event: "account.created",
          data: {
            reference: "ref-1",
            accountNumber: "5015575517",
            accountName: "ACME / JANE",
            bankCode: "090286",
            bankName: "Safe Haven MFB",
          },
        },
        "sig"
      );

      expect(res.status).toBe(200);
      await vi.waitFor(() => {
        expect(updateBank).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ accountNumber: "5015575517" }),
          })
        );
        expect(updateUser).toHaveBeenCalledWith(
          expect.objectContaining({ data: { kycStatus: "verified" } })
        );
      });
    });

    it("transfer.completed marks the transaction complete and notifies the user", async () => {
      findTxn.mockResolvedValue({
        id: "t1",
        userId: "u1",
        amount: 5000,
        accountName: "Jane Doe",
        bankName: "GTBank",
        bankAccount: "0123456789",
        reference: "ref-1",
        metadata: {},
      } as any);
      findUser.mockResolvedValue({ id: "u1", phone: "0801", name: "Jane" } as any);

      const res = await postAutoramp(buildApp(), { event: "transfer.completed", data: { reference: "ref-1" } }, "sig");

      expect(res.status).toBe(200);
      await vi.waitFor(() => {
        expect(updateTxn).toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ status: "completed" }) })
        );
        expect(sendTemplate).toHaveBeenCalled();
      });
    });

    it("transfer.failed marks the transaction failed and notifies the user", async () => {
      findTxn.mockResolvedValue({
        id: "t1",
        userId: "u1",
        amount: 5000,
        accountName: "Jane Doe",
        bankName: "GTBank",
        bankAccount: "0123456789",
        reference: "ref-1",
        metadata: {},
      } as any);
      findUser.mockResolvedValue({ id: "u1", phone: "0801", name: "Jane" } as any);

      const res = await postAutoramp(buildApp(), { event: "transfer.failed", data: { reference: "ref-1" } }, "sig");

      expect(res.status).toBe(200);
      await vi.waitFor(() => {
        expect(updateTxn).toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ status: "failed" }) })
        );
        expect(sendTemplate).toHaveBeenCalled();
      });
    });

    it("onramp.completed updates the transaction and sends a text message", async () => {
      findTxn.mockResolvedValue({
        id: "t1",
        userId: "u1",
        amount: 5000,
        reference: "ref-1",
        recipientPhone: "0801",
        metadata: {},
      } as any);

      const res = await postAutoramp(buildApp(), { event: "onramp.completed", data: { reference: "ref-1" } }, "sig");

      expect(res.status).toBe(200);
      await vi.waitFor(() => {
        expect(updateTxn).toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ status: "completed" }) })
        );
        expect(sendText).toHaveBeenCalled();
      });
    });

    it("subaccount.inflow notifies the account holder of a deposit", async () => {
      findBank.mockResolvedValue({
        id: "ba1",
        userId: "u1",
        accountNumber: "5015575517",
        user: { id: "u1", phone: "08012345678" },
      } as any);

      const res = await postAutoramp(
        buildApp(),
        {
          event: "subaccount.inflow",
          data: {
            amount: 50000,
            accountNumber: "5015575517",
            paymentReference: "SHW-INFLOW-1",
            debitAccountName: "SENDER",
            creditAccountName: "MARTINS",
            status: "Completed",
          },
        },
        "sig"
      );

      expect(res.status).toBe(200);
      await vi.waitFor(() => {
        expect(sendText).toHaveBeenCalledWith(
          "08012345678",
          expect.stringContaining("Deposit Received")
        );
        expect(sendText).toHaveBeenCalledWith(
          "08012345678",
          expect.stringContaining("5015575517")
        );
        expect(sendText).toHaveBeenCalledWith(
          "08012345678",
          expect.stringContaining("SENDER")
        );
      });
    });

    it("account.credit notifies the account holder of a deposit", async () => {
      findBank.mockResolvedValue({
        id: "ba1",
        userId: "u1",
        accountNumber: "0117964837",
        user: { id: "u1", phone: "08012345678" },
      } as any);

      const res = await postAutoramp(
        buildApp(),
        {
          event: "account.credit",
          data: {
            amount: 500,
            creditAccountNumber: "0117964837",
            creditAccountName: "MARTINS",
            debitAccountName: "SALIUTECH",
            status: "COMPLETED",
          },
        },
        "sig"
      );

      expect(res.status).toBe(200);
      await vi.waitFor(() => {
        expect(sendText).toHaveBeenCalledWith(
          "08012345678",
          expect.stringContaining("Deposit Received")
        );
        expect(sendText).toHaveBeenCalledWith(
          "08012345678",
          expect.stringContaining("SALIUTECH")
        );
      });
    });

    it("bank_transfer.completed marks the transaction complete and notifies", async () => {
      findTxn.mockResolvedValue({
        id: "t1",
        userId: "u1",
        amount: 1000,
        accountName: "Payee Ltd",
        bankName: "GTBank",
        bankAccount: "0123456789",
        reference: "ref-1",
        metadata: {},
      } as any);
      findUser.mockResolvedValue({ id: "u1", phone: "0801", name: "Jane" } as any);

      const res = await postAutoramp(
        buildApp(),
        { event: "bank_transfer.completed", data: { reference: "ref-1", amount: "1000.00", status: "COMPLETED" } },
        "sig"
      );

      expect(res.status).toBe(200);
      await vi.waitFor(() => {
        expect(updateTxn).toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ status: "completed" }) })
        );
        expect(sendTemplate).toHaveBeenCalled();
      });
    });

    it("bank_transfer.completed with FAILED status marks it failed", async () => {
      findTxn.mockResolvedValue({
        id: "t1",
        userId: "u1",
        amount: 1000,
        accountName: "Payee Ltd",
        bankName: "GTBank",
        bankAccount: "0123456789",
        reference: "ref-1",
        metadata: {},
      } as any);
      findUser.mockResolvedValue({ id: "u1", phone: "0801", name: "Jane" } as any);

      const res = await postAutoramp(
        buildApp(),
        { event: "bank_transfer.completed", data: { reference: "ref-1", amount: "1000.00", status: "FAILED" } },
        "sig"
      );

      expect(res.status).toBe(200);
      await vi.waitFor(() => {
        expect(updateTxn).toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ status: "failed" }) })
        );
      });
    });

    it("ignores unknown events but still acks", async () => {
      const res = await postAutoramp(buildApp(), { event: "something.weird", data: { reference: "ref-1" } }, "sig");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true });

      await vi.waitFor(() => {
        expect(findTxn).not.toHaveBeenCalled();
        expect(findBank).not.toHaveBeenCalled();
      });
    });
  });
});

describe("WhatsApp webhook verification (GET)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("echoes the challenge for a valid verify token", async () => {
    const res = await request(buildApp()).get(
      "/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=12345"
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe("12345");
  });

  it("rejects a bad verify token", async () => {
    const res = await request(buildApp()).get(
      "/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345"
    );
    expect(res.status).toBe(403);
  });
});

describe("WhatsApp webhook (POST) message handling", () => {
  beforeEach(() => vi.clearAllMocks());

  it("routes a text message into the bot", async () => {
    findEvent.mockResolvedValue(null);
    createEvent.mockResolvedValue({} as any);

    const app = buildApp();
    const res = await request(app)
      .post("/webhook/whatsapp")
      .send({
        object: "whatsapp_business_account",
        entry: [
          {
            changes: [
              {
                field: "messages",
                value: {
                  contacts: [{ profile: { name: "Chibuikem" } }],
                  messages: [{ from: "2349167582901", id: "msg_1", type: "text", text: { body: "hi" } }],
                },
              },
            ],
          },
        ],
      });

    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(handleMessage).toHaveBeenCalledWith(
        "09167582901", // cleanPhone normalises 234... -> 0...
        "Chibuikem",
        "hi",
        undefined,
        undefined
      );
    });
  });

  it("skips non-message objects", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/webhook/whatsapp")
      .send({ object: "not_whatsapp" });

    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 10));
    expect(handleMessage).not.toHaveBeenCalled();
  });
});

describe("Flutterwave webhook", () => {
  const invoiceTxn = {
    id: "tx_1",
    reference: "3RIKE-INV-1",
    userId: "user_1",
    amount: 3000,
    currency: "RWF",
    status: "processing",
    metadata: {},
    user: { id: "user_1", phone: "250788000111" },
  };

  const invoice = {
    id: "inv_1",
    reference: "3RIKE-INV-1",
    merchantId: "user_1",
    amount: 3000,
    currency: "RWF",
    status: "pending_payment",
    buyerPhone: "0781234567",
    items: [{ name: "batteries", qty: 3, unitPrice: 1000 }],
  };

  function postFlutterwave(app: express.Express, payload: unknown) {
    return request(app)
      .post("/webhook/flutterwave")
      .set("verif-hash", "test-signature")
      .send(payload as any);
  }

  /** v4 delivery: `flutterwave-signature` HMAC header instead of verif-hash. */
  function postFlutterwaveV4(app: express.Express, payload: unknown, signature = "hmac-sig") {
    return request(app)
      .post("/webhook/flutterwave")
      .set("flutterwave-signature", signature)
      .send(payload as any);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    verifyFlutterwaveSignature.mockReturnValue(true);
    verifyV4Signature.mockReturnValue(true);
    sendText.mockResolvedValue(true);
    invoiceForRef.mockResolvedValue(null as any);
    settleInvoice.mockResolvedValue({ settled: true } as any);
    failInvoice.mockResolvedValue(null as any);
    (ledgerCredit as any).mockResolvedValue({});
  });

  it("rejects a request with no signature header", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/webhook/flutterwave")
      .send({ event: "charge.completed", data: {} });
    expect(res.status).toBe(401);
  });

  it("rejects an invalid signature", async () => {
    verifyFlutterwaveSignature.mockReturnValue(false);
    const app = buildApp();
    const res = await request(app)
      .post("/webhook/flutterwave")
      .set("verif-hash", "bad")
      .send({ event: "charge.completed", data: {} });
    expect(res.status).toBe(401);
  });

  it("settles an invoice charge instead of running the generic credit", async () => {
    findTxn.mockResolvedValue(invoiceTxn as any);
    invoiceForRef.mockResolvedValue(invoice as any);

    const app = buildApp();
    const res = await postFlutterwave(app, {
      event: "charge.completed",
      data: { id: 99, tx_ref: "3RIKE-INV-1", status: "successful" },
    });

    expect(res.status).toBe(200);
    expect(settleInvoice).toHaveBeenCalledWith(
      "3RIKE-INV-1",
      expect.objectContaining({ flutterwave: expect.anything() })
    );
    // The generic credit path must not also run: settle owns the credit.
    expect(ledgerCredit).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalledWith(
      expect.stringContaining("Reference: 3RIKE-INV-1")
    );
    expect(updateTxn).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "completed" }) })
    );
  });

  it("falls back to the generic credit for a non-invoice charge", async () => {
    findTxn.mockResolvedValue({
      ...invoiceTxn,
      reference: "3RIKE-DEP-1",
      currency: "NGN",
      amount: 5000,
    } as any);
    invoiceForRef.mockResolvedValue(null);

    const app = buildApp();
    const res = await postFlutterwave(app, {
      event: "charge.completed",
      data: { id: 100, tx_ref: "3RIKE-DEP-1", status: "successful" },
    });

    expect(res.status).toBe(200);
    expect(settleInvoice).not.toHaveBeenCalled();
    expect(ledgerCredit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_1",
        amount: 5000,
        reference: "3RIKE-DEP-1",
        idempotencyKey: "fw-charge-credit:3RIKE-DEP-1",
      })
    );
    expect(sendText).toHaveBeenCalledWith(
      "250788000111",
      expect.stringContaining("Reference: 3RIKE-DEP-1")
    );
  });

  it("ignores a duplicate delivery for an already-settled transaction", async () => {
    findTxn.mockResolvedValue({ ...invoiceTxn, status: "completed" } as any);
    invoiceForRef.mockResolvedValue(invoice as any);

    const app = buildApp();
    await postFlutterwave(app, {
      event: "charge.completed",
      data: { id: 99, tx_ref: "3RIKE-INV-1", status: "successful" },
    });

    expect(settleInvoice).not.toHaveBeenCalled();
    expect(updateTxn).not.toHaveBeenCalled();
  });

  it("fails the invoice when the charge fails", async () => {
    findTxn.mockResolvedValue(invoiceTxn as any);
    invoiceForRef.mockResolvedValue(invoice as any);

    const app = buildApp();
    const res = await postFlutterwave(app, {
      event: "charge.failed",
      data: { id: 99, tx_ref: "3RIKE-INV-1", status: "failed" },
    });

    expect(res.status).toBe(200);
    expect(failInvoice).toHaveBeenCalledWith("3RIKE-INV-1", "failed");
    expect(settleInvoice).not.toHaveBeenCalled();
    expect(updateTxn).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "failed" }) })
    );
  });

  it("verifies a v4 HMAC signature instead of verif-hash", async () => {
    findTxn.mockResolvedValue(invoiceTxn as any);
    invoiceForRef.mockResolvedValue(invoice as any);

    const app = buildApp();
    const res = await postFlutterwaveV4(app, {
      webhook_id: "wbk_1",
      type: "charge.completed",
      data: { id: "chg_1", reference: "3RIKE-INV-1", status: "succeeded" },
    });

    expect(res.status).toBe(200);
    expect(verifyV4Signature).toHaveBeenCalledWith(expect.any(Buffer), "hmac-sig");
    expect(verifyFlutterwaveSignature).not.toHaveBeenCalled();
    expect(settleInvoice).toHaveBeenCalledWith(
      "3RIKE-INV-1",
      expect.objectContaining({ flutterwave: expect.anything() })
    );
    expect(updateTxn).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "completed" }) })
    );
  });

  it("rejects an invalid v4 signature", async () => {
    verifyV4Signature.mockReturnValue(false);
    const app = buildApp();
    const res = await postFlutterwaveV4(app, {
      type: "charge.completed",
      data: { reference: "3RIKE-INV-1" },
    });
    expect(res.status).toBe(401);
  });

  it("fails the invoice when a v4 charge.completed carries a failed status", async () => {
    findTxn.mockResolvedValue(invoiceTxn as any);
    invoiceForRef.mockResolvedValue(invoice as any);

    const app = buildApp();
    const res = await postFlutterwaveV4(app, {
      type: "charge.completed",
      data: { id: "chg_1", reference: "3RIKE-INV-1", status: "failed" },
    });

    expect(res.status).toBe(200);
    expect(failInvoice).toHaveBeenCalledWith("3RIKE-INV-1", "failed");
    expect(settleInvoice).not.toHaveBeenCalled();
  });
});
