// Minor-unit (integer money) migration tool.
//   npm run money:minor                 check the ledgers (drift, negatives, stock positions, token cover); change nothing
//   npm run money:minor -- --backfill   fill the minor columns on rows written before dual-writing
//
// Run the backfill, then the report, until it says "no drift". Only then is it
// safe to set MONEY_READS=minor, which reads balances from the integer columns.
import "dotenv/config";
import { prisma } from "@/db/prisma";
import { backfillMinor, findLedgerSumDrift, findTransactionDrift, findWalletDrift } from "@/services/moneyMinor";
import { findNegativeWallets, findPositionProblems } from "@/services/ledgerVerify";
import { stockSolvency } from "@/services/stockSolvency";

(async () => {
  if (process.argv.includes("--backfill")) {
    const done = await backfillMinor();
    console.log(`Backfilled ${done.wallets} wallet(s), ${done.entries} ledger entr${done.entries === 1 ? "y" : "ies"} and ${done.transactions} transaction(s).`);
  }

  const wallets = await findWalletDrift();
  if (wallets.length === 0) console.log("Wallets: no drift. Every minor balance matches its float balance.");
  for (const d of wallets) {
    console.log(`Wallet ${d.walletId} (${d.currency}, user ${d.userId}): float ${d.balance} -> expected ${d.expectedMinor}, stored ${d.balanceMinor}`);
  }

  const txs = await findTransactionDrift();
  if (txs.length === 0) console.log("Transactions: no drift. Every minor amount matches its float amount.");
  for (const d of txs.slice(0, 50)) {
    console.log(`Transaction ${d.transactionId} (${d.currency}): float ${d.amount} -> expected ${d.expectedMinor}, stored ${d.amountMinor ?? "missing"}`);
  }
  if (txs.length > 50) console.log(`...and ${txs.length - 50} more.`);

  const sums = await findLedgerSumDrift();
  if (sums.length === 0) console.log("Ledger: every wallet's entries add up to its balance.");
  for (const d of sums) {
    console.log(`Ledger ${d.walletId}: entries add up to ${d.fromEntriesMinor}, balance is ${d.balanceMinor}`);
  }
  const negatives = await findNegativeWallets();
  if (negatives.length === 0) console.log("Negative balances: none.");
  for (const d of negatives) console.log(`Negative: wallet ${d.walletId} (${d.currency}, user ${d.userId}) is at ${d.balance}`);

  const positions = await findPositionProblems();
  if (positions.length === 0) console.log("Stock positions: every position matches its entries.");
  for (const d of positions) console.log(`Position ${d.positionId} (user ${d.userId}, ${d.tokenAddress}): ${d.problem}, holds ${d.units}${d.fromEntries !== undefined ? `, entries add up to ${d.fromEntries}` : ""}`);

  // Does the treasury hold the tokens users are recorded as owning? Skipped quietly if there are none.
  let uncovered = 0;
  try {
    for (const c of await stockSolvency()) {
      if (c.covered) continue;
      uncovered++;
      console.log(`NOT COVERED ${c.tokenAddress}: users own ${c.owed}, treasury holds ${c.held === null ? "unknown (could not read the chain)" : c.held}`);
    }
    if (uncovered === 0) console.log("Stock cover: the treasury holds every token users own.");
  } catch (error: any) {
    uncovered++;
    console.log(`Stock cover: could not be checked (${error?.message}).`);
  }

  if (wallets.length || sums.length || txs.length || negatives.length || positions.length || uncovered) {
    console.log("\nDo not switch reads to the minor columns while any of the above remains unexplained.");
    process.exitCode = 1;
  }
  await prisma.$disconnect();
})();
