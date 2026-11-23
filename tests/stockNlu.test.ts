import { describe, it, expect, vi } from "vitest";

vi.mock("@/config", () => ({ config: { logLevel: "silent" } }));

import { parseStockRequest } from "@/utils/stockNlu";

const buy = (query: string, amount: number, currency?: string) => ({ intent: "buy", query, amount, ...(currency ? { currency } : {}) });

describe("buying", () => {
  it.each([
    ["buy 5000 of tesla", buy("tesla", 5000)],
    ["Buy 5000 of Tesla", buy("tesla", 5000)],
    ["buy tsla 5000", buy("tsla", 5000)],
    ["buy 5k of nvda", buy("nvda", 5000)],
    ["buy 1.5k apple", buy("apple", 1500)],
    ["buy ₦5k nvda", buy("nvda", 5000, "NGN")],
    ["buy $20 of apple", buy("apple", 20, "USD")],
    ["buy 20 dollars of apple", buy("apple", 20, "USD")],
    ["buy 2,500 kes of microsoft", buy("microsoft", 2500, "KES")],
    ["invest 3000 in tesla", buy("tesla", 3000)],
    ["invest 20 dollars in apple stock", buy("apple", 20, "USD")],
    ["I want to buy 2000 worth of amazon", buy("amazon", 2000)],
    ["can you buy 1000 of meta for me", buy("meta", 1000)],
    ["please purchase 7500 naira of google", buy("google", 7500, "NGN")],
    ["get me 1000 of AMZN", buy("amzn", 1000)],
    ["put 4000 into microstrategy", buy("microstrategy", 4000)],
    ["buy five thousand of tesla", buy("tesla", 5000)],
    ["buy 500 tzs of nvidia", buy("nvidia", 500, "TZS")],
  ])("%s", (text, expected) => {
    expect(parseStockRequest(text)).toEqual(expected);
  });

  it("has nothing safe to propose without an amount", () => {
    expect(parseStockRequest("buy tesla")).toBeNull();
    expect(parseStockRequest("I want to buy apple stock")).toBeNull();
  });

  it("has nothing to buy without a stock", () => {
    expect(parseStockRequest("buy 5000")).toBeNull();
    expect(parseStockRequest("buy 5000 of")).toBeNull();
  });
});

describe("recurring buys", () => {
  it.each([
    ["buy 2000 of apple every friday", { intent: "recurring_buy", query: "apple", amount: 2000, schedule: { frequency: "weekly", weekday: 5 } }],
    ["every monday buy 1000 nvda", { intent: "recurring_buy", query: "nvda", amount: 1000, schedule: { frequency: "weekly", weekday: 1 } }],
    ["buy ₦5,000 of tsla every week", { intent: "recurring_buy", query: "tsla", amount: 5000, currency: "NGN", schedule: { frequency: "weekly" } }],
    ["buy 500 of microsoft daily", { intent: "recurring_buy", query: "microsoft", amount: 500, schedule: { frequency: "daily" } }],
    ["invest 3000 in amazon every day", { intent: "recurring_buy", query: "amazon", amount: 3000, schedule: { frequency: "daily" } }],
    ["buy 10k of apple every month", { intent: "recurring_buy", query: "apple", amount: 10000, schedule: { frequency: "monthly" } }],
    ["buy 10k of apple monthly on the 1st", { intent: "recurring_buy", query: "apple", amount: 10000, schedule: { frequency: "monthly", dayOfMonth: 1 } }],
    ["buy 10k of apple every month on the 15th", { intent: "recurring_buy", query: "apple", amount: 10000, schedule: { frequency: "monthly", dayOfMonth: 15 } }],
    ["2000 of apple every friday", { intent: "recurring_buy", query: "apple", amount: 2000, schedule: { frequency: "weekly", weekday: 5 } }],
    ["put $50 into tesla each week", { intent: "recurring_buy", query: "tesla", amount: 50, currency: "USD", schedule: { frequency: "weekly" } }],
    ["buy 1000 of nvda every wednesday", { intent: "recurring_buy", query: "nvda", amount: 1000, schedule: { frequency: "weekly", weekday: 3 } }],
    ["buy 1000 of nvda every sunday", { intent: "recurring_buy", query: "nvda", amount: 1000, schedule: { frequency: "weekly", weekday: 0 } }],
  ])("%s", (text, expected) => {
    expect(parseStockRequest(text)).toEqual(expected);
  });

  it("does not let a day-of-month number be mistaken for the amount", () => {
    const r: any = parseStockRequest("buy 7000 of apple monthly on the 3rd");
    expect(r.amount).toBe(7000);
    expect(r.schedule.dayOfMonth).toBe(3);
  });

  it("refuses day 29 to 31, which do not exist every month, instead of silently skipping months", () => {
    const r: any = parseStockRequest("buy 7000 of apple monthly on the 31st");
    expect(r.schedule).toEqual({ frequency: "monthly" });
  });

  it("a recurring request without an amount is not understood", () => {
    expect(parseStockRequest("buy apple every friday")).toBeNull();
  });
});

