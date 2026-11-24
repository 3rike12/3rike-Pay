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
    expect(JSON.parse((fetchImpl.mock.calls[0] as any)[1].body).max_tokens).toBe(2000);
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

describe("a reasoning model that runs out of tokens", () => {
  it("says so plainly instead of the vague 'no text'", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: "length", message: { content: null } }] }) })) as any;
    const client = createOpenAiCompatibleClient({ apiKey: "k", baseUrl: "https://api.test/v1", model: "m", fetchImpl });
    await expect(client.complete([{ role: "user", content: "hi" }])).rejects.toThrow("ran out of tokens");
  });
});

describe("chat with tools", () => {
  const ok = (message: any, finish = "stop") => vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: finish, message }] }) })) as any;
  const client = (fetchImpl: any) => createOpenAiCompatibleClient({ apiKey: "k", baseUrl: "https://api.test/v1", model: "m", fetchImpl });

  it("sends the tools, and reads the tool calls the model makes", async () => {
    const f = ok({ content: "I'll look.", tool_calls: [{ id: "c1", type: "function", function: { name: "get_news", arguments: '{"ticker":"NVDA"}' } }] }, "tool_calls");
    const reply = await client(f).chat([{ role: "user", content: "hi" }], { tools: [{ name: "get_news", description: "d", parameters: { type: "object", properties: {} } }] });
    expect(reply).toEqual({ content: "I'll look.", toolCalls: [{ id: "c1", name: "get_news", arguments: '{"ticker":"NVDA"}' }], finishReason: "tool_calls" });
    const sent = JSON.parse(f.mock.calls[0][1].body);
    expect(sent.tools[0]).toEqual({ type: "function", function: { name: "get_news", description: "d", parameters: { type: "object", properties: {} } } });
    expect(sent.tool_choice).toBe("auto");
  });

  it("sends tool results back in the wire format, with the call id", async () => {
    const f = ok({ content: "Done." });
    await client(f).chat([
      { role: "user", content: "q" },
      { role: "assistant", content: null, toolCalls: [{ id: "c1", name: "get_news", arguments: "{}" }] },
      { role: "tool", toolCallId: "c1", content: "{}" },
    ]);
    const sent = JSON.parse(f.mock.calls[0][1].body);
    expect(sent.messages[1]).toEqual({ role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "get_news", arguments: "{}" } }] });
    expect(sent.messages[2]).toEqual({ role: "tool", tool_call_id: "c1", content: "{}" });
    expect(sent.tools).toBeUndefined();
  });

  it("ignores malformed tool calls, and an answer with neither text nor calls is an error", async () => {
    const r = await client(ok({ content: "x", tool_calls: [{ type: "function" }, { id: "a", type: "other", function: { name: "n" } }] })).chat([{ role: "user", content: "q" }]);
    expect(r.toolCalls).toEqual([]);
    await expect(client(ok({ content: null }, "length")).chat([{ role: "user", content: "q" }])).rejects.toThrow("ran out of tokens");
  });
});

describe("telling a missing model from a bad key", () => {
  const failing = (status: number, body: any) => vi.fn(async () => ({ ok: false, status, json: async () => body })) as any;
  const client = (fetchImpl: any) => createOpenAiCompatibleClient({ apiKey: "k", baseUrl: "https://api.test/v1", model: "m-1", fetchImpl });

  it("an access error still reads 'Model returned 404' to the caller, with nothing else in the message", async () => {
    await expect(client(failing(404, { error: { message: "model not found: m-1" } })).complete([{ role: "user", content: "a private question" }])).rejects.toThrow(/^Model returned 404$/);
  });

  it("a 400 never puts the provider's text, which can echo the prompt, into the error", async () => {
    const f = vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: { code: "bad_request", message: "bad request: a private question" } }) })) as any;
    const err = await client(f).complete([{ role: "user", content: "a private question" }]).catch((e) => e);
    expect(err.message).toBe("Model returned 400");
    expect(f).toHaveBeenCalledTimes(1); // and an ordinary 400 is not retried
  });
});

describe("verifyConfiguredModel", () => {
  const models = (ids: string[], status = 200) => vi.fn(async () => ({ ok: status === 200, status, json: async () => ({ data: ids.map((id) => ({ id })) }) })) as any;

  it("is off with no key, ok when the model is listed, 'missing' when it is not", async () => {
    const { verifyConfiguredModel } = await import("@/services/llm");
    const { config } = await import("@/config");
    (config as any).llm = { apiKey: "", baseUrl: "https://api.test/v1", model: "muse-spark-1.3" };
    expect(await verifyConfiguredModel(models(["muse-spark-1.3"]))).toBe("off");
    (config as any).llm = { apiKey: "k", baseUrl: "https://api.test/v1", model: "muse-spark-1.3" };
    expect(await verifyConfiguredModel(models(["a", "muse-spark-1.3"]))).toBe("ok");
    expect(await verifyConfiguredModel(models(["a", "b"]))).toBe("missing");
  });

  it("never throws: an error status, an empty list or a network failure is just 'unchecked'", async () => {
    const { verifyConfiguredModel } = await import("@/services/llm");
    const { config } = await import("@/config");
    (config as any).llm = { apiKey: "k", baseUrl: "https://api.test/v1", model: "m" };
    expect(await verifyConfiguredModel(models([], 403))).toBe("unchecked");
    expect(await verifyConfiguredModel(models([]))).toBe("unchecked");
    expect(await verifyConfiguredModel((async () => { throw new Error("net"); }) as any)).toBe("unchecked");
  });
});

