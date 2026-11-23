import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/config", () => ({ config: { logLevel: "silent", stocks: { navMaxAgeSeconds: 86400 } } }));

import {
  detectChanges, runStockAlerts, corporateActionMessage, priceMoveMessage,
  PRICE_MOVE_PCT, PRICE_COOLDOWN_MS, REFERENCE_MAX_AGE_MS, GIVE_UP_AFTER_MS, Undeliverable, type Snapshot, type AlertStore,
} from "@/services/stockAlerts";
import type { StockToken } from "@/services/stocks";

const NOW = new Date("2026-11-23T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const HOUR = 3600_000;
const ONE = 100_000_000n;
const ADDR = "0x" + "1".repeat(40);

const token = (over: Partial<StockToken> = {}): StockToken => ({
  address: ADDR, symbol: "TSLAc", ticker: "TSLA", name: "Tesla, Inc.", decimals: 8, multiplier: 1,
  navPrice: 100, navUpdatedAt: ago(HOUR).toISOString(), isin: null, ...over,
});
const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  tokenAddress: ADDR, multiplier: 1, navPrice: 100, navUpdatedAt: ago(2 * HOUR).toISOString(),
  refPrice: 100, refAt: ago(3 * HOUR), lastMoveAlertAt: null, pendingSince: null, ...over,
});

