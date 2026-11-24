/**
 * Fetch every tokenized stock from Coinbase and save the list to disk.
 *
 *   npx ts-node -r tsconfig-paths/register --transpile-only scripts/fetch-stocks.ts
 *
 * Run it on a machine that can reach Coinbase, then commit the file (default
 * data/stocks.snapshot.json). The app uses that copy whenever the live API cannot be reached.
 * Prices are not saved, only what each token is.
 */
import { config } from "@/config";
import { fetchAllStocks, saveSnapshot } from "@/services/stocks";

(async () => {
  if (!(config as any).stocks.snapshotPath) {
    console.log("STOCKS_SNAPSHOT_PATH is empty, so saving is switched off.");
    process.exit(1);
  }
  const stocks = await fetchAllStocks();
  if (stocks.length === 0) {
    console.log("Coinbase returned no usable stocks; nothing was saved.");
    process.exit(1);
  }
  const wrote = saveSnapshot(stocks);
  console.log(`${stocks.length} stocks: ${stocks.map((s) => s.ticker).join(", ")}`);
  console.log(wrote ? `Saved to ${(config as any).stocks.snapshotPath}.` : "Already up to date; the saved list was not changed.");
  process.exit(0);
})().catch((e) => {
  console.log("Failed:", e?.message);
  process.exit(1);
});