describe("selling", () => {
  it.each([
    ["sell 2000 of tsla", { intent: "sell", query: "tsla", amount: 2000 }],
    ["sell all my nvda", { intent: "sell", query: "nvda", fraction: 1 }],
    ["sell everything in apple", { intent: "sell", query: "apple", fraction: 1 }],
    ["sell half of my tesla", { intent: "sell", query: "tesla", fraction: 0.5 }],
    ["sell a quarter of msft", { intent: "sell", query: "msft", fraction: 0.25 }],
    ["sell $30 of amazon", { intent: "sell", query: "amazon", amount: 30, currency: "USD" }],
  ])("%s", (text, expected) => {
    expect(parseStockRequest(text)).toEqual(expected);
  });

  it("asks how much when the person did not say", () => {
    expect(parseStockRequest("sell my tesla")).toEqual({ intent: "sell", query: "tesla" });
  });

  it("is not triggered by 'cash out', which is the bank cash-out command", () => {
    expect(parseStockRequest("cash out 5000")).toBeNull();
  });
});

describe("standing orders", () => {
  it("stops all or one", () => {
    expect(parseStockRequest("stop my apple buys")).toEqual({ intent: "cancel_recurring", query: "apple" });
    expect(parseStockRequest("cancel recurring nvda")).toEqual({ intent: "cancel_recurring", query: "nvda" });
    expect(parseStockRequest("stop all my recurring buys")).toEqual({ intent: "cancel_recurring" });
    expect(parseStockRequest("pause my auto investing")).toEqual({ intent: "cancel_recurring" });
  });
});

describe("research questions", () => {
  it.each([
    ["why is nvidia down", ["nvidia"]],
    ["why did tesla go up today", ["tesla"]],
    ["explain apple to me", ["apple"]],
    ["analyze nvidia", ["nvidia"]],
    ["should i buy tesla", ["tesla"]],
    ["should i sell my microsoft", ["microsoft"]],
    ["should i keep my nvda", ["nvda"]],
    ["is tesla a good buy", ["tesla"]],
    ["is apple worth buying", ["apple"]],
    ["how risky is amazon", ["amazon"]],
    ["compare tesla and nvidia", ["tesla", "nvidia"]],
    ["tesla vs apple", ["tesla", "apple"]],
    ["apple versus microsoft", ["apple", "microsoft"]],
    ["what do you think of meta", ["meta"]],
  ])("%s", (text, queries) => {
    expect(parseStockRequest(text)).toEqual({ intent: "research", question: text, queries });
  });

  it("with no stock named, still a research question, with no stock", () => {
    expect(parseStockRequest("should i sell")).toEqual({ intent: "research", question: "should i sell", queries: [] });
    expect(parseStockRequest("why is it down")).toEqual({ intent: "research", question: "why is it down", queries: [] });
  });

  it("a number, email or link pasted into a question is never taken for a stock", () => {
    expect((parseStockRequest("why is tesla down 0788000111 ada@example.com https://x.test/a") as any).queries).toEqual(["tesla"]);
    const withPhone = (parseStockRequest("why is tesla down, call me on +254 712 345 678") as any).queries as string[];
    expect(withPhone[0]).toBe("tesla");
    expect(withPhone.join(" ")).not.toMatch(/\d/); // no part of the number survives as a "stock"
  });

  it("at most three stocks", () => {
    expect((parseStockRequest("compare tesla, nvidia, apple, meta and amazon") as any).queries).toHaveLength(3);
  });

  it("does not steal ordinary buys, sells, prices or the list", () => {
    expect(parseStockRequest("buy 5000 of tesla")).toMatchObject({ intent: "buy" });
    expect(parseStockRequest("sell half my nvda")).toMatchObject({ intent: "sell" });
    expect(parseStockRequest("price of tesla")).toEqual({ intent: "quote", query: "tesla" });
    expect(parseStockRequest("how is apple doing")).toEqual({ intent: "quote", query: "apple" });
    expect(parseStockRequest("my stocks")).toEqual({ intent: "holdings" });
    expect(parseStockRequest("what stocks can i buy")).toEqual({ intent: "list" });
    expect(parseStockRequest("buy 2000 of apple every friday")).toMatchObject({ intent: "recurring_buy" });
  });
});

