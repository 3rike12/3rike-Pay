// Minor-unit (integer money) migration tool.
//   npm run money:minor                 check the ledgers (drift, negatives, stock positions, token cover); change nothing
//   npm run money:minor -- --backfill   fill the minor columns on rows written before dual-writing
//   npm run money:minor -- --opening    show what the opening-balance step would post (changes nothing)
//   npm run money:minor -- --opening --apply   post it, so balances from before double-entry are explained
//
// Run the backfill, then the report, until it says "no drift". Only then is it
// safe to set MONEY_READS=minor, which reads balances from the integer columns.
import "dotenv/config";
import { prisma } from "@/db/prisma";
import { backfillMinor, findLedgerSumDrift, findTransactionDrift, findWalletDrift } from "@/services/moneyMinor";
import { countLegacyEntries, findNegativeWallets, findPositionProblems, findUnbalancedJournals, findZeroSumBreaks } from "@/services/ledgerVerify";
import { stockSolvency } from "@/services/stockSolvency";
import { gatherTrialBalance } from "@/services/trialBalance";
import { postOpeningBalances } from "@/services/ledgerOpening";

(async () => {
  if (process.argv.includes("--backfill")) {
    const done = await backfillMinor();
    console.log(`Backfilled ${done.wallets} wallet(s), ${done.entries} ledger entr${done.entries === 1 ? "y" : "ies"} and ${done.transactions} transaction(s).`);
  }

  if (process.argv.includes("--opening")) {
    const apply = process.argv.includes("--apply");
    const r = await postOpeningBalances({ apply });
    console.log(`${apply ? "Posted" : "Would post"} opening balances for ${r.wallets} wallet(s). Opening account by currency: ${JSON.stringify(r.byCurrency)}`);
    if (!apply) console.log("Nothing was changed. Add --apply to post them.");
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
  const unbalanced = await findUnbalancedJournals();
  if (unbalanced.length === 0) console.log("Journals: every journal balances.");
  for (const d of unbalanced) console.log(`UNBALANCED journal ${d.journalId} (${d.currency}): credits ${d.creditsMinor}, debits ${d.debitsMinor}`);
  const breaks = await findZeroSumBreaks();
  if (breaks.length === 0) console.log("Books: all accounts add up to exactly zero in every currency.");
  for (const d of breaks) console.log(`BOOKS DO NOT ADD UP in ${d.currency}: total ${d.totalMinor} (should be 0)`);
  const legacy = await countLegacyEntries();
  if (legacy > 0) console.log(`${legacy} entr${legacy === 1 ? "y" : "ies"} predate double-entry; run the opening-balance step to explain them.`);

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

  // The accounting equation across everything: what is held against what is owed, with trades in flight counted.
  let unbalanced = 0;
  try {
    const t = await gatherTrialBalance();
    console.log(`Trial balance: USDC held ${t.usdc.heldUsd ?? "unknown"}, owed ${t.usdc.expectedUsd.toFixed(2)} (cash ${t.usdc.cashOwedUsd.toFixed(2)} + ${t.usdc.inFlightBuyUsd.toFixed(2)} in ${t.inFlightOrders} trade(s) in flight): ${t.usdc.ok ? "balances" : "DOES NOT BALANCE"}${t.usdc.differenceUsd !== null ? ` (difference ${t.usdc.differenceUsd.toFixed(2)})` : ""}`);
    if (!t.usdc.ok) unbalanced++;
    for (const k of t.tokens) {
      if (!k.ok) unbalanced++;
      console.log(`Trial balance: ${k.tokenAddress} held ${k.held ?? "unknown"}, expected ${k.expected} (owned ${k.owed} + ${k.inFlightSell} in flight): ${k.ok ? "balances" : "DOES NOT BALANCE"}`);
    }
  } catch (error: any) {
    unbalanced++;
    console.log(`Trial balance: could not be built (${error?.message}).`);
  }

  if (wallets.length || sums.length || txs.length || negatives.length || positions.length || uncovered || unbalanced) {
    console.log("\nDo not switch reads to the minor columns while any of the above remains unexplained.");
    process.exitCode = 1;
  }
  await prisma.$disconnect();
})();
