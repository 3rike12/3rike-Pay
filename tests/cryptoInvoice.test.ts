import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/config", () => ({
  config: { logLevel: "debug", redis: {}, nearIntents: { originAsset: "nep141:usdc-base" } },
}));

const getStatus = vi.fn();
const requestQuote = vi.fn();
vi.mock("@/services/nearIntents", () => ({
  EVM_CHAIN_IDS: { base: 8453 },
  prettyOrigin: (l?: string) => {
    if (!l) return "";
    const [t, c] = l.split(" on ");
    return c ? `${t} on ${({ arb: "Arbitrum", base: "Base" } as Record<string, string>)[c] ?? c}` : l;
  },
  nearIntents: {
    getStatus: (...a: any[]) => getStatus(...a),
    requestQuote: (...a: any[]) => requestQuote(...a),
    isNearIntentsEnabled: () => true,
    fiatToDestinationUnits: () => "3448276",
  },
}));

const settle = vi.fn();
const fail = vi.fn();
const getInvoiceByReference = vi.fn();
const getInvoiceById = vi.fn();
vi.mock("@/services/invoice", () => ({
  INVOICE_STATUS: { DRAFT: "draft", SENT: "sent", PENDING: "pending_payment", PAID: "paid", EXPIRED: "expired", FAILED: "failed", CANCELLED: "cancelled" },
  INVOICE_TTL_MINUTES: 30,
  getInvoiceByReference: (...a: any[]) => getInvoiceByReference(...a),
  getInvoiceById: (...a: any[]) => getInvoiceById(...a),
  issueInvoice: vi.fn(),
  markPendingPayment: vi.fn(async () => ({ id: "inv1" })),
  settleInvoicePayment: (...a: any[]) => settle(...a),
  failInvoicePayment: (...a: any[]) => fail(...a),
}));

const txFind = vi.fn();
const txUpdate = vi.fn();
const txUpdateMany = vi.fn();
const invUpdateMany = vi.fn();
vi.mock("@/db/prisma", () => ({
  prisma: {
    transaction: { findUnique: (...a: any[]) => txFind(...a), update: (...a: any[]) => txUpdate(...a), updateMany: (...a: any[]) => txUpdateMany(...a), create: vi.fn() },
    invoice: { updateMany: (...a: any[]) => invUpdateMany(...a) },
  },
}));

import { getCryptoPaymentState, createCryptoPayment, scheduleCryptoVerification, setVerificationScheduler } from "@/services/cryptoInvoice";

const openInvoice = (over: Record<string, unknown> = {}) => ({ id: "inv1", status: "pending_payment", expiresAt: new Date(Date.now() + 600_000), ...over });
const twoQuotes = { nearQuotes: [{ depositAddress: "0xA" }, { depositAddress: "0xB" }] };

beforeEach(() => {
  vi.clearAllMocks();
  getInvoiceByReference.mockResolvedValue(openInvoice());
  txFind.mockResolvedValue({ metadata: twoQuotes });
});

