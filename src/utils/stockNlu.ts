import { parseAmountFromText } from "@/utils/helpers";

// ============================================
// Natural language for stocks
//
// Turns "buy 5k of tesla", "put 2000 into apple every friday", "sell half my
// nvda", "how is msft doing", "my stocks", "stop my apple buys" into a
// structured request. It is deterministic on purpose, like the transfer and
// invoice parsers: the same message always gives the same answer, it runs
// offline, and it can be tested exhaustively.
//
// It ONLY understands. It never resolves a stock, never moves money, and never
// decides that a request is safe to carry out. The caller looks the stock up in
// the catalogue, then shows the person exactly what will happen and waits for
// "yes" before anything is debited. A misread therefore costs a re-ask, never
// money.
//
// It returns null for anything that is not clearly about stocks, so other
// handlers (invoices, transfers, top-ups) are never hijacked.
// ============================================

export type Frequency = "daily" | "weekly" | "monthly";

export interface Schedule {
  frequency: Frequency;
  /** 0 = Sunday .. 6 = Saturday, for weekly schedules that name a day. */
  weekday?: number;
  /** 1..28 for monthly schedules that name a day. */
  dayOfMonth?: number;
}

/** A currency the person named. Absent means "my balance currency". */
export type NamedCurrency = "USD" | "NGN" | "KES" | "TZS";

export type StockRequest =
  | { intent: "buy"; query: string; amount: number; currency?: NamedCurrency }
  | { intent: "recurring_buy"; query: string; amount: number; currency?: NamedCurrency; schedule: Schedule }
  | { intent: "sell"; query: string; amount?: number; currency?: NamedCurrency; fraction?: number }
  | { intent: "cancel_recurring"; query?: string }
  | { intent: "holdings" }
  | { intent: "quote"; query: string }
  | { intent: "list" };

const WEEKDAYS: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

/** Words that carry no meaning for finding the stock. */
const FILLER = new Set([
  "of", "in", "into", "on", "to", "for", "with", "from", "at", "the", "a", "an", "some", "my", "me", "i", "please", "pls",
  "stock", "stocks", "share", "shares", "worth", "now", "today", "balance", "using", "use", "it", "and", "then", "just",
  "can", "you", "could", "would", "want", "wanna", "need", "like", "lets", "let's", "us", "tokenized", "token",
]);

const NUMBER_WORDS = new Set([
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen",
  "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty", "thirty", "forty", "fifty", "sixty",
  "seventy", "eighty", "ninety", "hundred", "thousand", "million",
]);

/** Pull a currency out of the text and remove the words that named it. */
function takeCurrency(text: string): { text: string; currency?: NamedCurrency } {
  let currency: NamedCurrency | undefined;
  const rules: Array<[RegExp, NamedCurrency]> = [
    [/\$|\busd\b|\bdollars?\b|\bbucks?\b/gi, "USD"],
    [/₦|\bngn\b|\bnaira\b/gi, "NGN"],
    [/\bkes\b|\bksh\b|\bkshs\b|\bshillings? kenyan\b|\bkenyan shillings?\b/gi, "KES"],
    [/\btzs\b|\btsh\b|\btshs\b|\btanzanian shillings?\b/gi, "TZS"],
  ];
  let out = text;
  for (const [re, code] of rules) {
    if (re.test(out)) {
      currency = currency ?? code;
      out = out.replace(re, " ");
    }
    re.lastIndex = 0;
  }
  return { text: out, currency };
}

function takeSchedule(text: string): { text: string; schedule?: Schedule } {
  let out = text;
  let schedule: Schedule | undefined;

  // "every friday", "each monday", "fridays"
  const day = out.match(/\b(?:every|each|on)\s+(sun|mon|tue|tues|wed|wednes|thu|thur|thurs|fri|sat|satur)(?:day)?s?\b/i)
    ?? out.match(/\b(sun|mon|tues?|wednes|wed|thu(?:rs?)?|fri|satur|sat)days?\b(?=.*\bevery\b|$)/i);
  if (day && /\b(every|each)\b/i.test(out)) {
    const key = day[1].toLowerCase().slice(0, 3);
    if (key in WEEKDAYS) {
      schedule = { frequency: "weekly", weekday: WEEKDAYS[key] };
      out = out.replace(day[0], " ");
    }
  }

  if (!schedule && /\b(every ?day|everyday|daily|each day)\b/i.test(out)) {
    schedule = { frequency: "daily" };
    out = out.replace(/\b(every ?day|everyday|daily|each day)\b/gi, " ");
  }

  if (!schedule && /\b(every ?week|weekly|each week)\b/i.test(out)) {
    schedule = { frequency: "weekly" };
    out = out.replace(/\b(every ?week|weekly|each week)\b/gi, " ");
  }

  if (!schedule && /\b(every ?month|monthly|each month)\b/i.test(out)) {
    schedule = { frequency: "monthly" };
    out = out.replace(/\b(every ?month|monthly|each month)\b/gi, " ");
    const dom = out.match(/\bon (?:the )?(\d{1,2})(?:st|nd|rd|th)?\b/i);
    if (dom) {
      const n = Number(dom[1]);
      // 29 to 31 do not exist every month; refuse rather than silently skip months.
      if (n >= 1 && n <= 28) schedule.dayOfMonth = n;
      out = out.replace(dom[0], " ");
    }
  }
  return { text: out, schedule };
}

