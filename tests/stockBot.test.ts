import { describe, it, expect, vi, beforeEach } from "vitest";

const cfg: any = vi.hoisted(() => ({ logLevel: "silent", stocks: { blockUs: true } }));
vi.mock("@/config", () => ({ config: cfg }));

import { createStockBot, CONFIRM_TTL_MS, type StockBotDeps } from "@/bot/stocks";
import type { StockToken } from "@/services/stocks";
import { OrderRefused } from "@/services/orderErrors";

const ONE = 100_000_000n;
const tok = (symbol: string, name: string, n: number, multiplier = 1): StockToken => ({
  address: `0x${n.toString(16).padStart(40, "0")}`, symbol: `${symbol}c`, ticker: symbol, name, decimals: 8, multiplier, navPrice: null, navUpdatedAt: null, isin: null,
});
const TSLA = tok("TSLA", "Tesla, Inc.", 1);
const NVDA = tok("NVDA", "NVIDIA Corporation", 2);
const MSFT = tok("MSFT", "Microsoft Corporation", 3);
const MSTR = tok("MSTR", "MicroStrategy Incorporated", 4);
const SAN = tok("SAN", "Banco Santander, S.A.", 5, 1.0105710788687274);
const CATALOGUE = [TSLA, NVDA, MSFT, MSTR, SAN];

const KE = { id: "u1", business: { country: "KE" } };
const PHONE = "254712345678";

let sent: string[];
let session: Record<string, any> | null;
let now: number;
let nextId: number;
let held: Map<string, bigint>;
let balance: number;
let placed: any[];
const last = () => sent[sent.length - 1] ?? "";

function makeBot(over: Partial<StockBotDeps> = {}) {
  const deps: StockBotDeps = {
    send: async (_p, t) => void sent.push(t),
    stocks: async () => CATALOGUE,
    setSession: async (_u, d) => void (session = d),
    resetSession: async () => void (session = null),
    currencyFor: () => "KES",
    money: (a, c) => `${c} ${a.toLocaleString("en-US", { maximumFractionDigits: 2 })}`,
    convert: (a, from, to) => {
      const perUsd: Record<string, number> = { USD: 1, KES: 130, NGN: 1500, TZS: 2600 };
      return (a / perUsd[from]) * perUsd[to];
    },
    balanceOf: async () => balance,
    orders: {
      previewBuy: async ({ cashAmount }) => ({
        usd: cashAmount / 130, usdcUnits: 0n, estimatedTokenUnits: BigInt(Math.round((cashAmount / 130 / 100) * 1e8)),
        estimatedShares: 0, minTokenUnits: BigInt(Math.round((cashAmount / 130 / 100) * 1e8 * 0.99)), priceImpactBps: 10, fx: {} as any,
      }),
      previewSell: async ({ units }) => ({
        estimatedUsdcUnits: 0n, estimatedCash: (Number(units) / 1e8) * 100 * 130, minUsdcUnits: 0n, priceImpactBps: 10, fx: {} as any,
      }),
      placeBuy: async (p) => (placed.push({ kind: "buy", ...p }), { state: "filled", side: "buy", tokenUnits: ONE, cashAmount: p.cashAmount, currency: p.currency } as any),
      placeSell: async (p) => (placed.push({ kind: "sell", ...p }), { state: "filled", side: "sell", tokenUnits: p.units, cashAmount: 13_000, currency: p.currency } as any),
      indicativePrice: async () => ({ usdPerShare: 412.3456 }),
      unitsForCash: async (_t, cash) => BigInt(Math.round((cash / 130 / 100) * 1e8)),
    },
    positions: {
      list: async () => [...held.entries()].filter(([, u]) => u > 0n).map(([tokenAddress, units]) => ({ tokenAddress, units })),
      get: async (_u, t) => held.get(t) ?? 0n,
    },
    schedules: fakeSchedules(),
    rebalance: {
      getTargets: async () => targets,
      setTargets: async (_u, rows) => void (targets = rows),
      clearTargets: async () => void (targets = []),
      plan: async () => (typeof planReply === 'function' ? planReply() : planReply),
    },
    sweep: {
      set: async (_u, percent, tokenAddress) => void sweeps.push({ percent, tokenAddress }),
      clear: async () => sweepsCleared++ >= 0 && sweeps.length > 0,
    },
    alerts: { optOut: async (u) => void optedOut.push(u), optIn: async (u) => void optedIn.push(u) },
    recent: { get: (u) => recentMap.get(u) ?? null, set: (u, a) => void recentMap.set(u, a) },
    market: { quote: async () => (typeof marketReply === "function" ? marketReply() : marketReply) },
    research: { ask: async (p) => (asked.push(p), typeof researchReply === "function" ? researchReply(p) : researchReply) },
    newId: () => `id${++nextId}`,
    now: () => now,
    ...over,
  };
  return createStockBot(deps);
}

let recentMap: Map<string, string>;
let marketReply: any;
let targets: Array<{ tokenAddress: string; percent: number }>;
let planReply: any;
let sweeps: Array<{ percent: number; tokenAddress: string | null }>;
let sweepsCleared: number;
let asked: any[];
let researchReply: any;
let optedOut: string[];
let optedIn: string[];
let created: any[];
let cancelledWith: Array<{ userId: string; tokenAddress?: string }>;
let cancelResult: number;
const DAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const fakeSchedules = (): StockBotDeps["schedules"] => ({
  checkCash: (cash) => {
    if (cash < 650) throw new OrderRefused("The minimum order is about $5.");
  },
  create: async (p) => void created.push(p),
  cancel: async (userId, tokenAddress) => (cancelledWith.push({ userId, tokenAddress }), cancelResult),
  label: (rule) => (rule.frequency === "weekly" ? `every ${DAY[rule.weekday ?? 1]}` : rule.frequency === "daily" ? "every day" : `on the ${rule.dayOfMonth ?? 1}st of every month`),
  firstRun: () => new Date("2026-11-27T08:00:00Z"),
});
let bot = makeBot();

beforeEach(() => {
  sent = [];
  session = null;
  now = 1_000_000;
  nextId = 0;
  held = new Map();
  balance = 100_000;
  placed = [];
  recentMap = new Map();
  marketReply = { price: 188.5, changePercent: 4.7, asOf: "2026-11-25" };
  targets = [];
  planReply = { status: 'no_target' };
  sweeps = [];
  sweepsCleared = 0;
  asked = [];
  researchReply = { kind: "text", text: "Tesla is up 6% recently." };
  optedOut = [];
  optedIn = [];
  created = [];
  cancelledWith = [];
  cancelResult = 1;
  cfg.stocks = { blockUs: true };
  bot = makeBot();
});

describe("messages that are not about stocks", () => {
  it.each(["hello", "balance", "2 waters at 1500", "send 5000 to 0123456789 gtbank", "add money", "/topup 5000", "yes", ""])("%j is left alone", async (text) => {
    expect(await bot.tryHandle(PHONE, KE, text)).toBe(false);
    expect(sent).toEqual([]);
  });
});

