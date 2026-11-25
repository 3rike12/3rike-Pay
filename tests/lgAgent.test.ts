import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import http from "http";
import type { AddressInfo } from "net";

vi.mock("@/config", () => ({ config: { logLevel: "silent" } }));

import { createChatModel, retryingFetch } from "@/services/agent/chatModel";
import { createAgentMemory, threadIdFor, type AgentMemory } from "@/services/agent/memory";
import { askAgentLangGraph, priorNumbers } from "@/services/agent/lgAgent";
import { buildPlans } from "@/services/planBuilder";
import type { ToolDeps } from "@/services/agent/stockTools";
import { HumanMessage, AIMessage, ToolMessage } from "@langchain/core/messages";

// ---- a stand-in for the model API: it plays a script and records every request it is sent ----
type Reply = { content?: string | null; tool_calls?: Array<{ name: string; args: unknown }>; status?: number };
const server = { queue: [] as Reply[], requests: [] as any[], url: "", responses: 0 }; // `responses` never resets: a real provider never repeats a response id
let httpServer: http.Server;

beforeAll(async () => {
  httpServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = body ? JSON.parse(body) : {};
      server.requests.push(parsed);
      const r = server.queue.shift() ?? { content: JSON.stringify({ answer: "(nothing scripted)" }) };
      if (r.status && r.status !== 200) {
        res.writeHead(r.status, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "scripted failure", code: r.content ?? undefined } }));
      }
      const calls = (r.tool_calls ?? []).map((c, i) => ({ id: `call_${server.responses + 1}_${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: `chatcmpl-${++server.responses}`, object: "chat.completion", created: 1, model: "m",
        choices: [{ index: 0, finish_reason: calls.length ? "tool_calls" : "stop", message: { role: "assistant", content: r.content ?? null, ...(calls.length ? { tool_calls: calls } : {}) } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    });
  });
  await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
  server.url = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/v1`;
});
afterAll(() => httpServer.close());

const say = (answer: string, extra: object = {}): Reply => ({ content: JSON.stringify({ answer, ...extra }) });
const call = (name: string, args: unknown = {}): Reply => ({ tool_calls: [{ name, args }] });

const tk = (n: number, ticker: string, name: string): any => ({ address: "0x" + n.toString(16).padStart(40, "0"), symbol: ticker + "c", ticker, name, decimals: 8, multiplier: 1 });
const NVDA = tk(1, "NVDA", "NVIDIA Corporation");
const TSLA = tk(2, "TSLA", "Tesla, Inc.");

const toolDeps = (over: Partial<ToolDeps> = {}): ToolDeps => ({
  currency: "KES",
  stocks: async () => [NVDA, TSLA],
  source: { id: "f", forTicker: async () => [], quote: async (t) => ({ ticker: t, price: 384.68, previousClose: 385.4, changePercent: -0.2, asOf: "2026-11-24" }) },
  priceStats: async () => null,
  portfolio: async () => ({ positions: [], positionCount: 0, largestPositionPercent: null, largestPositionTicker: null, recurringBuys: [] }),
  rebalance: async () => ({ status: "no_target" as const }),
  plans: async ({ budget, candidates }) => buildPlans({ budget, minOrder: 500, candidates: candidates.map((c) => ({ ticker: c.ticker, volatility: "unknown" as const, currentWeightPercent: null })) }),
  ...over,
});

// LangGraph stamps checkpoints with the real clock, so the test clock is expressed relative to it.
let clock = Date.now();
let memory: AgentMemory;
const model = () => createChatModel({ apiKey: "k", baseUrl: server.url, model: "m", fetchImpl: fetch, sleep: async () => {} });
const A = "user_aaaaaaaa-1111";
const B = "user_bbbbbbbb-2222";
const ask = (userId: string | undefined, question: string, over: Partial<ToolDeps> = {}, hints?: any) =>
  askAgentLangGraph({ model: model(), memory }, { userId, question, hints, deps: toolDeps(over) });
const sentText = (requestIndex: number) => JSON.stringify(server.requests[requestIndex].messages);

beforeEach(async () => {
  server.queue.length = 0;
  server.requests.length = 0;
  clock = Date.now();
  memory = await createAgentMemory({ now: () => clock });
});

describe("the agent runs on LangGraph and picks its own tools", () => {
  it("looks something up, then answers using only what the tool returned", async () => {
    server.queue.push(call("get_quote", { ticker: "TSLA" }), say("Tesla is $384.68, down 0.2% since the previous close."));
    const r: any = await ask(A, "price of tesla", {}, { tickers: ["TSLA"] });
    expect(r).toMatchObject({ kind: "ok", toolsUsed: ["get_quote"] });
    expect(r.text).toContain("$384.68");
    // the model was offered our seven tools, with the rules in its instructions
    const tools = server.requests[0].tools.map((t: any) => t.function.name).sort();
    expect(tools).toEqual(["build_plans", "check_target_mix", "find_stock", "get_my_portfolio", "get_news", "get_price_history", "get_quote"]);
    expect(JSON.stringify(server.requests[0].messages)).toContain("You cannot place orders");
  });

  it("an invented number is thrown away, exactly as before", async () => {
    server.queue.push(call("get_quote", { ticker: "TSLA" }), say("Tesla is $999.99 right now."));
    expect(await ask(A, "price of tesla")).toMatchObject({ kind: "fallback" });
  });

  it("a plan comes only from build_plans, and the amounts are ours", async () => {
    const hints = { budget: { amount: 5000, currency: "KES", frequency: "weekly" as const } };
    server.queue.push(call("build_plans", { budget: 5000, frequency: "weekly", tickers: ["NVDA", "TSLA"] }), say("An even split spreads it.", { planId: "even" }));
    const r: any = await ask(A, "I have 5000 a week, what should I buy", {}, hints);
    expect(r.suggestions).toEqual(["buy 2500 of NVDA every week", "buy 2500 of TSLA every week"]);
    server.queue.push(say("Try this.", { planId: "even" })); // never called build_plans this time
    expect(((await ask(B, "I have 5000 a week", {}, hints)) as any).suggestions).toEqual([]);
  });

  it("a failing tool reaches the model only as 'unavailable', and the run goes on", async () => {
    server.queue.push(call("get_quote", { ticker: "TSLA" }), say("I couldn't get a price just now."));
    const r: any = await ask(A, "price of tesla", { source: { id: "f", forTicker: async () => [], quote: async () => { throw new Error("P1001 db.internal:5432 secret"); } } });
    expect(r.kind).toBe("ok");
    expect(sentText(1)).toContain("That tool is unavailable right now.");
    expect(sentText(1)).not.toMatch(/5432|P1001|secret/);
  });

  it("with no model it is off", async () => {
    expect(await askAgentLangGraph({ model: null, memory }, { userId: A, question: "hi", deps: toolDeps() })).toMatchObject({ kind: "unavailable" });
  });

  it("a model that cannot be reached gives a plain message, nothing internal", async () => {
    server.queue.push({ status: 401 });
    const r: any = await ask(A, "price of tesla");
    expect(r).toMatchObject({ kind: "fallback" });
    expect(r.text).not.toMatch(/401|scripted|Error/);
  });
});

describe("conversation memory, kept by the framework, one thread per person", () => {
  it("a follow-up sees the earlier turn, and may repeat a number from it without a new lookup", async () => {
    server.queue.push(call("get_quote", { ticker: "TSLA" }), say("Tesla is $384.68, down 0.2%."));
    await ask(A, "price of tesla");
    server.queue.length = 0;
    server.requests.length = 0;
    server.queue.push(say("Nobody can know. It is at $384.68 today, a small dip."));
    const r: any = await ask(A, "can it go up");
    expect(r.kind).toBe("ok");
    // the earlier question and answer were sent to the model with the new one
    expect(sentText(0)).toContain("price of tesla");
    expect(sentText(0)).toContain("Tesla is $384.68");
    expect(sentText(0)).toContain("can it go up");
  });

  it("without that history the same answer is rejected: the number came from nowhere", async () => {
    server.queue.push(say("Nobody can know. It is at $384.68 today."));
    expect(await ask(B, "can it go up")).toMatchObject({ kind: "fallback" });
  });

  it("two people's conversations never mix, in either direction", async () => {
    server.queue.push(say("Noted about SECRET-A-NVIDIA."));
    await ask(A, "my private question SECRET-A-NVIDIA");
    server.queue.push(say("Noted about SECRET-B-TESLA."));
    await ask(B, "my private question SECRET-B-TESLA");
    server.requests.length = 0;

    server.queue.push(say("Fine."));
    await ask(A, "and what about now");
    server.queue.push(say("Fine."));
    await ask(B, "and what about now");
    expect(sentText(0)).toContain("SECRET-A-NVIDIA");
    expect(sentText(0)).not.toContain("SECRET-B-TESLA");
    expect(sentText(1)).toContain("SECRET-B-TESLA");
    expect(sentText(1)).not.toContain("SECRET-A-NVIDIA");
  });

  it("a person who has never spoken sees nothing of anyone else's", async () => {
    server.queue.push(say("Noted."));
    await ask(A, "SECRET-A anything");
    server.requests.length = 0;
    server.queue.push(say("Hello."));
    await ask("user_cccccccc-3333", "hello");
    expect(sentText(0)).not.toContain("SECRET-A");
  });

  it("a conversation that has been quiet for 30 minutes starts clean", async () => {
    server.queue.push(say("Noted OLD-TOPIC."));
    await ask(A, "OLD-TOPIC question");
    clock = Date.now() + 31 * 60_000; // 31 minutes later
    server.requests.length = 0;
    server.queue.push(say("Hello."));
    await ask(A, "a new topic");
    expect(sentText(0)).not.toContain("OLD-TOPIC");
    // ...but 5 minutes after THAT, the conversation is kept
    server.requests.length = 0;
    clock = Date.now() + 5 * 60_000;
    server.queue.push(say("Still here."));
    await ask(A, "and another");
    expect(sentText(0)).toContain("a new topic");
  });

  it("an id that is not one of ours gets no memory at all, and leaves nothing behind", async () => {
    for (const bad of ["*", "", "a:b", "user_*", "x".repeat(100), undefined]) {
      server.queue.push(say("Noted BAD-ID-TOPIC."));
      await ask(bad as any, "BAD-ID-TOPIC");
    }
    server.requests.length = 0;
    server.queue.push(say("Hi."));
    await ask("*", "hello");
    expect(sentText(0)).not.toContain("BAD-ID-TOPIC");
    for (const bad of ["*", "", "a:b", "user_*"]) expect(threadIdFor(bad)).toBeNull();
    expect(threadIdFor(A)).toBe(`stock:${A}`);
  });

  it("the conversation is trimmed so it cannot grow without limit", async () => {
    for (let i = 0; i < 20; i++) {
      server.queue.push(say(`answer ${i}`));
      await ask(A, `question ${i}`);
    }
    const lastBody = server.requests[server.requests.length - 1].messages;
    expect(lastBody.length).toBeLessThanOrEqual(28); // 24 kept + instructions + this turn
    expect(JSON.stringify(lastBody)).toContain("question 19");
    expect(JSON.stringify(lastBody)).not.toContain("question 0\"");
  });
});

describe("which numbers a follow-up may reuse", () => {
  it("what the person typed, tool data, and our earlier answers: never this turn's answer or unverified text beside a tool call", () => {
    const msgs = [
      new HumanMessage("I own 7 shares"),
      new AIMessage({ content: "let me check, it may be 111", tool_calls: [{ id: "t1", name: "get_quote", args: {} }] }),
      new ToolMessage({ content: '{"price_usd": 384.68}', tool_call_id: "t1" }),
      new AIMessage("It is 384.68."),
      new HumanMessage("and now?"),
      new AIMessage("It is 555.55."), // this turn's own answer
    ];
    const nums = priorNumbers(msgs);
    expect(nums).toContain(7);
    expect(nums).toContain(384.68);
    expect(nums).not.toContain(111);
    expect(nums).not.toContain(555.55);
  });
});

describe("the model client's retry policy, at the HTTP level", () => {
  const res = (status: number, body: any = {}, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
  const seq = (...rs: Array<() => Response>) => {
    let i = 0;
    return vi.fn(async () => rs[Math.min(i++, rs.length - 1)]()) as any;
  };
  const wrapped = (base: any, attempts?: number, sleeps: number[] = []) => retryingFetch(base, { attempts, sleep: async (ms) => void sleeps.push(ms) });

  it("a 404 that clears up, a 429 and a 5xx are tried again", async () => {
    expect((await wrapped(seq(() => res(404), () => res(429), () => res(503), () => res(200)), 4)("u")).status).toBe(200);
  });

  it("a lasting 404 is returned after three tries", async () => {
    const f = seq(() => res(404));
    expect((await wrapped(f)("u")).status).toBe(404);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("a malformed tool call (400 tool_use_failed) is tried again; any other 400, a bad key and a refusal are not", async () => {
    expect((await wrapped(seq(() => res(400, { error: { code: "tool_use_failed" } }), () => res(200)))("u")).status).toBe(200);
    for (const status of [400, 401, 403, 422]) {
      const f = seq(() => res(status, { error: { code: "other" } }));
      expect((await wrapped(f)("u")).status).toBe(status);
      expect(f).toHaveBeenCalledTimes(1);
    }
  });

  it("waits as long as the provider asks, never more than 5 seconds", async () => {
    const sleeps: number[] = [];
    await wrapped(seq(() => res(429, {}, { "retry-after": "3" }), () => res(200)), 3, sleeps)("u");
    expect(sleeps).toEqual([3000]);
    const long: number[] = [];
    await wrapped(seq(() => res(429, {}, { "retry-after": "60" }), () => res(200)), 3, long)("u");
    expect(long).toEqual([5000]);
  });

  it("a network error is not retried", async () => {
    const f = vi.fn(async () => { throw new Error("socket hang up"); }) as any;
    await expect(wrapped(f)("u")).rejects.toThrow("socket hang up");
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("the chat model's safety rules", () => {
  it("refuses a model that trains on what it is sent, a missing key, and a base URL that is not https", () => {
    const ok = { apiKey: "k", baseUrl: "https://api.test/v1", model: "m" };
    expect(() => createChatModel({ ...ok, model: "muse-spark-1.3-contributor" })).toThrow("trains on what it is sent");
    expect(() => createChatModel({ ...ok, apiKey: "" })).toThrow("API key");
    expect(() => createChatModel({ ...ok, baseUrl: "http://api.test/v1" })).toThrow("https");
    expect(() => createChatModel({ ...ok, model: "" })).toThrow("model name");
    expect(() => createChatModel(ok)).not.toThrow();
  });
});
