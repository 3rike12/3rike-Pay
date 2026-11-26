/**
 * The five tests that matter most for paying from Stellar.
 *
 * Unlike the unit tests, these run the REAL pay API, payment code, rail, 1Click client and Stellar check together,
 * and fake only the outside world: 1Click, Stellar (Horizon), the database and the job queue. So they catch the layers
 * disagreeing with each other, which the per-layer tests cannot.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("@/config", () => ({
  config: {
    logLevel: "debug",
    redis: {},
    app: { baseUrl: "https://pay.example.com" },
    walletConnect: { projectId: "" },
    features: { invoicingEnabled: true },
    treasury: { address: "0x2527D02599Ba641c19FEa793cD0F167589a0f10D", tokenDecimals: 6 },
    nearIntents: {
      network: "mainnet",
      baseUrl: "https://1click.test",
      apiKey: "k",
      recipient: "0x2527D02599Ba641c19FEa793cD0F167589a0f10D",
      recipientType: "DESTINATION_CHAIN",
      refundTo: "0x2527D02599Ba641c19FEa793cD0F167589a0f10D", // the treasury: right for EVM, wrong for Stellar
      originAsset: "nep141:usdc-base",
      destinationAsset: "nep141:usdc-base",
      destinationDecimals: 6,
      fxRates: { USD: 1, RWF: 1450 },
      slippageBps: 100,
      referral: "",
    },
  },
}));

// ---- the database: one payment row that really remembers what is saved to it ----
let txRow: any = null;
const INVOICE = { id: "inv1", merchantId: "m1", reference: "REF-1", status: "pending_payment", amount: 10000, currency: "RWF", items: [{ name: "Wallet top-up", qty: 1, unitPrice: 10000 }], expiresAt: new Date(Date.now() + 3_600_000), merchant: { name: "Test", business: null } };
vi.mock("@/db/prisma", () => ({
  prisma: {
    invoice: { findUnique: async () => INVOICE, updateMany: vi.fn() },
    transaction: {
      findUnique: async () => txRow,
      create: async ({ data }: any) => (txRow = { id: "tx1", ...data }),
      update: async ({ data }: any) => (txRow = { ...txRow, ...data }),
      updateMany: vi.fn(),
    },
  },
}));
vi.mock("@/services/invoice", () => ({
  INVOICE_STATUS: { DRAFT: "draft", SENT: "sent", PENDING: "pending_payment", PAID: "paid", EXPIRED: "expired", FAILED: "failed", CANCELLED: "cancelled" },
  INVOICE_TTL_MINUTES: 30,
  getInvoiceByReference: async () => INVOICE,
  getInvoiceById: async () => INVOICE,
  issueInvoice: vi.fn(),
  markPendingPayment: async () => INVOICE,
  settleInvoicePayment: vi.fn(),
  failInvoicePayment: vi.fn(),
  isTopUpInvoice: () => true,
}));
vi.mock("@/rails/settlement", () => ({ recordRailEvent: vi.fn(async () => null) }));

import { payApiRouter } from "@/api/pay";
import { getCryptoPaymentState, setVerificationScheduler } from "@/services/cryptoInvoice";

// ---- the outside world ----
const ME = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
const ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const TREASURY = "0x2527D02599Ba641c19FEa793cD0F167589a0f10D";
const TOKENS = [
  { assetId: "nep141:base-eth", symbol: "ETH", blockchain: "base", decimals: 18, price: 3000 },
  { assetId: "nep245:xlm", symbol: "XLM", blockchain: "stellar", decimals: 7, price: 0.13 },
  { assetId: "nep245:usdc-stellar", symbol: "USDC", blockchain: "stellar", decimals: 7, price: 1, contractAddress: ISSUER },
  { assetId: "nep245:yxlm", symbol: "YXLM", blockchain: "stellar", decimals: 7, price: 1 },
  { assetId: "nep141:sol", symbol: "SOL", blockchain: "sol", decimals: 9, price: 150 },
];
const MEMO = "257123970";

let stellarAccount: "missing" | "xlm-only" | "has-usdc" = "has-usdc";
let calls: Array<{ url: string; body?: any }> = [];

function fakeInternet() {
  return vi.fn(async (input: any, init?: any) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, body });
    const json = (status: number, data: unknown) => ({ ok: status < 300, status, json: async () => data, text: async () => JSON.stringify(data) });
    if (url.endsWith("/v0/tokens")) return json(200, TOKENS);
    if (url.includes("/v0/quote")) {
      const onStellar = body.originAsset.includes("stellar") || body.originAsset.includes("xlm");
      return json(200, { quote: { depositAddress: onStellar ? "GDEPOSITADDRESSSHAREDXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX" : "0xDEPOSIT", ...(onStellar ? { depositMemo: MEMO } : {}), amountIn: "39685692", amountInFormatted: "3.9", amountOut: body.amount } });
    }
    if (url.includes("/v0/status")) return json(200, { status: "PENDING_DEPOSIT" });
    if (url.includes("horizon")) {
      if (stellarAccount === "missing") return json(404, {});
      const balances: any[] = [{ asset_type: "native" }];
      if (stellarAccount === "has-usdc") balances.push({ asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: ISSUER });
      return json(200, { balances });
    }
    throw new Error(`unexpected request to ${url}`);
  });
}

const app = () => express().use(express.json()).use("/api/pay", payApiRouter);
const pay = (symbol: string, chain: string, refundTo?: string) => request(app()).post("/api/pay/REF-1/quote").send({ symbol, chain, refundTo });
const quotesAsked = () => calls.filter((c) => c.url.includes("/v0/quote"));

beforeEach(() => {
  txRow = null;
  calls = [];
  stellarAccount = "has-usdc";
  vi.stubGlobal("fetch", fakeInternet());
  setVerificationScheduler(async () => undefined); // no real timers or queue
});

describe("paying from Stellar, end to end", () => {
  it("1. a payer on Stellar gets a memo deposit that refunds to their own Stellar address, never the treasury's 0x", async () => {
    const res = await pay("XLM", "stellar", ME);
    expect(res.status).toBe(200);

    const [quote] = quotesAsked();
    expect(quote.body).toMatchObject({ depositMode: "MEMO", refundTo: ME, originAsset: "nep245:xlm", recipient: TREASURY });
    expect(quote.body.refundTo).not.toBe(TREASURY);

    // What the payer is shown: the shared address AND the memo that identifies their payment.
    expect(res.body.quote).toMatchObject({ depositAddress: expect.stringMatching(/^GDEPOSIT/), depositMemo: MEMO, refundTo: ME });
  });

  it("2. it will not mint a deposit address when the refund could not land: account missing, or no USDC trustline", async () => {
    stellarAccount = "missing";
    const missing = await pay("XLM", "stellar", ME);
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/isn't activated/);

    stellarAccount = "xlm-only";
    const noTrustline = await pay("USDC", "stellar", ME);
    expect(noTrustline.status).toBe(400);
    expect(noTrustline.body.error).toMatch(/no USDC trustline/);

    expect(quotesAsked()).toHaveLength(0); // nothing was sent to 1Click, so no address exists to send money to
    expect(txRow).toBeNull();

    // The same account is fine for XLM, which needs no trustline.
    expect((await pay("XLM", "stellar", ME)).status).toBe(200);
  });

  it("3. an address from the wrong chain is refused both ways, before anything is quoted", async () => {
    const stellarWith0x = await pay("XLM", "stellar", TREASURY);
    expect(stellarWith0x.status).toBe(400);
    const stellarWithNothing = await pay("XLM", "stellar");
    expect(stellarWithNothing.status).toBe(400);
    const baseWithStellar = await pay("ETH", "base", ME);
    expect(baseWithStellar.status).toBe(400);

    expect(quotesAsked()).toHaveLength(0);
    // And a Base payer never triggers a Stellar lookup.
    expect(calls.some((c) => c.url.includes("horizon"))).toBe(false);
  });

  it("4. nothing changed for everyone else: a Base payment has no memo mode and keeps its 0x refund", async () => {
    const res = await pay("ETH", "base", "0x1111111111111111111111111111111111111111");
    expect(res.status).toBe(200);
    const [quote] = quotesAsked();
    expect("depositMode" in quote.body).toBe(false);
    expect(quote.body.refundTo).toBe("0x1111111111111111111111111111111111111111");
    expect(res.body.quote.depositMemo ?? null).toBeNull();
  });

  it("5. the memo is kept and used when checking whether it was paid; without it a Stellar payment could never be found", async () => {
    expect((await pay("XLM", "stellar", ME)).status).toBe(200);
    expect(txRow.metadata.nearQuotes[0]).toMatchObject({ depositMemo: MEMO });

    calls = [];
    await getCryptoPaymentState("REF-1");
    const status = calls.find((c) => c.url.includes("/v0/status"));
    expect(status, "the payment was never looked up on 1Click").toBeDefined();
    expect(new URL(status!.url).searchParams.get("depositMemo")).toBe(MEMO);
    expect(new URL(status!.url).searchParams.get("depositAddress")).toMatch(/^GDEPOSIT/);
  });
});
