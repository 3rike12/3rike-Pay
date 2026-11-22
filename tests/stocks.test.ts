import { describe, it, expect, vi, beforeEach } from "vitest";

const cfg: any = vi.hoisted(() => ({ logLevel: "silent", stocks: { apiUrl: "https://api.test/v1/tokenized-stocks", cacheSeconds: 300, navMaxAgeSeconds: 86400 } }));
vi.mock("@/config", () => ({ config: cfg }));

import { normalizeStock, parseMultiplier, getStocks, fetchAllStocks, resetStockCache, findStock, sharesFor, navFreshness, type StockToken } from "@/services/stocks";

// FIXTURE: shaped from Coinbase's documentation, not captured from a live response.
// Addresses here are made up and must never be used outside tests.
const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const raw = (over: Record<string, unknown> = {}) => ({
  address: A(1), symbol: "TSLA", name: "Tesla, Inc.", decimals: 18, multiplier: "1.0042",
  nav_price: "412.35", nav_price_updated_at: "2026-11-21T21:00:00Z", isin: "US88160R1014", ...over,
});
const stock = (over: Partial<StockToken> = {}): StockToken => ({ ...normalizeStock(raw())!, ...over });

beforeEach(() => {
  resetStockCache();
  cfg.stocks = { apiUrl: "https://api.test/v1/tokenized-stocks", cacheSeconds: 300, navMaxAgeSeconds: 86400 };
});

describe("normalizeStock", () => {
  it("reads a record, keys it by lower-case address, and upper-cases the symbol", () => {
    expect(normalizeStock(raw({ address: "0xABCDEF0123456789ABCDEF0123456789ABCDEF01", symbol: "tsla" }))).toMatchObject({
      address: "0xabcdef0123456789abcdef0123456789abcdef01", symbol: "TSLA", name: "Tesla, Inc.", decimals: 18, multiplier: 1.0042, navPrice: 412.35, isin: "US88160R1014",
    });
  });

  it("drops what it cannot verify instead of guessing", () => {
    expect(normalizeStock(raw({ address: "0x123" }))).toBeNull(); // not an address
    expect(normalizeStock(raw({ address: undefined }))).toBeNull();
    expect(normalizeStock(raw({ decimals: undefined }))).toBeNull();
    expect(normalizeStock(raw({ decimals: -1 }))).toBeNull();
    expect(normalizeStock(raw({ decimals: 1.5 }))).toBeNull();
    expect(normalizeStock(raw({ symbol: "" }))).toBeNull();
    expect(normalizeStock(null)).toBeNull();
    expect(normalizeStock("nope")).toBeNull();
  });

  it("accepts the common alternative field names", () => {
    expect(normalizeStock({ contract_address: A(2), ticker: "nvda", name: "NVIDIA", decimals: "18" })).toMatchObject({ address: A(2), symbol: "NVDA", decimals: 18 });
  });

  it("treats a missing multiplier as 1 and a missing price as unknown", () => {
    const s = normalizeStock(raw({ multiplier: undefined, nav_price: undefined, nav_price_updated_at: undefined }))!;
    expect(s.multiplier).toBe(1);
    expect(s.navPrice).toBeNull();
    expect(s.navUpdatedAt).toBeNull();
  });

  it("does not trust a nonsense price", () => {
    expect(normalizeStock(raw({ nav_price: "-5" }))!.navPrice).toBeNull();
    expect(normalizeStock(raw({ nav_price: "abc" }))!.navPrice).toBeNull();
    expect(normalizeStock(raw({ nav_price: 0 }))!.navPrice).toBeNull();
  });
});

describe("parseMultiplier", () => {
  it("reads a plain decimal and a WAD value the same way", () => {
    expect(parseMultiplier("1.0042")).toBe(1.0042);
    expect(parseMultiplier(1.5)).toBe(1.5);
    expect(parseMultiplier("1004200000000000000")).toBeCloseTo(1.0042, 10);
    expect(parseMultiplier(2e18)).toBe(2);
  });
  it("rejects zero, negative and junk", () => {
    for (const v of [0, -1, "x", NaN, null, undefined, Infinity]) expect(parseMultiplier(v)).toBeNull();
  });
});

