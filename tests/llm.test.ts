import { describe, it, expect, vi, beforeEach } from "vitest";

const cfg: any = vi.hoisted(() => ({ logLevel: "silent", llm: { apiKey: "key", baseUrl: "https://api.meta.ai/v1", model: "muse-spark-1.3", reasoningEffort: "" } }));
vi.mock("@/config", () => ({ config: cfg }));

import { createOpenAiCompatibleClient, createConfiguredLlm, trainsOnInputs, LlmError } from "@/services/llm";

const ok = (text: any) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: text } }] }) }) as any;
const opts = (over: Record<string, any> = {}) => ({ apiKey: "sk-secret", baseUrl: "https://api.meta.ai/v1", model: "muse-spark-1.3", ...over });

beforeEach(() => {
  cfg.llm = { apiKey: "key", baseUrl: "https://api.meta.ai/v1", model: "muse-spark-1.3", reasoningEffort: "" };
});

describe("it will not use a model that trains on what it is sent", () => {
  it.each(["muse-spark-1.3-contributor", "muse-spark-1.2-contributor", "MUSE-SPARK-1.3-CONTRIBUTOR", "meta/muse-spark-1.3-contributor"])("refuses %s", (model) => {
    expect(trainsOnInputs(model)).toBe(true);
    expect(() => createOpenAiCompatibleClient(opts({ model }))).toThrow(/trains on what it is sent/);
  });
  it.each(["muse-spark-1.3", "muse-spark-1.1", "gpt-4o", "claude-sonnet-5-5"])("allows %s", (model) => {
    expect(trainsOnInputs(model)).toBe(false);
    expect(() => createOpenAiCompatibleClient(opts({ model }))).not.toThrow();
  });
});

describe("it refuses to be set up unsafely", () => {
  it("without a key, a model, or an https base URL", () => {
    expect(() => createOpenAiCompatibleClient(opts({ apiKey: "" }))).toThrow(/API key/);
    expect(() => createOpenAiCompatibleClient(opts({ model: "" }))).toThrow(/model name/);
    expect(() => createOpenAiCompatibleClient(opts({ baseUrl: "http://api.meta.ai/v1" }))).toThrow(/https/);
    expect(() => createOpenAiCompatibleClient(opts({ baseUrl: "api.meta.ai/v1" }))).toThrow(/https/);
  });
});

describe("the request", () => {
  it("is a Chat Completions call with a bearer key, the model, the messages, a token cap and a low temperature", async () => {
    const fetchImpl = vi.fn(async () => ok("hello"));
    const text = await createOpenAiCompatibleClient(opts({ fetchImpl })).complete([{ role: "user", content: "hi" }], { maxTokens: 300 });
    expect(text).toBe("hello");
    const [url, init] = fetchImpl.mock.calls[0] as any;
    expect(url).toBe("https://api.meta.ai/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json", Authorization: "Bearer sk-secret" });
    expect(JSON.parse(init.body)).toEqual({ model: "muse-spark-1.3", messages: [{ role: "user", content: "hi" }], max_tokens: 300, temperature: 0.2 });
  });

  it("sends reasoning_effort only when it was configured", async () => {
    const fetchImpl = vi.fn(async () => ok("x"));
    await createOpenAiCompatibleClient(opts({ fetchImpl, reasoningEffort: "low" })).complete([{ role: "user", content: "hi" }]);
    expect(JSON.parse((fetchImpl.mock.calls[0] as any)[1].body).reasoning_effort).toBe("low");
    const none = vi.fn(async () => ok("x"));
    await createOpenAiCompatibleClient(opts({ fetchImpl: none })).complete([{ role: "user", content: "hi" }]);
    expect(JSON.parse((none.mock.calls[0] as any)[1].body)).not.toHaveProperty("reasoning_effort");
  });

  it("defaults to a modest token cap", async () => {
    const fetchImpl = vi.fn(async () => ok("x"));
    await createOpenAiCompatibleClient(opts({ fetchImpl })).complete([{ role: "user", content: "hi" }]);
    expect(JSON.parse((fetchImpl.mock.calls[0] as any)[1].body).max_tokens).toBe(700);
  });
});

describe("when it goes wrong", () => {
  const client = (fetchImpl: any) => createOpenAiCompatibleClient(opts({ fetchImpl }));
  const messages = [{ role: "user" as const, content: "my secret question" }];

  it("an error status becomes an LlmError that does NOT include the response body, which can echo the prompt", async () => {
    const e = await client(async () => ({ ok: false, status: 429, text: async () => "echo: my secret question", json: async () => ({}) })).complete(messages).catch((x) => x);
    expect(e).toBeInstanceOf(LlmError);
    expect(e.status).toBe(429);
    expect(e.message).toBe("Model returned 429");
    expect(e.message).not.toContain("secret");
  });

  it("a network error, and a timeout, are reported plainly", async () => {
    await expect(client(async () => { throw new Error("ECONNRESET 10.0.0.1:443"); }).complete(messages)).rejects.toThrow("Model request failed: network error");
    const timeout = Object.assign(new Error("t"), { name: "TimeoutError" });
    await expect(client(async () => { throw timeout; }).complete(messages)).rejects.toThrow("timed out");
  });

  it("a reply that is not JSON, or has no text, is an error, not an empty answer", async () => {
    await expect(client(async () => ({ ok: true, status: 200, json: async () => { throw new Error("bad"); } })).complete(messages)).rejects.toThrow("not JSON");
    await expect(client(async () => ok("")).complete(messages)).rejects.toThrow("no text");
    await expect(client(async () => ok("   ")).complete(messages)).rejects.toThrow("no text");
    await expect(client(async () => ok(null)).complete(messages)).rejects.toThrow("no text");
    await expect(client(async () => ({ ok: true, status: 200, json: async () => ({ choices: [] }) })).complete(messages)).rejects.toThrow("no text");
  });

  it("the key never appears in an error", async () => {
    const e = await client(async () => ({ ok: false, status: 401, json: async () => ({}) })).complete(messages).catch((x) => x);
    expect(String(e.message)).not.toContain("sk-secret");
  });
});

describe("createConfiguredLlm", () => {
  it("is off (null) without a key", () => {
    cfg.llm.apiKey = "";
    expect(createConfiguredLlm()).toBeNull();
  });
  it("is off, not a crash, with a training model configured", () => {
    cfg.llm.model = "muse-spark-1.3-contributor";
    expect(createConfiguredLlm()).toBeNull();
  });
  it("is off with a bad base URL", () => {
    cfg.llm.baseUrl = "http://insecure";
    expect(createConfiguredLlm()).toBeNull();
  });
  it("gives a client when configured", () => {
    expect(createConfiguredLlm()).not.toBeNull();
  });
  it("is off when nothing is configured at all", () => {
    delete cfg.llm;
    expect(createConfiguredLlm()).toBeNull();
  });
});
