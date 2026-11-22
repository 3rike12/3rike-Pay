import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/config", () => ({
  config: {
    logLevel: "debug",
    redis: {},
    treasury: {
      address: "0xtreasury",
      tokenContract: "0xusdc",
      tokenDecimals: 6,
      minWithdrawUsd: 5,
      maxWithdrawUsd: 2000,
    },
    nearIntents: { originAsset: "nep141:usdc-base", fxRates: { USD: 1, KES: 130, NGN: 1500 } },
  },
}));

const debit = vi.fn();
const credit = vi.fn();
vi.mock("@/services/ledger", () => ({
  ledger: { debit: (...a: any[]) => debit(...a), credit: (...a: any[]) => credit(...a) },
}));

const initializeOffRamp = vi.fn();
const getUsdNgnRate = vi.fn();
vi.mock("@/services/autoramp", () => ({
  autoramp: {
    initializeOffRamp: (...a: any[]) => initializeOffRamp(...a),
    getUsdNgnRate: (...a: any[]) => getUsdNgnRate(...a),
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
const txUpdate = vi.fn();
const txFindFirst = vi.fn();
const txFindMany = vi.fn();
// The REAL rail event engine runs against in-memory tables.
vi.mock("@/db/prisma", async () => {
  const { makeIntentTables } = await import("./helpers/fakeIntents");
  const tables = makeIntentTables();
  return {
    __tables: tables,
    prisma: {
      paymentIntent: tables.paymentIntent,
      railEvent: tables.railEvent,
    transaction: {
      create: (...a: any[]) => txCreate(...a),
      updateMany: (...a: any[]) => txUpdateMany(...a),
      update: (...a: any[]) => txUpdate(...a),
      findFirst: (...a: any[]) => txFindFirst(...a),
      findMany: (...a: any[]) => txFindMany(...a),
    },
    },
  };
});
const tables = ((await import("@/db/prisma")) as any).__tables;

import { quoteCashout, requestCashout, applyOfframpEvent, listStuckCashouts } from "@/services/cashout";
import { setTreasurySigner } from "@/services/withdrawal";
import { resetFxCache } from "@/services/fx";

const bank = { bankCode: "000013", accountNumber: "0123456789", accountName: "A B", bankName: "GTBank" };

beforeEach(() => {
  vi.clearAllMocks();
  tables.reset();
  resetFxCache(); // a live rate cached by an earlier test must not answer this one
  setTreasurySigner(null);
  getUsdNgnRate.mockResolvedValue({ rate: 1500 });
  onChainBalanceUsd.mockResolvedValue(10_000);
  liabilities.mockResolvedValue({ totalUsd: 100, byCurrency: {} });
  initializeOffRamp.mockResolvedValue({
    data: { transactionId: "t1", depositAddress: "0xramp" },
    databaseRecord: { reference: "OFR-1" },
  });
});

describe("quoteCashout", () => {
  it("converts the merchant's currency to naira and rounds the USDC up to the cent", async () => {
    const q = await quoteCashout("KES", 13000); // $100 at 130
    expect(q.usd).toBeCloseTo(100);
    expect(q.ngn).toBe(150000);
    expect(q.usdc).toBe(100);
  });

  it("falls back to the static NGN rate when AutoRamp's rate is unavailable", async () => {
    getUsdNgnRate.mockResolvedValue(null);
    expect((await quoteCashout("KES", 13000)).ngn).toBe(150000);
  });

  it("rejects amounts outside the limits", async () => {
    await expect(quoteCashout("KES", 130)).rejects.toThrow(/minimum/i); // $1
    await expect(quoteCashout("KES", 130 * 5000)).rejects.toThrow(/maximum/i);
    await expect(quoteCashout("KES", 0)).rejects.toThrow(/valid amount/i);
  });
});

describe("requestCashout", () => {
  it("initialises the off-ramp, debits once, and parks for funding when there is no signer", async () => {
    const r = await requestCashout({ userId: "u1", currency: "KES", amount: 13000, ...bank });

    expect(initializeOffRamp).toHaveBeenCalledWith({
      network: "base", amount: 150000, bankCode: "000013", accountNumber: "0123456789",
    });
    expect(debit).toHaveBeenCalledWith(expect.objectContaining({
      userId: "u1", amount: 13000, currency: "KES", reference: "OFR-1", idempotencyKey: "cashout-debit:OFR-1",
    }));
    expect(txCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ reference: "OFR-1", type: "cashout", status: "processing" }),
    }));
    expect(txUpdateMany).toHaveBeenCalledWith({ where: { reference: "OFR-1" }, data: { status: "awaiting_signature" } });
    expect(r).toMatchObject({ reference: "OFR-1", status: "awaiting_signature", depositAddress: "0xramp" });
  });

  it("has the treasury send the exact USDC to AutoRamp when a signer is registered", async () => {
    const send = vi.fn().mockResolvedValue({ txHash: "0xtx" });
    setTreasurySigner({ send });
    const r = await requestCashout({ userId: "u1", currency: "KES", amount: 13000, ...bank });
    expect(send).toHaveBeenCalledWith({ to: "0xramp", amountUnits: "100000000", asset: "0xusdc", reference: "OFR-1" });
    expect(r).toMatchObject({ status: "processing", txHash: "0xtx" });
  });

  it("records the rate it used and says AutoRamp quoted it", async () => {
    await requestCashout({ userId: "u1", currency: "KES", amount: 13000, ...bank });
    const metadata = txCreate.mock.calls[0][0].data.metadata;
    expect(metadata.fx).toMatchObject({ currency: "NGN", perUsd: 1500, source: "autoramp" });
    expect(typeof metadata.fx.asOf).toBe("string");
  });

  it("falls back to the static table when AutoRamp's rate is unavailable, and records that instead", async () => {
    getUsdNgnRate.mockResolvedValue(null);
    await requestCashout({ userId: "u1", currency: "KES", amount: 13000, ...bank });
    expect(txCreate.mock.calls[0][0].data.metadata.fx).toEqual({ currency: "NGN", perUsd: 1500, source: "static", asOf: null });
  });

  it("reverses the debit if sending the USDC fails", async () => {
    setTreasurySigner({ send: vi.fn().mockRejectedValue(new Error("rpc down")) });
    await expect(requestCashout({ userId: "u1", currency: "KES", amount: 13000, ...bank })).rejects.toThrow(/balance was restored/);
    expect(credit).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: "cashout-reversal:OFR-1", amount: 13000 }));
  });

  it("never touches the balance when AutoRamp rejects the request", async () => {
    initializeOffRamp.mockRejectedValue(new Error("422"));
    await expect(requestCashout({ userId: "u1", currency: "KES", amount: 13000, ...bank })).rejects.toThrow(/couldn't set up/i);
    expect(debit).not.toHaveBeenCalled();
  });

  it("fails closed when the treasury cannot cover it", async () => {
    onChainBalanceUsd.mockResolvedValue(50);
    await expect(requestCashout({ userId: "u1", currency: "KES", amount: 13000, ...bank })).rejects.toThrow(/temporarily unavailable/i);
    expect(initializeOffRamp).not.toHaveBeenCalled();
    expect(debit).not.toHaveBeenCalled();
  });

  it("rejects a malformed account number before doing anything", async () => {
    await expect(requestCashout({ userId: "u1", currency: "KES", amount: 13000, ...bank, accountNumber: "123" })).rejects.toThrow(/10 digits/);
    expect(initializeOffRamp).not.toHaveBeenCalled();
  });
});

