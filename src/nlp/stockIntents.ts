import { trainClassifier, normalise, type Classifier } from "@/nlp/classifier";
import { STOCK_TRAINING } from "@/nlp/stockTrainingData";
import { closeWords } from "@/nlp/fuzzy";
import { knownStockWords } from "@/services/stocks";
import { FILLER, RESEARCH_FILLER, parseStockRequest, researchQueries, takeAmount, takeCurrency, type StockRequest } from "@/utils/stockNlu";

// ============================================
// Understanding everyday stock messages without the big model
//
// Two layers, in order:
//   1. The precise patterns in stockNlu (exact amounts, schedules, "buy 5000 of tesla").
//   2. A tiny local classifier for what the patterns miss: typos, short-hand, paraphrases.
//
// The classifier is held to strict rules:
//   - It only handles READ-ONLY requests (list, holdings, price, research, plan, targets, rebalance
//     check) plus hints. Anything that would spend money still needs the exact patterns; a loosely
//     worded "i wanna buy nvidia" only gets a nudge on how to say it, never an order.
//   - It must be confident and clearly ahead of the runner-up, or the message is not claimed.
//   - It knows what is NOT about stocks ("other": invoices, balance, top-up, greetings), so the
//     stock handler, which sees messages first, does not swallow them.
//   - It never calls any model or network.
// ============================================

export const MIN_CONFIDENCE = 0.85;
export const MIN_MARGIN = 0.6;

let model: Classifier | null = null;
const classifier = () => (model ??= trainClassifier(STOCK_TRAINING));

/** Words that say what is being asked, not which stock. */
const NOISE = new Set([
  ...FILLER,
  ...RESEARCH_FILLER,
  "price", "prices", "quote", "check", "cost", "costs", "trading", "current", "currently", "right", "much", "show", "tell", "wats", "whats",
  "what", "how", "is", "are", "doing", "does", "get", "purchase", "invest", "buy", "sell", "wanna", "id", "ill", "go", "this", "that", "up", "down",
  "hisa", "bei", "ya", "zangu", "u", "ur", "any", "news", "about", "think", "analyse", "analyze", "explain", "me", "tokenised",
]);

/** The words left after taking out everything that is not a stock name. May be empty, may contain a typo. */
export function stockWords(text: string): string {
  return normalise(text)
    .split(" ")
    .filter((w) => w && !NOISE.has(w) && !/^\d/.test(w))
    .join(" ");
}

/** Words that put a message in the stock domain. Without one of these, or a company name, the classifier stays silent. */
const ANCHOR = /\bwhat (?:should|to) (?:i )?buy\b|\bwhere (?:should|can) i (?:put|invest)\b|\b(stocks?|stoks?|stcks?|shares?|portfolios?|porfolio|invest\w*|holdings?|rebalanc\w*|rebalenc\w*|tokeni[sz]ed|target|allocation|equit(?:y|ies)|hisa|diversif\w*|securities|mix)\b/;

/** Well-known companies, so "nvdia price" is recognised before the catalogue is even loaded. */
const COMPANIES = [
  "tesla", "nvidia", "apple", "microsoft", "meta", "facebook", "google", "alphabet", "amazon", "netflix", "coinbase", "palantir", "applovin", "amd",
  "intel", "oracle", "salesforce", "adobe", "uber", "airbnb", "disney", "nike", "visa", "mastercard", "paypal", "shopify", "spotify", "robinhood",
  "micron", "broadcom", "qualcomm", "berkshire", "jpmorgan", "walmart", "costco", "boeing", "snowflake", "microstrategy", "santander", "bloom",
];

/** Does the message mention something to do with stocks: a stock word, or a company (misspelled is fine)? */
export function mentionsStocks(text: string, extra: string[] = []): boolean {
  const n = normalise(text);
  if (ANCHOR.test(n)) return true;
  const vocab = new Set([...COMPANIES, ...extra]);
  return n.split(" ").some((w) => (w.length >= 3 ? vocab.has(w) : false) || (w.length >= 4 && closeWords(w, vocab).length > 0));
}

export function parseStockRequestSmart(input: string, extraWords: string[] = knownStockWords()): StockRequest | null {
  const text = (input || "").trim();
  if (!text || text.startsWith("/") || text.length > 300) return null;
  const exact = parseStockRequest(text);
  if (exact) return exact;
  if (!mentionsStocks(text, extraWords)) return null;

  // A misspelled "rebalance" is still "rebalance"; the words around it ("my stocks") would otherwise win.
  if (normalise(text).split(" ").some((w) => w.length >= 6 && closeWords(w, ["rebalance", "rebalancing"]).length > 0)) return { intent: "rebalance" };

  const p = classifier().classify(text);
  if (!p || p.label === "other" || p.confidence < MIN_CONFIDENCE || p.margin < MIN_MARGIN) return null;

  const query = stockWords(text);
  // Wanting to sell is wanting to sell, whatever else the words resemble. Never an order: only a nudge.
  if (/\b(sell|selling|sold|dump|exit|offload)\b/.test(normalise(text)) && p.label !== "research" && p.label !== "plan") {
    return { intent: "sell_hint", ...(query ? { query } : {}) };
  }
  switch (p.label) {
    case "list":
      return { intent: "list" };
    case "holdings":
      return { intent: "holdings" };
    case "show_target":
      return { intent: "show_target" };
    case "rebalance":
      return { intent: "rebalance" };
    case "stocks_help":
      return { intent: "stocks_help" };
    case "quote":
      return query ? { intent: "quote", query } : null; // a price needs a stock
    case "research":
      return { intent: "research", question: text, queries: researchQueries(normalise(text)) };
    case "plan": {
      const { text: noCurrency, currency } = takeCurrency(text);
      const { amount } = takeAmount(noCurrency);
      return { intent: "plan", question: text, ...(amount !== undefined ? { budget: amount } : {}), ...(currency ? { currency } : {}) };
    }
    case "buy_hint":
      return { intent: "buy_hint", ...(query ? { query } : {}) };
    case "sell_hint":
      return { intent: "sell_hint", ...(query ? { query } : {}) };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Follow-ups in a conversation
//
// "Can it go up?" means nothing alone but a lot right after talking about Tesla. When a stock conversation is
// active, a message that refers back ("it", "that"), carries on ("and...", "what about...", "why?") or is a very
// short question is a follow-up. It must not steal a message meant for another part of the app, so anything
// about invoices, balances, top-ups and the like is never a follow-up.
// ---------------------------------------------------------------------------

const REFERS_BACK = /\b(it|its|it's|that|this|those|them|they|the stock|the price|the company|that one|this one)\b/i;
const CONTINUES = /^(and|but|so|then|also|what about|how about|what if|why|how come|really)\b/i;
const OTHER_TOPIC = /\b(invoice|invoices|balance|top ?up|cash ?out|withdraw\w*|payment|payments|paid|product|products|shop|business|currency|verify|verification|kyc|bank|airtime|pin|password|transfer|receipt|support)\b/i;

export function looksLikeFollowUp(text: string): boolean {
  const t = (text || "").trim();
  if (!t || t.startsWith("/") || t.length > 200) return false;
  if (OTHER_TOPIC.test(t)) return false;
  const words = t.split(/\s+/).length;
  return REFERS_BACK.test(t) || CONTINUES.test(t) || (words <= 3 && /\?\s*$/.test(t));
}