describe("plans", () => {
  it.each([
    ["I have 5000 a week, what should I buy", { budget: 5000, frequency: "weekly" }],
    ["what should i invest in with 10k a month", { budget: 10000, frequency: "monthly" }],
    ["build me a portfolio with 20000", { budget: 20000 }],
    ["I have $50 each week to put in stocks", { budget: 50, currency: "USD", frequency: "weekly" }],
    ["suggest a plan for 3000 daily", { budget: 3000, frequency: "daily" }],
    ["what can i buy with 2000", { budget: 2000 }],
    ["where should i put 5k", { budget: 5000 }],
  ])("%s", (text, extra) => {
    expect(parseStockRequest(text)).toEqual({ intent: "plan", question: text, ...extra });
  });

  it("a plan with no amount still asks, so the bot can say how much", () => {
    expect(parseStockRequest("what should i buy")).toEqual({ intent: "plan", question: "what should i buy" });
  });

  it("is not mistaken for a buy of a particular stock", () => {
    expect(parseStockRequest("invest 3000 in tesla")).toMatchObject({ intent: "buy", query: "tesla" });
  });
});

describe("stock alerts", () => {
  it.each(["stop stock alerts", "turn off stock alerts", "no more stock alerts", "mute stock notifications", "disable alerts", "stop the alerts"])("%s turns them off", (text) => {
    expect(parseStockRequest(text)).toEqual({ intent: "alerts_off" });
  });
  it.each(["turn on stock alerts", "enable stock alerts", "alert me about my stocks", "resume stock alerts", "notify me about stock changes"])("%s turns them on", (text) => {
    expect(parseStockRequest(text)).toEqual({ intent: "alerts_on" });
  });
  it("does not take over unrelated messages that merely mention alerts", () => {
    expect(parseStockRequest("alerts")).toBeNull();
    expect(parseStockRequest("what is an alert")).toBeNull();
    expect(parseStockRequest("stop")).toBeNull();
  });
  it("is not mistaken for stopping a recurring buy, which keeps its own meaning", () => {
    expect(parseStockRequest("stop my apple buys")).toEqual({ intent: "cancel_recurring", query: "apple" });
  });
});

describe("looking", () => {
  it.each([
    "my stocks",
    "show my portfolio",
    "what do i own",
    "what stocks do i have",
    "my holdings",
  ])("%s is a holdings request", (text) => {
    expect(parseStockRequest(text)).toEqual({ intent: "holdings" });
  });

  it.each([
    ["price of tesla", "tesla"],
    ["what is the price of nvda", "nvda"],
    ["how is apple doing", "apple"],
    ["how's msft doing today", "msft"],
    ["tell me about amazon", "amazon"],
    ["news on tesla", "tesla"],
    ["what's happening with meta", "meta"],
  ])("%s is a question about a stock", (text, query) => {
    expect(parseStockRequest(text)).toEqual({ intent: "quote", query });
  });

  it("lists what is available", () => {
    expect(parseStockRequest("what stocks can i buy")).toEqual({ intent: "list" });
    expect(parseStockRequest("list stocks")).toEqual({ intent: "list" });
    expect(parseStockRequest("stocks")).toEqual({ intent: "list" });
  });
});

describe("never hijacks the rest of the bot", () => {
  it.each([
    "2 waters at 1500",
    "send 5000 to 0123456789 gtbank",
    "add money",
    "/topup 5000",
    "/cashout 5000 gtbank 0123456789",
    "hello",
    "yes",
    "cancel",
    "how much is my balance",
    "balance",
    "I want to withdraw 3000",
    "create an invoice for 5000",
    "",
    "   ",
  ])("%j is not a stock request", (text) => {
    expect(parseStockRequest(text)).toBeNull();
  });

  it("a plain command is never read as language", () => {
    expect(parseStockRequest("/stocks")).toBeNull();
    expect(parseStockRequest("/buy 5000 tesla")).toBeNull();
  });

  it("words that merely look like a verb need a stock after them", () => {
    expect(parseStockRequest("put 500 on my balance")).toBeNull();
  });
});

describe("what the parser never does", () => {
  it("returns the person's own words, not a resolved stock or address", () => {
    const r: any = parseStockRequest("buy 5000 of 0x1234567890abcdef1234567890abcdef12345678");
    expect(r.intent).toBe("buy");
    expect(Object.keys(r).sort()).toEqual(["amount", "intent", "query"]);
  });

  it("is deterministic", () => {
    for (let i = 0; i < 5; i++) expect(parseStockRequest("buy 2000 of apple every friday")).toEqual(parseStockRequest("buy 2000 of apple every friday"));
  });
});