describe("detectChanges", () => {
  it("the first sight of a token is a baseline and never an alert, however odd it looks", () => {
    const d = detectChanges(null, token({ multiplier: 1.5, navPrice: 9999 }), NOW);
    expect(d.multiplierChange).toBeUndefined();
    expect(d.priceMove).toBeUndefined();
    expect(d.next).toMatchObject({ multiplier: 1.5, refPrice: 9999 });
  });

  describe("corporate actions", () => {
    it("a changed multiplier is reported with before and after", () => {
      expect(detectChanges(snap(), token({ multiplier: 1.0105710788687274 }), NOW).multiplierChange).toEqual({ from: 1, to: 1.0105710788687274 });
    });
    it("an unchanged multiplier is not, and float noise is not a change", () => {
      expect(detectChanges(snap(), token(), NOW).multiplierChange).toBeUndefined();
      expect(detectChanges(snap({ multiplier: 1.0105710788687274 }), token({ multiplier: 1.0105710788687276 }), NOW).multiplierChange).toBeUndefined();
    });
    it("a tiny but real change is reported (a small dividend)", () => {
      expect(detectChanges(snap(), token({ multiplier: 1.0001 }), NOW).multiplierChange).toEqual({ from: 1, to: 1.0001 });
    });
    it("a split (multiplier doubling) is reported", () => {
      expect(detectChanges(snap(), token({ multiplier: 2 }), NOW).multiplierChange).toEqual({ from: 1, to: 2 });
    });
    it("does not need a price at all", () => {
      expect(detectChanges(snap(), token({ multiplier: 2, navPrice: null, navUpdatedAt: null }), NOW).multiplierChange).toBeDefined();
    });
  });

  describe("price moves", () => {
    it("a move of at least the threshold, up or down, on a new fresh price", () => {
      expect(detectChanges(snap(), token({ navPrice: 106 }), NOW).priceMove?.pct).toBeCloseTo(6, 6);
      expect(detectChanges(snap(), token({ navPrice: 93 }), NOW).priceMove?.pct).toBeCloseTo(-7, 6);
    });
    it("exactly at the threshold counts, just under does not", () => {
      expect(detectChanges(snap(), token({ navPrice: 100 + PRICE_MOVE_PCT }), NOW).priceMove).toBeDefined();
      expect(detectChanges(snap(), token({ navPrice: 100 + PRICE_MOVE_PCT - 0.01 }), NOW).priceMove).toBeUndefined();
    });
    it("a stale price is never a move: feeds hold their last value off-hours", () => {
      const stale = token({ navPrice: 130, navUpdatedAt: ago(30 * HOUR).toISOString() });
      expect(detectChanges(snap(), stale, NOW).priceMove).toBeUndefined();
    });
    it("a price with no timestamp, or no price, is not a move", () => {
      expect(detectChanges(snap(), token({ navPrice: 130, navUpdatedAt: null }), NOW).priceMove).toBeUndefined();
      expect(detectChanges(snap(), token({ navPrice: null, navUpdatedAt: null }), NOW).priceMove).toBeUndefined();
    });
    it("the same data point seen again is not a second move", () => {
      const point = ago(HOUR).toISOString();
      expect(detectChanges(snap({ navUpdatedAt: point }), token({ navPrice: 130, navUpdatedAt: point }), NOW).priceMove).toBeUndefined();
    });
    it("after an alert the reference moves to the new price and the cooldown starts", () => {
      const d = detectChanges(snap(), token({ navPrice: 110 }), NOW);
      expect(d.next).toMatchObject({ refPrice: 110, refAt: NOW, lastMoveAlertAt: NOW });
    });
    it("during the cooldown even a big move is held back, and not lost: the reference is unchanged so it can alert later", () => {
      const prev = snap({ lastMoveAlertAt: ago(HOUR) });
      const d = detectChanges(prev, token({ navPrice: 120 }), NOW);
      expect(d.priceMove).toBeUndefined();
      expect(d.next.refPrice).toBe(100);
      expect(detectChanges({ ...prev, lastMoveAlertAt: ago(PRICE_COOLDOWN_MS) }, token({ navPrice: 120 }), NOW).priceMove).toBeDefined();
    });
    it("a slow drift is not a sudden move: the reference rolls forward each day", () => {
      const prev = snap({ refPrice: 100, refAt: ago(REFERENCE_MAX_AGE_MS + HOUR) });
      const d = detectChanges(prev, token({ navPrice: 103 }), NOW); // under the threshold, reference is a day old
      expect(d.priceMove).toBeUndefined();
      expect(d.next).toMatchObject({ refPrice: 103, refAt: NOW });
    });
    it("does not roll the reference forward while it is still young", () => {
      expect(detectChanges(snap({ refAt: ago(2 * HOUR) }), token({ navPrice: 103 }), NOW).next.refPrice).toBe(100);
    });
    it("a token that had no price gets its first reference without alerting", () => {
      const d = detectChanges(snap({ refPrice: null, refAt: null, navPrice: null, navUpdatedAt: null }), token({ navPrice: 100 }), NOW);
      expect(d.priceMove).toBeUndefined();
      expect(d.next).toMatchObject({ refPrice: 100, refAt: NOW });
    });
    it("always records the latest price data, whatever else happens", () => {
      const d = detectChanges(snap(), token({ navPrice: 101, navUpdatedAt: "2026-11-23T11:00:00Z" }), NOW);
      expect(d.next).toMatchObject({ navPrice: 101, navUpdatedAt: "2026-11-23T11:00:00Z" });
    });
  });
});

describe("the messages", () => {
  it("a corporate action explains what changed, in shares, and that nothing needs doing", () => {
    const m = corporateActionMessage(token({ multiplier: 1.0105710788687274 }), { from: 1, to: 1.0105710788687274 }, 2n * ONE);
    expect(m).toContain("Tesla, Inc. (TSLA): your share count changed");
    expect(m).toContain("from 1.0000 to 1.0106");
    expect(m).toContain("about 2.0211 shares (before: 2)");
    expect(m).toContain("You don't need to do anything");
    expect(m).toContain("sell half my TSLA");
    expect(m).toContain("stop stock alerts");
  });

  it("a price move reports the percentage only, with the direction, the holding and how to act or opt out", () => {
    const up = priceMoveMessage(token(), 6.234, ONE * 3n);
    expect(up).toContain("Tesla, Inc. (TSLA) is up 6.2%");
    expect(up).toContain("about 3 shares");
    expect(up).toContain("this isn't advice");
    expect(up).toContain("stop stock alerts");
    expect(up).not.toMatch(/\$\d/); // no absolute price: its units are not confirmed
    expect(priceMoveMessage(token(), -7.5, ONE)).toContain("is down 7.5%");
  });

  it("counts shares through the multiplier", () => {
    expect(priceMoveMessage(token({ multiplier: 1.5 }), 5, ONE * 2n)).toContain("about 3 shares");
  });
});

