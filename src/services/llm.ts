import { config } from "@/config";
import { createLogger } from "@/utils/logger";

const logger = createLogger("llm");

// ============================================
// A small client for any OpenAI-compatible chat model
//
// The rest of the app talks to `LlmClient`, so the provider can change without
// touching it, and tests use a fake. This one speaks Chat Completions, which
// Meta's Model API and most others accept.
//
// Rules it enforces:
//  - It refuses a model that trains on your inputs. Meta labels those SKUs
//    "-contributor" ("used to improve our products"); sending people's questions
//    there would feed them to the provider.
//  - It never logs prompts or answers (they hold what people asked about).
//  - A request has a timeout and a token cap, so one slow or runaway call cannot
//    hold up a person or run up a bill.
// ============================================

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmClient {
  /** The model's text reply. Throws LlmError if the model cannot be reached or answers badly. */
  complete(messages: LlmMessage[], options?: { maxTokens?: number }): Promise<string>;
}

export class LlmError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "LlmError";
  }
}

export interface OpenAiCompatibleOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  reasoningEffort?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** A model whose terms say it trains on what it is sent. Never allowed. */
export const trainsOnInputs = (model: string) => /-contributor\b/i.test(model);

export function createOpenAiCompatibleClient(o: OpenAiCompatibleOptions): LlmClient {
  if (!o.apiKey) throw new Error("The model client needs an API key");
  if (!/^https:\/\//i.test(o.baseUrl)) throw new Error("The model base URL must be https");
  if (!o.model) throw new Error("The model client needs a model name");
  if (trainsOnInputs(o.model)) {
    throw new Error(`Refusing to use "${o.model}": it trains on what it is sent. Use the non-contributor model.`);
  }
  const doFetch = o.fetchImpl ?? fetch;

  return {
    async complete(messages, options = {}) {
      const body: Record<string, unknown> = {
        model: o.model,
        messages,
        max_tokens: options.maxTokens ?? 700,
        temperature: 0.2,
        ...(o.reasoningEffort ? { reasoning_effort: o.reasoningEffort } : {}),
      };
      let res: Response;
      try {
        res = await doFetch(`${o.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${o.apiKey}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(o.timeoutMs ?? 30_000),
        });
      } catch (error: any) {
        throw new LlmError(`Model request failed: ${error?.name === "TimeoutError" ? "timed out" : "network error"}`);
      }
      if (!res.ok) {
        // Never include the response body: it can echo the prompt.
        logger.warn("Model returned an error", { status: res.status });
        throw new LlmError(`Model returned ${res.status}`, res.status);
      }
      let json: any;
      try {
        json = await res.json();
      } catch {
        throw new LlmError("Model reply was not JSON");
      }
      const text = json?.choices?.[0]?.message?.content;
      if (typeof text !== "string" || !text.trim()) throw new LlmError("Model reply had no text");
      return text;
    },
  };
}

/** The configured model, or null when no key is set (the research assistant is then simply off). */
export function createConfiguredLlm(): LlmClient | null {
  const c = (config as any).llm ?? {};
  if (!c.apiKey) return null;
  try {
    return createOpenAiCompatibleClient({ apiKey: c.apiKey, baseUrl: c.baseUrl, model: c.model, reasoningEffort: c.reasoningEffort || undefined });
  } catch (error: any) {
    logger.error("Could not set up the model; the research assistant stays off", { error: error?.message });
    return null;
  }
}
