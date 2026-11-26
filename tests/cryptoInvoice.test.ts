import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/config", () => ({
  config: {
    logLevel: "debug",
    redis: {},
    // Most tests here are about payments in general, so invoicing is on; the pause has its own tests below.
    features: { invoicingEnabled: true },
    nearIntents: { originAsset: "nep141:usdc-base", fxRates: { RWF: 1450 } },
    treasury: { address: "0x2527D02599Ba641c19FEa793cD0F167589a0f10D", tokenDecimals: 6 },
  },
}));

const getStatus = vi.fn();
const resolveDefaultOrigin = vi.fn();
const requestQuote = vi.fn();
vi.mock("@/services/nearIntents", () => ({
  EVM_CHAIN_IDS: { base: 8453 },
  prettyOrigin: (l?: string) => {
    if (!l) return "";
    const [t, c] = l.split(" on ");
    return c ? `${t} on ${({ arb: "Arbitrum", base: "Base" } as Record<string, string>)[c] ?? c}` : l;
  },
  STELLAR_CHAIN: "stellar",
  isStellarAddress: (v: string) => /^G[A-Z2-7]{55}$/.test(v),
  depositModeFor: (chain?: string | null) => (chain === "stellar" ? "MEMO" : undefined),
  evmChainIdFor: (chain: string) => ({ base: 8453, arb: 42161, eth: 1 } as Record<string, number>)[chain],
  nearIntents: {
    getStatus: (...a: any[]) => getStatus(...a),
    requestQuote: (...a: any[]) => requestQuote(...a),
    isNearIntentsEnabled: () => true,
    resolveDefaultOrigin: (...a: any[]) => resolveDefaultOrigin(...a),
    // The real conversion, at the test config's rate of 1,450 RWF to the dollar, in 6-decimal USDC units.
    fiatToDestinationUnits: (amount: number) => String(Math.round((amount / 1450) * 1e6)),
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
  isTopUpInvoice: (items: any) => Array.isArray(items) && items.length === 1 && items[0]?.name === "Wallet top-up",
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

const recordRailEvent = vi.fn(async () => null);
vi.mock("@/rails/settlement", () => ({ recordRailEvent: (...a: any[]) => (recordRailEvent as any)(...a) }));

import { getCryptoPaymentState, createCryptoPayment, createDefaultCryptoPayment, scheduleCryptoVerification, setVerificationScheduler } from "@/services/cryptoInvoice";

const openInvoice = (over: Record<string, unknown> = {}) => ({ id: "inv1", status: "pending_payment", expiresAt: new Date(Date.now() + 600_000), ...over });
const twoQuotes = { nearQuotes: [{ depositAddress: "0xA" }, { depositAddress: "0xB" }] };

beforeEach(() => {
  vi.clearAllMocks();
  getInvoiceByReference.mockResolvedValue(openInvoice());
  txFind.mockResolvedValue({ metadata: twoQuotes });
});

describe("getCryptoPaymentState records what 1Click reported", () => {
  it("records a settled payment with the deposit tx as its dedupe key", async () => {
    getStatus.mockResolvedValue({
      status: "SUCCESS",
      swapDetails: { originChainTxHashes: [{ hash: "0xabc", explorerUrl: "https://x.io/0xabc" }] },
    });
    txFind.mockResolvedValue({ metadata: { nearQuotes: [{ depositAddress: "0xA" }] } });
    await getCryptoPaymentState("ref");
    expect(recordRailEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        reference: "ref",
        kind: "invoice",
        direction: "in",
        rail: "1click",
        event: expect.objectContaining({ type: "settled", providerStatus: "SUCCESS", dedupeKey: "0xabc" }),
      })
    );
  });

  it("records a swap in flight, and a refund", async () => {
    getStatus.mockResolvedValue({ status: "PROCESSING" });
    await getCryptoPaymentState("ref");
    expect(recordRailEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ event: expect.objectContaining({ type: "processing" }) })
    );
    getStatus.mockResolvedValue({ status: "REFUNDED" });
    await getCryptoPaymentState("ref");
    expect(recordRailEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ event: { type: "refunded", providerStatus: "REFUNDED" } })
    );
  });

  it("records nothing while it is just waiting for money", async () => {
    getStatus.mockResolvedValue({ status: "PENDING_DEPOSIT" });
    await getCryptoPaymentState("ref");
    expect(recordRailEvent).not.toHaveBeenCalled();
  });

  it("a recording failure does not change the answer", async () => {
    recordRailEvent.mockResolvedValue(null);
    getStatus.mockResolvedValue({ status: "SUCCESS" });
    expect((await getCryptoPaymentState("ref")).state).toBe("paid");
  });
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
    getInvoiceById.mockResolvedValue({ id: "inv1", merchantId: "m1", status: "pending_payment", reference: "ref", amount: 10000, currency: "RWF" });
    txFind.mockResolvedValue({ id: "tx1", metadata: meta(1) });
    requestQuote.mockResolvedValue({ quote: { depositAddress: "0xNEW", amountIn: "1", amountOut: "2" } });

    await createCryptoPayment({ merchantId: "m1", invoiceId: "inv1", originAsset: "nep141:other" });

    const saved = txUpdate.mock.calls[0][0].data.metadata;
    expect(saved.nearQuotes.map((q: any) => q.depositAddress)).toEqual(["0x0", "0xNEW"]);
    expect(saved.nearIntents.depositAddress).toBe("0xNEW");
  });

  it("refuses to mint more than 8 quotes for one invoice", async () => {
    getInvoiceById.mockResolvedValue({ id: "inv1", merchantId: "m1", status: "pending_payment", reference: "ref", amount: 10000, currency: "RWF" });
    txFind.mockResolvedValue({ id: "tx1", metadata: meta(8) });
    await expect(createCryptoPayment({ merchantId: "m1", invoiceId: "inv1", originAsset: "nep141:other" })).rejects.toThrow(/Too many/);
    expect(requestQuote).not.toHaveBeenCalled();
  });
});