describe("who may use it", () => {
  it("tells a US number plainly, and only when they actually asked about stocks", async () => {
    expect(await bot.tryHandle("14155550100", KE, "buy 5000 of tesla")).toBe(true);
    expect(last()).toContain("United States");
    sent = [];
    expect(await bot.tryHandle("14155550100", KE, "hello")).toBe(false);
    expect(sent).toEqual([]);
  });

  it("charges nothing and starts nothing for a US user", async () => {
    await bot.tryHandle("14155550100", KE, "buy 5000 of tesla");
    expect(session).toBeNull();
    expect(placed).toEqual([]);
  });

  it("lets every other country in", async () => {
    for (const phone of ["254712345678", "2348012345678", "447911123456", "919876543210"]) {
      sent = [];
      expect(await bot.tryHandle(phone, { id: "u1" }, "list stocks")).toBe(true);
      expect(last()).toContain("Stocks you can buy");
    }
  });
});

describe("looking", () => {
  it("lists what is available", async () => {
    await bot.tryHandle(PHONE, KE, "what stocks can i buy");
    expect(last()).toContain("TSLA: Tesla, Inc.");
    expect(last()).toContain("NVDA: NVIDIA Corporation");
  });

  it("caps a long list and says how many more", async () => {
    const many = Array.from({ length: 30 }, (_, i) => tok(`T${i}`, `Company ${i}`, 100 + i));
    bot = makeBot({ stocks: async () => many });
    await bot.tryHandle(PHONE, KE, "list stocks");
    expect(last()).toContain("and 10 more");
  });

  it("answers a question with the venue's price per share, to the cent", async () => {
    await bot.tryHandle(PHONE, KE, "how is tesla doing");
    expect(last()).toContain("Tesla, Inc. (TSLA)");
    expect(last()).toContain("$412.35 per share");
  });

  it("says so, rather than inventing a price, when it cannot get one", async () => {
    marketReply = null; // no market quote either
    const b = createStockBot(depsWith({ indicativePrice: async () => null }));
    await b.tryHandle(PHONE, KE, "price of tesla");
    expect(last()).toContain("not available right now");
    expect(last()).not.toMatch(/\$\d/);
  });

  it("explains the multiplier on a token that has one", async () => {
    await bot.tryHandle(PHONE, KE, "price of santander");
    expect(last()).toContain("1 token = 1.0106 shares");
  });

  it("shows holdings as shares, through the multiplier", async () => {
    held.set(TSLA.address, 2n * ONE + ONE / 2n);
    held.set(SAN.address, ONE);
    await bot.tryHandle(PHONE, KE, "my stocks");
    expect(last()).toContain("2.5 shares of Tesla, Inc. (TSLA)");
    expect(last()).toContain("1.0106 shares of Banco Santander, S.A. (SAN)"); // one token is 1.0106 shares
  });

  it("says kindly when there are none", async () => {
    await bot.tryHandle(PHONE, KE, "my portfolio");
    expect(last()).toContain("don't hold any stocks yet");
  });

  it("explains an unknown stock and how to see the list", async () => {
    expect(await bot.tryHandle(PHONE, KE, "buy 5000 of dogecoin")).toBe(true);
    expect(last()).toContain("couldn't find a stock called \"dogecoin\"");
    expect(session).toBeNull();
  });

  it("does not guess from a fragment: 'micro' could be two companies, so it is not understood", async () => {
    await bot.tryHandle(PHONE, KE, "buy 5000 of micro");
    expect(last()).toContain("couldn't find");
    expect(session).toBeNull();
  });

  it("asks which one when a name genuinely matches two, and never picks", async () => {
    const twin = { ...MSFT, address: "0x" + "9".repeat(40), name: "Microsoft Corp B" };
    const b = createStockBot(depsWith({}, [MSFT, twin]));
    await b.tryHandle(PHONE, KE, "buy 5000 of msft");
    expect(last()).toContain("more than one stock");
    expect(last()).toContain("Microsoft Corp B");
    expect(session).toBeNull();
  });
});

