import { ToolInputError, type AgentTool } from "@/services/agent/loop";
import { findStock, type StockToken } from "@/services/stocks";
import type { ResearchSource, SourceItem } from "@/services/researchSources";
import type { PriceStats } from "@/services/priceHistory";
import type { PortfolioFacts } from "@/services/portfolioContext";
import type { RebalancePlan } from "@/services/rebalancePlan";
import type { Plan } from "@/services/planBuilder";

// ============================================
// The stock agent's toolbox
//
// Seven tools the model may choose from. Every one is READ-ONLY: none places an order,
// moves money or changes anything. Rules that hold for all of them:
//   - They are built for ONE person and ONE request. The person is fixed inside each tool
//     and the model never passes a user id, so it cannot ask about anyone else.
//   - Tickers are checked against the real catalogue; an unknown one is refused with a
//     message that tells the model how to find the right one.
//   - What a tool returns is compact, whitelisted data. The amount a person paid for a
//     holding is never returned; only percentages are.
//   - Anything a tool says is a number we computed or a provider reported, which is what
//     lets the final answer be checked against them.
// ============================================

export interface ToolDeps {
  /** The person's balance currency, which plan amounts are in. */
  currency: string;
  stocks(): Promise<StockToken[]>;
  source: ResearchSource | null;
  priceStats(address: string): Promise<PriceStats | null>;
  portfolio(): Promise<PortfolioFacts>;
  rebalance(): Promise<RebalancePlan>;
  /** The current time, replaceable for tests. */
  now?: () => number;
  /** Build and price plan options for a budget over some stocks. */
  plans(input: { budget: number; candidates: StockToken[] }): Promise<Plan[]>;
}

/** What happened during one run that the final answer is checked against. */
export interface RunState {
  /** The plan options built in this run, by id. Only these can ever be suggested. */
  plans: Map<string, Plan>;
  budget?: { amount: number; currency: string; frequency?: "daily" | "weekly" | "monthly" };
  /** News and earnings fetched, so we can credit the sources ourselves. */
  news: SourceItem[];
}

