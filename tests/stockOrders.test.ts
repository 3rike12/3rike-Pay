import { describe, it, expect, vi, beforeEach } from "vitest";

const cfg: any = vi.hoisted(() => ({
  logLevel: "silent",
  nearIntents: { fxRates: { USD: 1, KES: 130, NGN: 1500 } },
  stocks: { minOrderUsd: 5, maxOrderUsd: 500, maxSlippageBps: 100, maxPriceImpactBps: 150 },
}));
vi.mock("@/config", () => ({ config: cfg }));

const world = vi.hoisted(() => ({ w: null as any }));
vi.mock("@/services/ledger", async () => {
  const { makeOrderWorld } = await import("./helpers/fakeOrderWorld");
  world.w = makeOrderWorld();
  return { SYSTEM_ACCOUNTS: { external: "external", opening: "opening", fxClearing: "fx_clearing", fees: "fees", stockClearing: "stock_clearing" }, ledger: { debit: (...a: any[]) => world.w.ledger.debit(...a), credit: (...a: any[]) => world.w.ledger.credit(...a) } };
});
vi.mock("@/services/positions", () => ({ positions: { debit: (...a: any[]) => world.w.positions.debit(...a), credit: (...a: any[]) => world.w.positions.credit(...a) } }));
vi.mock("@/db/prisma", () => ({ prisma: { stockOrder: new Proxy({}, { get: (_t, k) => (...a: any[]) => world.w.stockOrder[k as string](...a) }) } }));

const solvency = vi.hoisted(() => ({ assets: 1_000_000, owed: 1000 }));
vi.mock("@/services/treasury", () => ({
  toUsd: (amount: number, currency: string) => amount / ({ USD: 1, KES: 130, NGN: 1500 } as Record<string, number>)[currency],
  fromUsd: (usd: number, currency: string) => usd * ({ USD: 1, KES: 130, NGN: 1500 } as Record<string, number>)[currency],
  onChainBalanceUsd: async () => solvency.assets,
  liabilities: async () => ({ totalUsd: solvency.owed, byCurrency: {} }),
}));

import { placeBuy, placeSell, advanceOrder, reconcileOrder, reconcileStuckOrders, previewBuy, previewSell, indicativePrice, unitsForCash, setOrderListener } from "@/services/stockOrders";
import { setStockVenue } from "@/services/stockVenue";
import type { StockToken } from "@/services/stocks";

const w = world.w;
const TOKEN: StockToken = {
  address: "0xb20000000000000000000016e38fd364d271ba28", symbol: "TSLAc", ticker: "TSLA", name: "Tesla, Inc.",
  decimals: 8, multiplier: 1, navPrice: null, navUpdatedAt: null, isin: null,
};
const ONE = 100_000_000n;
let venue: ReturnType<typeof w.makeVenue>;

const buy = (over: Record<string, any> = {}) => placeBuy({ reference: "buy-1", userId: "u1", token: TOKEN, cashAmount: 13_000, currency: "KES", ...over });
const sell = (over: Record<string, any> = {}) => placeSell({ reference: "sell-1", userId: "u1", token: TOKEN, units: ONE, currency: "KES", ...over });

beforeEach(() => {
  setOrderListener(null);
  w.reset();
  venue = w.makeVenue({ price: 100 }); // $100 per token
  setStockVenue(venue);
  w.setCash("u1", "KES", 100_000);
  solvency.assets = 1_000_000;
  solvency.owed = 1000;
  cfg.stocks = { minOrderUsd: 5, maxOrderUsd: 500, maxSlippageBps: 100, maxPriceImpactBps: 150 };
});

