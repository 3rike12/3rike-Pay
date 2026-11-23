import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/config", () => ({ config: { logLevel: "silent", money: { readsFrom: "float" } } }));
vi.mock("@/utils/idempotency", () => ({ acquireLock: async () => ({ release: async () => {} }), withIdempotencyKey: async (_k: string, fn: any) => fn() }));
vi.mock("@/db/prisma", async () => {
  const { makeLedgerDb } = await import("./helpers/fakeLedgerDb");
  const { makePositionDb } = await import("./helpers/fakePositionDb");
  const money = makeLedgerDb();
  const stock = makePositionDb();
  // One database with both ledgers' tables.
  const prisma = {
    wallet: money.wallet, ledgerEntry: money.ledgerEntry, transaction: money.transaction,
    stockPosition: stock.stockPosition, positionEntry: stock.positionEntry,
    // A transaction that can touch both ledgers; either failing rolls back both.
    $transaction: (fn: any) => money.$transaction((m: any) => stock.$transaction((st: any) => fn({ ...m, ...st }))),
  };
  return { __money: money, __stock: stock, prisma };
});
const { __money: money, __stock: stock } = (await import("@/db/prisma")) as any;

import { findNegativeWallets, findPositionProblems } from "@/services/ledgerVerify";
import { ledger } from "@/services/ledger";
import { positions } from "@/services/positions";

const TSLA = "0xb20000000000000000000016e38fd364d271ba28";

beforeEach(() => {
  money.reset();
  stock.reset();
});

describe("findNegativeWallets", () => {
  it("reports nothing when every wallet is at or above zero", async () => {
    await ledger.credit({ userId: "u1", amount: 10, currency: "KES", reference: "c" });
    await ledger.debit({ userId: "u1", amount: 10, currency: "KES", reference: "d" }); // exactly zero is fine
    expect(await findNegativeWallets()).toEqual([]);
  });

  it("finds a wallet that went negative on purpose, so someone looks at it", async () => {
    await ledger.credit({ userId: "u1", amount: 10, currency: "KES", reference: "c" });
    await ledger.debit({ userId: "u1", amount: 25, currency: "KES", reference: "fee", allowNegative: true });
    expect(await findNegativeWallets()).toEqual([expect.objectContaining({ userId: "u1", currency: "KES", balance: -15, balanceMinor: "-1500" })]);
  });
});

describe("findPositionProblems", () => {
  it("reports nothing for positions built through the ledger", async () => {
    await positions.credit({ userId: "u1", tokenAddress: TSLA, units: 500n, reference: "a" });
    await positions.debit({ userId: "u1", tokenAddress: TSLA, units: 200n, reference: "b" });
    await positions.credit({ userId: "u2", tokenAddress: TSLA, units: 7n, reference: "c" });
    expect(await findPositionProblems()).toEqual([]);
  });

  it("catches a position changed outside the ledger, with both numbers", async () => {
    await positions.credit({ userId: "u1", tokenAddress: TSLA, units: 500n, reference: "a" });
    [...stock.positions.values()][0].units = 900n; // tampered
    expect(await findPositionProblems()).toEqual([
      expect.objectContaining({ userId: "u1", problem: "entries_do_not_add_up", units: "900", fromEntries: "500" }),
    ]);
  });

  it("catches a negative position", async () => {
    await positions.credit({ userId: "u1", tokenAddress: TSLA, units: 5n, reference: "a" });
    [...stock.positions.values()][0].units = -3n;
    const problems = await findPositionProblems();
    expect(problems.map((p) => p.problem).sort()).toEqual(["entries_do_not_add_up", "negative"]);
  });

  it("catches a position with no entries at all", async () => {
    stock.positions.set("px", { id: "px", userId: "u9", tokenAddress: TSLA, units: 4n });
    expect(await findPositionProblems()).toEqual([expect.objectContaining({ problem: "entries_do_not_add_up", units: "4", fromEntries: "0" })]);
  });
});