/** First money amount in the text, and the text with it removed. Handles 5000, 5,000, 5k, 1.5k and "five thousand". */
function takeAmount(text: string): { text: string; amount?: number } {
  const numeric = text.match(/\d[\d,]*(?:\.\d+)?\s?(?:k|kay|m|mil|milla)?\b/i);
  if (numeric) {
    const amount = parseAmountFromText(numeric[0]);
    if (amount !== null && amount > 0) return { text: text.replace(numeric[0], " "), amount };
  }
  const words = text.split(/\s+/).filter((w) => NUMBER_WORDS.has(w.replace(/[^a-z]/gi, "").toLowerCase()));
  if (words.length) {
    const amount = parseAmountFromText(words.join(" "));
    if (amount !== null && amount > 0) {
      const rest = text.split(/\s+/).filter((w) => !NUMBER_WORDS.has(w.replace(/[^a-z]/gi, "").toLowerCase())).join(" ");
      return { text: rest, amount };
    }
  }
  return { text };
}

function cleanQuery(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9.\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !FILLER.has(w) && !NUMBER_WORDS.has(w))
    .join(" ")
    .trim();
}

const BUY = /\b(buy|buying|purchase|invest|investing|put)\b|\bget me\b|\bpick up\b|\bstack up on\b|\btop up my\b/i;
const SELL = /\b(sell|selling|dump|exit)\b/i;

/**
 * Read a message as a stock request. Null when it is not clearly about stocks.
 * The stock named is returned as the person's own words (`query`), for the
 * caller to resolve.
 */
export function parseStockRequest(input: string): StockRequest | null {
  const text = (input || "").trim();
  if (!text || text.startsWith("/")) return null;
  const lower = text.toLowerCase();

  // Stopping a standing order.
  if (/\b(stop|cancel|pause|end|delete|remove)\b/.test(lower) && /\b(buys?|buying|purchases?|recurring|schedule|auto|investing|plan)\b/.test(lower)) {
    const q = cleanQuery(lower.replace(/\b(stop|cancel|pause|end|delete|remove|buys?|buying|purchases?|recurring|schedule|auto|investing|plan|my|all)\b/g, " "));
    return { intent: "cancel_recurring", ...(q ? { query: q } : {}) };
  }

  // What do I own.
  if (/\b(my (stocks?|portfolio|holdings|shares|investments?)|portfolio|holdings|what (do i|stocks do i) (own|have|hold))\b/.test(lower)) {
    return { intent: "holdings" };
  }

  const { text: noCurrency, currency } = takeCurrency(text);
  const { text: noSchedule, schedule } = takeSchedule(noCurrency);

  // Selling.
  if (SELL.test(lower) && !BUY.test(lower)) {
    const fraction = /\b(all|everything|entire|whole)\b/i.test(noSchedule)
      ? 1
      : /\bhalf\b/i.test(noSchedule)
        ? 0.5
        : /\b(quarter|a quarter)\b/i.test(noSchedule)
          ? 0.25
          : undefined;
    const { text: rest, amount } = fraction ? { text: noSchedule, amount: undefined } : takeAmount(noSchedule);
    const query = cleanQuery(rest.replace(/\b(sell|selling|dump|exit|all|everything|entire|whole|half|quarter)\b/gi, " "));
    if (!query) return null;
    if (fraction === undefined && amount === undefined) return { intent: "sell", query }; // asks how much
    return { intent: "sell", query, ...(amount !== undefined ? { amount, ...(currency ? { currency } : {}) } : {}), ...(fraction !== undefined ? { fraction } : {}) };
  }

  // Buying, once or on a schedule.
  if (BUY.test(lower)) {
    const { text: rest, amount } = takeAmount(noSchedule);
    const query = cleanQuery(rest.replace(BUY, " ").replace(/\b(buy|buying|purchase|invest|investing|put|get me|pick up|stack up on|top up my)\b/gi, " "));
    // With no stock or no amount there is nothing safe to propose. Fall through
    // rather than give up: "what stocks can i buy" contains "buy" but is a list request.
    if (query && amount !== undefined) {
      if (schedule) return { intent: "recurring_buy", query, amount, ...(currency ? { currency } : {}), schedule };
      return { intent: "buy", query, amount, ...(currency ? { currency } : {}) };
    }
  }

  // A standing order phrased without a buy verb: "2000 of apple every friday".
  if (schedule) {
    const { text: rest, amount } = takeAmount(noSchedule);
    const query = cleanQuery(rest);
    if (amount !== undefined && query) return { intent: "recurring_buy", query, amount, ...(currency ? { currency } : {}), schedule };
    return null;
  }

  // Asking about a stock.
  const ask = lower.match(/\b(?:price (?:of|for)|how(?:'s| is| are| has| have)|what(?:'s| is) (?:the )?(?:price (?:of|for)|happening with|going on with)|tell me about|news (?:on|about)|update (?:on|about)|analy[sz]e|analysis (?:of|on)|thoughts on|is .+ (?:up|down))\b(.*)$/);
  if (ask) {
    const query = cleanQuery(ask[1].replace(/\b(doing|going|performing|trading|today|lately|this week|looking|up|down)\b/g, " "));
    if (query) return { intent: "quote", query };
  }

  // The bare list.
  if (/\b(what )?(stocks|shares) (can i|do you|are|is)\b|\b(list|show|see) (the |all |available )?(stocks|shares)\b|^stocks$|\bavailable stocks\b/.test(lower)) {
    return { intent: "list" };
  }
  return null;
}
