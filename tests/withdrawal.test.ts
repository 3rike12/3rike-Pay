import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/config", () => ({
  config: {
    logLevel: "debug",
    redis: {},
    treasury: { address: "0xtreasury", tokenContract: "0xusdc", tokenDecimals: 6, minWithdrawUsd: 5, maxWithdrawUsd: 2000 },
    nearIntents: {
      originAsset: "nep141:usdc-base",
      fxRates: { USD: 1, RWF: 1450 },
    },
  },
}));

const debit = vi.fn();
const credit = vi.fn();
vi.mock("@/services/ledger", () => ({ SYSTEM_ACCOUNTS: { external: "external", opening: "opening", fxClearing: "fx_clearing", fees: "fees", stockClearing: "stock_clearing" }, ledger: { debit: (...a: any[]) => debit(...a), credit: (...a: any[]) => credit(...a) } }));

const requestQuote = vi.fn();
const resolveOriginAsset = vi.fn();
const getStatus = vi.fn();
vi.mock("@/services/nearIntents", () => ({
  nearIntents: {
    requestQuote: (...a: any[]) => requestQuote(...a),
    resolveOriginAsset: (...a: any[]) => resolveOriginAsset(...a),
    getStatus: (...a: any[]) => getStatus(...a),
  },
}));

const onChainBalanceUsd = vi.fn();
const liabilities = vi.fn();
vi.mock("@/services/treasury", async () => {
  const real: any = await vi.importActual("@/services/treasury");
  return { ...real, onChainBalanceUsd: (...a: any[]) => onChainBalanceUsd(...a), liabilities: (...a: any[]) => liabilities(...a) };
});

const txCreate = vi.fn();
const txUpdateMany = vi.fn();
const txFind = vi.fn();
// The REAL rail event engine runs against in-memory tables.
vi.mock("@/db/prisma", async () => {
  const { makeIntentTables } = await import("./helpers/fakeIntents");
  const tables = makeIntentTables();
  return {
    __tables: tables,
    prisma: {
      transaction: {
        create: (...a: any[]) => txCreate(...a),
        updateMany: (...a: any[]) => txUpdateMany(...a),
        findUnique: (...a: any[]) => txFind(...a),
      },
      paymentIntent: tables.paymentIntent,
      railEvent: tables.railEvent,
    },
  };
});
const tables = ((await import("@/db/prisma")) as any).__tables;

import { requestWithdrawal, verifyWithdrawal, setTreasurySigner } from "@/services/withdrawal";

const ADDR = "0x2527D02599Ba641c19FEa793cD0F167589a0f10D";
const base = { userId: "u1", currency: "RWF", amount: 14500, symbol: "usdc", chain: "base", address: ADDR };

beforeEach(() => {
  vi.clearAllMocks();
  tables.reset();
  setTreasurySigner(null);
  onChainBalanceUsd.mockResolvedValue(1000);
  liabilities.mockResolvedValue({ totalUsd: 200, byCurrency: {} });
  resolveOriginAsset.mockResolvedValue({ assetId: "dest-asset", symbol: "USDC", blockchain: "base" });
  requestQuote.mockResolvedValue({ quote: { depositAddress: "0xdep", amountIn: "10000000", amountOut: "9990000" } });
});

describe("requestWithdrawal", () => {
  it("debits the ledger BEFORE quoting, and parks for signature without a signer", async () => {
    const order: string[] = [];
    debit.mockImplementation(async () => order.push("debit"));
    requestQuote.mockImplementation(async () => { order.push("quote"); return { quote: { depositAddress: "0xdep", amountIn: "10000000", amountOut: "1" } }; });

    const r = await requestWithdrawal(base);
    expect(order).toEqual(["debit", "quote"]);
    expect(r.status).toBe("awaiting_signature");
    expect(r.usd).toBe(10);
    expect(requestQuote.mock.calls[0][0]).toMatchObject({ swapType: "EXACT_INPUT", amount: "10000000", recipient: ADDR });
  });

  it("records the rate the payout was priced at", async () => {
    await requestWithdrawal(base);
    expect(txCreate.mock.calls[0][0].data.metadata.fx).toEqual({ currency: "RWF", perUsd: 1450, source: "static", asOf: null });
  });

  it("refuses an amount under the payout rail's own minimum, using the rail's number", async () => {
    await expect(requestWithdrawal({ ...base, amount: 100 })).rejects.toThrow(/Minimum withdrawal/);
    expect(debit).not.toHaveBeenCalled();
  });

  it("sends via the signer when one is registered", async () => {
    const send = vi.fn().mockResolvedValue({ txHash: "0xhash" });
    setTreasurySigner({ send });
    const r = await requestWithdrawal(base);
    expect(r.status).toBe("processing");
    expect(r.txHash).toBe("0xhash");
    expect(send).toHaveBeenCalledWith({ to: "0xdep", amountUnits: "10000000", asset: "0xusdc", reference: expect.any(String) });
  });

  it("restores the balance if the quote fails", async () => {
    requestQuote.mockRejectedValue(new Error("boom"));
    await expect(requestWithdrawal(base)).rejects.toThrow(/restored/);
    expect(credit).toHaveBeenCalledWith(expect.objectContaining({ amount: 14500, currency: "RWF", idempotencyKey: expect.stringMatching(/^withdraw-reversal:/) }));
  });

  it("fails closed when the treasury can't cover liabilities, without touching the ledger", async () => {
    onChainBalanceUsd.mockResolvedValue(50);
    await expect(requestWithdrawal(base)).rejects.toThrow(/unavailable/);
    expect(debit).not.toHaveBeenCalled();
  });

  it("rejects bad address, tiny and huge amounts", async () => {
    await expect(requestWithdrawal({ ...base, address: "nope" })).rejects.toThrow(/valid wallet/);
    await expect(requestWithdrawal({ ...base, amount: 100 })).rejects.toThrow(/Minimum/);
    await expect(requestWithdrawal({ ...base, amount: 99_999_999 })).rejects.toThrow(/Maximum/);
    expect(debit).not.toHaveBeenCalled();
  });
});

