import { ChatOpenAI } from "@langchain/openai";
import { trainsOnInputs } from "@/services/llm";
import { createLogger } from "@/utils/logger";

const logger = createLogger("chat-model");

// ============================================
// The chat model for the LangGraph agent
//
// Any OpenAI-compatible provider (Groq, Meta's Model API, ...), through LangChain's client. It keeps the rules the
// hand-written client had:
//   - it refuses a model that trains on what it is sent, and a base URL that is not https;
//   - a request that fails in a way that often clears up is tried again (see `retryingFetch`);
//   - a timeout and a token cap bound every call;
//   - it never logs prompts or answers.
// ============================================

type Sleep = (ms: number) => Promise<void>;

/**
 * Wrap `fetch` so a response that often clears up on the next try is repeated, up to `attempts` times in all:
 *   - 404 (a provider can say "model not found" for a valid key for a moment), 429, and any 5xx;
 *   - a 400 whose error code is tool_use_failed (the model wrote a tool call the provider could not parse).
 * The provider's Retry-After wins over our own wait, within 5 seconds. A bad key, a refusal or any other 400 is
 * returned straight away. Network errors and timeouts are not retried (already slow). Only the error CODE of a
 * 400 is read, never logged: its body can echo the prompt.
 */
export function retryingFetch(base: typeof fetch = fetch, options: { attempts?: number; sleep?: Sleep } = {}): typeof fetch {
  const attempts = Math.max(1, options.attempts ?? 3);
  const sleep: Sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  return (async (input: any, init?: any) => {
    for (let attempt = 1; ; attempt++) {
      const res: Response = await base(input, init);
      let retry = res.status === 404 || res.status === 429 || res.status >= 500;
      if (!retry && res.status === 400) {
        try {
          retry = ((await res.clone().json()) as any)?.error?.code === "tool_use_failed";
        } catch {
          /* not readable: not retried */
        }
      }
      if (!retry || attempt >= attempts) return res;
      const header = Number(res.headers?.get?.("retry-after"));
      const asked = Number.isFinite(header) && header > 0 ? header * 1000 : 0;
      logger.warn("Model request failed; trying again", { status: res.status, attempt, of: attempts });
      await sleep(Math.min(5000, Math.max(400 * 2 ** (attempt - 1), asked)));
    }
  }) as typeof fetch;
}

export interface ChatModelConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  reasoningEffort?: string;
  maxTokens?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  attempts?: number;
  sleep?: Sleep;
}

export function createChatModel(c: ChatModelConfig): ChatOpenAI {
  if (!c.apiKey) throw new Error("The model client needs an API key");
  if (!/^https?:\/\//i.test(c.baseUrl) || (!/^https:\/\//i.test(c.baseUrl) && !c.fetchImpl)) throw new Error("The model base URL must be https");
  if (!c.model) throw new Error("The model client needs a model name");
  if (trainsOnInputs(c.model)) throw new Error(`Refusing to use "${c.model}": it trains on what it is sent. Use the non-contributor model.`);

  return new ChatOpenAI({
    model: c.model,
    apiKey: c.apiKey,
    temperature: 0.2,
    maxTokens: c.maxTokens ?? 3000,
    timeout: c.timeoutMs ?? 30_000,
    maxRetries: 0, // retrying is done by retryingFetch, which knows this provider's quirks
    ...(c.reasoningEffort ? { modelKwargs: { reasoning_effort: c.reasoningEffort } } : {}),
    configuration: { baseURL: c.baseUrl, fetch: retryingFetch(c.fetchImpl ?? fetch, { attempts: c.attempts, sleep: c.sleep }) },
  });
}
