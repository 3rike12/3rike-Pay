import { parseStockRequest, type StockRequest, type NamedCurrency } from "@/utils/stockNlu";
import { findStock, type StockToken } from "@/services/stocks";
import { checkStockEligibility, eligibilityMessage } from "@/services/stockEligibility";
import type { BuyPreview, SellPreview, StockOrderRow } from "@/services/stockOrders";
import { OrderRefused } from "@/services/orderErrors";
import type { ScheduleRule, RunEvent } from "@/services/stockSchedules";

// ============================================
// Stocks in WhatsApp
//
// Understands what a person types ("buy 5k of tesla", "sell half my nvda", "how
// is apple doing", "my stocks") and walks them through it.
//
// Rules this module keeps:
//   - NOTHING is debited until the person says yes to a message that shows the
//     exact cost, what they get, and the worst price they could get.
//   - Pressing yes twice is safe: each confirmation carries one fixed order
//     reference, so a second yes resumes the same order, never makes another.
//   - A quote is only good for a few minutes; after that it is asked again.
//   - A message that is not clearly about stocks is not handled here, so invoices,
//     transfers and top-ups are never hijacked.
//
// Everything it needs from the outside is passed in, so it can be tested without
// WhatsApp or a database.
// ============================================

export const CONFIRM_TTL_MS = 5 * 60_000;
/** How many failed runs in a row pause a recurring buy (kept in step with stockSchedules). */
const MAX_SKIPS = 3;

export interface PendingStockOrder {
  id: string;
  kind: "buy" | "sell" | "recurring";
  /** recurring: when it repeats. */
  rule?: ScheduleRule;
  token: StockToken;
  currency: string;
  /** buy: what the person pays, in their currency. */
  cashAmount?: number;
  /** sell: raw token units, as a string (session data is JSON). */
  units?: string;
  expiresAt: number;
}

export interface StockBotDeps {
  send(phone: string, text: string): Promise<unknown>;
  stocks(): Promise<StockToken[]>;
  setSession(userId: string, data: Record<string, unknown>): Promise<unknown>;
  resetSession(userId: string): Promise<unknown>;
  currencyFor(user: any): string;
  money(amount: number, currency: string): string;
  convert(amount: number, from: string, to: string): number;
  balanceOf(userId: string, currency: string): Promise<number>;
  orders: {
    previewBuy(p: { token: StockToken; cashAmount: number; currency: string }): Promise<BuyPreview>;
    previewSell(p: { token: StockToken; units: bigint; currency: string }): Promise<SellPreview>;
    placeBuy(p: { reference: string; userId: string; token: StockToken; cashAmount: number; currency: string }): Promise<StockOrderRow>;
    placeSell(p: { reference: string; userId: string; token: StockToken; units: bigint; currency: string }): Promise<StockOrderRow>;
    indicativePrice(token: StockToken): Promise<{ usdPerShare: number } | null>;
    unitsForCash(token: StockToken, cashAmount: number, currency: string): Promise<bigint | null>;
  };
  positions: {
    list(userId: string): Promise<Array<{ tokenAddress: string; units: bigint }>>;
    get(userId: string, tokenAddress: string): Promise<bigint>;
  };
  research: {
    /**
     * Put a question to the research assistant. It is given the stocks (never anything about the person), and
     * a budget for "what should I buy" questions. Returns the message to send, or why there is none.
     */
    ask(p: {
      userId: string;
      question: string;
      stocks: StockToken[];
      budget?: { amount: number; currency: string; frequency?: "daily" | "weekly" | "monthly" };
    }): Promise<{ kind: "text"; text: string } | { kind: "off" } | { kind: "limit" }>;
  };
  alerts: {
    optOut(userId: string): Promise<unknown>;
    optIn(userId: string): Promise<unknown>;
  };
  schedules: {
    /** Throws OrderRefused if the amount is not allowed. */
    checkCash(cashAmount: number, currency: string): void;
    create(p: { reference: string; userId: string; token: StockToken; cashAmount: number; currency: string; rule: ScheduleRule }): Promise<unknown>;
    cancel(userId: string, tokenAddress?: string): Promise<number>;
    label(rule: ScheduleRule, createdOn: Date): string;
    firstRun(from: Date, rule: ScheduleRule): Date;
  };
  newId(): string;
  now(): number;
}

