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
vi.mock("@/services/ledger", () => ({ ledger: { debit: (...a: any[]) => debit(...a), credit: (...a: any[]) => credit(...a) } }));

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
vi.mock("@/db/prisma", () => ({
  prisma: {
    transaction: {
      create: (...a: any[]) => txCreate(...a),
      updateMany: (...a: any[]) => txUpdateMany(...a),
      findUnique: (...a: any[]) => txFind(...a),
    },
  },
}));

import { requestWithdrawal, verifyWithdrawal, setTreasurySigner } from "@/services/withdrawal";

const ADDR = "0x2527D02599Ba641c19FEa793cD0F167589a0f10D";
const base = { userId: "u1", currency: "RWF", amount: 14500, symbol: "usdc", chain: "base", address: ADDR };

beforeEach(() => {
  vi.clearAllMocks();
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

  it("stays pending while parked for signature", async () => {
    txFind.mockResolvedValue({ ...tx, status: "awaiting_signature" });
    expect(await verifyWithdrawal("r1")).toBe("pending");
    expect(getStatus).not.toHaveBeenCalled();
  });
});
