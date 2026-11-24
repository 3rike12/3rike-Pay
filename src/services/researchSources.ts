import { createLogger } from "@/utils/logger";

const logger = createLogger("research-sources");

// ============================================
// Research sources: recent news and earnings for a stock
//
// The research assistant cannot know why a price moved unless something tells it.
// This fetches dated, attributed items from a news provider and hands them over as
// quotes. Rules:
//   - It is DATA, never instructions. Text from the internet is cleaned (no links,
//     markup or line breaks), capped in length, and the model is told to treat it as
//     material to quote, not as commands.
//   - Every item carries its source and date, so the answer can say "per Reuters, 21 Nov".
//   - It can never break a research answer: any failure, timeout or odd response gives
//     an empty list, and the assistant simply says it can't see news.
//   - Results are remembered for a few minutes so a busy chat does not hammer the provider.
// ============================================

export interface SourceItem {
  kind: "news" | "earnings";
  ticker: string;
  /** YYYY-MM-DD. */
  date: string;
  /** Who published it ("Reuters"), or the provider for calendar entries. */
  source: string;
  headline: string;
  summary?: string;
}

/** Where a stock's underlying shares trade now, from the provider. Percentages are the useful part. */
export interface Quote {
  ticker: string;
  /** Latest price in USD. */
  price: number;
  /** Change since the previous close, in percent. */
  changePercent: number;
  previousClose: number;
  /** YYYY-MM-DD of the last trade the provider saw. */
  asOf: string;
}

export interface ResearchSource {
  id: string;
  forTicker(ticker: string): Promise<SourceItem[]>;
  /** The current quote, or null when the provider has none for this ticker. */
  quote?(ticker: string): Promise<Quote | null>;
}

const DAY = 24 * 3600_000;
const MAX_NEWS = 4;
const HEADLINE_MAX = 160;
const SUMMARY_MAX = 240;

/** Text from the internet, made safe to put in a prompt and in front of a person. */
export function clean(text: unknown, max: number): string {
  const s = String(text ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/https?:\/\/\S+|www\.\S+/gi, " ")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[`{}[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s.length <= max ? s : s.slice(0, max - 1).replace(/\s+\S*$/, "") + "…";
}

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

type Fetch = (url: string, init?: any) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;

export function createFinnhubSource(cfg: { apiKey: string; baseUrl?: string; fetchImpl?: Fetch; now?: () => number; cacheMs?: number }): ResearchSource {
  const base = (cfg.baseUrl ?? "https://finnhub.io/api/v1").replace(/\/$/, "");
  const doFetch: Fetch = cfg.fetchImpl ?? ((url, init) => fetch(url, init));
  const now = cfg.now ?? Date.now;
  const cacheMs = cfg.cacheMs ?? 15 * 60_000;
  const cache = new Map<string, { at: number; items: SourceItem[] }>();

  async function get(path: string, params: Record<string, string>): Promise<any> {
    const res = await doFetch(`${base}${path}?${new URLSearchParams(params)}`, {
      // The key goes in a header, not the URL, so it never lands in a log line.
      headers: { "X-Finnhub-Token": cfg.apiKey },
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function news(symbol: string, t: number): Promise<SourceItem[]> {
    const body = await get("/company-news", { symbol, from: iso(t - 7 * DAY), to: iso(t) });
    if (!Array.isArray(body)) return [];
    const seen = new Set<string>();
    return body
      .filter((n) => n && typeof n.headline === "string" && Number.isFinite(Number(n.datetime)) && Number(n.datetime) > 0)
      .sort((a, b) => Number(b.datetime) - Number(a.datetime))
      .flatMap((n): SourceItem[] => {
        const headline = clean(n.headline, HEADLINE_MAX);
        const key = headline.toLowerCase();
        const ms = Number(n.datetime) * 1000;
        if (!headline || seen.has(key) || ms > t + DAY) return []; // drop empties, repeats and anything dated in the future
        seen.add(key);
        const summary = clean(n.summary, SUMMARY_MAX);
        return [{ kind: "news", ticker: symbol, date: iso(ms), source: clean(n.source, 40) || "news", headline, ...(summary ? { summary } : {}) }];
      })
      .slice(0, MAX_NEWS);
  }

  async function earnings(symbol: string, t: number): Promise<SourceItem[]> {
    const body = await get("/calendar/earnings", { symbol, from: iso(t - 30 * DAY), to: iso(t + 45 * DAY) });
    const rows: any[] = Array.isArray(body?.earningsCalendar) ? body.earningsCalendar : [];
    return rows
      .filter((r) => typeof r?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.date))
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-2)
      .map((r): SourceItem => {
        const past = r.date <= iso(t);
        const bits: string[] = [];
        if (past && Number.isFinite(Number(r.epsActual)) && r.epsActual !== null) bits.push(`EPS ${r.epsActual}` + (Number.isFinite(Number(r.epsEstimate)) && r.epsEstimate !== null ? ` vs ${r.epsEstimate} expected` : ""));
        return {
          kind: "earnings",
          ticker: symbol,
          date: r.date,
          source: "Finnhub earnings calendar",
          headline: past ? `Reported earnings${bits.length ? ": " + bits.join(", ") : ""}` : "Earnings report scheduled",
        };
      });
  }

  const quotes = new Map<string, { at: number; quote: Quote | null }>();

  return {
    id: "finnhub",
    async quote(rawTicker) {
      const symbol = String(rawTicker || "").toUpperCase().replace(/[^A-Z0-9.]/g, "");
      if (!symbol) return null;
      const t = now();
      const hit = quotes.get(symbol);
      if (hit && t - hit.at < 60_000) return hit.quote;
      const body = await get("/quote", { symbol });
      const price = Number(body?.c);
      const previous = Number(body?.pc);
      const time = Number(body?.t);
      // An unknown symbol comes back as all zeros: that is "no quote", not a price of zero.
      const quote: Quote | null =
        Number.isFinite(price) && price > 0 && Number.isFinite(previous) && previous > 0 && Number.isFinite(time) && time > 0
          ? { ticker: symbol, price, previousClose: previous, changePercent: Math.round(((price - previous) / previous) * 1000) / 10, asOf: iso(time * 1000) }
          : null;
      quotes.set(symbol, { at: t, quote });
      return quote;
    },
    async forTicker(rawTicker) {
      const symbol = String(rawTicker || "").toUpperCase().replace(/[^A-Z0-9.]/g, "");
      if (!symbol) return [];
      const t = now();
      const hit = cache.get(symbol);
      if (hit && t - hit.at < cacheMs) return hit.items;
      // Each part can fail alone: news without earnings is still useful.
      const [n, e] = await Promise.all([news(symbol, t).catch((err) => (logger.warn("News lookup failed", { symbol, error: err?.message }), [])), earnings(symbol, t).catch((err) => (logger.warn("Earnings lookup failed", { symbol, error: err?.message }), []))]);
      const items = [...n, ...e];
      cache.set(symbol, { at: t, items });
      return items;
    },
  };
}

/** Everything for several stocks, in parallel. Never throws; a stock with nothing contributes nothing. */
export async function gatherSources(source: ResearchSource | null, tickers: string[]): Promise<SourceItem[]> {
  if (!source) return [];
  const lists = await Promise.all(tickers.slice(0, 3).map((t) => source.forTicker(t).catch(() => [] as SourceItem[])));
  return lists.flat();
}