/** What to say when something unexpected went wrong placing an order. Honest: money may have moved. */
const GENERIC_PLACE_ERROR =
  "Something went wrong while placing that order. If you were charged, the order will finish or be refunded automatically. Send *my stocks* in a few minutes to check.";
const GENERIC_PRICE_ERROR = "I couldn't price that right now. Please try again.";

const userSafe = (error: unknown, fallback: string) => (error instanceof OrderRefused ? error.message : fallback);
const dateText = (d: Date) => d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

const YES = /^(y|yes|yep|yeah|confirm|ok|okay|sure|do it|go ahead|proceed)[.!]*$/i;
const NO = /^(n|no|nope|cancel|stop|abort|never ?mind|dont|don't)[.!]*$/i;

const sharesText = (units: bigint, t: Pick<StockToken, "decimals" | "multiplier">) => {
  const n = (Number(units) / 10 ** t.decimals) * t.multiplier;
  return n >= 100 ? n.toFixed(2) : n.toFixed(4).replace(/\.?0+$/, "") || "0";
};
const label = (t: StockToken) => `${t.name} (${t.ticker})`;
const FINE_PRINT = "_Tokenized stock: an onchain certificate that tracks the share, not the share itself._";

export function createStockBot(deps: StockBotDeps) {
  const say = (phone: string, text: string) => deps.send(phone, text);

  /** The person's amount, in their own balance currency. */
  const inUserCurrency = (amount: number, named: NamedCurrency | undefined, userCurrency: string) =>
    named && named !== userCurrency ? deps.convert(amount, named, userCurrency) : amount;

  async function resolve(phone: string, stocks: StockToken[], query: string): Promise<StockToken | null> {
    const hit = findStock(stocks, query);
    if (hit.kind === "found") return hit.stock;
    if (hit.kind === "ambiguous") {
      const options = hit.matches.slice(0, 5).map((s) => `• ${s.ticker}: ${s.name}`).join("\n");
      await say(phone, `That could be more than one stock:\n\n${options}\n\nSend the ticker you mean, e.g. *buy 5000 of ${hit.matches[0].ticker}*.`);
      return null;
    }
    await say(phone, `I couldn't find a stock called "${query}". Send *stocks* to see what's available.`);
    return null;
  }

  async function propose(phone: string, user: any, pending: PendingStockOrder, body: string) {
    await deps.setSession(user.id, { ...pending });
    return say(phone, `${body}\n\n${FINE_PRINT}\n\nReply *YES* to confirm or *NO* to cancel. This quote is good for 5 minutes.`);
  }

  // ----- reading -----

  async function list(phone: string, stocks: StockToken[]) {
    if (stocks.length === 0) return say(phone, "No stocks are available right now. Please try again shortly.");
    const shown = stocks.slice(0, 20).map((s) => `• ${s.ticker}: ${s.name}`).join("\n");
    const more = stocks.length > 20 ? `\n…and ${stocks.length - 20} more.` : "";
    return say(phone, `*Stocks you can buy*\n\n${shown}${more}\n\nTry: *buy 5000 of ${stocks[0].ticker}*, or ask *how is ${stocks[0].ticker} doing*.`);
  }

  async function holdings(phone: string, user: any, stocks: StockToken[]) {
    const held = await deps.positions.list(user.id);
    if (held.length === 0) return say(phone, "You don't hold any stocks yet. Try: *buy 5000 of Tesla*.");
    const lines = held.map((h) => {
      const s = stocks.find((x) => x.address === h.tokenAddress);
      return s ? `• ${sharesText(h.units, s)} shares of ${label(s)}` : `• ${h.units} units of ${h.tokenAddress.slice(0, 8)}…`;
    });
    return say(phone, `*Your stocks*\n\n${lines.join("\n")}`);
  }

  async function quote(phone: string, token: StockToken) {
    const price = await deps.orders.indicativePrice(token);
    const multiplier = token.multiplier !== 1 ? `\n1 token = ${token.multiplier.toFixed(4)} shares (this changes with dividends).` : "";
    const priceLine = price ? `Price: about $${price.usdPerShare.toFixed(2)} per share (what you'd actually pay right now).` : "Price: not available right now.";
    return say(phone, `*${label(token)}*\n\n${priceLine}${multiplier}\n\nTo buy: *buy 5000 of ${token.ticker}*`);
  }

  // ----- buying and selling -----

  async function buy(phone: string, user: any, token: StockToken, amount: number, named?: NamedCurrency) {
    const currency = deps.currencyFor(user);
    const cashAmount = inUserCurrency(amount, named, currency);
    let preview: BuyPreview;
    try {
      preview = await deps.orders.previewBuy({ token, cashAmount, currency });
    } catch (error) {
      return say(phone, userSafe(error, GENERIC_PRICE_ERROR));
    }
    const balance = await deps.balanceOf(user.id, currency);
    if (balance < cashAmount) {
      return say(phone, `You have ${deps.money(balance, currency)} and this needs ${deps.money(cashAmount, currency)}. Add money with */topup*, then try again.`);
    }
    const worst = sharesText(preview.minTokenUnits, token);
    return propose(
      phone, user,
      { id: deps.newId(), kind: "buy", token, currency, cashAmount, expiresAt: deps.now() + CONFIRM_TTL_MS },
      `*Buy ${label(token)}*\n\nYou pay: ${deps.money(cashAmount, currency)} (about $${preview.usd.toFixed(2)})\nYou get: about ${sharesText(preview.estimatedTokenUnits, token)} shares\nAt worst: ${worst} shares (if the price moves)`
    );
  }

  async function sell(phone: string, user: any, token: StockToken, req: Extract<StockRequest, { intent: "sell" }>) {
    const currency = deps.currencyFor(user);
    const held = await deps.positions.get(user.id, token.address);
    if (held <= 0n) return say(phone, `You don't hold any ${token.ticker}.`);

    let units: bigint | null = null;
    let note = "";
    if (req.fraction !== undefined) {
      units = req.fraction >= 1 ? held : (held * BigInt(Math.round(req.fraction * 10_000))) / 10_000n;
    } else if (req.amount !== undefined) {
      const cash = inUserCurrency(req.amount, req.currency, currency);
      units = await deps.orders.unitsForCash(token, cash, currency);
      if (units === null) return say(phone, "I couldn't price that right now. Please try again.");
      if (units > held) {
        units = held;
        note = "\n\nThat's more than you hold, so this sells all of it.";
      }
    } else {
      return say(phone, `How much ${token.ticker} do you want to sell? For example *sell half my ${token.ticker}*, *sell all my ${token.ticker}* or *sell 2000 of ${token.ticker}*.`);
    }
    if (units <= 0n) return say(phone, "That's too small to sell.");

    let preview: SellPreview;
    try {
      preview = await deps.orders.previewSell({ token, units, currency });
    } catch (error) {
      return say(phone, userSafe(error, GENERIC_PRICE_ERROR));
    }
    const atLeast = deps.money(Math.floor(preview.estimatedCash * 0.99), currency);
    return propose(
      phone, user,
      { id: deps.newId(), kind: "sell", token, currency, units: units.toString(), expiresAt: deps.now() + CONFIRM_TTL_MS },
      `*Sell ${label(token)}*\n\nYou sell: about ${sharesText(units, token)} shares\nYou get: about ${deps.money(preview.estimatedCash, currency)}\nAt worst: about ${atLeast} (if the price moves)${note}`
    );
  }

  // ----- the research assistant -----

  async function ask(phone: string, user: any, question: string, tokens: StockToken[], budget?: { amount: number; currency: string; frequency?: "daily" | "weekly" | "monthly" }) {
    try {
      const r = await deps.research.ask({ userId: user.id, question, stocks: tokens, budget });
      if (r.kind === "off") return say(phone, "The research assistant isn't available yet.");
      if (r.kind === "limit") return say(phone, "You've asked a lot of questions today, so I'll pause there. Please try again tomorrow.");
      return say(phone, r.text);
    } catch {
      // Never show an internal error. The assistant only explains, so nothing was charged or changed.
      return say(phone, "I couldn't answer that just now. Please try again in a moment.");
    }
  }

  // ----- recurring buys -----

  async function recurring(phone: string, user: any, token: StockToken, amount: number, named: NamedCurrency | undefined, rule: ScheduleRule) {
    const currency = deps.currencyFor(user);
    const cashAmount = inUserCurrency(amount, named, currency);
    try {
      deps.schedules.checkCash(cashAmount, currency);
    } catch (error) {
      return say(phone, userSafe(error, GENERIC_PRICE_ERROR));
    }
    const now = new Date(deps.now());
    const when = deps.schedules.label(rule, now);
    const first = deps.schedules.firstRun(now, rule);
    const balance = await deps.balanceOf(user.id, currency);
    const low = balance < cashAmount ? `\n\nYou have ${deps.money(balance, currency)} now. Make sure you have enough on the day.` : "";
    return propose(
      phone, user,
      { id: deps.newId(), kind: "recurring", token, currency, cashAmount, rule, expiresAt: deps.now() + CONFIRM_TTL_MS },
      `*Recurring buy*\n\nI'll buy ${deps.money(cashAmount, currency)} of ${label(token)} ${when}.\nFirst buy: ${dateText(first)}, around 08:00 UTC.\n\nEach buy uses your balance at that moment. If it's too low I'll skip it and tell you; after 3 skips in a row I pause it. Stop any time with *stop my ${token.ticker} buys*.${low}`
    );
  }

  async function cancel(phone: string, user: any, stocks: StockToken[], query?: string) {
    let token: StockToken | null = null;
    if (query) {
      token = await resolve(phone, stocks, query);
      if (!token) return;
    }
    const stopped = await deps.schedules.cancel(user.id, token?.address);
    if (stopped === 0) return say(phone, token ? `You don't have a recurring buy for ${token.ticker}.` : "You don't have any recurring buys.");
    return say(phone, token ? `Stopped your recurring ${token.ticker} buy.` : `Stopped ${stopped === 1 ? "your recurring buy" : `all ${stopped} of your recurring buys`}.`);
  }

  // ----- the entry points -----

  /**
   * Handle a message if it is about stocks. Returns false when it is not, so the
   * caller carries on with its other handlers.
   */
  async function tryHandle(phone: string, user: any, text: string): Promise<boolean> {
    const req = parseStockRequest(text);
    if (!req) return false;

    const eligibility = checkStockEligibility({ phone, country: user?.business?.country });
    if (!eligibility.ok) {
      await say(phone, eligibilityMessage(eligibility));
      return true;
    }

    let stocks: StockToken[];
    try {
      stocks = await deps.stocks();
    } catch {
      await say(phone, "Stocks aren't available right now. Please try again shortly.");
      return true;
    }

    switch (req.intent) {
      case "list":
        await list(phone, stocks);
        return true;
      case "holdings":
        await holdings(phone, user, stocks);
        return true;
      case "quote": {
        const token = await resolve(phone, stocks, req.query);
        if (token) await quote(phone, token);
        return true;
      }
      case "buy": {
        const token = await resolve(phone, stocks, req.query);
        if (token) await buy(phone, user, token, req.amount, req.currency);
        return true;
      }
      case "sell": {
        const token = await resolve(phone, stocks, req.query);
        if (token) await sell(phone, user, token, req);
        return true;
      }
      case "research": {
        const tokens: StockToken[] = [];
        for (const q of req.queries) {
          const token = await resolve(phone, stocks, q);
          if (!token) return true; // resolve() has already said what is wrong
          tokens.push(token);
        }
        if (tokens.length === 0) {
          // No stock named: use what they hold, so "should I sell?" has something to be about.
          for (const h of (await deps.positions.list(user.id)).slice(0, 3)) {
            const t = stocks.find((x) => x.address === h.tokenAddress);
            if (t) tokens.push(t);
          }
        }
        if (tokens.length === 0) {
          await say(phone, "Which stock do you mean? For example: *why is Tesla down?* or *should I buy Nvidia?*");
          return true;
        }
        await ask(phone, user, req.question, tokens);
        return true;
      }
      case "plan": {
        if (req.budget === undefined) {
          await say(phone, "How much can you put in, and how often? For example: *I have 5000 a week, what should I buy?*");
          return true;
        }
        const currency = deps.currencyFor(user);
        const amount = inUserCurrency(req.budget, req.currency, currency);
        await ask(phone, user, req.question, stocks.slice(0, 5), { amount, currency, frequency: req.frequency });
        return true;
      }
      case "alerts_off":
        await deps.alerts.optOut(user.id);
        await say(phone, "Okay, I won't send you stock alerts. Say *turn on stock alerts* any time to get them again.");
        return true;
      case "alerts_on":
        await deps.alerts.optIn(user.id);
        await say(phone, "Stock alerts are on. I'll tell you when a stock you hold has a change to its share count, or a big price move. Say *stop stock alerts* to turn them off.");
        return true;
      case "recurring_buy": {
        const token = await resolve(phone, stocks, req.query);
        if (token) await recurring(phone, user, token, req.amount, req.currency, req.schedule);
        return true;
      }
      case "cancel_recurring":
        await cancel(phone, user, stocks, req.query);
        return true;
    }
  }

  /** The person is answering a pending order. */
  async function handleConfirm(phone: string, user: any, flowData: Record<string, unknown>, text: string): Promise<unknown> {
    const pending = flowData as unknown as PendingStockOrder;
    const answer = (text || "").trim();

    if (!pending?.id || !pending.token) {
      await deps.resetSession(user.id);
      return say(phone, "There's nothing waiting for your confirmation.");
    }

    if (NO.test(answer)) {
      await deps.resetSession(user.id);
      return say(phone, "Cancelled. Nothing was charged.");
    }

    if (!YES.test(answer)) {
      // Something else: a new request replaces the old one; anything else is a nudge.
      if (parseStockRequest(answer)) {
        await deps.resetSession(user.id);
        if (await tryHandle(phone, user, answer)) return;
      }
      return say(phone, "Reply *YES* to confirm or *NO* to cancel.");
    }

    if (deps.now() > pending.expiresAt) {
      await deps.resetSession(user.id);
      return say(phone, "That quote has expired because prices move. Send your request again for a fresh one.");
    }

    // One fixed reference per confirmation: a second yes resumes this order, it never makes another.
    const reference = `stk:${pending.id}`;
    await deps.resetSession(user.id);

    if (pending.kind === "recurring") {
      try {
        const now = new Date(deps.now());
        await deps.schedules.create({ reference: `stk-sch:${pending.id}`, userId: user.id, token: pending.token, cashAmount: pending.cashAmount!, currency: pending.currency, rule: pending.rule! });
        const first = deps.schedules.firstRun(now, pending.rule!);
        return say(phone, `Done. I'll buy ${deps.money(pending.cashAmount!, pending.currency)} of ${label(pending.token)} ${deps.schedules.label(pending.rule!, now)}. First buy: ${dateText(first)}.\n\nStop any time with *stop my ${pending.token.ticker} buys*.`);
      } catch (error) {
        return say(phone, userSafe(error, "I couldn't set that up. Please try again."));
      }
    }

    try {
      const order =
        pending.kind === "buy"
          ? await deps.orders.placeBuy({ reference, userId: user.id, token: pending.token, cashAmount: pending.cashAmount!, currency: pending.currency })
          : await deps.orders.placeSell({ reference, userId: user.id, token: pending.token, units: BigInt(pending.units!), currency: pending.currency });
      return say(phone, outcomeMessage(order, pending));
    } catch (error) {
      return say(phone, userSafe(error, GENERIC_PLACE_ERROR));
    }
  }

  function outcomeMessage(order: StockOrderRow, pending: PendingStockOrder): string {
    const t = pending.token;
    switch (order.state) {
      case "filled":
        return order.side === "buy"
          ? `Done. You bought about ${sharesText(order.tokenUnits, t)} shares of ${label(t)} for ${deps.money(order.cashAmount, order.currency)}.`
          : `Done. You sold about ${sharesText(order.tokenUnits, t)} shares of ${label(t)} and received ${deps.money(order.cashAmount, order.currency)}.`;
      case "refunded":
        return order.side === "buy"
          ? `The trade couldn't be completed at an acceptable price, so ${deps.money(order.cashAmount, order.currency)} was returned to your balance.`
          : `The trade couldn't be completed at an acceptable price, so your shares were returned.`;
      case "failed":
        return `That order didn't go through, and nothing was charged. ${order.failure ?? ""}`.trim();
      default:
        return "Your order is being processed. We'll message you as soon as it's done.";
    }
  }

  /**
   * The message for an order that has now finished, sent to its owner. Used for
   * orders resolved later than the person's own confirmation (a slow venue).
   */
  function settledMessage(order: StockOrderRow, token: StockToken | undefined): string | null {
    if (order.state !== "filled" && order.state !== "refunded") return null;
    const name = token ? label(token) : "your stock";
    const shares = token ? sharesText(order.tokenUnits, token) : "";
    if (order.state === "filled") {
      return order.side === "buy"
        ? `Your order is complete. You bought about ${shares} shares of ${name} for ${deps.money(order.cashAmount, order.currency)}.`
        : `Your order is complete. You sold about ${shares} shares of ${name} and received ${deps.money(order.cashAmount, order.currency)}.`;
    }
    return order.side === "buy"
      ? `Your ${name} order couldn't be completed at an acceptable price, so ${deps.money(order.cashAmount, order.currency)} was returned to your balance.`
      : `Your ${name} sale couldn't be completed at an acceptable price, so your shares were returned.`;
  }

  /** What to tell someone about a recurring buy that just ran (or did not). `token` gives the multiplier; without it shares assume 1. */
  function scheduleEventMessage(event: RunEvent, token?: StockToken): string {
    const s = event.schedule;
    const name = `${s.name} (${s.ticker})`;
    const amount = deps.money(s.cashAmount, s.currency);
    if (event.kind === "bought") {
      const shares = sharesText(event.order.tokenUnits, { decimals: s.tokenDecimals, multiplier: token?.multiplier ?? 1 });
      return `Your recurring buy went through: bought about ${shares} shares of ${name} for ${amount}.`;
    }
    if (event.kind === "processing") return `Your recurring buy of ${amount} of ${name} is being processed. I'll message you when it's done.`;
    const topUp = /balance was too low/.test(event.reason) ? " Add money with */topup*." : "";
    if (event.paused) {
      return `I've paused your recurring buy of ${name} because ${MAX_SKIPS} in a row didn't go through (the latest: ${event.reason}).${topUp}\n\nWhen you're ready, send something like *buy ${Math.round(s.cashAmount)} of ${s.ticker} every Friday* to start it again.`;
    }
    return `Your recurring buy of ${amount} of ${name} didn't go through: ${event.reason}.${topUp} I'll try again on ${dateText(event.nextRunAt)}.`;
  }

  /** `/stocks`, `/stock TSLA` and `/portfolio`. */
  async function handleCommand(phone: string, user: any, command: string, args: string): Promise<boolean> {
    const a = args.trim();
    const text = command === "portfolio" || command === "holdings" ? "my stocks" : command === "stock" && a ? `price of ${a}` : "list stocks";
    return tryHandle(phone, user, text);
  }

  return { tryHandle, handleConfirm, handleCommand, settledMessage, scheduleEventMessage };
}
