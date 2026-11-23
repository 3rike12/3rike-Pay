import { config } from "@/config";
import { createLogger } from "@/utils/logger";

const logger = createLogger("stocks");

// ============================================
// Tokenized stock catalogue (Base)
//
// Source: Coinbase's read-only tokenized-stocks API (reference data only: no
// wallet balances, no trading). Rules this module enforces:
//
//  - A token is identified by its ADDRESS, never its ticker or symbol. Symbols
//    are for people; they are matched case-insensitively for lookup only.
//  - One token is not permanently one share. Dividends and splits change a
//    multiplier, so a share count is raw units x multiplier (what `balanceOfUI`
//    returns on chain), never the raw balance alone.
//  - A record we cannot verify (no valid address or decimals) is dropped, not
//    guessed at. If the response shape ever changes the catalogue goes empty and
//    says so loudly, rather than showing wrong data.
//  - A price carries its timestamp. Feeds run 24/5 and hold their last value off
//    hours, so a price is stale when it is older than STOCKS_NAV_MAX_AGE_SECONDS.
//
// Shape, checked against a live response (2026-11-23): `{ tokens: [...],
// next_page_token }`, each token with contract_address, symbol, name, decimals,
// total_supply, isin, adgm_isin, multiplier, first_mint_date, icon_url,
// description, and nav_price + nav_price_updated_at on SOME tokens only (a token
// with no price has none until its feed publishes). Symbols carry a lowercase
// "c" (APPc, AMDc): that is the token's symbol; the company ticker is without it.
// Decimals are 8, not 18, which is why they are always read from the data.
// normalizeStock also accepts a few alternative field names and logs the keys it
// saw when it drops a record, so a future change shows up as an error, not as
// wrong data.
// ============================================

export interface StockToken {
  /** Lower-case 0x address: the identity. */
  address: string;
  /** The token's own symbol as published, e.g. "APPc". */
  symbol: string;
  /** The company ticker people say: the symbol without the trailing "c", e.g. "APP". */
  ticker: string;
  name: string;
  decimals: number;
  /** Shares per token. 1 until a dividend or split changes it. */
  multiplier: number;
  /** Reference price from the API. Whether it is per token or per share is to be confirmed against live data. */
  navPrice: number | null;
  navUpdatedAt: string | null;
  isin: string | null;
  /** Tokens in existence (from the API). Used only as a rough size ranking, never as a price. */
  totalSupply: number | null;
}

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

const pick = (raw: any, keys: string[]) => {
  for (const k of keys) if (raw?.[k] !== undefined && raw?.[k] !== null && raw?.[k] !== "") return raw[k];
  return undefined;
};

/** Multipliers are decimals near 1, but on chain they are WAD (1e18). Accept either. */
export function parseMultiplier(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 1e6 ? n / 1e18 : n;
}

/** "APPc" -> "APP". Only a trailing lowercase "c" after capitals is the token suffix. */
export function tickerOf(symbol: string): string {
  const m = symbol.match(/^([A-Z0-9.\-]+)c$/);
  return m ? m[1] : symbol;
}

export function normalizeStock(raw: any): StockToken | null {
  const address = pick(raw, ["address", "contract_address", "token_address"]);
  const decimals = Number(pick(raw, ["decimals"]));
  if (typeof address !== "string" || !ADDRESS_RE.test(address) || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    logger.warn("Dropped a stock record it could not verify", { keys: raw && typeof raw === "object" ? Object.keys(raw) : typeof raw });
    return null;
  }
  const symbol = String(pick(raw, ["symbol", "ticker"]) ?? "").trim();
  if (!symbol) return null;

  const nav = Number(pick(raw, ["nav_price", "navPrice"]));
  const supply = Number(pick(raw, ["total_supply", "totalSupply"]));
  return {
    address: address.toLowerCase(),
    symbol,
    ticker: tickerOf(symbol),
    name: String(pick(raw, ["name"]) ?? symbol).trim(),
    decimals,
    // No multiplier given means none applied yet: 1.
    multiplier: parseMultiplier(pick(raw, ["multiplier", "ui_multiplier"])) ?? 1,
    navPrice: Number.isFinite(nav) && nav > 0 ? nav : null,
    navUpdatedAt: (pick(raw, ["nav_price_updated_at", "navPriceUpdatedAt"]) as string | undefined) ?? null,
    isin: (pick(raw, ["isin"]) as string | undefined) ?? null,
    totalSupply: Number.isFinite(supply) && supply > 0 ? supply : null,
  };
}

// --------------------------------------------
// Fetching, with a cache that survives the API being down
// --------------------------------------------

type Fetcher = (url: string) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;

const defaultFetch: Fetcher = (url) => fetch(url, { signal: AbortSignal.timeout(15_000) });

let cached: { at: number; stocks: StockToken[] } | null = null;
export function resetStockCache() {
  cached = null;
}

