import { describe, it, expect, vi, beforeEach } from "vitest";

// Mutable, so a test can turn MONEY_READS=minor on.
const cfg: any = vi.hoisted(() => ({ logLevel: "silent", money: { readsFrom: "float" } }));
vi.mock("@/config", () => ({ config: cfg }));
vi.mock("@/utils/idempotency", () => ({
  acquireLock: async () => ({ release: async () => {} }),
  withIdempotencyKey: async (_k: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock("@/db/prisma", async () => {
  const { makeLedgerDb } = await import("./helpers/fakeLedgerDb");
  const db = makeLedgerDb();
  return { __db: db, prisma: db };
});
const db = ((await import("@/db/prisma")) as any).__db;

import { ledger } from "@/services/ledger";
import { backfillMinor, findWalletDrift, findLedgerSumDrift, findTransactionDrift } from "@/services/moneyMinor";
import { withTransactionMinor } from "@/utils/money";

beforeEach(() => {
  db.reset();
  cfg.money = { readsFrom: "float" };
});

describe("ledger dual-writes minor units", () => {
  it("a first credit creates the wallet with both representations", async () => {
    await ledger.credit({ userId: "u1", amount: 13000, currency: "KES", reference: "r1" });
    const [w] = [...db.wallets.values()];
    expect(w).toMatchObject({ balance: 13000, balanceMinor: 1300000n });
    expect(db.entries[0]).toMatchObject({ direction: "credit", amount: 13000, amountMinor: 1300000n, runningBalance: 13000, runningBalanceMinor: 1300000n });
  });

  it("credits and debits keep the float and the minor balance in step", async () => {
    await ledger.credit({ userId: "u1", amount: 100.1, currency: "KES", reference: "r1" });
    await ledger.credit({ userId: "u1", amount: 0.2, currency: "KES", reference: "r2" });
    await ledger.debit({ userId: "u1", amount: 50.05, currency: "KES", reference: "r3" });
    const [w] = [...db.wallets.values()];
    expect(w.balanceMinor).toBe(5025n); // 100.1 + 0.2 - 50.05 = 50.25
    expect(await findWalletDrift()).toEqual([]);
    expect(db.entries.map((e: any) => e.runningBalanceMinor)).toEqual([10010n, 10030n, 5025n]);
  });

  it("zero-decimal currencies store whole units", async () => {
    await ledger.credit({ userId: "u1", amount: 14500, currency: "RWF", reference: "r1" });
    expect([...db.wallets.values()][0].balanceMinor).toBe(14500n);
  });

  it("a transfer writes both wallets and both entries", async () => {
    db.seedWallet({ userId: "a", currency: "KES", balance: 1000, balanceMinor: 100000n });
    await ledger.transfer({ fromUserId: "a", toUserId: "b", amount: 250.5, currency: "KES", reference: "t1" });
    const a = [...db.wallets.values()].find((w: any) => w.userId === "a");
    const b = [...db.wallets.values()].find((w: any) => w.userId === "b");
    expect(a).toMatchObject({ balance: 749.5, balanceMinor: 74950n });
    expect(b).toMatchObject({ balance: 250.5, balanceMinor: 25050n });
    expect(db.entries.map((e: any) => [e.direction, e.amountMinor])).toEqual([["debit", 25050n], ["credit", 25050n]]);
  });

  it("a wallet that predates the migration heals on its first write", async () => {
    db.seedWallet({ userId: "u1", currency: "KES", balance: 500, balanceMinor: 0n }); // never backfilled
    await ledger.credit({ userId: "u1", amount: 100, currency: "KES", reference: "r1" });
    expect([...db.wallets.values()][0].balanceMinor).toBe(60000n); // derived from the float, not 0 + 10000
  });

  it("a debit past zero (a bookkeeping fee) stores the negative minor balance", async () => {
    await ledger.credit({ userId: "u1", amount: 10, currency: "KES", reference: "r1" });
    await ledger.debit({ userId: "u1", amount: 12.5, currency: "KES", reference: "r2", allowNegative: true });
    expect([...db.wallets.values()][0]).toMatchObject({ balance: -2.5, balanceMinor: -250n });
  });

  it("a refused debit changes nothing", async () => {
    await ledger.credit({ userId: "u1", amount: 10, currency: "KES", reference: "r1" });
    await expect(ledger.debit({ userId: "u1", amount: 20, currency: "KES", reference: "r2" })).rejects.toThrow("Insufficient");
    expect([...db.wallets.values()][0].balanceMinor).toBe(1000n);
    expect(db.entries).toHaveLength(1);
  });
});

describe("backfill and drift checks", () => {
  it("finds a wallet whose minor balance disagrees with its float", async () => {
    db.seedWallet({ userId: "u1", currency: "KES", balance: 12.34, balanceMinor: 0n });
    db.seedWallet({ userId: "u2", currency: "KES", balance: 5, balanceMinor: 500n });
    const drift = await findWalletDrift();
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({ userId: "u1", expectedMinor: "1234", balanceMinor: "0" });
  });

  it("backfills old wallets and entries, and is safe to run twice", async () => {
    const w = db.seedWallet({ userId: "u1", currency: "KES", balance: 12.34, balanceMinor: 0n });
    db.entries.push({ id: "e1", walletId: w.id, direction: "credit", amount: 12.34, currency: "KES", runningBalance: 12.34, amountMinor: 0n, runningBalanceMinor: 0n });
    expect(await backfillMinor()).toEqual({ wallets: 1, entries: 1, transactions: 0 });
    expect(w.balanceMinor).toBe(1234n);
    expect(db.entries[0]).toMatchObject({ amountMinor: 1234n, runningBalanceMinor: 1234n });
    expect(await backfillMinor()).toEqual({ wallets: 0, entries: 0, transactions: 0 });
    expect(await findWalletDrift()).toEqual([]);
  });

  it("reports wallets whose entries do not add up to their balance", async () => {
    await ledger.credit({ userId: "u1", amount: 100, currency: "KES", reference: "r1" });
    await ledger.debit({ userId: "u1", amount: 30, currency: "KES", reference: "r2" });
    expect(await findLedgerSumDrift()).toEqual([]);
    [...db.wallets.values()][0].balanceMinor = 7100n; // changed outside the ledger
    expect(await findLedgerSumDrift()).toEqual([expect.objectContaining({ balanceMinor: "7100", fromEntriesMinor: "7000" })]);
  });

  it("pages through more wallets than one batch", async () => {
    for (let i = 0; i < 1200; i++) db.seedWallet({ userId: `u${i}`, currency: "KES", balance: 1, balanceMinor: 0n });
    expect(await findWalletDrift()).toHaveLength(1200);
    expect((await backfillMinor()).wallets).toBe(1200);
    expect(await findWalletDrift()).toEqual([]);
  });
});

describe("MONEY_READS=minor", () => {
  beforeEach(() => {
    cfg.money = { readsFrom: "minor" };
  });

  it("adds in whole units, so 0.1 + 0.2 is exactly 0.30", async () => {
    await ledger.credit({ userId: "u1", amount: 0.1, currency: "USD", reference: "r1" });
    await ledger.credit({ userId: "u1", amount: 0.2, currency: "USD", reference: "r2" });
    const [w] = [...db.wallets.values()];
    expect(w.balanceMinor).toBe(30n);
    expect(await ledger.getBalance("u1", "USD")).toBe(0.3); // the float column holds 0.30000000000000004
    expect(w.balance).not.toBe(0.3);
  });

  it("records the exact running balance on each entry", async () => {
    await ledger.credit({ userId: "u1", amount: 0.1, currency: "USD", reference: "r1" });
    await ledger.credit({ userId: "u1", amount: 0.2, currency: "USD", reference: "r2" });
    expect(db.entries.map((e: any) => [e.runningBalance, e.runningBalanceMinor])).toEqual([[0.1, 10n], [0.3, 30n]]);
  });

  it("decides sufficiency on whole units: exactly the balance is allowed, a cent more is not", async () => {
    db.seedWallet({ userId: "u1", currency: "KES", balance: 10, balanceMinor: 1000n });
    await expect(ledger.debit({ userId: "u1", amount: 10.01, currency: "KES", reference: "r1" })).rejects.toThrow("Insufficient");
    await ledger.debit({ userId: "u1", amount: 10, currency: "KES", reference: "r2" });
    expect([...db.wallets.values()][0].balanceMinor).toBe(0n);
  });

  it("a transfer moves both wallets exactly", async () => {
    db.seedWallet({ userId: "a", currency: "KES", balance: 1000, balanceMinor: 100000n });
    await ledger.transfer({ fromUserId: "a", toUserId: "b", amount: 0.1, currency: "KES", reference: "t1" });
    await ledger.transfer({ fromUserId: "a", toUserId: "b", amount: 0.2, currency: "KES", reference: "t2" });
    const b = [...db.wallets.values()].find((w: any) => w.userId === "b");
    expect(b.balanceMinor).toBe(30n);
    expect(await ledger.getBalance("b", "KES")).toBe(0.3);
  });

  it("lists balances from the integer column", async () => {
    db.seedWallet({ userId: "u1", currency: "KES", balance: 0.30000000000000004, balanceMinor: 30n });
    expect(await ledger.listBalances("u1")).toEqual([{ currency: "KES", balance: 0.3 }]);
  });

  it("a wallet that still disagrees is read and moved from the float, and healed, never blocked", async () => {
    db.seedWallet({ userId: "u1", currency: "KES", balance: 500, balanceMinor: 0n }); // never backfilled
    expect(await ledger.getBalance("u1", "KES")).toBe(500); // not 0
    await ledger.debit({ userId: "u1", amount: 100, currency: "KES", reference: "r1" }); // not "insufficient"
    const [w] = [...db.wallets.values()];
    expect(w).toMatchObject({ balance: 400, balanceMinor: 40000n });
    expect(await findWalletDrift()).toEqual([]);
  });

  it("is the same as float mode when every wallet is clean", async () => {
    await ledger.credit({ userId: "u1", amount: 13000, currency: "KES", reference: "r1" });
    await ledger.debit({ userId: "u1", amount: 4500.5, currency: "KES", reference: "r2" });
    const [w] = [...db.wallets.values()];
    expect(w).toMatchObject({ balance: 8499.5, balanceMinor: 849950n });
    expect(await ledger.getBalance("u1", "KES")).toBe(8499.5);
  });

  it("a first credit creates the wallet in both columns", async () => {
    await ledger.credit({ userId: "u1", amount: 12.34, currency: "KES", reference: "r1" });
    expect([...db.wallets.values()][0]).toMatchObject({ balance: 12.34, balanceMinor: 1234n });
  });
});

describe("transactions", () => {
  it("fills the minor amount on create, using the row's currency", () => {
    expect(withTransactionMinor({ amount: 13000, currency: "KES" }).amountMinor).toBe(1300000n);
    expect(withTransactionMinor({ amount: 14500, currency: "RWF" }).amountMinor).toBe(14500n);
  });

  it("uses the column default (NGN) when no currency is given", () => {
    expect(withTransactionMinor({ amount: 10.5 }).amountMinor).toBe(1050n);
  });

  it("leaves an explicit minor amount, and rows with no numeric amount, alone", () => {
    expect(withTransactionMinor({ amount: 5, currency: "KES", amountMinor: 7n }).amountMinor).toBe(7n);
    expect(withTransactionMinor({ currency: "KES" })).toEqual({ currency: "KES" });
    expect(withTransactionMinor({ amount: NaN, currency: "KES" }).amountMinor).toBeUndefined();
  });

  it("finds and backfills transactions with no minor amount, and is safe to run twice", async () => {
    db.transactions.set("t1", { id: "t1", amount: 12.5, currency: "KES", amountMinor: null });
    db.transactions.set("t2", { id: "t2", amount: 3, currency: "RWF", amountMinor: 3n });
    expect((await findTransactionDrift()).map((d) => d.transactionId)).toEqual(["t1"]);
    expect((await backfillMinor()).transactions).toBe(1);
    expect(db.transactions.get("t1").amountMinor).toBe(1250n);
    expect((await backfillMinor()).transactions).toBe(0);
  });
});