describe("buying", () => {
  it("takes the cash, trades, and credits exactly the units received", async () => {
    const o = await buy(); // KES 13,000 = $100 = 1 token
    expect(o.state).toBe("filled");
    expect(w.cashOf("u1", "KES")).toBe(87_000);
    expect(w.unitsOf("u1", TOKEN.address)).toBe(ONE);
    expect(o.tokenUnits).toBe(ONE);
    expect(o.txHash).toBe("0xfill");
    expect(venue.calls.buy).toBe(1);
  });

  it("debits the cash BEFORE it asks the venue to trade", async () => {
    await buy();
    expect(w.log.indexOf("cash-debit:13000")).toBeLessThan(w.log.indexOf("units-credit:100000000"));
  });

  it("sends the venue a client reference and a price floor from the quote less the allowed slippage", async () => {
    await buy();
    expect(venue.lastBuy.reference).toBe("buy-1");
    expect(venue.lastBuy.usdcUnits).toBe(100_000_000n); // $100 in 6-decimal USDC
    expect(venue.lastBuy.minTokenUnits).toBe((ONE * 9900n) / 10000n); // quote 1 token, 1% slippage
  });

  it("records the rate used and the amounts", async () => {
    const o = await buy();
    expect(o).toMatchObject({ side: "buy", currency: "KES", cashAmount: 13_000, cashAmountMinor: 1_300_000n, usdcUnits: 100_000_000n, venue: "test-venue" });
    expect(o.fx).toMatchObject({ currency: "KES", perUsd: 130, source: "static" });
  });

  it("credits what was actually received when it differs from the quote", async () => {
    venue.buy = async (req: any) => ({ status: "filled", tokenUnits: ONE + 5n, usdcUnits: req.usdcUnits, txHash: "0xbetter" });
    const o = await buy();
    expect(w.unitsOf("u1", TOKEN.address)).toBe(ONE + 5n);
    expect(o.tokenUnits).toBe(ONE + 5n);
  });
});

describe("when the venue refuses", () => {
  it("refunds the cash exactly once and credits no units", async () => {
    venue.script.buy.push("reject");
    const o = await buy();
    expect(o.state).toBe("refunded");
    expect(w.cashOf("u1", "KES")).toBe(100_000);
    expect(w.unitsOf("u1", TOKEN.address)).toBe(0n);
    expect(w.log.filter((l: string) => l === "cash-credit:13000")).toHaveLength(1);
  });

  it("advancing it again does not refund twice", async () => {
    venue.script.buy.push("reject");
    await buy();
    await advanceOrder("buy-1");
    await advanceOrder("buy-1");
    expect(w.cashOf("u1", "KES")).toBe(100_000);
  });
});

describe("when the outcome is unknown", () => {
  it("a venue that times out does NOT refund: the order stays submitted", async () => {
    venue.script.buy.push("timeout");
    const o = await buy();
    expect(o.state).toBe("submitted");
    expect(w.cashOf("u1", "KES")).toBe(87_000); // still held, not refunded
    expect(w.unitsOf("u1", TOKEN.address)).toBe(0n);
  });

  it("a timeout where the trade DID happen is completed from the venue's own record, not refunded", async () => {
    venue.script.buy.push("fill-then-timeout");
    const first = await buy();
    expect(first.state).toBe("submitted");
    const done = await reconcileOrder("buy-1");
    expect(done.state).toBe("filled");
    expect(w.unitsOf("u1", TOKEN.address)).toBe(ONE);
    expect(w.cashOf("u1", "KES")).toBe(87_000);
    expect(venue.calls.buy).toBe(1); // never traded twice
  });

  it("a timeout where the venue never got the order is resubmitted under the same reference", async () => {
    venue.script.buy.push("timeout");
    await buy();
    const done = await reconcileOrder("buy-1");
    expect(done.state).toBe("filled");
    expect(venue.calls.buy).toBe(2);
    expect(venue.lastBuy.reference).toBe("buy-1");
    expect(w.unitsOf("u1", TOKEN.address)).toBe(ONE);
  });

  it("a venue that says it rejected the order is refunded on reconcile", async () => {
    venue.script.buy.push("timeout");
    await buy();
    venue.script.status = { state: "rejected", reason: "slippage" };
    const done = await reconcileOrder("buy-1");
    expect(done.state).toBe("refunded");
    expect(w.cashOf("u1", "KES")).toBe(100_000);
  });

  it("an order still pending at the venue is left alone", async () => {
    venue.script.buy.push("timeout");
    await buy();
    venue.script.status = { state: "pending" };
    expect((await reconcileOrder("buy-1")).state).toBe("submitted");
    expect(w.cashOf("u1", "KES")).toBe(87_000);
  });

  it("if the venue cannot be asked, nothing moves", async () => {
    venue.script.buy.push("timeout");
    await buy();
    venue.script.status = "throw";
    expect((await reconcileOrder("buy-1")).state).toBe("submitted");
    expect(w.cashOf("u1", "KES")).toBe(87_000);
    expect(venue.calls.buy).toBe(1);
  });

  it("reconciles every order stuck long enough, and only those", async () => {
    venue.script.buy.push("fill-then-timeout");
    await buy({ reference: "old" });
    w.orders.get("old").updatedAt = new Date(Date.now() - 3600_000);
    venue.script.buy.push("fill-then-timeout");
    await buy({ reference: "fresh" });
    const n = await reconcileStuckOrders(30 * 60_000);
    expect(n).toBe(1);
    expect(w.orders.get("old").state).toBe("filled");
    expect(w.orders.get("fresh").state).toBe("submitted");
  });
});