// --------------------------------------------------------------------------
// running it
// --------------------------------------------------------------------------
function makeWorld() {
  const snapshots = new Map<string, Snapshot>();
  const claims = new Set<string>();
  const optedOut = new Set<string>();
  const sent: Array<{ userId: string; text: string }> = [];
  const failFor = new Set<string>();
  const holdings = new Map<string, Array<{ userId: string; units: bigint }>>();
  const store: AlertStore = {
    getSnapshot: async (a) => snapshots.get(a) ?? null,
    saveSnapshot: async (s) => void snapshots.set(s.tokenAddress, s),
    claim: async (key) => (claims.has(key) ? false : (claims.add(key), true)),
    release: async (key) => void claims.delete(key),
    isOptedOut: async (u) => optedOut.has(u),
  };
  let catalogue: StockToken[] = [token()];
  const deps = (over: Record<string, any> = {}) => ({
    now: NOW,
    stocks: async () => catalogue,
    positions: {
      totals: async () => [...holdings.entries()].map(([tokenAddress, hs]) => ({ tokenAddress, units: hs.reduce((n, h) => n + h.units, 0n) })),
      holders: async (a: string) => holdings.get(a) ?? [],
    },
    store,
    notify: async (userId: string, text: string) => {
      if (failFor.has(userId)) throw new Error("whatsapp down");
      sent.push({ userId, text });
    },
    ...over,
  });
  return { snapshots, claims, optedOut, sent, failFor, holdings, store, deps, setCatalogue: (c: StockToken[]) => (catalogue = c) };
}

let w: ReturnType<typeof makeWorld>;
beforeEach(() => {
  w = makeWorld();
  w.holdings.set(ADDR, [{ userId: "alice", units: 2n * ONE }, { userId: "bob", units: ONE }]);
  w.snapshots.set(ADDR, snap());
});

