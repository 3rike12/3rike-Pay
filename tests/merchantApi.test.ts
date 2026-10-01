import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("@/config", () => ({
  config: {
    webhook: { secret: "test-secret" },
    logLevel: "debug",
  },
}));

vi.mock("@/db/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
  },
}));

vi.mock("@/services/ledger", () => ({
  ledger: { getBalance: vi.fn() },
}));

vi.mock("@/services/invoice", () => ({
  INVOICE_STATUS: {
    DRAFT: "draft",
    SENT: "sent",
    PENDING: "pending_payment",
    PAID: "paid",
    EXPIRED: "expired",
    FAILED: "failed",
    CANCELLED: "cancelled",
  },
  listInvoices: vi.fn(),
}));

import merchantRouter from "@/api/merchant";
import { prisma } from "@/db/prisma";
import { ledger } from "@/services/ledger";
import { listInvoices } from "@/services/invoice";

const VALID_KEY = "test-secret";
const MERCHANT = "merchant-1";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api", merchantRouter);
  return app;
}

const mockFindMerchant = vi.mocked(prisma.user.findUnique);
const mockGetBalance = vi.mocked(ledger.getBalance);
const mockListInvoices = vi.mocked(listInvoices);

function auth(req: request.Test): request.Test {
  return req.set("x-api-key", VALID_KEY);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFindMerchant.mockResolvedValue({ id: MERCHANT } as any);
  mockGetBalance.mockResolvedValue(125000 as any);
  mockListInvoices.mockResolvedValue({
    items: [],
    total: 0,
    limit: 20,
    offset: 0,
  } as any);
});

describe("merchant API authentication", () => {
  it("rejects a request with no x-api-key", async () => {
    const res = await request(buildApp()).get(`/api/balance?merchantId=${MERCHANT}`);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Missing x-api-key header" });
  });

  it("rejects a wrong x-api-key", async () => {
    const res = await request(buildApp())
      .get(`/api/balance?merchantId=${MERCHANT}`)
      .set("x-api-key", "nope");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Invalid API key" });
  });

  it("never touches the database without a valid key", async () => {
    await request(buildApp()).get(`/api/balance?merchantId=${MERCHANT}`);
    expect(mockFindMerchant).not.toHaveBeenCalled();
    expect(mockGetBalance).not.toHaveBeenCalled();
  });
});

describe("GET /api/balance", () => {
  it("returns the wallet balance", async () => {
    const res = await auth(request(buildApp()).get(`/api/balance?merchantId=${MERCHANT}`));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ merchantId: MERCHANT, currency: "RWF", balance: 125000 });
    expect(mockGetBalance).toHaveBeenCalledWith(MERCHANT, "RWF");
  });

  it("accepts an explicit currency", async () => {
    const res = await auth(
      request(buildApp()).get(`/api/balance?merchantId=${MERCHANT}&currency=usd`)
    );

    expect(res.status).toBe(200);
    expect(res.body.currency).toBe("USD");
    expect(mockGetBalance).toHaveBeenCalledWith(MERCHANT, "USD");
  });

  it("requires merchantId", async () => {
    const res = await auth(request(buildApp()).get("/api/balance"));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "merchantId is required" });
    expect(mockGetBalance).not.toHaveBeenCalled();
  });

  it("rejects a malformed currency", async () => {
    const res = await auth(
      request(buildApp()).get(`/api/balance?merchantId=${MERCHANT}&currency=RW`)
    );
    expect(res.status).toBe(400);
    expect(mockGetBalance).not.toHaveBeenCalled();
  });

  it("404s for an unknown merchant", async () => {
    mockFindMerchant.mockResolvedValue(null as any);

    const res = await auth(request(buildApp()).get(`/api/balance?merchantId=ghost`));

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Merchant not found", merchantId: "ghost" });
    expect(mockGetBalance).not.toHaveBeenCalled();
  });
});

describe("GET /api/invoices", () => {
  it("returns a paged page with hasMore", async () => {
    mockListInvoices.mockResolvedValue({
      items: [{ id: "inv_1", reference: "3RIKE-1", amount: 3000, currency: "RWF" }],
      total: 21,
      limit: 20,
      offset: 0,
    } as any);

    const res = await auth(
      request(buildApp()).get(`/api/invoices?merchantId=${MERCHANT}`)
    );

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(21);
    expect(res.body.limit).toBe(20);
    expect(res.body.offset).toBe(0);
    expect(res.body.hasMore).toBe(true);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({
      id: "inv_1",
      reference: "3RIKE-1",
      amount: 3000,
      currency: "RWF",
    });
  });

  it("reports hasMore false on the last page", async () => {
    mockListInvoices.mockResolvedValue({
      items: [{ id: "inv_9" }],
      total: 21,
      limit: 20,
      offset: 20,
    } as any);

    const res = await auth(
      request(buildApp()).get(`/api/invoices?merchantId=${MERCHANT}&offset=20`)
    );

    expect(res.status).toBe(200);
    expect(res.body.hasMore).toBe(false);
  });

  it("passes status, limit and offset through", async () => {
    await auth(
      request(buildApp()).get(
        `/api/invoices?merchantId=${MERCHANT}&status=paid&limit=5&offset=10`
      )
    );

    expect(mockListInvoices).toHaveBeenCalledWith(MERCHANT, {
      status: "paid",
      limit: 5,
      offset: 10,
    });
  });

  it("clamps an oversized limit instead of returning everything", async () => {
    await auth(
      request(buildApp()).get(`/api/invoices?merchantId=${MERCHANT}&limit=5000`)
    );

    expect(mockListInvoices).toHaveBeenCalledWith(MERCHANT, {
      status: undefined,
      limit: 100,
      offset: 0,
    });
  });

  it("requires merchantId", async () => {
    const res = await auth(request(buildApp()).get("/api/invoices"));
    expect(res.status).toBe(400);
    expect(mockListInvoices).not.toHaveBeenCalled();
  });

  it("rejects an unknown status", async () => {
    const res = await auth(
      request(buildApp()).get(`/api/invoices?merchantId=${MERCHANT}&status=whatever`)
    );
    expect(res.status).toBe(400);
    expect(res.body.allowed).toContain("paid");
    expect(mockListInvoices).not.toHaveBeenCalled();
  });

  it("rejects a non-integer limit", async () => {
    const res = await auth(
      request(buildApp()).get(`/api/invoices?merchantId=${MERCHANT}&limit=ten`)
    );
    expect(res.status).toBe(400);
    expect(mockListInvoices).not.toHaveBeenCalled();
  });

  it("rejects a negative offset", async () => {
    const res = await auth(
      request(buildApp()).get(`/api/invoices?merchantId=${MERCHANT}&offset=-1`)
    );
    expect(res.status).toBe(400);
    expect(mockListInvoices).not.toHaveBeenCalled();
  });

  it("404s for an unknown merchant", async () => {
    mockFindMerchant.mockResolvedValue(null as any);

    const res = await auth(
      request(buildApp()).get(`/api/invoices?merchantId=ghost`)
    );

    expect(res.status).toBe(404);
    expect(mockListInvoices).not.toHaveBeenCalled();
  });
});