describe("fetching", () => {
  const page = (records: any[], next?: string) => ({ ok: true, status: 200, json: async () => ({ tokenized_stocks: records, ...(next ? { next_page_token: next } : {}) }) });

  it("reads every page until there is no next token", async () => {
    const urls: string[] = [];
    const pages = [page([raw({ address: A(1), symbol: "TSLA" })], "p2"), page([raw({ address: A(2), symbol: "NVDA" })])];
    const out = await fetchAllStocks(async (u) => (urls.push(u), pages.shift()!));
    expect(out.map((s) => s.symbol)).toEqual(["TSLA", "NVDA"]);
    expect(urls[0]).toBe("https://api.test/v1/tokenized-stocks?page_size=500");
    expect(urls[1]).toBe("https://api.test/v1/tokenized-stocks?page_size=500&page_token=p2");
  });

  it("accepts a bare array, and skips records it cannot verify", async () => {
    const out = await fetchAllStocks(async () => ({ ok: true, status: 200, json: async () => [raw(), { address: "bad" }] }));
    expect(out).toHaveLength(1);
  });

  it("fails loudly on an HTTP error", async () => {
    await expect(fetchAllStocks(async () => ({ ok: false, status: 503, json: async () => ({}) }))).rejects.toThrow("503");
  });

  it("caches, then refetches after the TTL", async () => {
    const fetcher = vi.fn(async () => page([raw()]));
    await getStocks(fetcher, 1_000);
    await getStocks(fetcher, 1_000 + 299_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await getStocks(fetcher, 1_000 + 301_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps serving the last good list when the API goes down, and fails only if it never had one", async () => {
    await getStocks(async () => page([raw()]), 0);
    const down = async () => { throw new Error("EAI_AGAIN"); };
    expect((await getStocks(down, 400_000)).map((s) => s.symbol)).toEqual(["TSLA"]);
    resetStockCache();
    await expect(getStocks(down, 0)).rejects.toThrow("EAI_AGAIN");
  });

  it("does not replace a good list with an empty one (a changed response shape)", async () => {
    await getStocks(async () => page([raw()]), 0);
    const out = await getStocks(async () => page([{ nonsense: true }]), 400_000);
    expect(out.map((s) => s.symbol)).toEqual(["TSLA"]);
  });
});

describe("findStock", () => {
  const list = [
    stock({ address: A(1), symbol: "TSLA", name: "Tesla, Inc." }),
    stock({ address: A(2), symbol: "NVDA", name: "NVIDIA Corporation" }),
    stock({ address: A(3), symbol: "AAPL", name: "Apple Inc." }),
    stock({ address: A(4), symbol: "MSFT", name: "Microsoft Corporation" }),
    stock({ address: A(5), symbol: "MSTR", name: "MicroStrategy Incorporated" }),
    stock({ address: A(6), symbol: "GOOGL", name: "Alphabet Inc. Class A" }),
  ];
  const sym = (q: string) => { const r = findStock(list, q); return r.kind === "found" ? r.stock.symbol : r.kind; };

  it("finds by ticker, any case", () => {
    expect(sym("tsla")).toBe("TSLA");
    expect(sym("NVDA")).toBe("NVDA");
  });
  it("finds by company name, with or without the corporate suffix", () => {
    expect(sym("tesla")).toBe("TSLA");
    expect(sym("Apple")).toBe("AAPL");
    expect(sym("apple inc")).toBe("AAPL");
    expect(sym("microsoft")).toBe("MSFT");
    expect(sym("nvidia")).toBe("NVDA");
    expect(sym("alphabet")).toBe("GOOGL");
  });
  it("finds by address, and only an exact one", () => {
    expect(sym(A(3))).toBe("AAPL");
    expect(sym(A(3).toUpperCase().replace("0X", "0x"))).toBe("AAPL");
    expect(sym(A(99))).toBe("none");
  });
  it("does not guess from a fragment", () => {
    expect(sym("micro")).toBe("none"); // could be Microsoft or MicroStrategy: never pick
    expect(sym("te")).toBe("none");
    expect(sym("")).toBe("none");
  });
  it("reports a real ambiguity, never resolves it", () => {
    const dup = [...list, stock({ address: A(7), symbol: "MSFT", name: "Microsoft Corp (other)" })];
    const r = findStock(dup, "msft");
    expect(r.kind).toBe("ambiguous");
  });
  it("says none for something unknown", () => {
    expect(sym("bitcoin")).toBe("none");
  });
});

describe("shares and prices", () => {
  it("counts shares as raw units times the multiplier, not the raw balance", () => {
    const s = { decimals: 18, multiplier: 1.05 };
    expect(sharesFor(2n * 10n ** 18n, s)).toBeCloseTo(2.1, 10);
    expect(sharesFor(0n, s)).toBe(0);
  });
  it("follows the decimals", () => {
    expect(sharesFor(2_500_000n, { decimals: 6, multiplier: 1 })).toBe(2.5);
  });
  it("says a price is fresh, stale, or unknown", () => {
    const now = Date.parse("2026-11-22T12:00:00Z");
    expect(navFreshness({ navUpdatedAt: "2026-11-22T06:00:00Z" }, now)).toEqual({ fresh: true, ageMs: 6 * 3600_000 });
    expect(navFreshness({ navUpdatedAt: "2026-11-20T12:00:00Z" }, now).fresh).toBe(false);
    expect(navFreshness({ navUpdatedAt: null }, now)).toEqual({ fresh: false, ageMs: null });
    expect(navFreshness({ navUpdatedAt: "garbage" }, now).fresh).toBe(false);
  });
});