describe("while invoicing is paused, only a top-up can be paid", () => {
  const withInvoicing = async (on: boolean, run: () => Promise<void>) => {
    const { config } = await import("@/config");
    const saved = (config as any).features;
    (config as any).features = { invoicingEnabled: on };
    try {
      await run();
    } finally {
      (config as any).features = saved;
    }
  };
  const setup = (items: unknown) => {
    getInvoiceById.mockResolvedValue({ id: "inv1", merchantId: "m1", status: "pending_payment", reference: "ref", amount: 10000, currency: "RWF", items });
    txFind.mockResolvedValue({ id: "tx1", metadata: {} });
    requestQuote.mockResolvedValue({ quote: { depositAddress: "0xDEP", amountIn: "100", amountOut: "1" } });
    requestQuote.mockClear();
    txUpdate.mockClear();
  };

  it("refuses to pay a merchant's invoice, before any quote is requested or anything is written", async () => {
    await withInvoicing(false, async () => {
      setup([{ name: "Batteries", qty: 3, unitPrice: 1000 }]);
      await expect(createCryptoPayment({ merchantId: "m1", invoiceId: "inv1", originAsset: "nep141:other" })).rejects.toThrow("Invoices are paused for now.");
      expect(requestQuote).not.toHaveBeenCalled();
      expect(txUpdate).not.toHaveBeenCalled();
    });
  });

  it("refuses an invoice with no items recorded, rather than guessing it is a top-up", async () => {
    await withInvoicing(false, async () => {
      setup(undefined);
      await expect(createCryptoPayment({ merchantId: "m1", invoiceId: "inv1", originAsset: "nep141:other" })).rejects.toThrow("paused");
    });
  });

  it("a top-up still works", async () => {
    await withInvoicing(false, async () => {
      setup([{ name: "Wallet top-up", qty: 1, unitPrice: 10000 }]);
      await createCryptoPayment({ merchantId: "m1", invoiceId: "inv1", originAsset: "nep141:other" });
      expect(requestQuote).toHaveBeenCalledOnce();
    });
  });

  it("an invoice that merely has a top-up among other items is not a top-up", async () => {
    await withInvoicing(false, async () => {
      setup([{ name: "Wallet top-up", qty: 1, unitPrice: 5000 }, { name: "Batteries", qty: 1, unitPrice: 5000 }]);
      await expect(createCryptoPayment({ merchantId: "m1", invoiceId: "inv1", originAsset: "nep141:other" })).rejects.toThrow("paused");
    });
  });

  it("with invoicing on, an ordinary invoice is paid as before", async () => {
    await withInvoicing(true, async () => {
      setup([{ name: "Batteries", qty: 3, unitPrice: 1000 }]);
      await createCryptoPayment({ merchantId: "m1", invoiceId: "inv1", originAsset: "nep141:other" });
      expect(requestQuote).toHaveBeenCalledOnce();
    });
  });
});

