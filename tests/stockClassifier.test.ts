import { describe, it, expect, vi } from "vitest";

vi.mock("@/config", () => ({ config: { logLevel: "silent" } }));

import { trainClassifier, features, normalise } from "@/nlp/classifier";
import { parseStockRequestSmart, stockWords, looksLikeFollowUp } from "@/nlp/stockIntents";
import { STOCK_TRAINING } from "@/nlp/stockTrainingData";

describe("the classifier", () => {
  const c = trainClassifier([
    { label: "a", text: "good morning" }, { label: "a", text: "hello there" },
    { label: "b", text: "show my balance" }, { label: "b", text: "check balance" },
  ]);

  it("picks the closest label and says how sure it is", () => {
    const p = c.classify("hello")!;
    expect(p.label).toBe("a");
    expect(p.confidence).toBeGreaterThan(0.5);
    expect(p.margin).toBeGreaterThan(0);
  });

  it("copes with typos, because it reads character pieces", () => {
    expect(c.classify("helo ther")!.label).toBe("a");
    expect(c.classify("chek balanse")!.label).toBe("b");
  });

  it("is deterministic", () => {
    expect(c.classify("show my balance")).toEqual(c.classify("show my balance"));
  });

  it("says nothing for empty text or a single label", () => {
    expect(c.classify("")).toBeNull();
    expect(trainClassifier([{ label: "a", text: "x" }]).classify("x")).toBeNull();
  });

  it("normalises case, accents and punctuation", () => {
    expect(normalise("  Café!!  PRICE?? ")).toBe("cafe price");
    expect(features("hi")).toContain("w:hi");
  });
});

describe("understanding stock messages (phrases the model was NOT trained on)", () => {
  const trained = new Set(STOCK_TRAINING.map((e) => normalise(e.text)));
  const intent = (text: string) => parseStockRequestSmart(text)?.intent ?? null;

  // [text, expected intent]. None of these is in the training data (checked below).
  const CASES: Array<[string, string | string[]]> = [
    ["what stocks are on offer", "list"], ["which shares can i get", "list"], ["can i see all the stocks", "list"],
    ["what is in my portfolio", "holdings"], ["how much are my shares worth now", "holdings"], ["show me my stocks please", "holdings"], ["my stcks", "holdings"],
    ["how much is tesla right now", "quote"], ["nvidea price", "quote"], ["whats the price of apple today", "quote"], ["tesl price", "quote"],
    ["why has tesla dropped", "research"], ["is nvidia worth it", "research"], ["should i hold apple or sell", "research"], ["what is happening with meta", ["quote", "research"]], ["is amd a safe stock", "research"],
    ["what should i invest 3000 in", "plan"], ["i want some stock picks", "plan"], ["help me decide what to buy", "plan"],
    ["which target mix did i choose", "show_target"],
    ["is my portfolio balanced", "rebalance"], ["rebalnce my stocks", "rebalance"], ["check if my mix is off", "rebalance"],
    ["how do i buy a stock", "stocks_help"], ["how does this investing work", "stocks_help"], ["what are tokenised stocks", "stocks_help"],
    ["i want to buy tesla stock", "buy_hint"], ["can i buy some nvidia", "buy_hint"], ["i would like to invest", "buy_hint"],
    ["i want to sell my tesla", ["sell", "sell_hint"]], ["can i sell some of my shares", "sell_hint"],
  ];

  it("none of the test phrases is in the training data (so this is a fair test)", () => {
    for (const [t] of CASES) expect(trained.has(normalise(t)), t).toBe(false);
  });

  it("understands at least 85% of them", () => {
    const ok = (t: string, want: string | string[]) => [want].flat().includes(intent(t) ?? "");
    const wrong = CASES.filter(([t, want]) => !ok(t, want)).map(([t, want]) => `${t} -> ${intent(t)} (wanted ${want})`);
    expect(CASES.length - wrong.length, `missed:\n${wrong.join("\n")}`).toBeGreaterThanOrEqual(Math.ceil(CASES.length * 0.85));
  });

  it("it understands at least 70% of its own training phrases (the rest are listed, to show where the data needs work)", () => {
    const real = STOCK_TRAINING.filter((e) => e.label !== "other");
    const wrong = real.filter((e) => {
      const r = parseStockRequestSmart(e.text);
      return !r || (r.intent !== e.label && !(e.label === "sell_hint" && r.intent === "sell") && !(e.label === "quote" && r.intent === "research"));
    });
    expect(real.length - wrong.length, `missed:\n${wrong.map((e) => `${e.label}: ${e.text} -> ${parseStockRequestSmart(e.text)?.intent}`).join("\n")}`).toBeGreaterThanOrEqual(Math.ceil(real.length * 0.7));
  });
});

