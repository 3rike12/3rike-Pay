import { prisma } from "@/db/prisma";
import { toMinor } from "@/utils/money";

// ============================================
// Minor-unit migration tools
//
// Phase 1 (done): every ledger write also stores whole minor units.
// Phase 2 (this file): backfill rows written before that, then prove the two
// representations agree. Phase 3 (only after this reports zero drift on real
// data): read balances from the minor columns.
// ============================================

const PAGE = 500;

export interface WalletDrift {
  walletId: string;
  userId: string;
  currency: string;
  balance: number;
  balanceMinor: string;
  expectedMinor: string;
}

/** Wallets whose minor balance disagrees with their float balance. */
export async function findWalletDrift(): Promise<WalletDrift[]> {
  const drift: WalletDrift[] = [];
  let cursor: string | undefined;
  for (;;) {
    const wallets = await prisma.wallet.findMany({
      take: PAGE,
      orderBy: { id: "asc" },
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (wallets.length === 0) break;
    for (const w of wallets) {
      const expected = toMinor(w.balance, w.currency);
      if (w.balanceMinor !== expected) {
        drift.push({
          walletId: w.id,
          userId: w.userId,
          currency: w.currency,
          balance: w.balance,
          balanceMinor: w.balanceMinor.toString(),
          expectedMinor: expected.toString(),
        });
      }
    }
    cursor = wallets[wallets.length - 1].id;
  }
  return drift;
}

export interface LedgerSumDrift {
  walletId: string;
  balanceMinor: string;
  /** Credits minus debits, from the entries. */
  fromEntriesMinor: string;
}

/**
 * Wallets whose entries do not add up to their balance. This is a ledger
 * integrity check, not a migration step: it only means something after the
 * entries are backfilled, and wallets adjusted outside the ledger will show.
 */
export async function findLedgerSumDrift(): Promise<LedgerSumDrift[]> {
  const sums = await prisma.ledgerEntry.groupBy({ by: ["walletId", "direction"], _sum: { amountMinor: true } });
  const net = new Map<string, bigint>();
  for (const row of sums) {
    const amount = row._sum.amountMinor ?? 0n;
    net.set(row.walletId, (net.get(row.walletId) ?? 0n) + (row.direction === "credit" ? amount : -amount));
  }
  const out: LedgerSumDrift[] = [];
  const wallets = await prisma.wallet.findMany({ select: { id: true, balanceMinor: true } });
  for (const w of wallets) {
    const fromEntries = net.get(w.id) ?? 0n;
    if (fromEntries !== w.balanceMinor) {
      out.push({ walletId: w.id, balanceMinor: w.balanceMinor.toString(), fromEntriesMinor: fromEntries.toString() });
    }
  }
  return out;
}

export interface TransactionDrift {
  transactionId: string;
  currency: string;
  amount: number;
  amountMinor: string | null;
  expectedMinor: string;
}

/** Transactions whose minor amount is missing or disagrees with their float amount. */
export async function findTransactionDrift(): Promise<TransactionDrift[]> {
  const drift: TransactionDrift[] = [];
  let cursor: string | undefined;
  for (;;) {
    const rows = await prisma.transaction.findMany({
      take: PAGE,
      orderBy: { id: "asc" },
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (rows.length === 0) break;
    for (const t of rows) {
      const expected = toMinor(t.amount, t.currency);
      if (t.amountMinor !== expected) {
        drift.push({
          transactionId: t.id,
          currency: t.currency,
          amount: t.amount,
          amountMinor: t.amountMinor === null ? null : t.amountMinor.toString(),
          expectedMinor: expected.toString(),
        });
      }
    }
    cursor = rows[rows.length - 1].id;
  }
  return drift;
}

/** Fill the minor columns on rows written before dual-writing. Safe to run repeatedly. */
export async function backfillMinor(): Promise<{ wallets: number; entries: number; transactions: number }> {
  let wallets = 0;
  for (const d of await findWalletDrift()) {
    await prisma.wallet.update({ where: { id: d.walletId }, data: { balanceMinor: BigInt(d.expectedMinor) } });
    wallets++;
  }

  let entries = 0;
  let cursor: string | undefined;
  for (;;) {
    const rows = await prisma.ledgerEntry.findMany({
      take: PAGE,
      orderBy: { id: "asc" },
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (rows.length === 0) break;
    for (const e of rows) {
      const amountMinor = toMinor(e.amount, e.currency);
      const runningBalanceMinor = toMinor(e.runningBalance, e.currency);
      if (e.amountMinor !== amountMinor || e.runningBalanceMinor !== runningBalanceMinor) {
        await prisma.ledgerEntry.update({ where: { id: e.id }, data: { amountMinor, runningBalanceMinor } });
        entries++;
      }
    }
    cursor = rows[rows.length - 1].id;
  }
  let transactions = 0;
  for (const d of await findTransactionDrift()) {
    await prisma.transaction.update({ where: { id: d.transactionId }, data: { amountMinor: BigInt(d.expectedMinor) } });
    transactions++;
  }
  return { wallets, entries, transactions };
}