describe("buying: nothing is charged until they say yes", () => {
  it("shows the exact cost, what they get, the worst case and the fine print, then waits", async () => {
    await bot.tryHandle(PHONE, KE, "buy 13000 of tesla");
    expect(last()).toContain("Buy Tesla, Inc. (TSLA)");
    expect(last()).toContain("You pay: KES 13,000 (about $100.00)");
    expect(last()).toContain("about 1 shares");
    expect(last()).toContain("At worst: 0.99 shares");
    expect(last()).toContain("onchain certificate that tracks the share");
    expect(last()).toContain("YES");
    expect(placed).toEqual([]); // nothing happened yet
    expect(session).toMatchObject({ kind: "buy", cashAmount: 13_000, currency: "KES" });
  });

  it("understands slang, and amounts in another currency, converting to their balance currency", async () => {
    await bot.tryHandle(PHONE, KE, "buy $100 of nvda");
    expect(last()).toContain("You pay: KES 13,000");
    expect(session).toMatchObject({ cashAmount: 13_000 });
  });

  it("refuses before asking for confirmation when they cannot afford it, and points to top-up", async () => {
    balance = 500;
    await bot.tryHandle(PHONE, KE, "buy 13000 of tesla");
    expect(last()).toContain("You have KES 500");
    expect(last()).toContain("/topup");
    expect(session).toBeNull();
  });

  it("passes on the order service's own refusal (limits, price impact), and asks nothing", async () => {
    bot = makeBot({ orders: { ...depsWith({}).orders, previewBuy: async () => { throw new OrderRefused("The minimum order is about $5."); } } });
    await bot.tryHandle(PHONE, KE, "buy 100 of tesla");
    expect(last()).toBe("The minimum order is about $5.");
    expect(session).toBeNull();
  });

  it("never shows an internal error: a database or network failure becomes a plain sentence", async () => {
    bot = makeBot({ orders: { ...depsWith({}).orders, previewBuy: async () => { throw new Error("P1001: Can't reach database server at db.internal:5432"); } } });
    await bot.tryHandle(PHONE, KE, "buy 13000 of tesla");
    expect(last()).toBe("I couldn't price that right now. Please try again.");
    expect(last()).not.toContain("5432");
    expect(session).toBeNull();
  });

  it("YES places the order once, with a stable reference, and reports it", async () => {
    await bot.tryHandle(PHONE, KE, "buy 13000 of tesla");
    await bot.handleConfirm(PHONE, KE, session!, "yes");
    expect(placed).toHaveLength(1);
    expect(placed[0]).toMatchObject({ kind: "buy", reference: "stk:id1", userId: "u1", cashAmount: 13_000, currency: "KES", token: expect.objectContaining({ ticker: "TSLA" }) });
    expect(last()).toContain("Done. You bought");
    expect(last()).toContain("KES 13,000");
    expect(session).toBeNull();
  });

  it("pressing YES twice is the same order: the reference does not change", async () => {
    await bot.tryHandle(PHONE, KE, "buy 13000 of tesla");
    const data = { ...session! }; // both taps arrive carrying the same confirmation
    await bot.handleConfirm(PHONE, KE, data, "yes");
    await bot.handleConfirm(PHONE, KE, data, "YES");
    expect(new Set(placed.map((p) => p.reference))).toEqual(new Set(["stk:id1"]));
  });

  it.each(["no", "NO", "cancel", "nope", "never mind"])("%s cancels and charges nothing", async (answer) => {
    await bot.tryHandle(PHONE, KE, "buy 13000 of tesla");
    await bot.handleConfirm(PHONE, KE, session!, answer);
    expect(placed).toEqual([]);
    expect(last()).toContain("Nothing was charged");
    expect(session).toBeNull();
  });

  it("an expired quote is not used: they are asked to start again", async () => {
    await bot.tryHandle(PHONE, KE, "buy 13000 of tesla");
    now += CONFIRM_TTL_MS + 1;
    await bot.handleConfirm(PHONE, KE, session!, "yes");
    expect(placed).toEqual([]);
    expect(last()).toContain("expired");
  });

  it("a quote is still good at the last moment", async () => {
    await bot.tryHandle(PHONE, KE, "buy 13000 of tesla");
    now += CONFIRM_TTL_MS;
    await bot.handleConfirm(PHONE, KE, session!, "yes");
    expect(placed).toHaveLength(1);
  });

  it("something unrelated just nudges, and keeps the order waiting", async () => {
    await bot.tryHandle(PHONE, KE, "buy 13000 of tesla");
    const waiting = session;
    await bot.handleConfirm(PHONE, KE, session!, "hmm what");
    expect(last()).toContain("Reply *YES*");
    expect(placed).toEqual([]);
    expect(session).toEqual(waiting);
  });

  it("a different stock request replaces the waiting one", async () => {
    await bot.tryHandle(PHONE, KE, "buy 13000 of tesla");
    await bot.handleConfirm(PHONE, KE, session!, "buy 6500 of nvda");
    expect(last()).toContain("Buy NVIDIA Corporation (NVDA)");
    expect(session).toMatchObject({ cashAmount: 6_500, token: expect.objectContaining({ ticker: "NVDA" }) });
    expect(placed).toEqual([]);
  });

  it("a confirmation with nothing behind it says so", async () => {
    await bot.handleConfirm(PHONE, KE, {}, "yes");
    expect(last()).toContain("nothing waiting");
    expect(placed).toEqual([]);
  });

  it("reports a refused order, an unknown outcome and a failure each in plain words", async () => {
    const outcomes: Array<[any, RegExp]> = [
      [{ state: "refunded", side: "buy", cashAmount: 13_000, currency: "KES" }, /returned to your balance/],
      [{ state: "submitted", side: "buy", cashAmount: 13_000, currency: "KES" }, /being processed/],
      [{ state: "failed", side: "buy", cashAmount: 13_000, currency: "KES", failure: "Insufficient balance" }, /nothing was charged/],
    ];
    for (const [order, expected] of outcomes) {
      sent = [];
      const b = createStockBot(depsWith({}, undefined, { placeBuy: async () => order }));
      await b.tryHandle(PHONE, KE, "buy 13000 of tesla");
      await b.handleConfirm(PHONE, KE, session!, "yes");
      expect(last()).toMatch(expected);
    }
  });

  it("a deliberate refusal placing the order is shown as written", async () => {
    const b = createStockBot(depsWith({}, undefined, { placeBuy: async () => { throw new OrderRefused("Stocks are temporarily unavailable."); } }));
    await b.tryHandle(PHONE, KE, "buy 13000 of tesla");
    await b.handleConfirm(PHONE, KE, session!, "yes");
    expect(last()).toBe("Stocks are temporarily unavailable.");
  });

  it("an unexpected error placing the order is honest: money may have moved, and it will be resolved", async () => {
    const b = createStockBot(depsWith({}, undefined, { placeBuy: async () => { throw new Error("connect ECONNRESET 10.0.0.5:5432"); } }));
    await b.tryHandle(PHONE, KE, "buy 13000 of tesla");
    await b.handleConfirm(PHONE, KE, session!, "yes");
    expect(last()).toContain("If you were charged, the order will finish or be refunded automatically");
    expect(last()).not.toContain("ECONNRESET");
    expect(last()).not.toContain("Nothing was charged"); // it might have been
  });

  it("when the catalogue cannot be loaded, says so and starts nothing", async () => {
    bot = makeBot({ stocks: async () => { throw new Error("EAI_AGAIN"); } });
    expect(await bot.tryHandle(PHONE, KE, "buy 13000 of tesla")).toBe(true);
    expect(last()).toContain("aren't available right now");
    expect(session).toBeNull();
  });
});

describe("selling", () => {
  beforeEach(() => {
    held.set(TSLA.address, 3n * ONE);
  });

  it("sells half, exactly", async () => {
    await bot.tryHandle(PHONE, KE, "sell half my tesla");
    expect(session).toMatchObject({ kind: "sell", units: (3n * ONE / 2n).toString() });
    expect(last()).toContain("You sell: about 1.5 shares");
  });

  it("sells all, exactly the holding", async () => {
    await bot.tryHandle(PHONE, KE, "sell all my tsla");
    expect(session).toMatchObject({ units: (3n * ONE).toString() });
  });

  it("sells a quarter without losing a unit to rounding", async () => {
    held.set(TSLA.address, 1_000_000_003n);
    await bot.tryHandle(PHONE, KE, "sell a quarter of tsla");
    expect(BigInt(session!.units)).toBe((1_000_000_003n * 2500n) / 10000n);
  });

  it("sells an amount of cash worth, and shows what it pays and the worst case", async () => {
    await bot.tryHandle(PHONE, KE, "sell 13000 of tesla"); // about one token
    expect(session).toMatchObject({ kind: "sell", units: ONE.toString() });
    expect(last()).toContain("You get: about KES 13,000");
    expect(last()).toContain("At worst: about KES 12,870");
  });

  it("an amount larger than the holding sells everything, and says so", async () => {
    await bot.tryHandle(PHONE, KE, "sell 99999 of tesla");
    expect(session).toMatchObject({ units: (3n * ONE).toString() });
    expect(last()).toContain("sells all of it");
  });

  it("asks how much when they did not say", async () => {
    await bot.tryHandle(PHONE, KE, "sell my tesla");
    expect(last()).toContain("How much TSLA");
    expect(session).toBeNull();
  });

  it("will not sell what they do not hold", async () => {
    await bot.tryHandle(PHONE, KE, "sell half my nvda");
    expect(last()).toContain("don't hold any NVDA");
    expect(session).toBeNull();
  });

  it("YES sells the exact units that were shown", async () => {
    await bot.tryHandle(PHONE, KE, "sell half my tesla");
    await bot.handleConfirm(PHONE, KE, session!, "yes");
    expect(placed).toHaveLength(1);
    expect(placed[0]).toMatchObject({ kind: "sell", reference: "stk:id1", units: 3n * ONE / 2n, userId: "u1" });
    expect(typeof placed[0].units).toBe("bigint");
    expect(last()).toContain("Done. You sold");
  });
});