describe("it must NOT claim messages that are not about stocks", () => {
  const NOT_STOCKS = [
    "hello", "hi there", "good evening", "thanks a lot", "ok", "yes please", "no thanks", "cancel that", "menu", "help",
    "invoice", "create invoice for 2000", "i want to send an invoice", "show invoices", "list my invoices", "pending invoices",
    "balance", "whats my balance", "how much do i have in my wallet", "check my wallet", "my balance please",
    "top up", "top up 5000", "add money to my account", "deposit", "i want to fund my account",
    "cash out", "cashout 20000", "withdraw", "send my money to my bank", "i want to withdraw to gtbank",
    "add product", "new product shoes 3000", "list my products", "my shop", "business profile", "set my currency to ngn", "change currency",
    "payments", "show my payments", "did my customer pay", "has anyone paid me", "recent transactions", "payment history",
    "verify me", "start verification", "send money", "transfer to john", "buy airtime for 500", "pay electricity",
    "i have a problem with my payment", "my money has not arrived", "where is my payment", "support", "talk to someone",
    "how do i get paid", "can my customers pay with usdc", "send my customer a link", "what is the fee", "how much does this cost",
    "good night", "bye", "asante sana", "habari yako", "lol", "great", "what is your name", "who made you", "are you a bot",
    "my account number", "show my pin", "i forgot my pin", "how do i change my number",
  ];

  it("claims none of them", () => {
    const claimed = NOT_STOCKS.filter((t) => parseStockRequestSmart(t) !== null).map((t) => `${t} -> ${parseStockRequestSmart(t)!.intent}`);
    expect(claimed).toEqual([]);
  });

  it("does not claim empty text, a slash command or a very long message", () => {
    expect(parseStockRequestSmart("")).toBeNull();
    expect(parseStockRequestSmart("/invoice")).toBeNull();
    expect(parseStockRequestSmart("show my stocks ".repeat(30))).toBeNull();
  });
});

describe("how the layers combine", () => {
  it("the precise patterns still win, and are unchanged", () => {
    expect(parseStockRequestSmart("buy 5000 of tesla")).toMatchObject({ intent: "buy", query: "tesla", amount: 5000 });
    expect(parseStockRequestSmart("sell half my nvda")).toMatchObject({ intent: "sell", fraction: 0.5 });
    expect(parseStockRequestSmart("why is nvidia up")).toMatchObject({ intent: "research" });
  });

  it("NEVER turns a loose phrase into an order: wanting to buy only gets a nudge", () => {
    for (const t of ["i wanna buy some nvidia", "get me some tesla", "i want to purchase stock", "sell my shares", "i want out of nvidia"]) {
      const r = parseStockRequestSmart(t);
      expect(["buy_hint", "sell_hint", "sell", null], t).toContain(r?.intent ?? null);
    }
  });

  it("takes the stock out of a message, even misspelled, and leaves the typo for the fuzzy matcher", () => {
    expect(stockWords("how much is nvdia right now")).toBe("nvdia");
    expect(stockWords("whats the price of apple today")).toBe("apple");
    expect(stockWords("my stocks")).toBe("");
    expect(parseStockRequestSmart("nvdia price")).toEqual({ intent: "quote", query: "nvdia" });
  });

  it("a price needs a stock: 'what is the price' alone is not claimed as a quote", () => {
    expect(parseStockRequestSmart("price")?.intent ?? null).not.toBe("quote");
  });

  it("a budget in a loose plan question is picked up", () => {
    const r = parseStockRequestSmart("what should i invest 3000 in");
    expect(r).toMatchObject({ intent: "plan", budget: 3000 });
  });
});

describe("is this a follow-up to a stock conversation?", () => {
  it("yes when it refers back, carries on, or is a very short question", () => {
    for (const t of ["Can it go up", "will it recover?", "is that a good price", "and Nvidia?", "what about meta", "how about the other one", "why?", "so should I wait", "what if it drops", "is it risky"]) {
      expect(looksLikeFollowUp(t), t).toBe(true);
    }
  });

  it("no when it is about another part of the app, however it is phrased", () => {
    for (const t of ["is my invoice paid", "what is my balance", "can i cash out", "how do i top up", "can it send a payment", "verify my account", "my bank account", "reset my pin", "contact support"]) {
      expect(looksLikeFollowUp(t), t).toBe(false);
    }
  });

  it("no for plain statements, thanks, greetings, slash commands, empty and very long text", () => {
    for (const t of ["thanks", "ok", "hello", "good morning", "I like tesla", "/stocks", "", "   ", "x ".repeat(150)]) {
      expect(looksLikeFollowUp(t), JSON.stringify(t.slice(0, 20))).toBe(false);
    }
  });
});