/** Every page of the list, normalised. Throws if the API cannot be read. */
export async function fetchAllStocks(fetcher: Fetcher = defaultFetch): Promise<StockToken[]> {
  const base = (config as any).stocks?.apiUrl ?? "https://api.coinbase.com/v1/tokenized-stocks";
  const out: StockToken[] = [];
  let token: string | undefined;
  for (let page = 0; page < 20; page++) {
    const url = `${base}?page_size=500${token ? `&page_token=${encodeURIComponent(token)}` : ""}`;
    const res = await fetcher(url);
    if (!res.ok) throw new Error(`Stocks API failed (${res.status})`);
    const body = await res.json();
    const records: any[] = Array.isArray(body) ? body : (body?.tokens ?? body?.tokenized_stocks ?? body?.stocks ?? body?.data ?? body?.records ?? []);
    for (const r of records) {
      const s = normalizeStock(r);
      if (s) out.push(s);
    }
    token = body?.next_page_token || undefined;
    if (!token) break;
  }
  if (out.length === 0) logger.error("The stocks API returned no usable records; check the response shape");
  return out;
}

/**
 * The catalogue, cached for STOCKS_CACHE_SECONDS. If a refresh fails the last
 * good list keeps being served; with none at all this throws.
 */
/** A stand-in catalogue for demos. When set, it replaces the live API. */
let catalogueOverride: ((now: number) => StockToken[]) | null = null;
export function setStockCatalogueOverride(fn: ((now: number) => StockToken[]) | null) {
  catalogueOverride = fn;
}

export async function getStocks(fetcher?: Fetcher, now = Date.now()): Promise<StockToken[]> {
  if (catalogueOverride) return catalogueOverride(now);
  const ttl = ((config as any).stocks?.cacheSeconds ?? 300) * 1000;
  if (cached && now - cached.at < ttl) return cached.stocks;
  try {
    const stocks = await fetchAllStocks(fetcher);
    if (stocks.length > 0) cached = { at: now, stocks };
    else if (cached) return cached.stocks;
    return stocks;
  } catch (error: any) {
    if (cached) {
      logger.warn("Stocks API failed; serving the last good list", { error: error?.message });
      return cached.stocks;
    }
    throw error;
  }
}

// --------------------------------------------
// Lookup and display
// --------------------------------------------

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const SUFFIXES = /\b(inc|incorporated|corp|corporation|co|company|plc|ltd|holdings|class [a-z])\b/g;
const simpleName = (s: string) => norm(s).replace(SUFFIXES, "").replace(/\s+/g, " ").trim();

export type Lookup =
  | { kind: "found"; stock: StockToken }
  | { kind: "ambiguous"; matches: StockToken[] }
  | { kind: "none" };

/**
 * Find a stock a person asked for: by address, then ticker, then name ("tesla",
 * "apple inc"). Ambiguity is reported, never resolved by guessing, because the
 * next step may spend money.
 */
export function findStock(stocks: StockToken[], query: string): Lookup {
  const q = norm(query);
  if (!q) return { kind: "none" };
  if (ADDRESS_RE.test(query.trim())) {
    const hit = stocks.find((s) => s.address === query.trim().toLowerCase());
    return hit ? { kind: "found", stock: hit } : { kind: "none" };
  }
  // By the token's symbol ("appc") or the company ticker ("app").
  const bySymbol = stocks.filter((s) => norm(s.symbol) === q || norm(s.ticker) === q);
  if (bySymbol.length === 1) return { kind: "found", stock: bySymbol[0] };
  if (bySymbol.length > 1) return { kind: "ambiguous", matches: bySymbol };

  const exact = stocks.filter((s) => simpleName(s.name) === simpleName(q) || norm(s.name) === q);
  if (exact.length === 1) return { kind: "found", stock: exact[0] };
  if (exact.length > 1) return { kind: "ambiguous", matches: exact };

  // A name that starts with what they typed ("micro" is too loose, "microsoft" is not): whole words only.
  const words = simpleName(q);
  const partial = stocks.filter((s) => {
    const n = ` ${simpleName(s.name)} `;
    return words.length >= 3 && n.includes(` ${words} `);
  });
  if (partial.length === 1) return { kind: "found", stock: partial[0] };
  if (partial.length > 1) return { kind: "ambiguous", matches: partial };
  return { kind: "none" };
}

/** Shares held for a raw on-chain balance: raw units / 10^decimals x multiplier (what balanceOfUI returns). */
export function sharesFor(rawUnits: bigint, stock: Pick<StockToken, "decimals" | "multiplier">): number {
  return (Number(rawUnits) / 10 ** stock.decimals) * stock.multiplier;
}

export function navFreshness(stock: Pick<StockToken, "navUpdatedAt">, now = Date.now()): { fresh: boolean; ageMs: number | null } {
  if (!stock.navUpdatedAt) return { fresh: false, ageMs: null };
  const at = Date.parse(stock.navUpdatedAt);
  if (!Number.isFinite(at)) return { fresh: false, ageMs: null };
  const maxAgeMs = (((config as any).stocks?.navMaxAgeSeconds as number | undefined) ?? 86400) * 1000;
  return { fresh: now - at <= maxAgeMs, ageMs: now - at };
}
