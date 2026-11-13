import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("@/config", () => ({
  config: { logLevel: "debug", redis: {}, app: { baseUrl: "https://pay.example.com" }, walletConnect: { projectId: "" } },
}));
const invoiceFind = vi.fn();
const txFind = vi.fn();
vi.mock("@/db/prisma", () => ({
  prisma: { invoice: { findUnique: (...a: any[]) => invoiceFind(...a) }, transaction: { findUnique: (...a: any[]) => txFind(...a) } },
}));
vi.mock("@/services/nearIntents", () => ({
  EVM_ADDRESS_RE: /^0x[a-fA-F0-9]{40}$/,
  nearIntents: {
    isNearIntentsEnabled: () => true,
    listPayableTokens: async () => [{ symbol: "USDC", blockchain: "base" }],
  },
}));
vi.mock("@/services/cryptoInvoice", () => ({
  createCryptoPayment: vi.fn(),
  getCryptoPaymentState: vi.fn(),
  scheduleCryptoVerification: vi.fn(),
}));
vi.mock("@/services/invoice", () => ({ getInvoiceByReference: vi.fn() }));

import { payPageRouter, payApiRouter } from "@/api/pay";

describe("pay page QR", () => {
  it("serves a PNG QR of the pay link", async () => {
    const app = express();
    app.use("/pay", payPageRouter);
    const res = await request(app).get("/pay/3RIKE-TEST-1/qr.png");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("image/png");
    expect(res.body.length).toBeGreaterThan(500);
    // PNG magic bytes
    expect(res.body.subarray(0, 4).toString("hex")).toBe("89504e47");
  });

  it("serves an empty config so the backend's own page calls its own origin", async () => {
    const app = express();
    app.use("/pay", payPageRouter);
    const res = await request(app).get("/pay/config.js");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("javascript");
    expect(res.text).toContain("window.PAY_CONFIG");
    expect(res.text).not.toContain("apiBase");
  });

  it("serves the favicon as a PNG, not as an invoice reference", async () => {
    const app = express();
    app.use("/pay", payPageRouter);
    const res = await request(app).get("/pay/favicon.png");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("image/png");
    expect(res.body.subarray(0, 4).toString("hex")).toBe("89504e47");
  });
});

describe("pay API: merchant details", () => {
  const invoice = {
    reference: "3RIKE-TEST-1", merchantId: "SECRET-USER-ID", id: "SECRET-INVOICE-ID", buyerPhone: "0781234567",
    amount: 5000, currency: "RWF", items: [], status: "pending_payment", expiresAt: new Date(Date.now() + 600_000),
    createdAt: new Date("2026-11-12T08:00:00Z"), paidAt: null,
    merchant: {
      name: "Owner Name",
      business: { name: "Kigali Corner Shop", country: "RW", phone: "+250788123456", email: "hello@shop.example", registrationNumber: "RDB-1" },
    },
  };
  const app = () => { const a = express(); a.use(express.json()); a.use("/api/pay", payApiRouter); return a; };

  it("returns the merchant's saved business profile", async () => {
    invoiceFind.mockResolvedValue(invoice); txFind.mockResolvedValue(null);
    const res = await request(app()).get("/api/pay/3RIKE-TEST-1");
    expect(res.status).toBe(200);
    expect(res.body.merchant).toBe("Kigali Corner Shop");
    expect(res.body.merchantInfo).toEqual({
      name: "Kigali Corner Shop", country: "RW", phone: "+250788123456", email: "hello@shop.example", registrationNumber: "RDB-1",
    });
  });

  it("never leaks internal ids or the buyer's phone", async () => {
    invoiceFind.mockResolvedValue(invoice); txFind.mockResolvedValue(null);
    const body = JSON.stringify((await request(app()).get("/api/pay/3RIKE-TEST-1")).body);
    expect(body).not.toContain("SECRET-USER-ID");
    expect(body).not.toContain("SECRET-INVOICE-ID");
    expect(body).not.toContain("0781234567");
  });

  it("falls back to the owner's name when no business profile exists", async () => {
    invoiceFind.mockResolvedValue({ ...invoice, merchant: { name: "Owner Name", business: null } }); txFind.mockResolvedValue(null);
    const res = await request(app()).get("/api/pay/3RIKE-TEST-1");
    expect(res.body.merchant).toBe("Owner Name");
    expect(res.body.merchantInfo.phone).toBeNull();
  });
});

describe("pay API: cross-origin use from a separately hosted page", () => {
  it("answers a browser preflight from another origin (the Vercel page)", async () => {
    const helmet = (await import("helmet")).default;
    const cors = (await import("cors")).default;
    const app = express();
    app.use(helmet({ contentSecurityPolicy: false }));
    app.use(cors());
    app.use(express.json());
    app.use("/api/pay", payApiRouter);

    const pre = await request(app)
      .options("/api/pay/3RIKE-TEST-1/quote")
      .set("Origin", "https://pay.3rike.com")
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "content-type");
    expect(pre.status).toBeLessThan(300);
    expect(pre.headers["access-control-allow-origin"]).toBeTruthy();
    expect(pre.headers["access-control-allow-headers"]).toMatch(/content-type/i);
  });
});
