/**
 * Try the LangGraph agent's conversation memory live, with the real model and market data.
 *
 *   npx ts-node -r tsconfig-paths/register --transpile-only scripts/ask-lg.ts
 *
 * Plays: person A asks about a stock, A asks a follow-up with no stock named, then person B asks the SAME follow-up.
 * B must not know what A was talking about. Uses the demo catalogue and in-memory (or AGENT_DB_URL) memory; no database
 * of yours is touched. Prints the answers and never a key.
 */
import { config } from "@/config";
import { createChatModel } from "@/services/agent/chatModel";
import { createAgentMemory } from "@/services/agent/memory";
import { askAgentLangGraph } from "@/services/agent/lgAgent";
import { createFinnhubSource } from "@/services/researchSources";
import { demoStocks } from "@/services/venues/demo";
import { buildPlans } from "@/services/planBuilder";
import { renderResearch } from "@/services/stockResearch";

(async () => {
  const c: any = (config as any).llm;
  if (!c.apiKey) {
    console.log("No model key is set (STOCKS_LLM_API_KEY).");
    process.exit(1);
  }
  const model = createChatModel({ apiKey: c.apiKey, baseUrl: c.baseUrl, model: c.model, reasoningEffort: c.reasoningEffort || undefined });
  const memory = await createAgentMemory({ connectionString: process.env.AGENT_DB_URL });
  const newsKey = (config as any).research?.newsApiKey;
  const source = newsKey ? createFinnhubSource({ apiKey: newsKey, baseUrl: (config as any).research.newsBaseUrl }) : null;
  const stocks = demoStocks();
  console.log(`Model: ${c.model} (${c.baseUrl.replace(/^https?:\/\//, "").split("/")[0]})   Memory: ${memory.kind}   Market data: ${source ? "on" : "off"}\n`);

  const deps = {
    currency: "KES",
    stocks: async () => stocks,
    source,
    priceStats: async () => null,
    portfolio: async () => ({ positions: [], positionCount: 0, largestPositionPercent: null, largestPositionTicker: null, recurringBuys: [] }),
    rebalance: async () => ({ status: "no_target" as const }),
    plans: async ({ budget, candidates }: any) => buildPlans({ budget, minOrder: 650, candidates: candidates.map((x: any) => ({ ticker: x.ticker, volatility: "unknown" as const, currentWeightPercent: null })) }),
  };

  const A = "user_demo_person_A_00000001";
  const B = "user_demo_person_B_00000002";
  const turn = async (who: string, id: string, question: string, tickers?: string[]) => {
    const t0 = Date.now();
    const a = await askAgentLangGraph({ model, memory }, { userId: id, question, hints: tickers ? { tickers } : undefined, deps });
    const text = a.kind === "ok" ? renderResearch(a, a.news).split("\n\n_This is general")[0] : `[${a.kind}] ${(a as any).text ?? ""}`;
    console.log(`${who}: ${question}\n   -> ${text.replace(/\n+/g, " ")}\n   (${((Date.now() - t0) / 1000).toFixed(1)}s, tools: ${a.toolsUsed.join(", ") || "none"})\n`);
  };

  await turn("Person A", A, "How about TSLA, what's the current price?", ["TSLA"]);
  await turn("Person A", A, "Can it go up?");
  await turn("Person B", B, "Can it go up?");
  await memory.close();
  process.exit(0);
})().catch((e) => {
  console.log("Failed:", e?.message);
  process.exit(1);
});
