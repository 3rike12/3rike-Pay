// Minor-unit (integer money) migration tool.
//   npm run money:minor                 report drift between float and minor balances, change nothing
//   npm run money:minor -- --backfill   fill the minor columns on rows written before dual-writing
//
// Run the backfill, then the report, until it says "no drift". Only then is it
// safe to set MONEY_READS=minor, which reads balances from the integer columns.
import "dotenv/config";
import { prisma } from "@/db/prisma";
import { backfillMinor, findLedgerSumDrift, findTransactionDrift, findWalletDrift } from "@/services/moneyMinor";

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
  if (wallets.length || sums.length || txs.length) {
    console.log("\nDo not switch reads to the minor columns while any of the above remains unexplained.");
    process.exitCode = 1;
  }
  await prisma.$disconnect();
})();
