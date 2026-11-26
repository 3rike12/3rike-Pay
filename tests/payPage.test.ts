import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("@/config", () => ({
  config: { logLevel: "debug", redis: {}, app: { baseUrl: "https://pay.example.com" }, walletConnect: { projectId: "" }, nearIntents: {} },
}));
const invoiceFind = vi.fn();
const txFind = vi.fn();
vi.mock("@/db/prisma", () => ({
  prisma: { invoice: { findUnique: (...a: any[]) => invoiceFind(...a) }, transaction: { findUnique: (...a: any[]) => txFind(...a) } },
}));
const resolveOriginAsset = vi.fn();
const submitDepositTx = vi.fn();
vi.mock("@/services/nearIntents", () => ({
  EVM_ADDRESS_RE: /^0x[a-fA-F0-9]{40}$/,
  STELLAR_CHAIN: "stellar",
  isStellarAddress: (v: string) => /^G[A-Z2-7]{55}$/.test(v),
  walletChainIds: () => [8453],
  nearIntents: {
    isNearIntentsEnabled: () => true,
    listPayableTokens: async () => [{ symbol: "USDT", blockchain: "base" }, { symbol: "USDC", blockchain: "arb" }],
    resolveOriginAsset: (...a: any[]) => resolveOriginAsset(...a),
    submitDepositTx: (...a: any[]) => submitDepositTx(...a),
  },
}));
const createCryptoPayment = vi.fn();
vi.mock("@/services/cryptoInvoice", () => ({
  originMetaFor: (t: any) => ({ symbol: t.symbol, chain: t.blockchain, tokenAddress: t.contractAddress ?? null, decimals: t.decimals }),
  createCryptoPayment: (...a: any[]) => createCryptoPayment(...a),
  getCryptoPaymentState: vi.fn(),
  scheduleCryptoVerification: vi.fn(),
}));
const getInvoiceByReference = vi.fn();
vi.mock("@/services/invoice", () => ({ getInvoiceByReference: (...a: any[]) => getInvoiceByReference(...a), settleInvoicePayment: vi.fn() }));

import { config } from "@/config";
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

  it("serves a small holder page at /pay (no reference), separate from the invoice page", async () => {
    const app = express();
    app.use("/pay", payPageRouter);
    const res = await request(app).get("/pay");
    expect(res.status).toBe(200);
    expect(res.type).toMatch(/html/);
    expect(res.text).toContain("Pay an invoice");
    expect(res.text).toContain("/pay/"); // sends the person on to /pay/<reference>
    expect(res.text).not.toContain("PAY_CONFIG"); // no API calls: it is a static holder
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

describe("pay API: payment options", () => {
  const TREASURY = "0x2527D02599Ba641c19FEa793cD0F167589a0f10D";
  const invoice = {
    reference: "3RIKE-TEST-1", merchantId: "m1", id: "inv1", amount: 5000, currency: "RWF", items: [], status: "pending_payment",
    expiresAt: new Date(Date.now() + 600_000), createdAt: new Date(), paidAt: null, merchant: { name: "Shop", business: null },
  };
  const app = () => { const a = express(); a.use(express.json()); a.use("/api/pay", payApiRouter); return a; };

  beforeEach(() => {
    vi.clearAllMocks();
    invoiceFind.mockResolvedValue(invoice);
    txFind.mockResolvedValue(null);
    getInvoiceByReference.mockResolvedValue(invoice);
    resolveOriginAsset.mockResolvedValue({ assetId: "nep141:usdt", symbol: "USDT", blockchain: "base" });
    (config as any).treasury = { address: TREASURY, tokenContract: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", tokenDecimals: 6 };
  });
  afterEach(() => {
    delete (config as any).treasury;
  });

  it("offers exactly the tokens 1Click can swap: no special USDC-on-Base entry", async () => {
    const res = await request(app()).get("/api/pay/3RIKE-TEST-1");
    expect(res.body.tokens.map((t: any) => `${t.symbol}/${t.chain}`)).toEqual(["USDT/base", "USDC/arb"]);
  });

  it("every token, USDC on Base included, is handed to 1Click as a swap (1Click decides what it supports)", async () => {
    for (const [symbol, chain] of [["USDT", "base"], ["USDC", "arb"], ["USDC", "base"]]) {
      resolveOriginAsset.mockClear();
      await request(app()).post("/api/pay/3RIKE-TEST-1/quote").send({ symbol, chain });
      expect(resolveOriginAsset).toHaveBeenCalledWith(symbol, chain);
    }
    expect(createCryptoPayment).toHaveBeenCalledWith(expect.not.objectContaining({ direct: true }));
  });

  it("still tells 1Click about a swap payment's transaction", async () => {
    txFind.mockResolvedValue({ metadata: { nearIntents: { depositAddress: "0xdep" } } });
    submitDepositTx.mockResolvedValue({});
    await request(app()).post("/api/pay/3RIKE-TEST-1/submit").send({ txHash: "0x" + "a".repeat(64) });
    expect(submitDepositTx).toHaveBeenCalled();
  });

  describe("a Stellar payment", () => {
    const STELLAR_ME = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
    beforeEach(() => {
      createCryptoPayment.mockClear();
      resolveOriginAsset.mockResolvedValue({ assetId: "nep245:xlm", symbol: "XLM", blockchain: "stellar", decimals: 7 });
    });

    it("takes a Stellar address for refunds and passes it on", async () => {
      const res = await request(app()).post("/api/pay/3RIKE-TEST-1/quote").send({ symbol: "XLM", chain: "stellar", refundTo: STELLAR_ME });
      expect(res.status).not.toBe(400);
      expect(createCryptoPayment).toHaveBeenCalledWith(expect.objectContaining({ refundTo: STELLAR_ME }));
    });

    it("rejects an Ethereum address as a Stellar refund address", async () => {
      const res = await request(app()).post("/api/pay/3RIKE-TEST-1/quote").send({ symbol: "XLM", chain: "stellar", refundTo: "0x2527D02599Ba641c19FEa793cD0F167589a0f10D" });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Stellar address/);
      expect(createCryptoPayment).not.toHaveBeenCalled();
    });

    it("still rejects a Stellar address as an EVM refund address", async () => {
      resolveOriginAsset.mockResolvedValue({ assetId: "nep141:base", symbol: "ETH", blockchain: "base", decimals: 18 });
      const res = await request(app()).post("/api/pay/3RIKE-TEST-1/quote").send({ symbol: "ETH", chain: "base", refundTo: STELLAR_ME });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/0x/);
    });

    it("lets the payment code decide when there is no refund address at all", async () => {
      await request(app()).post("/api/pay/3RIKE-TEST-1/quote").send({ symbol: "XLM", chain: "stellar" });
      expect(createCryptoPayment).toHaveBeenCalledWith(expect.objectContaining({ refundTo: undefined }));
    });
  });
});

