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

import webhooksRouter from "@/api/webhooks";
import { autoramp } from "@/services/autoramp";
import { whatsapp } from "@/services/whatsapp";
import { prisma, logWebhookEvent } from "@/services/database";
import { handleMessage } from "@/bot";

const verifySignature = vi.mocked(autoramp.verifyWebhookSignature);
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

function buildApp() {
  const app = express();
  app.use("/webhook/autoramp", express.raw({ type: "application/json" }));
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