describe("runStockAlerts", () => {
  it("tells every holder about a corporate action, each with their own share count", async () => {
    w.setCatalogue([token({ multiplier: 1.5 })]);
    const r = await runStockAlerts(w.deps());
    expect(r).toEqual({ checked: 1, sent: 2 });
    expect(w.sent.map((s) => s.userId).sort()).toEqual(["alice", "bob"]);
    expect(w.sent.find((s) => s.userId === "alice")!.text).toContain("about 3 shares (before: 2)");
    expect(w.sent.find((s) => s.userId === "bob")!.text).toContain("about 1.5 shares (before: 1)");
  });

  it("tells holders about a big price move", async () => {
    w.setCatalogue([token({ navPrice: 110 })]);
    expect((await runStockAlerts(w.deps())).sent).toBe(2);
    expect(w.sent[0].text).toContain("is up 10.0%");
  });

  it("running it again straight away tells nobody twice", async () => {
    w.setCatalogue([token({ multiplier: 1.5 })]);
    await runStockAlerts(w.deps());
    await runStockAlerts(w.deps());
    await runStockAlerts(w.deps());
    expect(w.sent).toHaveLength(2);
  });

  it("two passes at the same moment still tell each person once", async () => {
    w.setCatalogue([token({ multiplier: 1.5 })]);
    // Both read the same old snapshot, as two instances would.
    const [a, b] = await Promise.all([runStockAlerts(w.deps()), runStockAlerts(w.deps())]);
    expect(a.sent + b.sent).toBe(2);
    expect(w.sent).toHaveLength(2);
  });

  it("does not message anyone who opted out, and still messages the others", async () => {
    w.optedOut.add("alice");
    w.setCatalogue([token({ multiplier: 1.5 })]);
    await runStockAlerts(w.deps());
    expect(w.sent.map((s) => s.userId)).toEqual(["bob"]);
  });

  it("an opt-out stays an opt-out across later events", async () => {
    w.optedOut.add("alice");
    w.setCatalogue([token({ multiplier: 1.5 })]);
    await runStockAlerts(w.deps());
    w.setCatalogue([token({ multiplier: 2 })]);
    await runStockAlerts(w.deps());
    expect(w.sent.filter((s) => s.userId === "alice")).toEqual([]);
  });

  it("a send that fails is retried on the next pass, and nobody else is told twice", async () => {
    w.failFor.add("alice");
    w.setCatalogue([token({ multiplier: 1.5 })]);
    expect((await runStockAlerts(w.deps())).sent).toBe(1); // bob got it, alice's send failed
    expect(w.sent.map((s) => s.userId)).toEqual(["bob"]);
    w.failFor.clear();
    expect((await runStockAlerts(w.deps({ now: new Date(NOW.getTime() + 60_000) }))).sent).toBe(1); // alice, now
    expect(w.sent.map((s) => s.userId).sort()).toEqual(["alice", "bob"]); // and bob was not told again
    expect(await runStockAlerts(w.deps({ now: new Date(NOW.getTime() + 120_000) }))).toEqual({ checked: 1, sent: 0 });
  });

  it("holds the snapshot back while someone is still waiting to be told, so the change is seen again", async () => {
    w.failFor.add("alice");
    w.setCatalogue([token({ multiplier: 1.5 })]);
    await runStockAlerts(w.deps());
    expect(w.snapshots.get(ADDR)!.multiplier).toBe(1); // not advanced to 1.5
    expect(w.snapshots.get(ADDR)!.pendingSince).toEqual(NOW);
    w.failFor.clear();
    await runStockAlerts(w.deps({ now: new Date(NOW.getTime() + 60_000) }));
    expect(w.snapshots.get(ADDR)!.multiplier).toBe(1.5); // advanced once everyone was told
    expect(w.snapshots.get(ADDR)!.pendingSince).toBeNull();
  });

  it("a price alert that failed once is retried under the same event, not duplicated for the others", async () => {
    w.failFor.add("alice");
    const point = ago(HOUR).toISOString();
    w.setCatalogue([token({ navPrice: 110, navUpdatedAt: point })]);
    await runStockAlerts(w.deps());
    w.failFor.clear();
    await runStockAlerts(w.deps({ now: new Date(NOW.getTime() + 600_000) }));
    expect(w.sent.map((s) => s.userId).sort()).toEqual(["alice", "bob"]);
  });

  it("gives up after six hours, so one persistent failure cannot freeze a token's alerts forever", async () => {
    w.failFor.add("alice");
    w.setCatalogue([token({ multiplier: 1.5 })]);
    await runStockAlerts(w.deps());
    await runStockAlerts(w.deps({ now: new Date(NOW.getTime() + GIVE_UP_AFTER_MS - 1000) }));
    expect(w.snapshots.get(ADDR)!.multiplier).toBe(1); // still holding on
    await runStockAlerts(w.deps({ now: new Date(NOW.getTime() + GIVE_UP_AFTER_MS + 1000) }));
    expect(w.snapshots.get(ADDR)!.multiplier).toBe(1.5); // gave up and moved on
    expect(w.snapshots.get(ADDR)!.pendingSince).toBeNull();
    // ...and a LATER, different event is noticed normally.
    w.failFor.clear();
    w.setCatalogue([token({ multiplier: 2 })]);
    await runStockAlerts(w.deps({ now: new Date(NOW.getTime() + GIVE_UP_AFTER_MS + 60_000) }));
    expect(w.sent.map((s) => s.userId).sort()).toEqual(["alice", "bob", "bob"]);
  });

  it("a person who can never be reached is not retried and does not hold anyone back", async () => {
    w.deps = ((orig) => (over: any = {}) => ({
      ...orig(over),
      notify: async (userId: string, text: string) => {
        if (userId === "alice") throw new Undeliverable();
        w.sent.push({ userId, text });
      },
    }))(w.deps);
    w.setCatalogue([token({ multiplier: 1.5 })]);
    await runStockAlerts(w.deps());
    expect(w.sent.map((s) => s.userId)).toEqual(["bob"]);
    expect(w.snapshots.get(ADDR)!.multiplier).toBe(1.5); // moved on: nothing to wait for
    expect(w.snapshots.get(ADDR)!.pendingSince).toBeNull();
  });

  it("a failure for one person does not stop the rest, or the other tokens", async () => {
    const other = "0x" + "2".repeat(40);
    w.holdings.set(other, [{ userId: "carol", units: ONE }]);
    w.snapshots.set(other, snap({ tokenAddress: other }));
    w.failFor.add("alice");
    w.setCatalogue([token({ multiplier: 1.5 }), token({ address: other, ticker: "NVDA", name: "NVIDIA", multiplier: 2 })]);
    const r = await runStockAlerts(w.deps());
    expect(r.sent).toBe(2); // bob and carol
    expect(w.sent.map((s) => s.userId).sort()).toEqual(["bob", "carol"]);
  });

  it("the first time it sees a token it only records a baseline, and tells nobody", async () => {
    w.snapshots.clear();
    w.setCatalogue([token({ multiplier: 3, navPrice: 5000 })]);
    expect(await runStockAlerts(w.deps())).toEqual({ checked: 1, sent: 0 });
    expect(w.snapshots.get(ADDR)).toMatchObject({ multiplier: 3 });
  });

  it("says nothing when nothing changed, but still keeps the snapshot current", async () => {
    w.setCatalogue([token({ navPrice: 101, navUpdatedAt: "2026-11-23T11:30:00Z" })]);
    expect((await runStockAlerts(w.deps())).sent).toBe(0);
    expect(w.snapshots.get(ADDR)).toMatchObject({ navPrice: 101, navUpdatedAt: "2026-11-23T11:30:00Z" });
  });

  it("only looks at tokens somebody holds, and does not even fetch the catalogue with no holders", async () => {
    w.holdings.clear();
    const stocks = vi.fn(async () => [token()]);
    expect(await runStockAlerts(w.deps({ stocks }))).toEqual({ checked: 0, sent: 0 });
    expect(stocks).not.toHaveBeenCalled();
  });

  it("skips a held token that is no longer listed", async () => {
    w.setCatalogue([]);
    expect(await runStockAlerts(w.deps())).toEqual({ checked: 0, sent: 0 });
    expect(w.sent).toEqual([]);
  });

  it("ignores a token whose holders all sold down to nothing", async () => {
    w.holdings.set(ADDR, [{ userId: "alice", units: 0n }]);
    w.setCatalogue([token({ multiplier: 2 })]);
    expect(await runStockAlerts(w.deps())).toEqual({ checked: 0, sent: 0 });
  });

  it("a price move and a corporate action together are two separate messages", async () => {
    w.setCatalogue([token({ multiplier: 1.5, navPrice: 110 })]);
    await runStockAlerts(w.deps());
    expect(w.sent.filter((s) => s.userId === "alice")).toHaveLength(2);
  });

  it("after a price alert the next small wiggle does not alert again, even though the old reference was far", async () => {
    w.setCatalogue([token({ navPrice: 110, navUpdatedAt: ago(HOUR).toISOString() })]);
    await runStockAlerts(w.deps());
    const first = w.sent.length;
    w.setCatalogue([token({ navPrice: 111, navUpdatedAt: new Date(NOW.getTime() - 60_000).toISOString() })]);
    await runStockAlerts(w.deps({ now: new Date(NOW.getTime() + 60_000) }));
    expect(w.sent.length).toBe(first);
  });
});
