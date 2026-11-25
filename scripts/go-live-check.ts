/**
 * Is the real-money path ready? A READ-ONLY check of everything that has to be true before a real top-up becomes a real stock.
 * It moves no money, signs nothing and writes nothing. It never prints a key.
 *
 *   python3 scripts/with-env-file.py .env.prod NEAR_INTENTS_NETWORK=mainnet STOCKS_VENUE=0x -- \
 *     npx ts-node -r tsconfig-paths/register --transpile-only scripts/go-live-check.ts
 *
 * Passing the two overrides shows what the system would do once switched; without them it reports the CURRENT settings.
 * Checks: the settings, the treasury's funds on Base, 1Click on mainnet, and a firm 0x quote for a stock (which also
 * reveals the exact contract addresses the allowlist must contain).
 */
import fs from "fs";
import path from "path";
import { config } from "@/config";
import { nearIntents } from "@/services/nearIntents";

type Status = "ok" | "warn" | "FAIL";
const results: Array<{ status: Status; name: string; detail: string }> = [];
const add = (status: Status, name: string, detail: string) => results.push({ status, name, detail });
const line = (r: (typeof results)[number]) => `${r.status === "ok" ? "  ok  " : r.status === "warn" ? " warn " : " FAIL "} ${r.name.padEnd(34)} ${r.detail}`;

const EVM = /^0x[0-9a-fA-F]{40}$/;
const BASE_USDC = "0x833589fCd6eDb6E08f4c7C32D4f71b54bdA02913";
const FALLBACK_TOKENS = [
  { ticker: "APP", address: "0xb20000000000000000000006f910a0e7bbd3c168", decimals: 8 },
  { ticker: "AMD", address: "0xb2000000000000000000000d8ce462e99ee7a47b", decimals: 8 },
  { ticker: "ANT", address: "0xb20000000000000000000016e38fd364d271ba28", decimals: 8 },
];

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(config.treasury.rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(15_000) });
  const body: any = await res.json();
  if (body.error) throw new Error(body.error.message ?? "rpc error");
  return body.result as T;
}

async function settings() {
  const c: any = config;
  const v = c.stocks?.venue ?? {};
  c.nearIntents.network === "mainnet"
    ? add("ok", "1Click network", "mainnet")
    : add("FAIL", "1Click network", `"${c.nearIntents.network}": top-ups use test tokens, so no real money enters`);
  EVM.test(c.treasury.address) ? add("ok", "Treasury address", `${c.treasury.address.slice(0, 6)}…${c.treasury.address.slice(-4)} (an EVM address)`) : add("FAIL", "Treasury address", "TREASURY_ADDRESS is missing or not an EVM address");
  v.kind === "0x" ? add("ok", "Stock venue", "0x") : add("FAIL", "Stock venue", `STOCKS_VENUE is "${v.kind || "unset"}": real stock orders stay off`);
  v.zeroExApiKey ? add("ok", "0x API key", "set") : add("FAIL", "0x API key", "STOCKS_0X_API_KEY is not set");
  (v.zeroExAllowedTargets?.length ?? 0) > 0 ? add("ok", "0x allowlist", `${v.zeroExAllowedTargets.length} address(es) configured`) : add("FAIL", "0x allowlist", "STOCKS_0X_ALLOWED_TARGETS is empty: the treasury may call or approve nothing");
  c.privy?.enabled ? add("ok", "Privy treasury wallet", "configured") : add("FAIL", "Privy treasury wallet", "PRIVY_* is not configured: nothing can sign a trade");
  add("ok", "Order limits", `$${c.stocks?.minOrderUsd}–$${c.stocks?.maxOrderUsd} per order, price impact cap ${(c.stocks?.maxPriceImpactBps ?? 0) / 100}%`);
}

async function treasuryFunds() {
  const t = config.treasury.address;
  if (!EVM.test(t)) return;
  try {
    const chain = parseInt(await rpc<string>("eth_chainId", []), 16);
    chain === 8453 ? add("ok", "Chain", "Base mainnet (8453)") : add("FAIL", "Chain", `RPC is chain ${chain}, not Base mainnet (8453)`);
    const eth = Number(BigInt(await rpc<string>("eth_getBalance", [t, "latest"]))) / 1e18;
    eth >= 0.0005 ? add("ok", "Treasury gas (ETH)", `${eth.toFixed(5)} ETH`) : add("warn", "Treasury gas (ETH)", `${eth.toFixed(5)} ETH: a trade needs a little ETH on Base for gas (about 0.0005 to start)`);
    const data = "0x70a08231" + t.toLowerCase().replace(/^0x/, "").padStart(64, "0");
    const usdc = Number(BigInt(await rpc<string>("eth_call", [{ to: config.treasury.tokenContract || BASE_USDC, data }, "latest"]))) / 10 ** config.treasury.tokenDecimals;
    usdc >= 20 ? add("ok", "Treasury USDC", `$${usdc.toFixed(2)}`) : add("warn", "Treasury USDC", `$${usdc.toFixed(2)}: stock buys spend the treasury's USDC, so fund a starting float`);
  } catch (error: any) {
    add("FAIL", "Base RPC", `could not read the treasury: ${String(error?.message).slice(0, 100)}`);
  }
}