describe("commands", () => {
  it("/stocks explains how to use stocks, /stock X quotes, /portfolio shows holdings, and 'list stocks' lists", async () => {
    expect(await bot.handleCommand(PHONE, KE, "stocks", "")).toBe(true);
    expect(last()).toContain("confirm before anything is bought");
    await bot.tryHandle(PHONE, KE, "list stocks");
    expect(last()).toContain("Stocks you can buy");
    expect(await bot.handleCommand(PHONE, KE, "stock", "nvda")).toBe(true);
    expect(last()).toContain("NVIDIA Corporation (NVDA)");
    expect(await bot.handleCommand(PHONE, KE, "portfolio", "")).toBe(true);
    expect(last()).toContain("don't hold any stocks yet");
  });

  it("/stock with nothing after it lists", async () => {
    await bot.handleCommand(PHONE, KE, "stock", "");
    expect(last()).toContain("Stocks you can buy");
  });
});

describe("the research assistant", () => {
  it("passes the question and the named stocks to the assistant and sends back its answer", async () => {
    expect(await bot.tryHandle(PHONE, KE, "why is tesla down")).toBe(true);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ userId: "u1", question: "why is tesla down", budget: undefined });
    expect(asked[0].stocks.map((s: StockToken) => s.ticker)).toEqual(["TSLA"]);
    expect(last()).toBe("Tesla is up 6% recently.");
  });

  it("compares several stocks", async () => {
    await bot.tryHandle(PHONE, KE, "compare tesla and nvidia");
    expect(asked[0].stocks.map((s: StockToken) => s.ticker)).toEqual(["TSLA", "NVDA"]);
  });

  it("with no stock named, uses what the person holds, up to three", async () => {
    held.set(TSLA.address, ONE);
    held.set(NVDA.address, ONE);
    await bot.tryHandle(PHONE, KE, "should i sell");
    expect(asked[0].stocks.map((s: StockToken) => s.ticker).sort()).toEqual(["NVDA", "TSLA"]);
  });

  it("with no stock named and nothing held, asks which stock, and does not call the assistant", async () => {
    await bot.tryHandle(PHONE, KE, "should i sell");
    expect(asked).toEqual([]);
    expect(last()).toContain("Which stock do you mean?");
  });

  it("does not guess an unknown stock, and does not call the assistant", async () => {
    await bot.tryHandle(PHONE, KE, "why is dogecoin down");
    expect(asked).toEqual([]);
    expect(last()).toContain("couldn't find a stock called");
  });

  it("a plan passes the budget in the person's own currency, with up to five stocks to choose from", async () => {
    await bot.tryHandle(PHONE, KE, "I have 5000 a week, what should I buy");
    expect(asked[0].budget).toEqual({ amount: 5000, currency: "KES", frequency: "weekly" });
    expect(asked[0].stocks).toHaveLength(5);
  });

  it("converts a budget named in another currency", async () => {
    await bot.tryHandle(PHONE, KE, "I have $100 a month to put in stocks, what should I buy");
    expect(asked[0].budget).toMatchObject({ amount: 13_000, currency: "KES", frequency: "monthly" });
  });

  it("a plan with no amount asks for one", async () => {
    await bot.tryHandle(PHONE, KE, "what should i buy");
    expect(asked).toEqual([]);
    expect(last()).toContain("How much can you put in");
  });

  it("says kindly when the assistant is off, and when the person has used their allowance", async () => {
    researchReply = { kind: "off" };
    await bot.tryHandle(PHONE, KE, "why is tesla down");
    expect(last()).toBe("The research assistant isn't available yet.");
    researchReply = { kind: "limit" };
    await bot.tryHandle(PHONE, KE, "why is tesla down");
    expect(last()).toContain("try again tomorrow");
  });

  it("never shows an internal error, and says nothing was changed", async () => {
    researchReply = () => { throw new Error("P1001 can't reach db.internal:5432"); };
    await bot.tryHandle(PHONE, KE, "why is tesla down");
    expect(last()).toBe("I couldn't answer that just now. Please try again in a moment.");
    expect(last()).not.toContain("5432");
    expect(placed).toEqual([]);
    expect(session).toBeNull();
  });

  it("a question never creates an order or a confirmation: it only answers", async () => {
    researchReply = { kind: "text", text: "Here is one idea.\n• *buy 2500 of TSLA every friday*" };
    await bot.tryHandle(PHONE, KE, "I have 5000 a week, what should I buy");
    expect(placed).toEqual([]);
    expect(created).toEqual([]);
    expect(session).toBeNull();
  });

  it("a US number is refused before the assistant is ever asked", async () => {
    await bot.tryHandle("14155550100", KE, "why is tesla down");
    expect(asked).toEqual([]);
    expect(last()).toContain("United States");
  });

  it("an ordinary buy is not sent to the assistant", async () => {
    await bot.tryHandle(PHONE, KE, "buy 13000 of tesla");
    expect(asked).toEqual([]);
  });
});

describe("stock alerts on and off", () => {
  it("turns them off, says so, and how to turn them back on", async () => {
    expect(await bot.tryHandle(PHONE, KE, "stop stock alerts")).toBe(true);
    expect(optedOut).toEqual(["u1"]);
    expect(last()).toContain("won't send you stock alerts");
    expect(last()).toContain("turn on stock alerts");
  });

  it("turns them back on", async () => {
    await bot.tryHandle(PHONE, KE, "turn on stock alerts");
    expect(optedIn).toEqual(["u1"]);
    expect(last()).toContain("Stock alerts are on");
  });

  it("is never confused with stopping a recurring buy", async () => {
    await bot.tryHandle(PHONE, KE, "stop my tesla buys");
    expect(optedOut).toEqual([]);
    expect(cancelledWith).toHaveLength(1);
  });

  it("a US number is not told anything about alerts", async () => {
    await bot.tryHandle("14155550100", KE, "stop stock alerts");
    expect(optedOut).toEqual([]);
    expect(last()).toContain("United States");
  });
});

describe("announcing an order that finished later", () => {
  const filled = (over: any = {}) => ({ state: "filled", side: "buy", tokenUnits: ONE, cashAmount: 13_000, currency: "KES", ...over });

  it("says what was bought, in shares through the multiplier, and what it cost", () => {
    expect(bot.settledMessage(filled() as any, SAN)).toBe("Your order is complete. You bought about 1.0106 shares of Banco Santander, S.A. (SAN) for KES 13,000.");
  });

  it("says what was sold and received", () => {
    expect(bot.settledMessage(filled({ side: "sell", cashAmount: 12_900 }) as any, TSLA)).toContain("You sold about 1 shares of Tesla, Inc. (TSLA) and received KES 12,900");
  });

  it("says plainly that money or shares came back after a refusal", () => {
    expect(bot.settledMessage({ state: "refunded", side: "buy", cashAmount: 13_000, currency: "KES", tokenUnits: 0n } as any, TSLA)).toContain("KES 13,000 was returned to your balance");
    expect(bot.settledMessage({ state: "refunded", side: "sell", cashAmount: 0, currency: "KES", tokenUnits: ONE } as any, TSLA)).toContain("your shares were returned");
  });

  it("says nothing for an order that has not ended, or that failed before anything moved", () => {
    expect(bot.settledMessage({ state: "submitted", side: "buy" } as any, TSLA)).toBeNull();
    expect(bot.settledMessage({ state: "failed", side: "buy" } as any, TSLA)).toBeNull();
  });

  it("still speaks sensibly if the stock is no longer in the catalogue", () => {
    expect(bot.settledMessage(filled() as any, undefined)).toContain("your stock");
  });
});

