/**
 * Read-only check: can 0x price the tokenized stocks on Base?
 *
 *   npx ts-node -r tsconfig-paths/register --transpile-only scripts/zerox-check.ts
 *
 * Moves no money and signs nothing. For each stock it asks 0x what $5 of USDC would buy and
 * prints the answer, or 0x's own reason for refusing. Never prints the API key.
 */
import { config } from "@/config";
import { getStocks } from "@/services/stocks";

const BASE_CHAIN_ID = 8453;
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

(async () => {
  const key = config.stocks.venue.zeroExApiKey;
  if (!key) {
    console.log("STOCKS_0X_API_KEY is not set (or the server has not loaded your .env).");
    process.exit(1);
  }
  const base = config.stocks.venue.zeroExBaseUrl || "https://api.0x.org";
  const usdc = config.treasury.tokenContract || BASE_USDC;
  let stocks: Array<{ ticker: string; address: string; decimals: number }>;
  try {
    stocks = await getStocks();
    console.log(`Catalogue: ${stocks.length} stocks. Pricing $5 of USDC against the first ${Math.min(6, stocks.length)}.\n`);
  } catch (error: any) {
    // Coinbase's catalogue could not be reached from here: use the real tokens saved from an earlier response.
    console.log(`Could not reach the Coinbase catalogue (${error?.message}); using the five real tokens saved in tests.\n`);
    stocks = [
      { ticker: "APP", address: "0xb20000000000000000000006f910a0e7bbd3c168", decimals: 8 },
      { ticker: "AMD", address: "0xb2000000000000000000000d8ce462e99ee7a47b", decimals: 8 },
      { ticker: "ANT", address: "0xb20000000000000000000016e38fd364d271ba28", decimals: 8 },
      { ticker: "BE", address: "0xb20000000000000000000016f9dfe862feba122b", decimals: 8 },
      { ticker: "SAN", address: "0xb20000000000000000000017bb66e9301e913a99", decimals: 8 },
    ];
  }

  for (const s of stocks.slice(0, 6)) {
    const params = new URLSearchParams({
      chainId: String(BASE_CHAIN_ID),
      sellToken: usdc,
      buyToken: s.address,
      sellAmount: String(5_000_000),
    });
    try {
      const res = await fetch(`${base}/swap/allowance-holder/price?${params}`, {
        headers: { "0x-api-key": key, "0x-version": "v2" },
        signal: AbortSignal.timeout(15_000),
      });
      const body: any = await res.json().catch(() => ({}));
      if (res.ok && body.liquidityAvailable !== false && body.buyAmount) {
        const tokens = Number(body.buyAmount) / 10 ** s.decimals;
        console.log(`${s.ticker.padEnd(6)} OK   $5 buys ${tokens.toFixed(6)} tokens (about $${(5 / tokens).toFixed(2)} each)`);
      } else {
        const why = body.message || body.reason || (body.liquidityAvailable === false ? "no liquidity available" : `HTTP ${res.status}`);
        console.log(`${s.ticker.padEnd(6)} NO   ${String(why).slice(0, 200)}`);
      }
    } catch (error: any) {
      console.log(`${s.ticker.padEnd(6)} ERR  ${String(error?.message).slice(0, 200)}`);
    }
  }
  process.exit(0); // imports can leave connections open
})().catch((e) => {
  console.log("Failed:", e?.message);
  process.exit(1);
});