describe("retrying what often clears up", () => {
  const reply = (status: number) =>
    status === 200
      ? { ok: true, status, json: async () => ({ choices: [{ finish_reason: "stop", message: { content: "hi" } }] }) }
      : { ok: false, status, json: async () => ({ error: { message: "The requested model was not found." } }) };
  const sequence = (...statuses: number[]) => {
    let i = 0;
    return vi.fn(async () => reply(statuses[Math.min(i++, statuses.length - 1)])) as any;
  };
  const make = (fetchImpl: any, attempts?: number) =>
    createOpenAiCompatibleClient({ apiKey: "k", baseUrl: "https://api.test/v1", model: "m", fetchImpl, attempts, sleep: async () => {} });
  const ask = (c: any) => c.complete([{ role: "user", content: "q" }]);

  it("a model-not-found that clears up on the next try gives the answer", async () => {
    const f = sequence(404, 200);
    expect(await ask(make(f))).toBe("hi");
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("rate limits and server errors are tried again too", async () => {
    expect(await ask(make(sequence(429, 503, 200)))).toBe("hi");
  });

  it("a real, lasting 404 still ends in the same error, after three tries and not more", async () => {
    const f = sequence(404);
    await expect(ask(make(f))).rejects.toThrow(/^Model returned 404$/);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("a bad request, a bad key and a refusal are NOT retried", async () => {
    for (const status of [400, 401, 403, 422]) {
      const f = sequence(status);
      await expect(ask(make(f))).rejects.toThrow(String(status));
      expect(f).toHaveBeenCalledTimes(1);
    }
  });

  it("a timeout is not retried, because it is already slow", async () => {
    const f = vi.fn(async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); }) as any;
    await expect(ask(make(f))).rejects.toThrow("timed out");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("the number of tries can be set, including just one", async () => {
    const f = sequence(404);
    await expect(ask(make(f, 1))).rejects.toThrow("404");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("chat with tools retries the same way", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(reply(404))
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: "stop", message: { content: "done" } }] }) }) as any;
    expect((await make(f).chat([{ role: "user", content: "q" }])).content).toBe("done");
  });
});

describe("provider quirks (Groq and similar)", () => {
  const make = (fetchImpl: any, sleeps: number[] = []) =>
    createOpenAiCompatibleClient({ apiKey: "k", baseUrl: "https://api.test/v1", model: "m", fetchImpl, sleep: async (ms) => void sleeps.push(ms) });
  const ok = { ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: "stop", message: { content: "fine" } }] }) };

  it("a malformed tool call (a 400 with code tool_use_failed) is tried again, without logging what the model wrote", async () => {
    const bad = { ok: false, status: 400, json: async () => ({ error: { code: "tool_use_failed", message: "Failed to call a function", failed_generation: "<function=x>secret</function>" } }) };
    const f = vi.fn().mockResolvedValueOnce(bad).mockResolvedValueOnce(ok) as any;
    expect((await make(f).complete([{ role: "user", content: "q" }]))).toBe("fine");
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("waits as long as the provider asks after a rate limit, but never more than 5 seconds", async () => {
    const limited = (secs: string) => ({ ok: false, status: 429, headers: { get: (h: string) => (h === "retry-after" ? secs : null) }, json: async () => ({}) });
    const sleeps: number[] = [];
    await make(vi.fn().mockResolvedValueOnce(limited("3")).mockResolvedValueOnce(ok) as any, sleeps).complete([{ role: "user", content: "q" }]);
    expect(sleeps).toEqual([3000]);
    const long: number[] = [];
    await make(vi.fn().mockResolvedValueOnce(limited("60")).mockResolvedValueOnce(ok) as any, long).complete([{ role: "user", content: "q" }]);
    expect(long).toEqual([5000]);
  });

  it("sends no reasoning_effort unless one is configured", async () => {
    const f = vi.fn(async () => ok) as any;
    await make(f).complete([{ role: "user", content: "q" }]);
    expect(JSON.parse(f.mock.calls[0][1].body)).not.toHaveProperty("reasoning_effort");
  });
});
