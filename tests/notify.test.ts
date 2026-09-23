import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("@/config", () => ({
  config: {
    webhook: { secret: "test-secret" },
    logLevel: "debug",
  },
}));

vi.mock("@/services/notifications", () => ({
  notifyUser: vi.fn(),
  notifyBulk: vi.fn(),
  notifyPayment: vi.fn(),
  notifyKyc: vi.fn(),
  notifyWelcomeCreateWallet: vi.fn(),
}));

vi.mock("@/db/prisma", () => ({
  prisma: {
    bankAccount: { findFirst: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));

import notifyRouter from "@/api/notify";
import {
  notifyUser,
  notifyBulk,
  notifyPayment,
  notifyKyc,
  notifyWelcomeCreateWallet,
} from "@/services/notifications";
import { prisma } from "@/db/prisma";

const VALID_KEY = "test-secret";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/webhook/notify", notifyRouter);
  return app;
}

const mockNotifyUser = vi.mocked(notifyUser);
const mockNotifyBulk = vi.mocked(notifyBulk);
const mockNotifyPayment = vi.mocked(notifyPayment);
const mockNotifyKyc = vi.mocked(notifyKyc);
const mockWelcome = vi.mocked(notifyWelcomeCreateWallet);
const mockFindBank = vi.mocked(prisma.bankAccount.findFirst);
const mockFindUser = vi.mocked(prisma.user.findUnique);

describe("notify webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("authentication", () => {
    it("rejects requests with no x-api-key", async () => {
      const res = await request(buildApp()).get("/webhook/notify/health");
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: "Missing x-api-key header" });
    });

    it("rejects requests with an invalid x-api-key", async () => {
      const res = await request(buildApp())
        .get("/webhook/notify/health")
        .set("x-api-key", "wrong-key");
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "Invalid API key" });
    });

    it("accepts requests with the correct x-api-key", async () => {
      const res = await request(buildApp())
        .get("/webhook/notify/health")
        .set("x-api-key", VALID_KEY);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
    });
  });

  describe("POST / (single notification)", () => {
    it("sends a notification and returns success", async () => {
      mockNotifyUser.mockResolvedValue(true);
      const res = await request(buildApp())
        .post("/webhook/notify")
        .set("x-api-key", VALID_KEY)
        .send({ phone: "08012345678", message: "Hello" });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockNotifyUser).toHaveBeenCalledWith(
        expect.objectContaining({ phone: "08012345678", message: "Hello" })
      );
    });

    it("returns 400 when phone or message is missing", async () => {
      const res = await request(buildApp())
        .post("/webhook/notify")
        .set("x-api-key", VALID_KEY)
        .send({ phone: "08012345678" });
      expect(res.status).toBe(400);
      expect(mockNotifyUser).not.toHaveBeenCalled();
    });
  });

  describe("POST /bulk", () => {
    it("returns the sent/failed counts", async () => {
      mockNotifyBulk.mockResolvedValue({ sent: 2, failed: 1 });
      const res = await request(buildApp())
        .post("/webhook/notify/bulk")
        .set("x-api-key", VALID_KEY)
        .send({ phones: ["0801", "0802", "0803"], message: "Hello" });
      expect(res.status).toBe(200);
      expect(res.body.sent).toBe(2);
      expect(res.body.failed).toBe(1);
    });

    it("returns 400 when phones array is empty", async () => {
      const res = await request(buildApp())
        .post("/webhook/notify/bulk")
        .set("x-api-key", VALID_KEY)
        .send({ phones: [], message: "Hello" });
      expect(res.status).toBe(400);
    });
  });

  describe("POST /payment", () => {
    it("requires phone, type, amount and reference", async () => {
      const res = await request(buildApp())
        .post("/webhook/notify/payment")
        .set("x-api-key", VALID_KEY)
        .send({ phone: "0801", type: "received" });
      expect(res.status).toBe(400);
    });

    it("sends a payment notification with valid fields", async () => {
      mockNotifyPayment.mockResolvedValue(true);
      const res = await request(buildApp())
        .post("/webhook/notify/payment")
        .set("x-api-key", VALID_KEY)
        .send({ phone: "0801", type: "received", amount: 5000, reference: "ref-1" });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe("POST /welcome", () => {
    it("rejects when optIn is not true", async () => {
      const res = await request(buildApp())
        .post("/webhook/notify/welcome")
        .set("x-api-key", VALID_KEY)
        .send({ phone: "0801", name: "Ada" });
      expect(res.status).toBe(400);
      expect(mockWelcome).not.toHaveBeenCalled();
    });

    it("sends a welcome when optIn is true", async () => {
      mockWelcome.mockResolvedValue({ sent: true, alreadySent: false });
      const res = await request(buildApp())
        .post("/webhook/notify/welcome")
        .set("x-api-key", VALID_KEY)
        .send({ phone: "0801", name: "Ada", optIn: true });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe("POST /user-by-vendor", () => {
    it("returns 404 when the user cannot be found", async () => {
      mockFindBank.mockResolvedValue(null);
      mockFindUser.mockResolvedValue(null);
      const res = await request(buildApp())
        .post("/webhook/notify/user-by-vendor")
        .set("x-api-key", VALID_KEY)
        .send({ vendorData: "unknown", message: "Hello" });
      expect(res.status).toBe(404);
    });

    it("notifies a user found by vendor data", async () => {
      mockFindBank.mockResolvedValue(null);
      mockFindUser.mockResolvedValue({ id: "u1", phone: "0801" });
      mockNotifyUser.mockResolvedValue(true);
      const res = await request(buildApp())
        .post("/webhook/notify/user-by-vendor")
        .set("x-api-key", VALID_KEY)
        .send({ vendorData: "u1", message: "Hello" });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });
});
