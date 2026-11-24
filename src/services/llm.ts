import { config } from "@/config";
import { createLogger } from "@/utils/logger";

const logger = createLogger("llm");

// ============================================
// A small client for any OpenAI-compatible chat model
//
// The rest of the app talks to `LlmClient` (plain text in, text out) and `ChatModel`
// (messages and tool calls), so the provider can change without touching it, and
// tests use a fake. This one speaks Chat Completions, which Meta's Model API and
// most others accept, including native tool calling.
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

// ----- chat with tools -----

export interface ToolCall {
  id: string;
  name: string;
  /** The arguments exactly as the model wrote them: a JSON string, not yet trusted. */
  arguments: string;
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

/** A tool the model may ask for. `parameters` is a JSON Schema object. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatReply {
  content: string | null;
  toolCalls: ToolCall[];
  finishReason: string;
}

export interface ChatModel {
  chat(messages: ChatMessage[], options?: { tools?: ToolSpec[]; maxTokens?: number }): Promise<ChatReply>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** True when asking again is likely to work (a malformed tool call, say). */
    readonly retryable = false,
    /** How long the provider asked us to wait, if it said. */
    readonly retryAfterMs?: number
  ) {
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
  /** How many times to try a request that fails in a way that often clears up. Default 3. */
  attempts?: number;
  /** Wait between tries; replaceable so tests need not wait. */
  sleep?: (ms: number) => Promise<void>;
}

/** A model whose terms say it trains on what it is sent. Never allowed. */
const safeHost = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return "invalid url";
  }
};

export const trainsOnInputs = (model: string) => /-contributor\b/i.test(model);

function toWire(m: ChatMessage): Record<string, unknown> {
  if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
  if (m.role === "assistant") {
    return {
      role: "assistant",
      content: m.content,
      ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })) } : {}),
    };
  }
  return { role: m.role, content: m.content };
}

export function createOpenAiCompatibleClient(o: OpenAiCompatibleOptions): LlmClient & ChatModel {
  if (!o.apiKey) throw new Error("The model client needs an API key");
  if (!/^https:\/\//i.test(o.baseUrl)) throw new Error("The model base URL must be https");
  if (!o.model) throw new Error("The model client needs a model name");
  if (trainsOnInputs(o.model)) {
    throw new Error(`Refusing to use "${o.model}": it trains on what it is sent. Use the non-contributor model.`);
  }
  const doFetch = o.fetchImpl ?? fetch;
  const attempts = Math.max(1, o.attempts ?? 3);
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  /**
   * A provider can answer "model not found" (404), rate-limit (429) or fail (5xx) for a moment and then be fine,
   * and a request is safe to repeat (it only reads). So those are tried again after a short wait. A timeout is NOT
   * retried (it is already slow), and neither is a bad request or a bad key.
   */
  async function request(messages: unknown[], maxTokens: number, tools?: ToolSpec[]): Promise<any> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await requestOnce(messages, maxTokens, tools);
      } catch (error) {
        const status = error instanceof LlmError ? error.status : undefined;
        const transient = (error instanceof LlmError && error.retryable) || status === 404 || status === 429 || (status !== undefined && status >= 500);
        if (!transient || attempt >= attempts) throw error;
        logger.warn("Model request failed; trying again", { status, attempt, of: attempts });
        // The provider's own "try again in N seconds" wins over our guess, within reason.
        const asked = error instanceof LlmError ? error.retryAfterMs : undefined;
        await sleep(Math.min(5000, Math.max(400 * 2 ** (attempt - 1), asked ?? 0)));
      }
    }
  }

  /** One request; returns the first choice. Shared by `complete` and `chat`. */
  async function requestOnce(messages: unknown[], maxTokens: number, tools?: ToolSpec[]): Promise<any> {
    const body: Record<string, unknown> = {
      model: o.model,
      messages,
      max_tokens: maxTokens,
      temperature: 0.2,
      ...(o.reasoningEffort ? { reasoning_effort: o.reasoningEffort } : {}),
      ...(tools?.length ? { tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })), tool_choice: "auto" } : {}),
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
      const header = Number(res.headers?.get?.("retry-after"));
      const retryAfterMs = Number.isFinite(header) && header > 0 ? header * 1000 : undefined;
      // Some models now and then write a tool call in a form the provider cannot parse and report it as a 400. It
      // is the model's own slip, not our request, and the next try usually works. Only the error CODE is read.
      if (res.status === 400) {
        let code: unknown;
        try {
          code = ((await res.json()) as any)?.error?.code;
        } catch {
          /* not readable */
        }
        if (code === "tool_use_failed") throw new LlmError("Model returned 400", 400, true);
      }
      // A response body can echo the prompt, so it is never logged in general. For access problems (bad key,
      // no permission, unknown model) the provider's short error message says what to fix and holds no prompt.
      let detail: string | undefined;
      if (res.status === 401 || res.status === 403 || res.status === 404) {
        try {
          const body: any = await res.json();
          const m = body?.error?.message ?? body?.message;
          if (typeof m === "string") detail = m.replace(/\s+/g, " ").slice(0, 200);
        } catch {
          /* no readable message */
        }
      }
      logger.warn("Model returned an error", { status: res.status, model: o.model, host: safeHost(o.baseUrl), ...(detail ? { detail } : {}) });
      throw new LlmError(`Model returned ${res.status}`, res.status, false, retryAfterMs);
    }
    let json: any;
    try {
      json = await res.json();
    } catch {
      throw new LlmError("Model reply was not JSON");
    }
    return json?.choices?.[0];
  }

  const outOfTokens = (choice: any) =>
    new LlmError(choice?.finish_reason === "length" ? "Model ran out of tokens before answering (raise the limit or lower the reasoning effort)" : "Model reply had no text");

  return {
    async complete(messages, options = {}) {
      const choice = await request(messages, options.maxTokens ?? 2000);
      const text = choice?.message?.content;
      // A reasoning model spends its token budget thinking first; running out leaves no answer at all.
      if (typeof text !== "string" || !text.trim()) throw outOfTokens(choice);
      return text;
    },

    async chat(messages, options = {}) {
      const choice = await request(messages.map(toWire), options.maxTokens ?? 3000, options.tools);
      const message = choice?.message;
      const calls: ToolCall[] = (Array.isArray(message?.tool_calls) ? message.tool_calls : [])
        .filter((c: any) => c?.type === "function" && typeof c?.function?.name === "string")
        .map((c: any) => ({ id: String(c.id ?? ""), name: c.function.name, arguments: typeof c.function.arguments === "string" ? c.function.arguments : JSON.stringify(c.function.arguments ?? {}) }));
      const content = typeof message?.content === "string" && message.content.trim() ? message.content : null;
      if (content === null && calls.length === 0) throw outOfTokens(choice);
      return { content, toolCalls: calls, finishReason: String(choice?.finish_reason ?? "") };
    },
  };
}

