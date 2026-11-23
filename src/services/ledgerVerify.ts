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
 * People's wallets below zero. A negative balance is only ever meant to happen on
 * purpose (a bookkeeping fee booked with allowNegative), so each one deserves a
 * look. System counter-accounts are negative by design (money that came in from
 * outside), so they are not reported here.
 */
export async function findNegativeWallets(): Promise<NegativeWallet[]> {
  const rows = await prisma.wallet.findMany({ where: { balanceMinor: { lt: 0n }, kind: "user" } });
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

// --------------------------------------------
// Double-entry invariants
// --------------------------------------------

export interface UnbalancedJournal {
  journalId: string;
  currency: string;
  creditsMinor: string;
  debitsMinor: string;
}

/** Journals whose entries do not balance in some currency. There should never be one. */
export async function findUnbalancedJournals(): Promise<UnbalancedJournal[]> {
  const rows = await prisma.ledgerEntry.groupBy({ by: ["journalId", "currency", "direction"], where: { journalId: { not: null } }, _sum: { amountMinor: true } } as any);
  const per = new Map<string, { journalId: string; currency: string; credits: bigint; debits: bigint }>();
  for (const r of rows as any[]) {
    const key = `${r.journalId}|${r.currency}`;
    const row = per.get(key) ?? { journalId: r.journalId, currency: r.currency, credits: 0n, debits: 0n };
    const v: bigint = r._sum.amountMinor ?? 0n;
    if (r.direction === "credit") row.credits += v;
    else row.debits += v;
    per.set(key, row);
  }
  return [...per.values()]
    .filter((r) => r.credits !== r.debits)
    .map((r) => ({ journalId: r.journalId, currency: r.currency, creditsMinor: r.credits.toString(), debitsMinor: r.debits.toString() }));
}

export interface ZeroSumBreak {
  currency: string;
  totalMinor: string;
}

/**
 * The one number that proves nothing was created or lost: every account's balance in a
 * currency, added together, must be exactly zero. Returns the currencies where it is not.
 * Only meaningful once any balance from before double-entry has been given its opening
 * journal (see ledgerOpening).
 */
export async function findZeroSumBreaks(): Promise<ZeroSumBreak[]> {
  const rows = await (prisma.wallet as any).groupBy({ by: ["currency"], _sum: { balanceMinor: true } });
  return (rows as any[])
    .map((r) => ({ currency: r.currency as string, total: (r._sum.balanceMinor ?? 0n) as bigint }))
    .filter((r) => r.total !== 0n)
    .map((r) => ({ currency: r.currency, totalMinor: r.total.toString() }));
}

/** Entries written before double-entry existed (no journal). They are explained by an opening journal. */
export async function countLegacyEntries(): Promise<number> {
  return (await prisma.ledgerEntry.findMany({ where: { journalId: null } as any })).length;
}