describe("the 1Click minimum, said in the invoice's own currency", () => {
  const invoiceOf = (amount: number) => ({ id: "inv1", merchantId: "m1", status: "pending_payment", reference: "ref", amount, currency: "RWF" });
  const quote = () => requestQuote.mockResolvedValue({ quote: { depositAddress: "0xDEP", amountIn: "100", amountOut: "1" } });

  it("refuses an invoice below $5, says so in RWF with the dollar figure in brackets, and quotes and writes nothing", async () => {
    getInvoiceById.mockResolvedValue(invoiceOf(7000)); // about $4.83
    txFind.mockResolvedValue({ id: "tx1", metadata: {} });
    const err = await createCryptoPayment({ merchantId: "m1", invoiceId: "inv1", originAsset: "nep141:other" }).catch((e) => e);
    expect(err.message).toContain("RWF 7,250"); // the minimum, in the invoice's currency
    expect(err.message).toContain("$5 USD");
    expect(err.message).toContain("RWF 7,000"); // what this invoice is
    expect(err.message).not.toMatch(/\$4\.83/); // no stray dollar amount as the headline
    expect(requestQuote).not.toHaveBeenCalled();
    expect(txUpdate).not.toHaveBeenCalled();
  });

  it("accepts exactly the minimum, and anything above it", async () => {
    quote();
    for (const amount of [7250, 7251, 100_000]) {
      requestQuote.mockClear();
      getInvoiceById.mockResolvedValue(invoiceOf(amount));
      txFind.mockResolvedValue({ id: "tx1", metadata: {} });
      await createCryptoPayment({ merchantId: "m1", invoiceId: "inv1", originAsset: "nep141:other" });
      expect(requestQuote, String(amount)).toHaveBeenCalledOnce();
    }
  });

  it("falls back to dollars if the currency has no FX rate, rather than failing with a confusing error", async () => {
    getInvoiceById.mockResolvedValue({ ...invoiceOf(100), currency: "XYZ" });
    txFind.mockResolvedValue({ id: "tx1", metadata: {} });
    const err = await createCryptoPayment({ merchantId: "m1", invoiceId: "inv1", originAsset: "nep141:other" }).catch((e) => e);
    expect(err.message).toContain("start at $5");
  });
});