describe("verifyWithdrawal", () => {
  const tx = { userId: "u1", type: "withdrawal", status: "processing", amount: 14500, currency: "RWF", metadata: { nearIntents: { depositAddress: "0xdep" } } };

  it("completes on SUCCESS", async () => {
    txFind.mockResolvedValue(tx);
    getStatus.mockResolvedValue({ status: "SUCCESS" });
    expect(await verifyWithdrawal("r1")).toBe("completed");
    expect(credit).not.toHaveBeenCalled();
  });

  it("credits the merchant back on REFUNDED", async () => {
    txFind.mockResolvedValue(tx);
    getStatus.mockResolvedValue({ status: "REFUNDED" });
    expect(await verifyWithdrawal("r1")).toBe("failed");
    expect(credit).toHaveBeenCalledWith(expect.objectContaining({ amount: 14500, idempotencyKey: "withdraw-reversal:r1" }));
  });

  it("records what the rail reported, once it is final", async () => {
    txFind.mockResolvedValue(tx);
    getStatus.mockResolvedValue({ status: "REFUNDED" });
    await verifyWithdrawal("r1");
    const [intent] = [...tables.intents.values()];
    expect(intent).toMatchObject({ reference: "r1", kind: "withdrawal", rail: "1click-payout", state: "refunded" });
    expect(tables.events).toEqual([expect.objectContaining({ type: "refunded", providerStatus: "REFUNDED", applied: true })]);
  });

  it("records nothing while the swap is still running", async () => {
    txFind.mockResolvedValue(tx);
    getStatus.mockResolvedValue({ status: "PROCESSING" });
    expect(await verifyWithdrawal("r1")).toBe("pending");
    expect(tables.intents.size).toBe(0);
  });

  it("refunds exactly once however many times the refund is reported", async () => {
    txFind.mockResolvedValue(tx);
    getStatus.mockResolvedValue({ status: "REFUNDED" });
    expect(await verifyWithdrawal("r1")).toBe("failed");
    expect(await verifyWithdrawal("r1")).toBe("failed"); // a poll that ran again before the status landed
    expect(credit).toHaveBeenCalledTimes(1);
  });

  it("keeps the payout open, state unmoved, when the refund cannot be posted, so the next poll retries it", async () => {
    txFind.mockResolvedValue(tx);
    getStatus.mockResolvedValue({ status: "REFUNDED" });
    credit.mockRejectedValueOnce(new Error("ledger down"));
    expect(await verifyWithdrawal("r1")).toBe("pending");
    expect([...tables.intents.values()].map((i: any) => i.state)).toEqual(["processing"]); // not marked refunded with no refund behind it
    expect(tables.events).toHaveLength(0);
    expect(txUpdateMany).not.toHaveBeenCalledWith(expect.objectContaining({ data: { status: "failed" } }));
    expect(await verifyWithdrawal("r1")).toBe("failed");
    expect(credit).toHaveBeenCalledTimes(2); // the retry, with the same idempotency key
    expect(credit.mock.calls[1][0].idempotencyKey).toBe("withdraw-reversal:r1");
  });

  it("stays pending while parked for signature", async () => {
    txFind.mockResolvedValue({ ...tx, status: "awaiting_signature" });
    expect(await verifyWithdrawal("r1")).toBe("pending");
    expect(getStatus).not.toHaveBeenCalled();
  });
});