describe("recurring buys", () => {
  it("proposes the schedule in plain words and waits: nothing is created until they say yes", async () => {
    expect(await bot.tryHandle(PHONE, KE, "buy 2000 of tesla every friday")).toBe(true);
    expect(last()).toContain("Recurring buy");
    expect(last()).toContain("I'll buy KES 2,000 of Tesla, Inc. (TSLA) every Friday");
    expect(last()).toContain("First buy: Fri 27 Nov, around 08:00 UTC");
    expect(last()).toContain("after 3 skips in a row I pause it");
    expect(last()).toContain("stop my TSLA buys");
    expect(created).toEqual([]);
    expect(session).toMatchObject({ kind: "recurring", cashAmount: 2_000, rule: { frequency: "weekly", weekday: 5 } });
  });

  it("understands daily and monthly too", async () => {
    await bot.tryHandle(PHONE, KE, "buy 1000 of nvda every day");
    expect(session).toMatchObject({ rule: { frequency: "daily" } });
    await bot.tryHandle(PHONE, KE, "buy 1000 of nvda monthly on the 1st");
    expect(session).toMatchObject({ rule: { frequency: "monthly", dayOfMonth: 1 } });
  });

  it("YES creates exactly one schedule, with a reference tied to this confirmation, and says when it starts", async () => {
    await bot.tryHandle(PHONE, KE, "buy 2000 of tesla every friday");
    await bot.handleConfirm(PHONE, KE, session!, "yes");
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ reference: "stk-sch:id1", userId: "u1", cashAmount: 2_000, currency: "KES", rule: { frequency: "weekly", weekday: 5 }, token: expect.objectContaining({ ticker: "TSLA" }) });
    expect(last()).toContain("Done. I'll buy KES 2,000 of Tesla, Inc. (TSLA) every Friday");
    expect(last()).toContain("First buy: Fri 27 Nov");
    expect(placed).toEqual([]); // a schedule is not an order: nothing is bought now
  });

  it("pressing YES twice carries the same reference, so it is one schedule", async () => {
    await bot.tryHandle(PHONE, KE, "buy 2000 of tesla every friday");
    const data = { ...session! };
    await bot.handleConfirm(PHONE, KE, data, "yes");
    await bot.handleConfirm(PHONE, KE, data, "yes");
    expect(new Set(created.map((c) => c.reference))).toEqual(new Set(["stk-sch:id1"]));
  });

  it("NO creates nothing", async () => {
    await bot.tryHandle(PHONE, KE, "buy 2000 of tesla every friday");
    await bot.handleConfirm(PHONE, KE, session!, "no");
    expect(created).toEqual([]);
    expect(last()).toContain("Nothing was charged");
  });

  it("an expired confirmation is not used", async () => {
    await bot.tryHandle(PHONE, KE, "buy 2000 of tesla every friday");
    now += CONFIRM_TTL_MS + 1;
    await bot.handleConfirm(PHONE, KE, session!, "yes");
    expect(created).toEqual([]);
  });

  it("refuses an amount that is too small before asking for confirmation", async () => {
    await bot.tryHandle(PHONE, KE, "buy 100 of tesla every friday");
    expect(last()).toBe("The minimum order is about $5.");
    expect(session).toBeNull();
  });

  it("warns, but still offers it, when the balance is low today", async () => {
    balance = 500;
    await bot.tryHandle(PHONE, KE, "buy 2000 of tesla every friday");
    expect(last()).toContain("You have KES 500 now. Make sure you have enough on the day.");
    expect(session).toMatchObject({ kind: "recurring" });
  });

  it("shows why a schedule could not be created, but never an internal error", async () => {
    let b = createStockBot(depsWith({}, undefined, undefined, { create: async () => { throw new OrderRefused("You can have up to 10 recurring buys at once. Stop one to add another."); } }));
    await b.tryHandle(PHONE, KE, "buy 2000 of tesla every friday");
    await b.handleConfirm(PHONE, KE, session!, "yes");
    expect(last()).toContain("up to 10 recurring buys");
    b = createStockBot(depsWith({}, undefined, undefined, { create: async () => { throw new Error("P2002 unique violation on stock_schedule_reference_key"); } }));
    await b.tryHandle(PHONE, KE, "buy 2000 of tesla every friday");
    await b.handleConfirm(PHONE, KE, session!, "yes");
    expect(last()).toBe("I couldn't set that up. Please try again.");
  });

  it("an unknown stock is not scheduled", async () => {
    await bot.tryHandle(PHONE, KE, "buy 2000 of dogecoin every friday");
    expect(last()).toContain("couldn't find a stock called");
    expect(session).toBeNull();
  });
});

describe("stopping recurring buys", () => {
  it("stops one stock's buys and says so", async () => {
    await bot.tryHandle(PHONE, KE, "stop my tesla buys");
    expect(cancelledWith).toEqual([{ userId: "u1", tokenAddress: TSLA.address }]);
    expect(last()).toBe("Stopped your recurring TSLA buy.");
  });

  it("stops all of them and says how many", async () => {
    cancelResult = 3;
    await bot.tryHandle(PHONE, KE, "stop all my recurring buys");
    expect(cancelledWith).toEqual([{ userId: "u1", tokenAddress: undefined }]);
    expect(last()).toBe("Stopped all 3 of your recurring buys.");
  });

  it("says kindly when there was nothing to stop", async () => {
    cancelResult = 0;
    await bot.tryHandle(PHONE, KE, "stop my tesla buys");
    expect(last()).toBe("You don't have a recurring buy for TSLA.");
    await bot.tryHandle(PHONE, KE, "cancel recurring");
    expect(last()).toBe("You don't have any recurring buys.");
  });

  it("does not guess an unknown stock", async () => {
    await bot.tryHandle(PHONE, KE, "stop my dogecoin buys");
    expect(cancelledWith).toEqual([]);
    expect(last()).toContain("couldn't find a stock called");
  });
});

describe("telling people about a recurring buy that ran", () => {
  const sched: any = { name: "Tesla, Inc.", ticker: "TSLA", cashAmount: 2_000, currency: "KES", tokenDecimals: 8 };
  const order: any = { state: "filled", tokenUnits: ONE, side: "buy" };

  it("says what was bought", () => {
    expect(bot.scheduleEventMessage({ kind: "bought", schedule: sched, order }, TSLA)).toBe("Your recurring buy went through: bought about 1 shares of Tesla, Inc. (TSLA) for KES 2,000.");
  });

  it("counts shares through the multiplier when it knows it", () => {
    expect(bot.scheduleEventMessage({ kind: "bought", schedule: sched, order }, SAN)).toContain("1.0106 shares");
  });

  it("says when it is still being processed", () => {
    expect(bot.scheduleEventMessage({ kind: "processing", schedule: sched, order }, TSLA)).toContain("being processed");
  });

  it("explains a skipped run, suggests topping up when the balance was the reason, and says when it will try again", () => {
    const m = bot.scheduleEventMessage({ kind: "failed", schedule: sched, reason: "your balance was too low", paused: false, nextRunAt: new Date("2026-12-04T08:00:00Z") }, TSLA);
    expect(m).toContain("didn't go through: your balance was too low");
    expect(m).toContain("/topup");
    expect(m).toContain("Fri 4 Dec");
  });

  it("says plainly when it has been paused, and how to start it again", () => {
    const m = bot.scheduleEventMessage({ kind: "failed", schedule: sched, reason: "your balance was too low", paused: true, nextRunAt: new Date() }, TSLA);
    expect(m).toContain("I've paused your recurring buy");
    expect(m).toContain("3 in a row");
    expect(m).toContain("buy 2000 of TSLA every Friday");
  });
});