describe("applyOfframpEvent", () => {
  const tx = (status: string) => ({ id: "x1", userId: "u1", amount: 13000, currency: "KES", status, metadata: { ngn: 150000 } });

  it("completes a cash-out once, ignoring duplicate webhooks", async () => {
    txFindFirst.mockResolvedValueOnce(tx("processing"));
    expect(await applyOfframpEvent("offramp.completed", "OFR-1")).toMatchObject({ outcome: "completed", ngn: 150000 });
    txFindFirst.mockResolvedValueOnce(tx("completed"));
    expect(await applyOfframpEvent("offramp.completed", "OFR-1")).toBeNull();
  });

  it("credits the merchant back on failure, idempotently", async () => {
    txFindFirst.mockResolvedValueOnce(tx("processing"));
    const r = await applyOfframpEvent("offramp.failed", "OFR-1");
    expect(r).toMatchObject({ outcome: "failed", amount: 13000, currency: "KES" });
    expect(credit).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: "cashout-reversal:OFR-1" }));
    txFindFirst.mockResolvedValueOnce(tx("failed"));
    expect(await applyOfframpEvent("offramp.failed", "OFR-1")).toBeNull();
  });

  it("records every report, including the ones it refuses", async () => {
    txFindFirst.mockResolvedValueOnce(tx("processing"));
    await applyOfframpEvent("offramp.completed", "OFR-1");
    const [intent] = [...tables.intents.values()];
    expect(intent).toMatchObject({ reference: "OFR-1", kind: "cashout", rail: "autoramp", state: "settled" });

    txFindFirst.mockResolvedValueOnce(tx("completed"));
    await applyOfframpEvent("offramp.failed", "OFR-1");
    expect(tables.events.map((e: any) => [e.type, e.applied])).toEqual([["settled", true], ["failed", false]]);
    expect(intent.state).toBe("settled"); // the contradiction did not move it
  });

  it("posts the refund once even if the provider repeats the failure before the Transaction updates", async () => {
    txFindFirst.mockResolvedValue(tx("processing")); // the Transaction row is stale on both deliveries
    await applyOfframpEvent("offramp.failed", "OFR-1");
    expect(await applyOfframpEvent("offramp.failed", "OFR-1")).toBeNull();
    expect(credit).toHaveBeenCalledTimes(1);
  });

  it("does not mark the cash-out failed when the refund could not be posted, so the webhook can be retried", async () => {
    txFindFirst.mockResolvedValue(tx("processing"));
    credit.mockRejectedValueOnce(new Error("ledger down"));
    await expect(applyOfframpEvent("offramp.failed", "OFR-1")).rejects.toThrow("ledger down");
    expect([...tables.intents.values()][0]?.state ?? "created").not.toBe("failed");
    expect(txUpdate).not.toHaveBeenCalled();
    expect(await applyOfframpEvent("offramp.failed", "OFR-1")).toMatchObject({ outcome: "failed" });
  });

  it("catches the Transaction up if a crash left it behind the engine", async () => {
    txFindFirst.mockResolvedValueOnce(tx("processing"));
    await applyOfframpEvent("offramp.completed", "OFR-1");
    txUpdate.mockClear();
    txFindFirst.mockResolvedValueOnce(tx("processing")); // the update was lost
    expect(await applyOfframpEvent("offramp.completed", "OFR-1")).toBeNull(); // no second message
    expect(txUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "completed" } }));
  });

  it("does not hand the money back after the bank already paid it", async () => {
    txFindFirst.mockResolvedValueOnce(tx("completed"));
    expect(await applyOfframpEvent("offramp.failed", "OFR-1")).toBeNull();
    expect(credit).not.toHaveBeenCalled();
    expect(txUpdate).not.toHaveBeenCalled();
  });

  it("does not mark a refunded cash-out as paid", async () => {
    txFindFirst.mockResolvedValueOnce(tx("failed"));
    expect(await applyOfframpEvent("offramp.completed", "OFR-1")).toBeNull();
    expect(txUpdate).not.toHaveBeenCalled();
  });

  it("still settles a cash-out an operator funded by hand", async () => {
    txFindFirst.mockResolvedValueOnce(tx("awaiting_signature"));
    expect(await applyOfframpEvent("offramp.completed", "OFR-1")).toMatchObject({ outcome: "completed" });
  });

  it("ignores events that are not about a payout", async () => {
    txFindFirst.mockResolvedValueOnce(tx("processing"));
    expect(await applyOfframpEvent("offramp.pending", "OFR-1")).toBeNull();
    expect(txUpdate).not.toHaveBeenCalled();
  });

  it("ignores references that are not cash-outs", async () => {
    txFindFirst.mockResolvedValueOnce(null);
    expect(await applyOfframpEvent("offramp.failed", "OFR-9")).toBeNull();
  });
});

describe("listStuckCashouts", () => {
  it("asks for processing cash-outs older than the cutoff, oldest first", async () => {
    txFindMany.mockResolvedValue([{ reference: "OFR-1" }]);
    const now = Date.parse("2026-11-22T12:00:00Z");
    expect(await listStuckCashouts(60 * 60 * 1000, now)).toEqual([{ reference: "OFR-1" }]);
    const args = txFindMany.mock.calls.at(-1)![0];
    expect(args.where).toMatchObject({ type: "cashout", status: "processing" });
    expect(args.where.createdAt.lt).toEqual(new Date("2026-11-22T11:00:00Z"));
    expect(args.orderBy).toEqual({ createdAt: "asc" });
  });
});
