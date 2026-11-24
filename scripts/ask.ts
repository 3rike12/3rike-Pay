/**
 * Ask the stock agent a question from the command line, with the real model and news provider.
 *
 *   npx ts-node -r tsconfig-paths/register --transpile-only scripts/ask.ts "why is nvidia stock up"
 *   npx ts-node -r tsconfig-paths/register --transpile-only scripts/ask.ts "I have 5000 a week, what should I buy" --budget 5000 --weekly
 *
 * The catalogue is the demo market (no database or Coinbase needed) and the portfolio is a small FAKE one,
 * so every tool can be exercised. Prints the tools the agent chose and the final message. Never prints a key.
 */
import { config } from "@/config";
import { createConfiguredLlm } from "@/services/llm";
import { createFinnhubSource } from "@/services/researchSources";
import { askAgent } from "@/services/agent/stockAgent";
import { demoStocks } from "@/services/venues/demo";
import { buildPlans } from "@/services/planBuilder";
import { renderResearch } from "@/services/stockResearch";

(async () => {
  const args = process.argv.slice(2);
  const question = args.find((a) => !a.startsWith("--"));
  if (!question) {
    console.log('Usage: scripts/ask.ts "why is nvidia stock up" [--budget 5000] [--weekly]');
    process.exit(1);
  }
  const bi = args.indexOf("--budget");
  const budget = bi >= 0 ? { amount: Number(args[bi + 1]), currency: "KES", ...(args.includes("--weekly") ? { frequency: "weekly" as const } : {}) } : undefined;

  const llm = createConfiguredLlm();
  const newsKey = (config as any).research?.newsApiKey;
  console.log(`Model: ${llm ? "configured" : "NOT configured"}   News: ${newsKey ? "configured" : "NOT configured"}\n`);
  const source = newsKey ? createFinnhubSource({ apiKey: newsKey, baseUrl: (config as any).research.newsBaseUrl }) : null;

  const stocks = demoStocks();
  const nvda = stocks.find((s) => s.ticker === "NVDA")!;
  const answer = await askAgent(llm, {
    question,
    hints: budget ? { budget } : undefined,
    deps: {
      currency: "KES",
      stocks: async () => stocks,
      source,
      priceStats: async () => null,
      // A FAKE portfolio for testing: 2 NVDA bought at an average that makes it +8%.
      portfolio: async () => ({
        positions: [{ ticker: "NVDA", name: nvda.name, shares: 2, weightPercent: 100, costUsd: 250, profitLossPercent: 8, heldDays: 12 }],
        positionCount: 1, largestPositionPercent: 100, largestPositionTicker: "NVDA", recurringBuys: [],
      }),
      rebalance: async () => ({ status: "no_target" as const }),
      plans: async ({ budget: b, candidates }) =>
        buildPlans({ budget: b, minOrder: 650, candidates: candidates.map((c) => ({ ticker: c.ticker, volatility: "unknown" as const, currentWeightPercent: c.ticker === "NVDA" ? 100 : 0 })) }),
    },
  });

  console.log(`Tools the agent chose: ${answer.toolsUsed.length ? answer.toolsUsed.join(", ") : "(none)"}\n`);
  if (answer.kind === "ok") console.log(renderResearch(answer, answer.news));
  else if (answer.kind === "fallback") console.log("FALLBACK:", answer.text);
  else console.log("The assistant is off (no model key).");
  process.exit(0);
})().catch((e) => {
  console.log("Failed:", e?.message);
  process.exit(1);
});