describe("crashes: every step can be resumed with no double debit or credit", () => {
  for (const step of ["cash-debit", "state:funded", "state:submitted", "units-credit", "state:filled"]) {
    it(`a crash right after ${step} resumes to a single, complete fill`, async () => {
      w.crash.add(step);
      await buy().catch(() => {});
      // The process restarts and the order is advanced again (a worker, a retry, a user pressing yes twice).
      for (let i = 0; i < 3; i++) await advanceOrder("buy-1").catch(() => {});
      const o = w.orders.get("buy-1");
      expect(o.state, `state after resume from ${step}`).toMatch(/filled|submitted/);
      if (o.state === "submitted") await reconcileOrder("buy-1");
      expect(w.orders.get("buy-1").state).toBe("filled");
      expect(w.cashOf("u1", "KES")).toBe(87_000); // debited once
      expect(w.unitsOf("u1", TOKEN.address)).toBe(ONE); // credited once
      expect(venue.calls.buy).toBeLessThanOrEqual(2);
    });
  }

  it("a crash while refunding resumes to a single refund", async () => {
    venue.script.buy.push("reject");
    w.crash.add("cash-credit");
    await buy().catch(() => {});
    for (let i = 0; i < 3; i++) await advanceOrder("buy-1").catch(() => {});
    await reconcileOrder("buy-1").catch(() => {});
    expect(w.orders.get("buy-1").state).toBe("refunded");
    expect(w.cashOf("u1", "KES")).toBe(100_000);
  });
});

describe("one order, however many times it is sent", () => {
  it("the same reference twice is one order", async () => {
    await buy();
    const again = await buy();
    expect(again.state).toBe("filled");
    expect(w.orders.size).toBe(1);
    expect(w.cashOf("u1", "KES")).toBe(87_000);
    expect(venue.calls.buy).toBe(1);
  });

  it("five simultaneous submissions trade once, take the cash once, credit once", async () => {
    await Promise.allSettled(Array.from({ length: 5 }, () => buy()));
    await advanceOrder("buy-1").catch(() => {});
    expect(w.orders.size).toBe(1);
    expect(w.orders.get("buy-1").state).toBe("filled");
    expect(w.cashOf("u1", "KES")).toBe(87_000);
    expect(w.unitsOf("u1", TOKEN.address)).toBe(ONE);
    expect(venue.calls.buy).toBe(1);
  });

  it("five workers released at the same instant on a funded order submit it to the venue once", async () => {
    w.crash.add("state:funded"); // the order is funded, then the process dies before submitting
    await buy().catch(() => {});
    expect(w.orders.get("buy-1").state).toBe("funded");
    await Promise.all(Array.from({ length: 5 }, () => advanceOrder("buy-1").catch(() => {})));
    expect(venue.calls.buy).toBe(1);
    expect(w.orders.get("buy-1").state).toBe("filled");
    expect(w.unitsOf("u1", TOKEN.address)).toBe(ONE);
    expect(w.cashOf("u1", "KES")).toBe(87_000);
  });

  it("five workers released at the same instant on a created order take the cash once", async () => {
    w.crash.add("cash-debit");
    await buy().catch(() => {});
    expect(w.orders.get("buy-1").state).toBe("created");
    await Promise.all(Array.from({ length: 5 }, () => advanceOrder("buy-1").catch(() => {})));
    expect(w.cashOf("u1", "KES")).toBe(87_000);
    expect(venue.calls.buy).toBe(1);
  });

  it("a reference reused for a different order is refused, not treated as a retry", async () => {
    await buy();
    await expect(buy({ cashAmount: 26_000 })).rejects.toThrow(/reference/i);
    await expect(buy({ userId: "u2" })).rejects.toThrow(/reference/i);
    expect(w.cashOf("u1", "KES")).toBe(87_000);
  });
});

