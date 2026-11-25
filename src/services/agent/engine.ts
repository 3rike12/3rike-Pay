export type AgentEngine = "langgraph" | "custom";

/**
 * Which agent answers research questions. LangGraph (with conversation memory) is the default; STOCKS_AGENT_ENGINE=custom
 * switches back to the original hand-written loop. Anything else, including nothing, means LangGraph.
 */
export function resolveAgentEngine(value: string | undefined): AgentEngine {
  return String(value ?? "").trim().toLowerCase() === "custom" ? "custom" : "langgraph";
}