/** The configured model, or null when no key is set (the research assistant is then simply off). */
export function createConfiguredLlm(): (LlmClient & ChatModel) | null {
  const c = (config as any).llm ?? {};
  if (!c.apiKey) return null;
  try {
    return createOpenAiCompatibleClient({ apiKey: c.apiKey, baseUrl: c.baseUrl, model: c.model, reasoningEffort: c.reasoningEffort || undefined });
  } catch (error: any) {
    logger.error("Could not set up the model; the research assistant stays off", { error: error?.message });
    return null;
  }
}

/**
 * At startup, ask the provider which models this key can use and say so in the log if the configured one is
 * not among them. Turns a puzzling 404 on the first question into a clear line at boot. Never throws and
 * never blocks startup; it logs the model name and host only, never the key.
 */
export async function verifyConfiguredModel(fetchImpl: typeof fetch = fetch): Promise<"ok" | "missing" | "unchecked" | "off"> {
  const c = (config as any).llm ?? {};
  if (!c.apiKey) return "off";
  try {
    const res = await fetchImpl(`${c.baseUrl}/models`, { headers: { Authorization: `Bearer ${c.apiKey}` }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      logger.warn("Could not check the research model", { status: res.status, host: safeHost(c.baseUrl) });
      return "unchecked";
    }
    const ids: string[] = ((await res.json()) as any)?.data?.map((m: any) => String(m?.id)) ?? [];
    if (ids.length === 0) return "unchecked";
    if (!ids.includes(c.model)) {
      logger.error("The configured research model is not available to this API key", { model: c.model, host: safeHost(c.baseUrl), available: ids.slice(0, 12) });
      return "missing";
    }
    logger.info("Research model is available", { model: c.model, host: safeHost(c.baseUrl) });
    return "ok";
  } catch (error: any) {
    logger.warn("Could not check the research model", { error: error?.name === "TimeoutError" ? "timed out" : "network error" });
    return "unchecked";
  }
}