describe("refused before any money moves", () => {
  it("not enough cash: the order fails and nothing is traded", async () => {
    w.setCash("u1", "KES", 100);
    const o = await buy();
    expect(o.state).toBe("failed");
    expect(o.failure).toMatch(/Insufficient/);
    expect(venue.calls.buy).toBe(0);
    expect(w.cashOf("u1", "KES")).toBe(100);
  });

  it("below the minimum and above the maximum order size", async () => {
    await expect(buy({ cashAmount: 130 })).rejects.toThrow(/minimum/i); // $1
    await expect(buy({ reference: "b2", cashAmount: 130 * 600 })).rejects.toThrow(/maximum/i); // $600
    expect(w.orders.size).toBe(0);
    expect(w.cashOf("u1", "KES")).toBe(100_000);
  });

  it("a price impact above the limit", async () => {
    venue.script.impactBps = 400;
    await expect(buy()).rejects.toThrow(/price impact|too large/i);
    expect(w.orders.size).toBe(0);
    expect(w.cashOf("u1", "KES")).toBe(100_000);
  });

  it("when the treasury could not cover its own commitments", async () => {
    solvency.assets = 500; // less than owed (1000)
    await expect(buy()).rejects.toThrow(/temporarily unavailable/i);
    expect(w.orders.size).toBe(0);
  });

  it("when the treasury has less USDC than the order needs", async () => {
    solvency.assets = 50;
    solvency.owed = 10;
    await expect(buy()).rejects.toThrow(/temporarily unavailable/i);
  });

  it("when no venue is configured, with a clear message", async () => {
    setStockVenue(null);
    await expect(buy()).rejects.toThrow(/isn't available yet/i);
    expect(w.orders.size).toBe(0);
  });

  it("a currency with no rate, a zero or non-numeric amount", async () => {
    await expect(buy({ currency: "XYZ" })).rejects.toThrow();
    for (const cashAmount of [0, -5, NaN, Infinity]) await expect(buy({ reference: `x${cashAmount}`, cashAmount })).rejects.toThrow();
    expect(w.orders.size).toBe(0);
  });
});

describe("selling", () => {
  beforeEach(() => {
    w.holdings.set(`u1/${TOKEN.address}`, 3n * ONE);
  });

  it("takes the units first, trades, and credits the cash from the proceeds", async () => {
    const o = await sell({ units: ONE }); // 1 token at $100 = $100 = KES 13,000
    expect(o.state).toBe("filled");
    expect(w.unitsOf("u1", TOKEN.address)).toBe(2n * ONE);
    expect(w.cashOf("u1", "KES")).toBe(113_000);
    expect(w.log.indexOf("units-debit:100000000")).toBeLessThan(w.log.indexOf("cash-credit:13000"));
    expect(o).toMatchObject({ side: "sell", usdcUnits: 100_000_000n, tokenUnits: ONE });
  });

  it("sends the venue a floor on the proceeds", async () => {
    await sell();
    expect(venue.lastSell.minUsdcUnits).toBe((100_000_000n * 9900n) / 10000n);
  });

  it("returns the units, and credits no cash, when the venue refuses", async () => {
    venue.script.buy.push("reject");
    const o = await sell();
    expect(o.state).toBe("refunded");
    expect(w.unitsOf("u1", TOKEN.address)).toBe(3n * ONE);
    expect(w.cashOf("u1", "KES")).toBe(100_000);
  });

  it("does not return the units on an unknown outcome", async () => {
    venue.script.buy.push("timeout");
    const o = await sell();
    expect(o.state).toBe("submitted");
    expect(w.unitsOf("u1", TOKEN.address)).toBe(2n * ONE);
  });

  it("completes a sale that traded before the timeout, from the venue's record", async () => {
    venue.script.buy.push("fill-then-timeout");
    await sell();
    const done = await reconcileOrder("sell-1");
    expect(done.state).toBe("filled");
    expect(w.cashOf("u1", "KES")).toBe(113_000);
    expect(w.unitsOf("u1", TOKEN.address)).toBe(2n * ONE);
  });

  it("refuses to sell what the user does not hold, and trades nothing", async () => {
    const o = await sell({ units: 4n * ONE }); // $400: inside the size limit, but more than the 3 held
    expect(o.state).toBe("failed");
    expect(o.failure).toMatch(/Insufficient/);
    expect(venue.calls.sell).toBe(0);
    expect(w.unitsOf("u1", TOKEN.address)).toBe(3n * ONE);
  });

  it("two sales that together exceed the holding: one trades, the other fails", async () => {
    const [a, b] = await Promise.all([sell({ reference: "s1", units: 2n * ONE }), sell({ reference: "s2", units: 2n * ONE })]);
    expect([a.state, b.state].sort()).toEqual(["failed", "filled"]);
    expect(w.unitsOf("u1", TOKEN.address)).toBe(ONE);
  });

  it("a crash after taking the units resumes to one sale and one credit", async () => {
    w.crash.add("units-debit");
    await sell().catch(() => {});
    for (let i = 0; i < 3; i++) await advanceOrder("sell-1").catch(() => {});
    expect(w.orders.get("sell-1").state).toBe("filled");
    expect(w.unitsOf("u1", TOKEN.address)).toBe(2n * ONE);
    expect(w.cashOf("u1", "KES")).toBe(113_000);
  });

  it("refuses zero or non-bigint units", async () => {
    await expect(sell({ units: 0n })).rejects.toThrow();
    await expect(sell({ reference: "s9", units: 5 as any })).rejects.toThrow(/bigint/i);
  });
});

describe("previewBuy (what the person sees before confirming)", () => {
  it("shows the cost in USD, the shares expected through the multiplier, the floor and the impact", async () => {
    const p = await previewBuy({ token: { ...TOKEN, multiplier: 1.0105710788687274 }, cashAmount: 13_000, currency: "KES" });
    expect(p.usd).toBe(100);
    expect(p.estimatedTokenUnits).toBe(ONE);
    expect(p.estimatedShares).toBeCloseTo(1.0105710788687274, 10);
    expect(p.minTokenUnits).toBe((ONE * 9900n) / 10000n);
    expect(p.priceImpactBps).toBe(10);
  });

  it("refuses with the same limits an order would hit, and moves nothing", async () => {
    await expect(previewBuy({ token: TOKEN, cashAmount: 130, currency: "KES" })).rejects.toThrow(/minimum/i);
    venue.script.impactBps = 400;
    await expect(previewBuy({ token: TOKEN, cashAmount: 13_000, currency: "KES" })).rejects.toThrow(/price impact|too large/i);
    expect(w.cashOf("u1", "KES")).toBe(100_000);
  });
});

describe("previewSell", () => {
  it("shows what the sale should pay in the user's currency, the floor and the impact", async () => {
    const p = await previewSell({ token: TOKEN, units: ONE, currency: "KES" });
    expect(p.estimatedUsdcUnits).toBe(100_000_000n);
    expect(p.estimatedCash).toBe(13_000);
    expect(p.minUsdcUnits).toBe((100_000_000n * 9900n) / 10000n);
    expect(p.priceImpactBps).toBe(10);
  });

  it("rounds the cash DOWN, never up", async () => {
    const p = await previewSell({ token: TOKEN, units: 33_333_333n, currency: "KES" }); // 0.33333333 token = $33.333333 = KES 4333.33329
    expect(p.estimatedCash).toBe(4333.33);
  });

  it("refuses a bad amount, too large a price impact, or too large a sale", async () => {
    await expect(previewSell({ token: TOKEN, units: 0n, currency: "KES" })).rejects.toThrow();
    venue.script.impactBps = 400;
    await expect(previewSell({ token: TOKEN, units: ONE, currency: "KES" })).rejects.toThrow(/too large/i);
    venue.script.impactBps = 10;
    await expect(previewSell({ token: TOKEN, units: 10n * ONE, currency: "KES" })).rejects.toThrow(/maximum/i);
  });
});

describe("indicativePrice", () => {
  it("is the venue's own price per SHARE: price per token divided by the multiplier", async () => {
    expect((await indicativePrice(TOKEN))!.usdPerShare).toBeCloseTo(100, 6);
    expect((await indicativePrice({ ...TOKEN, multiplier: 1.25 }))!.usdPerShare).toBeCloseTo(80, 6); // a token is worth 1.25 shares
  });

  it("is null with no venue, or when the venue cannot be asked", async () => {
    venue.quoteBuy = async () => { throw new Error("down"); };
    expect(await indicativePrice(TOKEN)).toBeNull();
    setStockVenue(null);
    expect(await indicativePrice(TOKEN)).toBeNull();
  });
});

describe("unitsForCash", () => {
  it("converts a cash amount into the token units it would buy", async () => {
    expect(await unitsForCash(TOKEN, 13_000, "KES")).toBe(ONE);
    expect(await unitsForCash(TOKEN, 6_500, "KES")).toBe(ONE / 2n);
  });
  it("is null when it cannot be priced", async () => {
    expect(await unitsForCash(TOKEN, 100, "XYZ")).toBeNull();
    setStockVenue(null);
    expect(await unitsForCash(TOKEN, 13_000, "KES")).toBeNull();
  });
});

describe("telling people how an order ended", () => {
  const seen = () => {
    const calls: Array<{ reference: string; state: string }> = [];
    setOrderListener(async (o) => void calls.push({ reference: o.reference, state: o.state }));
    return calls;
  };

  it("does NOT announce an order that finishes inside the call that placed it: the caller has the result and tells them", async () => {
    const calls = seen();
    await buy();
    venue.script.buy.push("reject");
    await buy({ reference: "buy-2" });
    w.holdings.set(`u1/${TOKEN.address}`, 3n * ONE);
    await sell();
    expect(calls).toEqual([]); // one message each, from the reply, never two
  });

  it("announces a fill that is resolved later, once", async () => {
    const calls = seen();
    venue.script.buy.push("fill-then-timeout");
    await buy();
    expect(calls).toEqual([]); // "being processed": nothing to announce yet
    await reconcileOrder("buy-1");
    expect(calls).toEqual([{ reference: "buy-1", state: "filled" }]);
  });

  it("announces a refund that is resolved later, once", async () => {
    const calls = seen();
    venue.script.buy.push("timeout");
    await buy();
    venue.script.status = { state: "rejected", reason: "slippage" };
    await reconcileOrder("buy-1");
    expect(calls).toEqual([{ reference: "buy-1", state: "refunded" }]);
  });

  it("announces a sale resolved later, and an order resubmitted after the venue never got it", async () => {
    w.holdings.set(`u1/${TOKEN.address}`, 3n * ONE);
    const calls = seen();
    venue.script.buy.push("timeout");
    await sell();
    await reconcileOrder("sell-1"); // venue never received it: resubmitted, fills
    expect(calls).toEqual([{ reference: "sell-1", state: "filled" }]);
  });

  it("never announces the same order twice, however many workers resolve it at once", async () => {
    const calls = seen();
    venue.script.buy.push("fill-then-timeout");
    await buy();
    await Promise.all(Array.from({ length: 5 }, () => reconcileOrder("buy-1")));
    await reconcileOrder("buy-1");
    expect(calls).toHaveLength(1);
  });

  it("does not announce a failure where nothing moved (the caller already told them)", async () => {
    const calls = seen();
    w.setCash("u1", "KES", 10);
    await buy();
    expect(calls).toEqual([]);
  });

  it("a listener that throws does not undo or block the order", async () => {
    setOrderListener(async () => {
      throw new Error("whatsapp down");
    });
    venue.script.buy.push("fill-then-timeout");
    await buy();
    const o = await reconcileOrder("buy-1");
    expect(o.state).toBe("filled");
    expect(w.unitsOf("u1", TOKEN.address)).toBe(ONE);
  });

  it("works with no listener at all", async () => {
    setOrderListener(null);
    venue.script.buy.push("fill-then-timeout");
    await buy();
    expect((await reconcileOrder("buy-1")).state).toBe("filled");
  });
});