/** A fresh deps object with some overrides, for tests that need a differently behaved dependency. */
function depsWith(ordersOver: Partial<StockBotDeps["orders"]>, stocks?: StockToken[], placeOver?: Partial<StockBotDeps["orders"]>, schedulesOver?: Partial<StockBotDeps["schedules"]>): StockBotDeps {
  const d: StockBotDeps = {
    send: async (_p, t) => void sent.push(t),
    stocks: async () => stocks ?? CATALOGUE,
    setSession: async (_u, data) => void (session = data),
    resetSession: async () => void (session = null),
    currencyFor: () => "KES",
    money: (a, c) => `${c} ${a.toLocaleString("en-US", { maximumFractionDigits: 2 })}`,
    convert: (a, from, to) => {
      const perUsd: Record<string, number> = { USD: 1, KES: 130, NGN: 1500, TZS: 2600 };
      return (a / perUsd[from]) * perUsd[to];
    },
    balanceOf: async () => balance,
    orders: {
      previewBuy: async ({ cashAmount }) => ({ usd: cashAmount / 130, usdcUnits: 0n, estimatedTokenUnits: BigInt(Math.round((cashAmount / 130 / 100) * 1e8)), estimatedShares: 0, minTokenUnits: 0n, priceImpactBps: 10, fx: {} as any }),
      previewSell: async ({ units }) => ({ estimatedUsdcUnits: 0n, estimatedCash: (Number(units) / 1e8) * 13000, minUsdcUnits: 0n, priceImpactBps: 10, fx: {} as any }),
      placeBuy: async (p) => (placed.push({ kind: "buy", ...p }), { state: "filled", side: "buy", tokenUnits: ONE, cashAmount: p.cashAmount, currency: p.currency } as any),
      placeSell: async (p) => (placed.push({ kind: "sell", ...p }), { state: "filled", side: "sell", tokenUnits: p.units, cashAmount: 13_000, currency: p.currency } as any),
      indicativePrice: async () => ({ usdPerShare: 412.3456 }),
      unitsForCash: async (_t, cash) => BigInt(Math.round((cash / 130 / 100) * 1e8)),
      ...ordersOver,
      ...placeOver,
    },
    positions: { list: async () => [], get: async () => 0n },
    schedules: { ...fakeSchedules(), ...schedulesOver },
    alerts: { optOut: async (u) => void optedOut.push(u), optIn: async (u) => void optedIn.push(u) },
    recent: { get: (u) => recentMap.get(u) ?? null, set: (u, a) => void recentMap.set(u, a) },
    market: { quote: async () => (typeof marketReply === "function" ? marketReply() : marketReply) },
    research: { ask: async (p) => (asked.push(p), typeof researchReply === "function" ? researchReply(p) : researchReply) },
    newId: () => `id${++nextId}`,
    now: () => now,
  };
  return d;
}


describe("target mix", () => {
  it("saves a mix that adds up to 100", async () => {
    await bot.tryHandle(PHONE, KE, "keep me 40% nvidia 35% microsoft 25% tesla");
    expect(targets).toEqual([{ tokenAddress: NVDA.address, percent: 40 }, { tokenAddress: MSFT.address, percent: 35 }, { tokenAddress: TSLA.address, percent: 25 }]);
    expect(last()).toContain("Target mix saved");
    expect(last()).toContain("*rebalance*");
  });

  it("refuses a mix that does not add up, and says what it adds up to", async () => {
    await bot.tryHandle(PHONE, KE, "keep me 40% nvidia 35% microsoft 20% tesla");
    expect(targets).toEqual([]);
    expect(last()).toContain("add up to 95%");
  });

  it("refuses the same stock twice, and an unknown stock, without saving anything", async () => {
    await bot.tryHandle(PHONE, KE, "keep me 50% nvidia 50% nvidia");
    expect(last()).toContain("twice");
    await bot.tryHandle(PHONE, KE, "keep me 50% nvidia 50% dogecoin");
    expect(last()).toContain("couldn't find a stock called");
    expect(targets).toEqual([]);
  });

  it("clears it", async () => {
    targets = [{ tokenAddress: NVDA.address, percent: 100 }];
    await bot.tryHandle(PHONE, KE, "clear my target");
    expect(targets).toEqual([]);
  });

  it("shows the mix against the target, or explains there is none", async () => {
    await bot.tryHandle(PHONE, KE, "show my target mix");
    expect(last()).toContain("haven't set a target");
    planReply = { status: "balanced", maxDrift: 1, total: 100, rows: [{ token: NVDA, targetPercent: 60, actualPercent: 58.5 }, { token: MSFT, targetPercent: 40, actualPercent: 41.5 }] };
    await bot.tryHandle(PHONE, KE, "what is my target mix");
    expect(last()).toContain("NVDA: 58.5% now, target 60%");
  });
});

