import { prisma } from "@/db/prisma";

// ============================================
// Ledger integrity checks
//
// Read-only. They report; they never fix. A balance that does not match its
// entries, or one that has gone negative, is a fact for a person to look at,
// never something to quietly repair.
// ============================================

export interface NegativeWallet {
  walletId: string;
  userId: string;
  currency: string;
  balance: number;
  balanceMinor: string;
}

/**
 * Wallets below zero. A negative balance is only ever meant to happen on
 * purpose (a bookkeeping fee booked with allowNegative), so each one deserves a
 * look.
 */
export async function findNegativeWallets(): Promise<NegativeWallet[]> {
  const rows = await prisma.wallet.findMany({ where: { balanceMinor: { lt: 0n } } });
  return rows.map((w) => ({
    walletId: w.id,
    userId: w.userId,
    currency: w.currency,
    balance: w.balance,
    balanceMinor: w.balanceMinor.toString(),
  }));
}

export interface PositionProblem {
  positionId: string;
  userId: string;
  tokenAddress: string;
  problem: "negative" | "entries_do_not_add_up";
  units: string;
  /** Credits minus debits from the entries. */
  fromEntries?: string;
}

/** Stock positions that are negative, or whose entries do not add up to the holding. */
export async function findPositionProblems(): Promise<PositionProblem[]> {
  const problems: PositionProblem[] = [];

  const sums = await prisma.positionEntry.groupBy({ by: ["positionId", "direction"], _sum: { units: true } });
  const net = new Map<string, bigint>();
  for (const r of sums) {
    const v = r._sum.units ?? 0n;
    net.set(r.positionId, (net.get(r.positionId) ?? 0n) + (r.direction === "credit" ? v : -v));
  }

  const all = await prisma.stockPosition.findMany({});
  for (const p of all) {
    if (p.units < 0n) {
      problems.push({ positionId: p.id, userId: p.userId, tokenAddress: p.tokenAddress, problem: "negative", units: p.units.toString() });
    }
    const fromEntries = net.get(p.id) ?? 0n;
    if (fromEntries !== p.units) {
      problems.push({
        positionId: p.id, userId: p.userId, tokenAddress: p.tokenAddress,
        problem: "entries_do_not_add_up", units: p.units.toString(), fromEntries: fromEntries.toString(),
      });
    }
  }
  return problems;
}