describe("getCryptoPaymentState (all quotes)", () => {
  it("settles when an EARLIER quote's address was the one paid", async () => {
    getStatus.mockImplementation(async (addr: string) => ({ status: addr === "0xA" ? "SUCCESS" : "PENDING_DEPOSIT" }));
    const r = await getCryptoPaymentState("ref");
    expect(r.state).toBe("paid");
    expect(settle).toHaveBeenCalledOnce();
    expect(getStatus).toHaveBeenCalledTimes(2);
  });

  it("hands the merchant message and the receipt what was actually paid, with the tx link", async () => {
    txFind.mockResolvedValue({
      metadata: { nearQuotes: [{ depositAddress: "0xA", originLabel: "USDC on arb", amountInFormatted: "3.49" }] },
    });
    getStatus.mockResolvedValue({
      status: "SUCCESS",
      swapDetails: {
        amountInFormatted: "3.485943",
        originChainTxHashes: [{ hash: "0xabc", explorerUrl: "https://arbiscan.io/tx/0xabc" }],
      },
    });

    expect((await getCryptoPaymentState("ref")).state).toBe("paid");

    const meta = settle.mock.calls[0][1];
    expect(meta.crypto.paidWith).toBe("3.485943 USDC on Arbitrum");
    expect(meta.crypto.txUrl).toBe("https://arbiscan.io/tx/0xabc");
    // and the same proof is stored for the customer's receipt
    const saved = txUpdate.mock.calls.find((c: any[]) => c[0].data.metadata?.receipt)?.[0].data.metadata.receipt;
    expect(saved.paidWith).toBe("3.485943 USDC on Arbitrum");
    expect(saved.txHash).toBe("0xabc");
  });

  it("drops a non-https explorer link rather than showing it", async () => {
    txFind.mockResolvedValue({ metadata: { nearQuotes: [{ depositAddress: "0xA", originLabel: "USDC on base" }] } });
    getStatus.mockResolvedValue({
      status: "SUCCESS",
      swapDetails: { originChainTxHashes: [{ hash: "0x1", explorerUrl: "javascript:alert(1)" }] },
    });
    await getCryptoPaymentState("ref");
    expect(settle.mock.calls[0][1].crypto.txUrl).toBeNull();
  });

  it("reports processing while any deposit is in flight", async () => {
    getStatus.mockImplementation(async (addr: string) => ({ status: addr === "0xB" ? "PROCESSING" : "PENDING_DEPOSIT" }));
    expect((await getCryptoPaymentState("ref")).state).toBe("processing");
    expect(settle).not.toHaveBeenCalled();
  });

  it("does NOT fail the invoice when only one of two quotes is refunded", async () => {
    getStatus.mockImplementation(async (addr: string) => ({ status: addr === "0xA" ? "REFUNDED" : "PENDING_DEPOSIT" }));
    expect((await getCryptoPaymentState("ref")).state).toBe("awaiting_payment");
    expect(fail).not.toHaveBeenCalled();
  });

  it("reports refunded only when every quote is dead", async () => {
    getStatus.mockResolvedValue({ status: "REFUNDED" });
    expect((await getCryptoPaymentState("ref")).state).toBe("refunded");
    expect(fail).toHaveBeenCalledWith("ref", "REFUNDED");
  });

  it("expires an unpaid invoice once its window closes", async () => {
    getInvoiceByReference.mockResolvedValue(openInvoice({ expiresAt: new Date(Date.now() - 1000) }));
    getStatus.mockResolvedValue({ status: "PENDING_DEPOSIT" });
    expect((await getCryptoPaymentState("ref")).state).toBe("expired");
    expect(invUpdateMany).toHaveBeenCalled();
  });

  it("never expires an invoice that has a deposit in flight", async () => {
    getInvoiceByReference.mockResolvedValue(openInvoice({ expiresAt: new Date(Date.now() - 1000) }));
    getStatus.mockResolvedValue({ status: "PROCESSING" });
    expect((await getCryptoPaymentState("ref")).state).toBe("processing");
  });

  it("settles a LATE payment that lands after the invoice already expired", async () => {
    getInvoiceByReference.mockResolvedValue(openInvoice({ status: "expired" }));
    getStatus.mockImplementation(async (addr: string) => ({ status: addr === "0xB" ? "SUCCESS" : "PENDING_DEPOSIT" }));
    expect((await getCryptoPaymentState("ref")).state).toBe("paid");
    expect(settle).toHaveBeenCalledOnce();
  });

  it("keeps reporting expired when nothing arrived", async () => {
    getInvoiceByReference.mockResolvedValue(openInvoice({ status: "expired" }));
    getStatus.mockResolvedValue({ status: "PENDING_DEPOSIT" });
    expect((await getCryptoPaymentState("ref")).state).toBe("expired");
    expect(settle).not.toHaveBeenCalled();
  });

  it("falls back to the single legacy quote format", async () => {
    txFind.mockResolvedValue({ metadata: { nearIntents: { depositAddress: "0xOLD" } } });
    getStatus.mockResolvedValue({ status: "PENDING_DEPOSIT" });
    expect((await getCryptoPaymentState("ref")).state).toBe("awaiting_payment");
    expect(getStatus).toHaveBeenCalledWith("0xOLD", undefined);
  });
});

describe("createCryptoPayment quote history", () => {
  const meta = (n: number) => ({ nearQuotes: Array.from({ length: n }, (_, i) => ({ depositAddress: `0x${i}` })) });

  it("appends a new quote instead of overwriting the earlier ones", async () => {
    getInvoiceById.mockResolvedValue({ id: "inv1", merchantId: "m1", status: "pending_payment", reference: "ref", amount: 5000, currency: "RWF" });
    txFind.mockResolvedValue({ id: "tx1", metadata: meta(1) });
    requestQuote.mockResolvedValue({ quote: { depositAddress: "0xNEW", amountIn: "1", amountOut: "2" } });

    await createCryptoPayment({ merchantId: "m1", invoiceId: "inv1", originAsset: "nep141:other" });

    const saved = txUpdate.mock.calls[0][0].data.metadata;
    expect(saved.nearQuotes.map((q: any) => q.depositAddress)).toEqual(["0x0", "0xNEW"]);
    expect(saved.nearIntents.depositAddress).toBe("0xNEW");
  });

  it("refuses to mint more than 8 quotes for one invoice", async () => {
    getInvoiceById.mockResolvedValue({ id: "inv1", merchantId: "m1", status: "pending_payment", reference: "ref", amount: 5000, currency: "RWF" });
    txFind.mockResolvedValue({ id: "tx1", metadata: meta(8) });
    await expect(createCryptoPayment({ merchantId: "m1", invoiceId: "inv1", originAsset: "nep141:other" })).rejects.toThrow(/Too many/);
    expect(requestQuote).not.toHaveBeenCalled();
  });
});

describe("scheduleCryptoVerification", () => {
  it("hands tracking to the durable queue when one is running", () => {
    const scheduler = vi.fn().mockResolvedValue(undefined);
    setVerificationScheduler(scheduler);
    scheduleCryptoVerification("ref");
    expect(scheduler).toHaveBeenCalledWith("ref");
    setVerificationScheduler(null);
  });

  it("falls back to in-process timers if the queue rejects the job", async () => {
    setVerificationScheduler(vi.fn().mockRejectedValue(new Error("redis down")));
    getStatus.mockResolvedValue({ status: "PENDING_DEPOSIT" });
    scheduleCryptoVerification("ref", [10]);
    await new Promise((r) => setTimeout(r, 120));
    expect(getStatus).toHaveBeenCalled(); // the timer chain ran
    setVerificationScheduler(null);
  });
});
