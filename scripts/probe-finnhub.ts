/**
 * Which Finnhub endpoints does your key's plan allow? Calls each once for NVDA and prints the status and the
 * SHAPE of the answer (field names, counts), never the key.
 *
 *   npx ts-node -r tsconfig-paths/register --transpile-only scripts/probe-finnhub.ts
 */
import { config } from "@/config";

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const unix = (offset: number) => String(Math.floor((Date.now() + offset * 86_400_000) / 1000));

const CALLS: Array<[string, string, Record<string, string>]> = [
  ["quote", "/quote", { symbol: "NVDA" }],
  ["company news", "/company-news", { symbol: "NVDA", from: day(-7), to: day(0) }],
  ["market news", "/news", { category: "general" }],
  ["earnings calendar", "/calendar/earnings", { symbol: "NVDA", from: day(-30), to: day(45) }],
  ["earnings surprises", "/stock/earnings", { symbol: "NVDA" }],
  ["company profile", "/stock/profile2", { symbol: "NVDA" }],
  ["basic financials", "/stock/metric", { symbol: "NVDA", metric: "all" }],
  ["analyst recommendations", "/stock/recommendation", { symbol: "NVDA" }],
  ["price target", "/stock/price-target", { symbol: "NVDA" }],
  ["upgrades/downgrades", "/stock/upgrade-downgrade", { symbol: "NVDA" }],
  ["insider transactions", "/stock/insider-transactions", { symbol: "NVDA" }],
  ["insider sentiment", "/stock/insider-sentiment", { symbol: "NVDA", from: day(-180), to: day(0) }],
  ["news sentiment", "/news-sentiment", { symbol: "NVDA" }],
  ["peers", "/stock/peers", { symbol: "NVDA" }],
  ["price history (candles)", "/stock/candle", { symbol: "NVDA", resolution: "D", from: unix(-30), to: unix(0) }],
  ["market status", "/stock/market-status", { exchange: "US" }],
  ["market holidays", "/stock/market-holiday", { exchange: "US" }],
  ["economic calendar", "/calendar/economic", {}],
  ["IPO calendar", "/calendar/ipo", { from: day(0), to: day(30) }],
  ["social sentiment", "/stock/social-sentiment", { symbol: "NVDA" }],
  ["ETF holdings-style: symbol search", "/search", { q: "nvidia" }],
];

const shape = (v: any): string => {
  if (Array.isArray(v)) return `list of ${v.length}${v[0] && typeof v[0] === "object" ? ` {${Object.keys(v[0]).slice(0, 8).join(", ")}}` : ""}`;
  if (v && typeof v === "object") return `{${Object.keys(v).slice(0, 10).join(", ")}}`;
  return typeof v;
};

(async () => {
  const key = (config as any).research?.newsApiKey;
  if (!key) {
    console.log("STOCKS_NEWS_API_KEY is not set.");
    process.exit(1);
  }
  const base = (config as any).research.newsBaseUrl;
  for (const [label, path, params] of CALLS.slice(Number(process.argv[2] ?? 0))) {
    try {
      const res = await fetch(`${base}${path}?${new URLSearchParams(params)}`, { headers: { "X-Finnhub-Token": key }, signal: AbortSignal.timeout(12_000) });
      const body: any = await res.json().catch(() => null);
      const verdict = res.ok ? "OK    " : res.status === 403 ? "LOCKED" : `HTTP ${res.status}`;
      const detail = res.ok ? shape(body) : String(body?.error ?? "").slice(0, 90);
      console.log(`${verdict} ${label.padEnd(34)} ${detail}`);
    } catch (error: any) {
      console.log(`ERROR  ${label.padEnd(34)} ${String(error?.message).slice(0, 80)}`);
    }
    await new Promise((r) => setTimeout(r, 1100)); // stay well inside the 60 calls a minute limit
  }
  process.exit(0);
})().catch((e) => {
  console.log("Failed:", e?.message);
  process.exit(1);
});
