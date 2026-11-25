import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The REAL config module, read fresh for each set of environment variables. dotenv is switched off so the
// developer's own .env (and its real keys) can never leak into these tests.
vi.mock("dotenv", () => ({ default: { config: () => ({}) }, config: () => ({}) }));

const KEYS = ["STOCKS_LLM_PROVIDER", "STOCKS_LLM_API_KEY", "GROQ_API_KEY", "MODEL_API_KEY", "STOCKS_LLM_BASE_URL", "STOCKS_LLM_MODEL", "STOCKS_LLM_REASONING_EFFORT"];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  vi.resetModules();
});
afterEach(() => {
  for (const k of KEYS) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
});

const load = async (env: Record<string, string>) => {
  Object.assign(process.env, env);
  vi.resetModules();
  return ((await import("@/config")) as any).config.llm;
};

describe("the model provider settings", () => {
  it("defaults to Meta, with low reasoning effort", async () => {
    expect(await load({ STOCKS_LLM_API_KEY: "k" })).toMatchObject({ provider: "meta", baseUrl: "https://api.meta.ai/v1", model: "muse-spark-1.3", reasoningEffort: "low", apiKey: "k" });
  });

  it("STOCKS_LLM_PROVIDER=groq points at Groq with gpt-oss (Llama 3.3 was retired there) and low reasoning effort", async () => {
    const c = await load({ STOCKS_LLM_PROVIDER: "groq", STOCKS_LLM_API_KEY: "gk" });
    expect(c).toMatchObject({ provider: "groq", baseUrl: "https://api.groq.com/openai/v1", model: "openai/gpt-oss-120b", reasoningEffort: "low", apiKey: "gk" });
  });

  it("Groq also reads GROQ_API_KEY, and Meta does not", async () => {
    expect((await load({ STOCKS_LLM_PROVIDER: "groq", GROQ_API_KEY: "from-groq-var" })).apiKey).toBe("from-groq-var");
    expect((await load({ STOCKS_LLM_PROVIDER: "meta", GROQ_API_KEY: "from-groq-var" })).apiKey).toBe("");
  });

  it("any single value can still be set by hand, and an explicit empty effort turns it off", async () => {
    const c = await load({ STOCKS_LLM_PROVIDER: "groq", STOCKS_LLM_MODEL: "openai/gpt-oss-20b", STOCKS_LLM_REASONING_EFFORT: "medium", STOCKS_LLM_BASE_URL: "https://proxy.example/openai/v1/" });
    expect(c).toMatchObject({ model: "openai/gpt-oss-20b", reasoningEffort: "medium", baseUrl: "https://proxy.example/openai/v1" });
    expect((await load({ STOCKS_LLM_REASONING_EFFORT: "" })).reasoningEffort).toBe("");
  });

  it("an unknown provider name falls back to Meta rather than breaking", async () => {
    expect(await load({ STOCKS_LLM_PROVIDER: "nonsense" })).toMatchObject({ provider: "meta", baseUrl: "https://api.meta.ai/v1" });
  });
});