export const newRunState = (): RunState => ({ plans: new Map(), news: [] });

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const TICKER = { type: "string", description: "A stock ticker such as NVDA. Use find_stock first if you only have a company name." };

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export function buildStockTools(deps: ToolDeps, state: RunState): AgentTool[] {
  async function token(raw: unknown): Promise<StockToken> {
    const t = String(raw ?? "").trim().toUpperCase();
    if (!t) throw new ToolInputError("A ticker is required.");
    const hit = (await deps.stocks()).find((s) => s.ticker.toUpperCase() === t);
    if (!hit) throw new ToolInputError(`There is no stock with ticker "${t.slice(0, 12)}". Use find_stock to look one up by name.`);
    return hit;
  }
  const tickerArgs = (a: unknown) => ({ ticker: String(asRecord(a).ticker ?? "").trim().toUpperCase().slice(0, 12) });

  const findStockTool: AgentTool = {
    spec: { name: "find_stock", description: "Look up a stock we offer by company name or ticker. Returns its ticker, or the options when it is ambiguous.", parameters: obj({ query: { type: "string", description: "A company name or ticker, e.g. 'nvidia'." } }, ["query"]) },
    parse: (a) => {
      const query = String(asRecord(a).query ?? "").trim().slice(0, 60);
      if (!query) throw new ToolInputError("A query is required.");
      return { query };
    },
    async run({ query }) {
      const hit = findStock(await deps.stocks(), query);
      if (hit.kind === "found") return { result: "found", ticker: hit.stock.ticker, name: hit.stock.name };
      if (hit.kind === "ambiguous") return { result: "ambiguous", options: hit.matches.slice(0, 5).map((s) => ({ ticker: s.ticker, name: s.name })) };
      return { result: "none" };
    },
  };

  const quoteTool: AgentTool = {
    spec: { name: "get_quote", description: "The current price of the company's shares in USD and how much it has changed since the previous close, in percent. Use it to see whether and how far a stock has moved.", parameters: obj({ ticker: TICKER }, ["ticker"]) },
    parse: tickerArgs,
    async run({ ticker }) {
      await token(ticker);
      if (!deps.source?.quote) return { available: false, reason: "No price source is configured." };
      const q = await deps.source.quote(ticker);
      if (!q) return { available: false, reason: "No quote is available for this stock right now." };
      return { available: true, ticker: q.ticker, price_usd: q.price, change_since_previous_close_percent: q.changePercent, previous_close_usd: q.previousClose, as_of: q.asOf };
    },
  };

  const newsTool: AgentTool = {
    spec: { name: "get_news", description: "Recent news headlines (last 7 days) and earnings reports for a stock, each with its source and date. Use it to look for reasons a stock moved. News is evidence that something may be related, not proof of why a price moved.", parameters: obj({ ticker: TICKER }, ["ticker"]) },
    parse: tickerArgs,
    async run({ ticker }) {
      await token(ticker);
      if (!deps.source) return { available: false, reason: "No news source is configured.", items: [] };
      const items = await deps.source.forTicker(ticker);
      state.news.push(...items);
      // How old each item is, so the answer can say "two days ago" and not present stale news as today's explanation.
      const now = (deps.now ?? Date.now)();
      // Whole calendar days: an item dated today is 0 days old however late in the day it is asked.
      const today = Date.parse(new Date(now).toISOString().slice(0, 10));
      const daysAgo = (date: string) => Math.max(0, Math.round((today - Date.parse(date)) / 86_400_000));
      return { available: true, items: items.map((i) => ({ type: i.kind, date: i.date, ...(i.kind === "news" ? { days_ago: daysAgo(i.date) } : {}), source: i.source, headline: i.headline, ...(i.summary ? { summary: i.summary } : {}) })) };
    },
  };

  const historyTool: AgentTool = {
    spec: { name: "get_price_history", description: "How the stock has behaved over recent weeks, from prices we recorded: the 7 and 30 day change, the worst drop in 30 days and a low/medium/high volatility label. Fields are null when we have not recorded enough history.", parameters: obj({ ticker: TICKER }, ["ticker"]) },
    parse: tickerArgs,
    async run({ ticker }) {
      const t = await token(ticker);
      const s = await deps.priceStats(t.address);
      if (!s || s.historyDays === 0) return { available: false, reason: "We have not recorded enough price history for this stock yet." };
      return { available: true, change_7d_percent: s.change7dPercent, change_30d_percent: s.change30dPercent, worst_drop_30d_percent: s.drawdown30dPercent, volatility: s.volatility, days_of_history: s.historyDays };
    },
  };

  const portfolioTool: AgentTool = {
    spec: { name: "get_my_portfolio", description: "What THIS person holds: each stock with their share count, its weight in their portfolio, their gain or loss against what they paid (percent), how long they have held it, and their active recurring buys. Use it for questions about their own holdings or whether to hold, sell or add.", parameters: obj({}) },
    parse: () => ({}),
    async run() {
      const p = await deps.portfolio();
      return {
        holdings: p.positions.map((x) => ({ ticker: x.ticker, name: x.name, shares: x.shares, weight_percent: x.weightPercent, gain_or_loss_percent: x.profitLossPercent, days_held: x.heldDays })),
        count: p.positionCount,
        largest_holding: p.largestPositionTicker ? { ticker: p.largestPositionTicker, weight_percent: p.largestPositionPercent } : null,
        recurring_buys: p.recurringBuys.map((r) => ({ ticker: r.ticker, amount: r.amount, currency: r.currency, frequency: r.frequency })),
      };
    },
  };

  const targetTool: AgentTool = {
    spec: { name: "check_target_mix", description: "Whether THIS person's holdings match the target mix they set. Returns each stock's target and actual weight. If they have drifted, tell them to send 'rebalance' to see the trades; you cannot rebalance for them.", parameters: obj({}) },
    parse: () => ({}),
    async run() {
      const p = await deps.rebalance();
      if (p.status === "no_target") return { status: "no_target", note: "They have not set a target mix." };
      if (p.status === "unpriced") return { status: "unpriced", note: "A held stock cannot be priced right now." };
      const rows = p.status === "nothing_held" || p.status === "balanced" || p.status === "trades" ? p.rows.map((r) => ({ ticker: r.token.ticker, target_percent: r.targetPercent, actual_percent: r.actualPercent })) : [];
      if (p.status === "nothing_held") return { status: "nothing_held", rows };
      return { status: p.status === "balanced" ? "on_target" : "drifted", biggest_gap_points: p.maxDrift, rows };
    },
  };

  const plansTool: AgentTool = {
    spec: {
      name: "build_plans",
      description: "Build ready-made allocation options for a budget (in the person's own currency). Returns plans, each with an id, the amount per stock and notes. This is the ONLY way to suggest buying: pick one plan and return its id as planId. Never invent amounts.",
      parameters: obj({
        budget: { type: "number", description: "How much they can put in, in their own currency." },
        frequency: { type: "string", enum: ["daily", "weekly", "monthly"], description: "How often, if they said." },
        tickers: { type: "array", items: { type: "string" }, description: "Up to 5 tickers to spread across. Omit to use a default set." },
      }, ["budget"]),
    },
    parse: (a) => {
      const r = asRecord(a);
      const budget = Number(r.budget);
      if (!Number.isFinite(budget) || budget <= 0 || budget > 1e9) throw new ToolInputError("budget must be a positive number.");
      const frequency = ["daily", "weekly", "monthly"].includes(String(r.frequency)) ? (String(r.frequency) as "daily" | "weekly" | "monthly") : undefined;
      const tickers = Array.isArray(r.tickers) ? r.tickers.map((t) => String(t).trim().toUpperCase().slice(0, 12)).filter(Boolean).slice(0, 5) : [];
      return { budget: Math.round(budget * 100) / 100, frequency, tickers };
    },
    maxCalls: 3,
    async run({ budget, frequency, tickers }) {
      let candidates: StockToken[];
      if (tickers.length) candidates = await Promise.all(tickers.map((t: string) => token(t)));
      else candidates = (await deps.stocks()).slice(0, 5);
      const plans = await deps.plans({ budget, candidates });
      state.budget = { amount: budget, currency: deps.currency, ...(frequency ? { frequency } : {}) };
      state.plans.clear(); // only the latest budget's plans can be suggested
      for (const p of plans) state.plans.set(p.id, p);
      if (plans.length === 0) return { plans: [], reason: "The budget is too small for the minimum order, or there is nothing to spread it across." };
      return {
        currency: deps.currency,
        budget,
        plans: plans.map((p) => ({ id: p.id, title: p.title, notes: p.notes, lines: p.lines.map((l) => ({ ticker: l.ticker, amount: l.amount, percent: l.percent, ...(l.impactPercent !== undefined ? { price_impact_percent: l.impactPercent } : {}) })) })),
      };
    },
  };

  return [findStockTool, quoteTool, newsTool, historyTool, portfolioTool, targetTool, plansTool];
}