describe("every crypto payment goes through 1Click", () => {
  it("polls each 1Click deposit address and never reads the chain itself", async () => {
    txFind.mockResolvedValue({ metadata: { nearQuotes: [{ depositAddress: "0xA" }, { depositAddress: "0xB" }] } });
    getStatus.mockResolvedValue({ status: "PENDING_DEPOSIT" });
    const r = await getCryptoPaymentState("ref");
    expect(r.state).toBe("awaiting_payment");
    expect(getStatus).toHaveBeenCalledTimes(2);
  });

  it("a new payment is a swap quote, labelled as 1Click", async () => {
    getInvoiceById.mockResolvedValue({ id: "inv1", merchantId: "m1", status: "pending_payment", reference: "ref", amount: 10000, currency: "RWF" });
    txFind.mockResolvedValue({ id: "tx1", metadata: {} });
    requestQuote.mockResolvedValue({ quote: { depositAddress: "0xDEP", amountIn: "100", amountOut: "3448276" } });
    const out: any = await createCryptoPayment({ merchantId: "m1", invoiceId: "inv1", originAsset: "nep141:other" });
    expect(requestQuote).toHaveBeenCalledOnce();
    expect(out.provider).toBe("1click");
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

describe("the default payment a top-up is prepared in", () => {
  it("uses whichever token 1Click offers first of its preferences, not a hard-wired one", async () => {
    getInvoiceById.mockResolvedValue({ id: "inv1", merchantId: "m1", status: "pending_payment", reference: "ref", amount: 10000, currency: "RWF", items: [{ name: "Wallet top-up", qty: 1, unitPrice: 10000 }] });
    txFind.mockResolvedValue({ id: "tx1", metadata: {} });
    requestQuote.mockResolvedValue({ quote: { depositAddress: "0xDEP", amountIn: "100", amountOut: "1" } });
    requestQuote.mockClear();
    resolveDefaultOrigin.mockResolvedValue({ assetId: "nep141:base.omft.near", symbol: "ETH", blockchain: "base", decimals: 18 });

    await createDefaultCryptoPayment("m1", "inv1");

    expect(requestQuote).toHaveBeenCalledOnce();
    expect(requestQuote.mock.calls[0][0]).toMatchObject({ originAsset: "nep141:base.omft.near" });
    const saved = txUpdate.mock.calls.at(-1)![0].data.metadata;
    expect(saved.nearIntents.originLabel).toBe("ETH on base");
  });

  it("says plainly when 1Click offers nothing to pay in, instead of quoting something wrong", async () => {
    resolveDefaultOrigin.mockResolvedValue(null);
    requestQuote.mockClear();
    await expect(createDefaultCryptoPayment("m1", "inv1")).rejects.toThrow("default payment token is unavailable");
    expect(requestQuote).not.toHaveBeenCalled();
  });
});

describe("paying from Stellar", () => {
  const STELLAR_ME = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
  const stellarMeta = { symbol: "USDC", chain: "stellar", chainId: null, tokenAddress: null, decimals: 7 };
  const pay = (extra: Record<string, unknown> = {}) =>
    createCryptoPayment({ merchantId: "m1", invoiceId: "inv1", originAsset: "nep245:stellar-usdc", originLabel: "USDC on stellar", originMeta: stellarMeta, ...extra } as any);

  beforeEach(async () => {
    getInvoiceById.mockResolvedValue({ id: "inv1", merchantId: "m1", status: "pending_payment", reference: "ref", amount: 10000, currency: "RWF", items: [{ name: "Wallet top-up", qty: 1, unitPrice: 10000 }] });
    txFind.mockResolvedValue({ id: "tx1", metadata: {} });
    requestQuote.mockReset();
    requestQuote.mockResolvedValue({ quote: { depositAddress: "GDEPOSIT", depositMemo: "257123970", amountIn: "39", amountOut: "6900000" } });
    const { config } = await import("@/config");
    (config as any).nearIntents.refundToStellar = "";
  });

  it("asks 1Click for memo mode and refunds to the payer's own Stellar address", async () => {
    await pay({ refundTo: STELLAR_ME });
    expect(requestQuote).toHaveBeenCalledOnce();
    expect(requestQuote.mock.calls[0][0]).toMatchObject({ depositMode: "MEMO", refundTo: STELLAR_ME });
    const saved = txUpdate.mock.calls.at(-1)![0].data.metadata.nearIntents;
    expect(saved.depositMemo).toBe("257123970");
    expect(saved.refundTo).toBe(STELLAR_ME);
  });

  it("without the payer's address it uses the platform's Stellar refund account", async () => {
    const { config } = await import("@/config");
    (config as any).nearIntents.refundToStellar = "GBPLATFORMREFUNDACCOUNTXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX".slice(0, 56).replace(/[^A-Z2-7]/g, "A");
    await pay();
    expect(requestQuote.mock.calls[0][0].refundTo).toBe((config as any).nearIntents.refundToStellar);
  });

  it("with neither, it refuses and asks for the address, rather than quoting a refund that cannot work", async () => {
    await expect(pay()).rejects.toThrow("Add your Stellar address");
    expect(requestQuote).not.toHaveBeenCalled();
  });

  it("never sends the treasury's 0x address, or any non-Stellar address, as a Stellar refund", async () => {
    await expect(pay({ refundTo: "0x2527D02599Ba641c19FEa793cD0F167589a0f10D" })).rejects.toThrow("Add your Stellar address");
    expect(requestQuote).not.toHaveBeenCalled();
  });

  it("leaves other chains alone: no memo mode, the refund as given", async () => {
    await createCryptoPayment({ merchantId: "m1", invoiceId: "inv1", originAsset: "nep141:base", originLabel: "ETH on base", originMeta: { symbol: "ETH", chain: "base" }, refundTo: "0xabc" } as any);
    expect(requestQuote.mock.calls[0][0].depositMode).toBeUndefined();
    expect(requestQuote.mock.calls[0][0].refundTo).toBe("0xabc");
  });
});

