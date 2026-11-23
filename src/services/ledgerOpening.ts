import { prisma } from "@/db/prisma";
import { createLogger } from "@/utils/logger";
import { fromMinor } from "@/utils/money";

const logger = createLogger("ledger-opening");

// ============================================
// Opening balances
//
// Balances that existed before double-entry have no counter-entry, so the books do
// not add up to zero. This brings them in WITHOUT moving any money: for each wallet
// whose balance is not explained by its journalled entries, it records an opening
// journal. The wallet gets an entry that explains the balance (its balance is left
// exactly as it is), and the system `opening` account takes the opposite side. After
// it runs, every currency adds up to zero and the ledger is fully double-entry.
//
// Safe to run any number of times (each journal has a key, and a wallet already
// explained is skipped), safe on live data (it changes no user balance), and a no-op
// when there is nothing legacy to bring in. It is never run automatically.
// ============================================

export interface OpeningResult {
  wallets: number;
  /** Per currency, what the opening account took on (the negative of the legacy total). */
  byCurrency: Record<string, string>;
}

export async function postOpeningBalances(options: { apply: boolean }): Promise<OpeningResult> {
  const result: OpeningResult = { wallets: 0, byCurrency: {} };
  const p = prisma as any;
  const wallets = (await p.wallet.findMany({})) as any[];

  for (const w of wallets) {
    const entries = (await p.ledgerEntry.findMany({ where: { walletId: w.id, journalId: { not: null } } })) as any[];
    const explained = entries.reduce((n: bigint, e: any) => n + (e.direction === "credit" ? e.amountMinor : -e.amountMinor), 0n);
    const legacy: bigint = BigInt(w.balanceMinor) - explained;
    if (legacy === 0n) continue;

    result.wallets++;
    result.byCurrency[w.currency] = (BigInt(result.byCurrency[w.currency] ?? "0") - legacy).toString();
    if (!options.apply) continue;

    const key = `opening:${w.id}:${legacy}`;
    await p.$transaction(async (tx: any) => {
      if (await tx.journal.findUnique({ where: { idempotencyKey: key } })) return; // already brought in
      const journal = await tx.journal.create({ data: { reference: `opening:${w.id}`, description: "Opening balance", idempotencyKey: key } });
      const amount = legacy < 0n ? -legacy : legacy;
      const decimal = fromMinor(amount, w.currency);
      const direction = legacy > 0n ? "credit" : "debit";
      const opposite = legacy > 0n ? "debit" : "credit";

      // The wallet: an entry that EXPLAINS the existing balance. The balance itself is not touched.
      await tx.ledgerEntry.create({
        data: {
          walletId: w.id, journalId: journal.id, direction, amount: decimal, amountMinor: amount, currency: w.currency,
          runningBalance: w.balance, runningBalanceMinor: w.balanceMinor, reference: `opening:${w.id}`, description: "Opening balance",
          metadata: { type: "opening" },
        },
      });

      // The opposite side, on the system opening account, which does move.
      const opening = await openingWallet(tx, w.currency, w.id);
      const moved = BigInt(opening.balanceMinor) + (opposite === "credit" ? amount : -amount);
      await tx.wallet.update({
        where: { id: opening.id },
        data: { balance: { increment: opposite === "credit" ? decimal : -decimal }, balanceMinor: { increment: opposite === "credit" ? amount : -amount } },
      });
      await tx.ledgerEntry.create({
        data: {
          walletId: opening.id, journalId: journal.id, direction: opposite, amount: decimal, amountMinor: amount, currency: w.currency,
          runningBalance: fromMinor(moved, w.currency), runningBalanceMinor: moved, reference: `opening:${w.id}`, description: "Opening balance",
          metadata: { type: "opening" },
        },
      });
    });
    logger.info("Opening balance recorded", { walletId: w.id, currency: w.currency });
  }
  return result;
}

/** The system wallet that takes the other side of opening balances. */
async function openingWallet(tx: any, currency: string, seed: string) {
  const phone = "system:opening:0";
  let user = await tx.user.findUnique({ where: { phone } });
  if (!user) user = await tx.user.create({ data: { phone, name: phone } });
  let wallet = await tx.wallet.findUnique({ where: { userId_currency: { userId: user.id, currency } } });
  if (!wallet) wallet = await tx.wallet.create({ data: { userId: user.id, currency, balance: 0, balanceMinor: 0n, kind: "system" } });
  void seed;
  return wallet;
}
