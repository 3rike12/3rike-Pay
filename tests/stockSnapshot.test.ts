import { describe, it, expect, vi, beforeEach } from "vitest";

const cfg: any = vi.hoisted(() => ({ logLevel: "silent", stocks: { snapshotPath: "data/stocks.snapshot.json", cacheSeconds: 300 } }));
vi.mock("@/config", () => ({ config: cfg }));

import { getStocks, loadSnapshot, saveSnapshot, resetStockCache, type SnapshotFs } from "@/services/stocks";

const FILE = "/app/data/stocks.snapshot.json";
const tk = (n: number, ticker: string, over: any = {}) => ({
  address: "0x" + n.toString(16).padStart(40, "0"), symbol: `${ticker}c`, ticker, name: `${ticker} Inc`, decimals: 8, multiplier: 1,
  navPrice: 123.45, navUpdatedAt: "2026-11-24T00:00:00Z", isin: null, totalSupply: null, ...over,
});

function fakeFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  let writes = 0;
  const fsx: SnapshotFs = {
    existsSync: ((p: string) => files.has(p)) as any,
    readFileSync: ((p: string) => { if (!files.has(p)) throw new Error("ENOENT"); return files.get(p)!; }) as any,
    writeFileSync: ((p: string, d: string) => { writes++; files.set(p, String(d)); }) as any,
    renameSync: ((a: string, b: string) => { files.set(b, files.get(a)!); files.delete(a); }) as any,
    mkdirSync: (() => undefined) as any,
  };
  return { fsx, files, writes: () => writes };
}

describe("saveSnapshot and loadSnapshot", () => {
  it("saves the list without prices, and loads it back", () => {
    const f = fakeFs();
    expect(saveSnapshot([tk(1, "TSLA"), tk(2, "NVDA")] as any, f.fsx, FILE)).toBe(true);
    const saved = JSON.parse(f.files.get(FILE)!);
    expect(saved.stocks.every((s: any) => s.navPrice === null && s.navUpdatedAt === null)).toBe(true);
    expect(loadSnapshot(f.fsx, FILE).map((s) => s.ticker)).toEqual(["TSLA", "NVDA"]);
  });

  it("writes nothing when the list has not changed, even if only the prices did", () => {
    const f = fakeFs();
    saveSnapshot([tk(1, "TSLA")] as any, f.fsx, FILE);
    expect(saveSnapshot([tk(1, "TSLA", { navPrice: 999 })] as any, f.fsx, FILE)).toBe(false);
    expect(f.writes()).toBe(1);
  });

  it("writes again when a stock appears or a multiplier changes", () => {
    const f = fakeFs();
    saveSnapshot([tk(1, "TSLA")] as any, f.fsx, FILE);
    expect(saveSnapshot([tk(1, "TSLA"), tk(2, "NVDA")] as any, f.fsx, FILE)).toBe(true);
    expect(saveSnapshot([tk(1, "TSLA", { multiplier: 1.004 }), tk(2, "NVDA")] as any, f.fsx, FILE)).toBe(true);
  });

  it("never saves an empty list over a good one", () => {
    const f = fakeFs();
    saveSnapshot([tk(1, "TSLA")] as any, f.fsx, FILE);
    expect(saveSnapshot([], f.fsx, FILE)).toBe(false);
    expect(loadSnapshot(f.fsx, FILE)).toHaveLength(1);
  });

  it("is switched off with no path", () => {
    const f = fakeFs();
    expect(saveSnapshot([tk(1, "TSLA")] as any, f.fsx, null)).toBe(false);
    expect(loadSnapshot(f.fsx, null)).toEqual([]);
  });

  it("an unreadable, corrupt or missing file loads as empty, never an error", () => {
    expect(loadSnapshot(fakeFs().fsx, FILE)).toEqual([]);
    expect(loadSnapshot(fakeFs({ [FILE]: "{not json" }).fsx, FILE)).toEqual([]);
    expect(loadSnapshot(fakeFs({ [FILE]: JSON.stringify({ stocks: "nope" }) }).fsx, FILE)).toEqual([]);
  });

  it("drops a record that is not valid: a bad address, decimals, multiplier or no ticker", () => {
    const good = tk(1, "TSLA");
    const bad = [tk(2, "X", { address: "0xnothex" }), tk(3, "Y", { decimals: -1 }), tk(4, "Z", { multiplier: 0 }), tk(5, "", {}), null];
    const f = fakeFs({ [FILE]: JSON.stringify({ stocks: [good, ...bad] }) });
    expect(loadSnapshot(f.fsx, FILE).map((s) => s.ticker)).toEqual(["TSLA"]);
  });

  it("a failing write is swallowed and reported as not saved", () => {
    const f = fakeFs();
    f.fsx.writeFileSync = (() => { throw new Error("EACCES"); }) as any;
    expect(saveSnapshot([tk(1, "TSLA")] as any, f.fsx, FILE)).toBe(false);
  });
});

describe("getStocks with a saved list", () => {
  beforeEach(() => resetStockCache());

  const record = (t: ReturnType<typeof tk>) => ({
    contract_address: t.address, symbol: t.symbol, name: t.name, decimals: 8, multiplier: 1, nav_price: "1", nav_updated_at: "2026-11-24T00:00:00Z",
  });
  const down = async () => { throw new Error("fetch failed"); };

  it("serves the saved list when the live API is down at startup, instead of failing", async () => {
    const path = require("path").resolve(process.cwd(), "tests/.tmp-snapshot.json");
    const fsReal = require("fs");
    try {
      fsReal.writeFileSync(path, JSON.stringify({ stocks: [tk(1, "TSLA"), tk(2, "NVDA")] }));
      cfg.stocks.snapshotPath = "tests/.tmp-snapshot.json";
      const out = await getStocks(down as any);
      expect(out.map((s) => s.ticker)).toEqual(["TSLA", "NVDA"]);
      expect(out.every((s) => s.navPrice === null)).toBe(true); // no price from disk, so none is trusted
    } finally {
      fsReal.rmSync(path, { force: true });
      cfg.stocks.snapshotPath = "data/stocks.snapshot.json";
    }
  });

  it("with no saved list and the API down, it still fails loudly", async () => {
    cfg.stocks.snapshotPath = "tests/.does-not-exist.json";
    await expect(getStocks(down as any)).rejects.toThrow("fetch failed");
    cfg.stocks.snapshotPath = "data/stocks.snapshot.json";
  });

  it("a live list is used when it works, and the disk is not needed", async () => {
    cfg.stocks.snapshotPath = "";
    const live = async () => ({ ok: true, status: 200, json: async () => ({ tokens: [record(tk(1, "TSLA"))] }) });
    const out = await getStocks(live as any);
    expect(out.map((s) => s.ticker)).toEqual(["TSLA"]);
    cfg.stocks.snapshotPath = "data/stocks.snapshot.json";
  });
});
