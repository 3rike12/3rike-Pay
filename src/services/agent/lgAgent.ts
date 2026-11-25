import { randomUUID } from "crypto";
import { createAgent, createMiddleware, tool } from "langchain";
import { RemoveMessage, trimMessages, type BaseMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { REMOVE_ALL_MESSAGES } from "@langchain/langgraph";
import { createToolRunner } from "@/services/agent/loop";
import { buildStockTools, newRunState } from "@/services/agent/stockTools";
import { SYSTEM_PROMPT, finalizeAnswer, numbersIn, userMessage, type AgentAnswer, type AgentRequest } from "@/services/agent/stockAgent";
import type { AgentMemory } from "@/services/agent/memory";
import { SAFE_FALLBACK } from "@/services/stockResearch";
import { createLogger } from "@/utils/logger";

const logger = createLogger("stock-agent-lg");

// ============================================
// The stock agent on LangGraph
//
// The same agent as stockAgent.ts, run by LangGraph, with the framework's own memory. What is the same, on purpose:
//   - every tool call goes through the shared ToolRunner (limits, timeouts, no internal errors leaked, data labelled);
//   - the final answer goes through the shared finalizeAnswer (numbers must come from tools, a plan id must come from
//     build_plans, our disclaimer and news credit are added by us).
// What LangGraph adds is the conversation: the agent runs in THIS PERSON'S THREAD, so "can it go up?" has something to
// refer to. Nothing is shared between people.
// ============================================

/** Most messages kept in a conversation; older ones are dropped so it cannot grow without limit. */
const KEEP_MESSAGES = 24;

const trimConversation = createMiddleware({
  name: "TrimConversation",
  beforeModel: async (state: { messages: BaseMessage[] }) => {
    if (state.messages.length <= KEEP_MESSAGES) return;
    // Keep the most recent messages, starting on a person's message so a tool call is never separated from its result.
    const kept = await trimMessages(state.messages, { strategy: "last", maxTokens: KEEP_MESSAGES, tokenCounter: (m) => m.length, startOn: "human", includeSystem: false });
    return { messages: [new RemoveMessage({ id: REMOVE_ALL_MESSAGES }), ...kept] };
  },
});

const textOf = (m: BaseMessage): string => {
  const c = m.content as unknown;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p: any) => (typeof p === "string" ? p : typeof p?.text === "string" ? p.text : "")).join("");
  return "";
};

const isToolCaller = (m: BaseMessage) => Array.isArray((m as any).tool_calls) && (m as any).tool_calls.length > 0;

/**
 * Numbers from EARLIER turns that a follow-up may repeat: what the person typed, the data tools returned, and our own
 * earlier answers (which already passed the checks). Never this turn's answer, and never text the model wrote
 * alongside a tool call, which nothing has verified.
 */
export function priorNumbers(messages: BaseMessage[]): number[] {
  let lastHuman = -1;
  messages.forEach((m, i) => {
    if (m.getType() === "human") lastHuman = i;
  });
  const out: number[] = [];
  for (const m of messages.slice(0, Math.max(0, lastHuman))) {
    const type = m.getType();
    if (type === "human" || type === "tool" || (type === "ai" && !isToolCaller(m))) numbersIn(textOf(m), out);
  }
  return out;
}

export async function askAgentLangGraph(deps: { model: BaseChatModel | null; memory: AgentMemory }, req: AgentRequest): Promise<AgentAnswer> {
  if (!deps.model) return { kind: "unavailable", news: [], toolsUsed: [] };

  const state = newRunState();
  const tools = buildStockTools(req.deps, state);
  const runner = createToolRunner(tools);
  const lcTools = tools.map((t) =>
    tool(async (args: unknown) => runner.run(t.spec.name, JSON.stringify(args ?? {})), {
      name: t.spec.name,
      description: t.spec.description,
      schema: t.spec.parameters as any,
    })
  );

  // THIS person's thread. Without a usable id there is no memory: a one-off thread nobody else can name, removed after.
  const own = req.userId ? await deps.memory.threadFor(req.userId) : null;
  const threadId = own ?? `stock:once:${randomUUID()}`;

  const agent = createAgent({
    model: deps.model,
    tools: lcTools,
    systemPrompt: SYSTEM_PROMPT,
    checkpointer: deps.memory.checkpointer,
    middleware: [trimConversation],
  });

  try {
    const result = await agent.invoke(
      { messages: [{ role: "user", content: userMessage(req) }] },
      { configurable: { thread_id: threadId }, recursionLimit: 14, signal: AbortSignal.timeout(60_000) }
    );
    const messages = result.messages as BaseMessage[];
    const last = messages[messages.length - 1];
    const text = last && last.getType() === "ai" && !isToolCaller(last) ? textOf(last) : null;
    logger.info("Agent finished", { messages: messages.length, tools: runner.records.length, remembered: !!own });
    return finalizeAnswer({ text: text || null, req, records: runner.records, state, priorNumbers: priorNumbers(messages) });
  } catch (error: any) {
    logger.warn("The agent could not complete", { error: error?.name === "GraphRecursionError" ? "too many steps" : error?.message });
    const toolsUsed = [...new Set(runner.records.map((r) => r.tool))];
    return error?.name === "GraphRecursionError"
      ? { kind: "fallback", text: SAFE_FALLBACK, news: [], toolsUsed }
      : { kind: "fallback", text: "I couldn't reach the research assistant just now. Please try again in a moment.", news: [], toolsUsed };
  } finally {
    if (!own) await deps.memory.checkpointer.deleteThread(threadId).catch(() => undefined);
  }
}