describe("rebalance", () => {
  const rows = [{ token: NVDA, targetPercent: 40, actualPercent: 55 }, { token: MSFT, targetPercent: 60, actualPercent: 45 }];
  const tradesPlan = () => ({
    status: "trades", maxDrift: 15, total: 1000, rows,
    trades: [{ side: "sell", token: NVDA, usd: 150, units: 3n * ONE }, { side: "buy", token: MSFT, usd: 147, cashAmount: 19_110 }],
  });

  it("proposes the trades and places NOTHING until the person says yes", async () => {
    planReply = tradesPlan();
    await bot.tryHandle(PHONE, KE, "rebalance my portfolio");
    expect(last()).toContain("Sell about $150.00 of NVDA");
    expect(last()).toContain("Buy KES 19,110 of MSFT");
    expect(last()).toContain("Reply *YES*");
    expect(placed).toEqual([]);
    expect(session?.kind).toBe("rebalance");
  });

  it("on yes, sells first and then buys, each with its own fixed reference", async () => {
    planReply = tradesPlan();
    await bot.tryHandle(PHONE, KE, "rebalance");
    const snapshot = JSON.parse(JSON.stringify(session, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    await bot.handleConfirm(PHONE, KE, snapshot, "yes");
    expect(placed.map((p) => [p.kind, p.token.ticker])).toEqual([["sell", "NVDA"], ["buy", "MSFT"]]);
    expect(placed[0].reference).toBe("stk:id1:0");
    expect(placed[1].reference).toBe("stk:id1:1");
    expect(placed[0].units).toBe(3n * ONE);
    expect(last()).toContain("✓ Sold NVDA");
    expect(last()).toContain("✓ Bought MSFT");
    expect(session).toBeNull();
  });

  it("saying yes twice places the same references, never new orders", async () => {
    planReply = tradesPlan();
    await bot.tryHandle(PHONE, KE, "rebalance");
    const snapshot = JSON.parse(JSON.stringify(session));
    await bot.handleConfirm(PHONE, KE, snapshot, "yes");
    await bot.handleConfirm(PHONE, KE, snapshot, "yes");
    expect(new Set(placed.map((p) => p.reference)).size).toBe(2);
  });

  it("no cancels it, and an expired quote asks again", async () => {
    planReply = tradesPlan();
    await bot.tryHandle(PHONE, KE, "rebalance");
    await bot.handleConfirm(PHONE, KE, JSON.parse(JSON.stringify(session)), "no");
    expect(placed).toEqual([]);
    await bot.tryHandle(PHONE, KE, "rebalance");
    now += CONFIRM_TTL_MS + 1;
    await bot.handleConfirm(PHONE, KE, JSON.parse(JSON.stringify(session)), "yes");
    expect(last()).toContain("expired");
    expect(placed).toEqual([]);
  });

  it("one trade failing does not stop the other, and nothing internal leaks", async () => {
    planReply = tradesPlan();
    const b = makeBot({ orders: { ...(makeBotOrders()), placeSell: async () => { throw new Error("P1001 db.internal:5432"); } } as any });
    await b.tryHandle(PHONE, KE, "rebalance");
    await b.handleConfirm(PHONE, KE, JSON.parse(JSON.stringify(session)), "yes");
    expect(last()).toContain("✗ NVDA: something went wrong");
    expect(last()).toContain("✓ Bought MSFT");
    expect(last()).not.toContain("5432");
  });

  it("says plainly when there is no target, nothing held, or the mix is already on target", async () => {
    await bot.tryHandle(PHONE, KE, "rebalance");
    expect(last()).toContain("haven't set a target");
    planReply = { status: "nothing_held", rows };
    await bot.tryHandle(PHONE, KE, "rebalance");
    expect(last()).toContain("don't hold any of the stocks");
    planReply = { status: "balanced", rows, maxDrift: 1, total: 100 };
    await bot.tryHandle(PHONE, KE, "rebalance");
    expect(last()).toContain("You're on target");
    expect(placed).toEqual([]);
  });

  it("will not check a mix it cannot price, and does not guess", async () => {
    planReply = { status: "unpriced", missing: ["AAPL"] };
    await bot.tryHandle(PHONE, KE, "rebalance");
    expect(last()).toContain("can't price AAPL");
  });

  it("a failing planner gives a plain message, not an error", async () => {
    planReply = () => { throw new Error("boom"); };
    await bot.tryHandle(PHONE, KE, "rebalance");
    expect(last()).toBe("I couldn't price that right now. Please try again.");
  });

  it("a US number is refused before anything", async () => {
    await bot.tryHandle("14155550100", KE, "rebalance");
    expect(last()).toContain("United States");
  });
});

describe("investing a share of sales", () => {
  it("saves the rule for a named stock", async () => {
    await bot.tryHandle(PHONE, KE, "invest 10% of my sales in nvidia");
    expect(sweeps).toEqual([{ percent: 10, tokenAddress: NVDA.address }]);
    expect(last()).toContain("10% of every paid invoice into NVIDIA Corporation (NVDA)");
  });

  it("with no stock named, follows the target mix; without a mix it asks which stock", async () => {
    await bot.tryHandle(PHONE, KE, "invest 10% of my sales");
    expect(sweeps).toEqual([]);
    expect(last()).toContain("Which stock?");
    targets = [{ tokenAddress: NVDA.address, percent: 60 }, { tokenAddress: MSFT.address, percent: 40 }];
    await bot.tryHandle(PHONE, KE, "invest 10% of my sales");
    expect(sweeps).toEqual([{ percent: 10, tokenAddress: null }]);
    expect(last()).toContain("your target mix");
  });

  it("refuses an unreasonable share", async () => {
    await bot.tryHandle(PHONE, KE, "invest 80% of my sales in nvidia");
    expect(sweeps).toEqual([]);
    expect(last()).toContain("between 1% and 50%");
  });

  it("stops it", async () => {
    await bot.tryHandle(PHONE, KE, "invest 10% of my sales in nvidia");
    await bot.tryHandle(PHONE, KE, "stop investing my sales");
    expect(last()).toContain("stopped investing your sales");
    await bot.tryHandle(PHONE, KE, "stop investing my sales");
    expect(sweepsCleared).toBe(2);
  });
});

function makeBotOrders() {
  return {
    previewBuy: async () => ({}) as any,
    previewSell: async () => ({}) as any,
    placeBuy: async (p: any) => (placed.push({ kind: "buy", ...p }), { state: "filled", side: "buy", tokenUnits: ONE, cashAmount: p.cashAmount, currency: p.currency }) as any,
    placeSell: async (p: any) => (placed.push({ kind: "sell", ...p }), { state: "filled", side: "sell", tokenUnits: p.units, cashAmount: 1, currency: p.currency }) as any,
    indicativePrice: async () => ({ usdPerShare: 1 }),
    unitsForCash: async () => 0n,
  };
}

describe("everyday wording, understood locally", () => {
  it("explains how stocks work, and /stocks does the same", async () => {
    await bot.tryHandle(PHONE, KE, "how do stocks work here");
    expect(last()).toContain("*Stocks*");
    expect(last()).toContain("buy 5000 of Nvidia");
    sent = [];
    await bot.handleCommand(PHONE, KE, "stocks", "");
    expect(last()).toContain("confirm before anything is bought");
  });

  it("a loose 'I want to buy' gets a nudge on how to say it, and NEVER an order", async () => {
    await bot.tryHandle(PHONE, KE, "i wanna buy some nvidia");
    expect(last()).toContain("How much NVIDIA Corporation (NVDA)");
    expect(last()).toContain("buy 5000 of NVDA");
    expect(placed).toEqual([]);
    expect(session).toBeNull();
    await bot.tryHandle(PHONE, KE, "i want to buy stocks");
    expect(last()).toContain("Which stock, and how much?");
    expect(placed).toEqual([]);
  });

  it("a loose 'sell' gets a nudge too, and sells nothing", async () => {
    held.set(TSLA.address, ONE);
    await bot.tryHandle(PHONE, KE, "sell my shares");
    expect(last()).toContain("Which stock, and how much?");
    await bot.tryHandle(PHONE, KE, "i would like to sell some tesla");
    expect(last()).toMatch(/How much TSLA would you like to sell|how much/i);
    expect(placed).toEqual([]);
  });

  it("a misspelled stock is understood, and the bot says what it assumed", async () => {
    await bot.tryHandle(PHONE, KE, "nvdia price");
    expect(sent.some((m) => m.includes("Assuming you mean NVIDIA Corporation (NVDA)"))).toBe(true);
    expect(last()).toContain("NVIDIA Corporation");
  });

  it("a price question does not call the research assistant (the big model)", async () => {
    await bot.tryHandle(PHONE, KE, "whats the price of tesla");
    await bot.tryHandle(PHONE, KE, "tesl price");
    expect(asked).toEqual([]);
  });

  it("leaves every other part of the app alone", async () => {
    for (const text of ["balance", "hello", "cash out", "top up 5000", "create invoice", "buy airtime for 500", "show my invoices", "help", "i have a problem with my payment"]) {
      expect(await bot.tryHandle(PHONE, KE, text), text).toBe(false);
    }
    expect(sent).toEqual([]);
  });
});

describe("answers that read well", () => {
  it("a price question shows the market price and the move, even with no trading venue", async () => {
    await bot.tryHandle(PHONE, KE, "price of tesla");
    expect(last()).toContain("Price: $188.50 per share, up 4.7% since the previous close (as of 2026-11-25).");
    expect(last()).toContain("why is TSLA up?");
  });

  it("says down, unchanged, and when there is no market price at all", async () => {
    marketReply = { price: 100, changePercent: -5.9, asOf: "2026-11-25" };
    await bot.tryHandle(PHONE, KE, "price of tesla");
    expect(last()).toContain("down 5.9% since the previous close");
    marketReply = { price: 100, changePercent: 0, asOf: "2026-11-25" };
    await bot.tryHandle(PHONE, KE, "price of tesla");
    expect(last()).toContain("unchanged since the previous close");
    marketReply = null;
    await bot.tryHandle(PHONE, KE, "price of tesla");
    expect(last()).toContain("what you'd actually pay right now"); // falls back to the venue's price
  });

  it("when the market quote fails, the price card still comes (never an error)", async () => {
    marketReply = () => { throw new Error("finnhub down"); };
    await bot.tryHandle(PHONE, KE, "price of tesla");
    expect(last()).toContain("*Tesla, Inc. (TSLA)*");
  });

  it("an exact ticker inside a longer sentence is NOT reported as a guess", async () => {
    await bot.tryHandle(PHONE, KE, "How about TSLA stocks what's the current price");
    expect(sent.some((m) => m.includes("Assuming you mean"))).toBe(false);
    expect(sent).toHaveLength(1);
    expect(last()).toContain("*Tesla, Inc. (TSLA)*");
  });

  it("a real misspelling still says what it assumed", async () => {
    await bot.tryHandle(PHONE, KE, "price of nvdia");
    expect(sent.some((m) => m.includes("Assuming you mean NVIDIA Corporation (NVDA)"))).toBe(true);
  });

  it("'why is it up?' is about the stock they were just talking about", async () => {
    await bot.tryHandle(PHONE, KE, "how about tsla what's the current price");
    await bot.tryHandle(PHONE, KE, "why is it up");
    expect(asked).toHaveLength(1);
    expect(asked[0].stocks.map((s: StockToken) => s.ticker)).toEqual(["TSLA"]);
    expect(sent.some((m) => m.includes("Which stock do you mean?"))).toBe(false);
  });

  it("the stock they just named beats what they hold", async () => {
    held.set(NVDA.address, ONE);
    await bot.tryHandle(PHONE, KE, "price of tesla");
    await bot.tryHandle(PHONE, KE, "should i sell");
    expect(asked[0].stocks.map((s: StockToken) => s.ticker)).toEqual(["TSLA"]);
  });

  it("with nothing recent it falls back to holdings, and with neither it asks which stock", async () => {
    held.set(NVDA.address, ONE);
    await bot.tryHandle(PHONE, KE, "why is it up");
    expect(asked[0].stocks.map((s: StockToken) => s.ticker)).toEqual(["NVDA"]);
    held.clear();
    recentMap.clear();
    asked.length = 0;
    await bot.tryHandle(PHONE, KE, "why is it up");
    expect(asked).toEqual([]);
    expect(last()).toContain("Which stock do you mean?");
  });

  it("each person has their own 'last stock'", async () => {
    await bot.tryHandle(PHONE, { ...KE, id: "u1" }, "price of tesla");
    await bot.tryHandle(PHONE, { ...KE, id: "u2" }, "why is it up");
    expect(asked).toEqual([]); // u2 never mentioned a stock
  });
});

describe("a conversation, not a list of commands", () => {
  it("'can it go up' right after a price is a question about that stock", async () => {
    await bot.tryHandle(PHONE, KE, "price of tesla");
    expect(await bot.tryHandle(PHONE, KE, "Can it go up")).toBe(true);
    expect(asked).toHaveLength(1);
    expect(asked[0].question).toBe("Can it go up");
    expect(asked[0].stocks.map((s: StockToken) => s.ticker)).toEqual(["TSLA"]);
  });

  it("with no stock in the conversation it is not claimed, so the app's usual reply applies", async () => {
    expect(await bot.tryHandle(PHONE, KE, "Can it go up")).toBe(false);
    expect(asked).toEqual([]);
  });

  it("each line of a two-line message is answered, in order: the price, then the question", async () => {
    await bot.tryHandle(PHONE, KE, "How about TSLA stocks what's the current price\n\nAnd can it go up");
    expect(sent[0]).toContain("*Tesla, Inc. (TSLA)*");
    expect(asked).toHaveLength(1);
    expect(asked[0].question).toBe("And can it go up");
    expect(asked[0].stocks.map((s: StockToken) => s.ticker)).toEqual(["TSLA"]);
    expect(last()).toBe("Tesla is up 6% recently.");
  });

  it("carries on with 'and Nvidia?' and 'why?'", async () => {
    await bot.tryHandle(PHONE, KE, "price of tesla");
    await bot.tryHandle(PHONE, KE, "what about nvidia");
    expect(asked[0].stocks.map((s: StockToken) => s.ticker)).toEqual(["NVDA"]);
    await bot.tryHandle(PHONE, KE, "why?");
    expect(asked).toHaveLength(2);
    expect(asked[1].stocks.map((s: StockToken) => s.ticker)).toEqual(["NVDA"]); // the one just discussed
  });

  it("never steals a message meant for another part of the app, even mid-conversation", async () => {
    await bot.tryHandle(PHONE, KE, "price of tesla");
    sent.length = 0;
    for (const text of ["is my invoice paid", "what is my balance", "can i cash out", "thanks", "ok", "how do i top up", "hello", "/invoice"]) {
      expect(await bot.tryHandle(PHONE, KE, text), text).toBe(false);
    }
    expect(asked).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("a multi-line message that is not all about stocks is left whole for the rest of the app", async () => {
    expect(await bot.tryHandle(PHONE, KE, "hello there\nmy invoice is not paid")).toBe(false);
    expect(await bot.tryHandle(PHONE, KE, "create invoice\n5000 for shoes")).toBe(false);
    expect(sent).toEqual([]);
  });

  it("each person has their own thread of conversation", async () => {
    await bot.tryHandle(PHONE, { ...KE, id: "u1" }, "price of tesla");
    expect(await bot.tryHandle(PHONE, { ...KE, id: "u2" }, "can it go up")).toBe(false);
  });
});