async function oneClick() {
  const c: any = config;
  try {
    const tokens = await nearIntents.listPayableTokens();
    const onBase = tokens.filter((x) => x.blockchain === "base").map((x) => x.symbol.toUpperCase());
    add("ok", "1Click tokens", `${tokens.length} payable tokens`);
    add(onBase.some((s) => s !== "ETH") ? "ok" : "warn", "What a payer on Base can use", onBase.length ? `${onBase.join(", ")}${onBase.some((s) => s !== "ETH") ? "" : " only: USDC and USDT on Base are not accepted (USDC is the treasury's own asset)"}` : "nothing on Base");
    const def = await nearIntents.resolveDefaultOrigin();
    if (!def) return add("FAIL", "Default payment token", "1Click offers no token to pre-prepare a payment in");
    add("ok", "Default payment token", `${def.symbol} on ${def.blockchain}`);
    const q: any = await nearIntents.requestQuote({ swapType: "EXACT_OUTPUT", amount: "5000000", originAsset: def.assetId, dry: true, deadline: new Date(Date.now() + 10 * 60_000) });
    const amountIn = q?.quote?.amountInFormatted ?? q?.quote?.amountIn;
    add("ok", "1Click dry quote for $5", `a payer would send about ${amountIn} ${def.symbol} on ${def.blockchain} (dry run: no deposit address, nothing created)`);
    c.nearIntents.apiKey ? add("ok", "1Click API key", "set (no extra fee)") : add("warn", "1Click API key", "not set: works, but pays about 0.2% extra per swap");
  } catch (error: any) {
    add("FAIL", "1Click", `${String(error?.message).slice(0, 120)}`);
  }
}

async function catalogue() {
  const c: any = config;
  try {
    const { getStocks } = await import("@/services/stocks");
    const stocks = await getStocks();
    if (stocks.length) {
      add("ok", "Stock catalogue", `${stocks.length} stocks (live from Coinbase)`);
      return stocks.slice(0, 3).map((s) => ({ ticker: s.ticker, address: s.address, decimals: s.decimals }));
    }
  } catch {
    /* fall through */
  }
  const file = path.resolve(process.cwd(), c.stocks?.snapshotPath || "data/stocks.snapshot.json");
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8")).stocks as any[];
    if (saved?.length) {
      add("warn", "Stock catalogue", `Coinbase unreachable from here; using the saved list (${saved.length} stocks)`);
      return saved.slice(0, 3).map((s) => ({ ticker: s.ticker, address: s.address, decimals: s.decimals }));
    }
  } catch {
    /* fall through */
  }
  add("warn", "Stock catalogue", "Coinbase unreachable and no saved list; testing three known tokens instead");
  return FALLBACK_TOKENS;
}

async function zeroEx(tokens: Array<{ ticker: string; address: string; decimals: number }>) {
  const c: any = config;
  const v = c.stocks?.venue ?? {};
  if (!v.zeroExApiKey) return add("FAIL", "0x firm quote", "skipped: no API key");
  if (!EVM.test(c.treasury.address)) return add("FAIL", "0x firm quote", "skipped: no treasury address");
  const found = new Set<string>();
  let ok = 0;
  for (const t of tokens) {
    const params = new URLSearchParams({ chainId: "8453", sellToken: c.treasury.tokenContract || BASE_USDC, buyToken: t.address, sellAmount: "5000000", taker: c.treasury.address, slippageBps: String(c.stocks?.maxSlippageBps ?? 100) });
    try {
      const res = await fetch(`${v.zeroExBaseUrl || "https://api.0x.org"}/swap/allowance-holder/quote?${params}`, { headers: { "0x-api-key": v.zeroExApiKey, "0x-version": "v2" }, signal: AbortSignal.timeout(15_000) });
      const b: any = await res.json().catch(() => ({}));
      if (res.ok && b.buyAmount && b.liquidityAvailable !== false) {
        ok++;
        const tokensOut = Number(b.buyAmount) / 10 ** t.decimals;
        add("ok", `0x firm quote ${t.ticker}`, `$5 buys ${tokensOut.toFixed(6)} tokens (estimated gas ${b.gas ?? "?"})`);
        if (b.transaction?.to) found.add(String(b.transaction.to).toLowerCase());
        if (b.issues?.allowance?.spender) found.add(String(b.issues.allowance.spender).toLowerCase());
      } else {
        add("FAIL", `0x firm quote ${t.ticker}`, String(b.message || b.reason || (b.liquidityAvailable === false ? "no liquidity" : `HTTP ${res.status}`)).slice(0, 140));
      }
    } catch (error: any) {
      add("FAIL", `0x firm quote ${t.ticker}`, String(error?.message).slice(0, 100));
    }
  }
  if (ok === 0) return;
  const configured = new Set((v.zeroExAllowedTargets ?? []).map((a: string) => a.toLowerCase()));
  const missing = [...found].filter((a) => !configured.has(a));
  add("ok", "Contracts a trade touches", [...found].join(", "));
  missing.length === 0
    ? add("ok", "Allowlist covers them", "yes")
    : add("FAIL", "Allowlist covers them", `missing ${missing.join(", ")}: set STOCKS_0X_ALLOWED_TARGETS=${[...new Set([...configured, ...found])].join(",")}`);
}

(async () => {
  console.log("Go-live check (read-only: no money moves, nothing is signed or written)\n");
  await settings();
  await treasuryFunds();
  await oneClick();
  const tokens = await catalogue();
  await zeroEx(tokens ?? FALLBACK_TOKENS);
  results.forEach((r) => console.log(line(r)));
  const fails = results.filter((r) => r.status === "FAIL").length;
  const warns = results.filter((r) => r.status === "warn").length;
  console.log(`\n${fails === 0 ? "READY" : "NOT READY"}: ${fails} blocking, ${warns} to look at.`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => {
  console.log("Check crashed:", e?.message);
  process.exit(2);
});
