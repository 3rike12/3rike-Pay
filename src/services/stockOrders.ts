import { config } from "@/config";
import { prisma } from "@/db/prisma";
import { SYSTEM_ACCOUNTS, ledger } from "@/services/ledger";
import { positions } from "@/services/positions";
import { staticFx, type FxRecord } from "@/services/fx";
import { fromUsd, liabilities, onChainBalanceUsd, toUsd } from "@/services/treasury";
import { getStockVenue, type StockVenue, type VenueResult } from "@/services/stockVenue";
import type { StockToken } from "@/services/stocks";
import { OrderRefused } from "@/services/orderErrors";
import { minorExponent, toMinor } from "@/utils/money";
import { createLogger } from "@/utils/logger";

const logger = createLogger("stock-orders");

// ============================================
// Stock orders: turning cash into stock tokens and back
//
// BUY   user cash  --debit-->  treasury USDC  --venue-->  token  --credit-->  user position
// SELL  user position --debit--> token --venue--> USDC  --credit-->  user cash
//
// Money is at risk at every arrow, so an order is a row that moves through
// GUARDED states, and every step can be repeated safely:
//
//   created -> funded -> submitted -> filled | refunded      (failed: nothing moved)
//
//  1. The user's side is taken FIRST (cash debited, or units debited), with an
//     idempotency key, so the same money can never be spent twice.
//  2. A state change only happens if the order is still in the state we expect
//     (an atomic conditional update), so of two workers racing, one wins.
//  3. Anything that moves value is done with an idempotency key BEFORE the state
//     advances. A crash in between is simply retried: the repeat is a no-op.
//  4. The venue is told our order reference and is idempotent on it, so
//     resubmitting trades once.
//  5. NEVER REFUND ON AN UNKNOWN OUTCOME. A venue call that times out may have
//     traded. Refunding then would leave tokens in the treasury nobody owns. The
//     order stays `submitted` until the venue's own record says what happened;
//     only a definite rejection is refunded.
//
// `advanceOrder` drives created and funded orders forward. It deliberately does
// not touch a submitted one: a concurrent worker cannot tell "someone is mid-call"
// from "stuck", and guessing would resubmit. Submitted orders are resolved by
// `reconcileOrder`, which asks the venue.
// ============================================

export { OrderRefused };

export type OrderState = "created" | "funded" | "submitted" | "filled" | "refunded" | "failed";

export interface StockOrderRow {
  id: string;
  reference: string;
  userId: string;
  side: "buy" | "sell";
  tokenAddress: string;
  tokenDecimals: number;
  currency: string;
  cashAmount: number;
  cashAmountMinor: bigint;
  usdcUnits: bigint;
  tokenUnits: bigint;
  minTokenUnits: bigint;
  minUsdcUnits: bigint;
  state: OrderState;
  venue: string;
  txHash: string | null;
  failure: string | null;
  fx: FxRecord;
  updatedAt: Date;
}

// --------------------------------------------
// Telling people how an order ended
//
// The order service knows nothing about WhatsApp. Whoever wants to announce a
// result registers a listener. It is called for orders that finish LATER than the
// call that placed them (resolved by `reconcileOrder`), once per order, by the
// caller that actually moved it to filled or refunded (the winner of the guarded
// transition), so a repeated or racing call can never announce twice.
//
// It is deliberately NOT called for an order that finishes inside `placeBuy` or
// `placeSell`: that caller already has the result in hand and tells the person
// itself, and announcing as well would send two messages. A listener that throws
// never affects the order: the money has already moved.
// --------------------------------------------
type OrderListener = (order: StockOrderRow) => Promise<void> | void;
let listener: OrderListener | null = null;

export function setOrderListener(fn: OrderListener | null) {
  listener = fn;
}

async function announce(reference: string) {
  if (!listener) return;
  try {
    const order = await load(reference);
    if (order) await listener(order);
  } catch (error: any) {
    logger.warn("Order listener failed", { reference, error: error?.message });
  }
}

const isUnique = (e: unknown) => (e as { code?: string } | null)?.code === "P2002";
const TERMINAL: OrderState[] = ["filled", "refunded", "failed"];
const USDC_DECIMALS = 6;

const settings = () => {
  const s: any = (config as any).stocks ?? {};
  return {
    minOrderUsd: s.minOrderUsd ?? 5,
    maxOrderUsd: s.maxOrderUsd ?? 500,
    maxSlippageBps: s.maxSlippageBps ?? 100,
    maxPriceImpactBps: s.maxPriceImpactBps ?? 150,
  };
};

/** `units` less `bps` basis points: the lowest the venue may fill at. */
const withSlippage = (units: bigint, bps: number) => (units * BigInt(10_000 - bps)) / 10_000n;

const orders = () => (prisma as any).stockOrder;

async function load(reference: string): Promise<StockOrderRow | null> {
  return (await orders().findUnique({ where: { reference } })) as StockOrderRow | null;
}

/** The guarded state change. True only if this caller made it: the order was still in `from`. */
async function transition(reference: string, from: OrderState, to: OrderState, extra: Record<string, unknown> = {}): Promise<boolean> {
  const { count } = await orders().updateMany({ where: { reference, state: from }, data: { state: to, ...extra } });
  return count === 1;
}

function requireVenue(): StockVenue {
  const v = getStockVenue();
  if (!v) throw new OrderRefused("Buying and selling stocks isn't available yet.");
  return v;
}

// --------------------------------------------
// Checks and quotes that happen before any money moves
// --------------------------------------------

function toUsdChecked(amount: number, currency: string): number {
  if (!Number.isFinite(amount) || amount <= 0) throw new OrderRefused("Enter an amount above zero.");
  let usd: number;
  try {
    usd = toUsd(amount, currency);
  } catch {
    throw new OrderRefused(`Stocks aren't available for ${currency} balances yet.`);
  }
  if (!Number.isFinite(usd) || usd <= 0) throw new OrderRefused("Enter an amount above zero.");
  return usd;
}

function checkSize(usd: number, opts: { min: boolean }) {
  const { minOrderUsd, maxOrderUsd } = settings();
  if (opts.min && usd < minOrderUsd) throw new OrderRefused(`The minimum order is about $${minOrderUsd}.`);
  if (usd > maxOrderUsd) throw new OrderRefused(`The maximum order is about $${maxOrderUsd}.`);
}

function checkImpact(bps: number) {
  const { maxPriceImpactBps } = settings();
  if (bps > maxPriceImpactBps) {
    throw new OrderRefused(`That order is too large for the current market (it would move the price ${(bps / 100).toFixed(2)}%). Try a smaller amount.`);
  }
}

/** The treasury must be able to cover what it already owes, and the USDC this order will spend. */
async function checkTreasury(usd: number) {
  const [assets, owed] = await Promise.all([onChainBalanceUsd(), liabilities()]);
  if (assets < usd || assets < owed.totalUsd) {
    logger.error("Treasury cannot cover a stock order", { assets, liabilities: owed.totalUsd, usd });
    throw new OrderRefused("Stocks are temporarily unavailable. Please try again shortly.");
  }
}

/** The USD value of a buy, after checking it is a real amount in a supported currency and within the size limits. Throws OrderRefused. */
export function checkOrderCash(cashAmount: number, currency: string): number {
  const usd = toUsdChecked(cashAmount, currency);
  checkSize(usd, { min: true });
  return usd;
}

export interface BuyPreview {
  usd: number;
  usdcUnits: bigint;
  estimatedTokenUnits: bigint;
  /** Shares this should be worth, through the multiplier. */
  estimatedShares: number;
  minTokenUnits: bigint;
  priceImpactBps: number;
  fx: FxRecord;
}

/** What a buy would do, with the same limits an order hits. Moves nothing. */
export async function previewBuy(p: { token: StockToken; cashAmount: number; currency: string }): Promise<BuyPreview> {
  const venue = requireVenue();
  const usd = toUsdChecked(p.cashAmount, p.currency);
  checkSize(usd, { min: true });
  const usdcUnits = BigInt(Math.floor(usd * 10 ** USDC_DECIMALS));
  const quote = await venue.quoteBuy(p.token, usdcUnits);
  checkImpact(quote.priceImpactBps);
  return {
    usd,
    usdcUnits,
    estimatedTokenUnits: quote.tokenUnits,
    estimatedShares: (Number(quote.tokenUnits) / 10 ** p.token.decimals) * p.token.multiplier,
    minTokenUnits: withSlippage(quote.tokenUnits, settings().maxSlippageBps),
    priceImpactBps: quote.priceImpactBps,
    fx: staticFx(p.currency),
  };
}

export interface SellPreview {
  estimatedUsdcUnits: bigint;
  /** What the sale should pay, in the user's currency, rounded down. */
  estimatedCash: number;
  minUsdcUnits: bigint;
  priceImpactBps: number;
  fx: FxRecord;
}

/** What selling `units` would do, with the same limits an order hits. Moves nothing. */
export async function previewSell(p: { token: Pick<StockToken, "address" | "decimals">; units: bigint; currency: string }): Promise<SellPreview> {
  if (typeof p.units !== "bigint") throw new Error("Units must be a bigint: a JS number can silently lose precision");
  if (p.units <= 0n) throw new OrderRefused("Enter an amount above zero.");
  const venue = requireVenue();
  const quote = await venue.quoteSell(p.token, p.units);
  checkImpact(quote.priceImpactBps);
  checkSize(Number(quote.usdcUnits) / 10 ** USDC_DECIMALS, { min: false });
  return {
    estimatedUsdcUnits: quote.usdcUnits,
    estimatedCash: cashFromUsdc(quote.usdcUnits, p.currency),
    minUsdcUnits: withSlippage(quote.usdcUnits, settings().maxSlippageBps),
    priceImpactBps: quote.priceImpactBps,
    fx: staticFx(p.currency),
  };
}

/**
 * The price the venue would trade at right now, per SHARE in USD: the price per
 * token divided by the multiplier. Taken from a small quote, so it is what an
 * order would actually get, not a reference price. Null when there is no venue
 * or it cannot be asked.
 */
export async function indicativePrice(token: StockToken): Promise<{ usdPerShare: number } | null> {
  const venue = getStockVenue();
  if (!venue) return null;
  try {
    const usdc = BigInt(10 * 10 ** USDC_DECIMALS); // a $10 quote
    const { tokenUnits } = await venue.quoteBuy(token, usdc);
    const tokens = Number(tokenUnits) / 10 ** token.decimals;
    if (!(tokens > 0)) return null;
    return { usdPerShare: 10 / (tokens * token.multiplier) };
  } catch (error: any) {
    logger.warn("Could not get an indicative price", { token: token.address, error: error?.message });
    return null;
  }
}

/** How many raw token units about `cashAmount` buys right now, from the venue's quote. Null if it cannot be priced. */
export async function unitsForCash(token: Pick<StockToken, "address" | "decimals">, cashAmount: number, currency: string): Promise<bigint | null> {
  const venue = getStockVenue();
  if (!venue) return null;
  try {
    const usd = toUsdChecked(cashAmount, currency);
    return (await venue.quoteBuy(token, BigInt(Math.floor(usd * 10 ** USDC_DECIMALS)))).tokenUnits;
  } catch {
    return null;
  }
}

// --------------------------------------------
// Placing an order
// --------------------------------------------

/** Create the row, or return the existing one for this reference. A reference reused for a different order is an error. */
async function createOrFind(data: Omit<StockOrderRow, "id" | "state" | "txHash" | "failure" | "updatedAt">): Promise<StockOrderRow> {
  const same = (o: StockOrderRow) =>
    o.userId === data.userId &&
    o.side === data.side &&
    o.tokenAddress === data.tokenAddress &&
    o.currency === data.currency &&
    (data.side === "buy" ? o.cashAmount === data.cashAmount : o.tokenUnits === data.tokenUnits);
  const check = (o: StockOrderRow) => {
    if (!same(o)) throw new Error(`Order reference ${data.reference} was already used for a different order`);
    return o;
  };

  const existing = await load(data.reference);
  if (existing) return check(existing);
  try {
    return (await orders().create({ data })) as StockOrderRow;
  } catch (error) {
    if (!isUnique(error)) throw error;
    const raced = await load(data.reference);
    if (!raced) throw error;
    return check(raced);
  }
}

/**
 * Buy `cashAmount` (in the user's balance currency) of a stock. Safe to call
 * again with the same `reference`: it resumes the same order instead of making a
 * second one.
 */
export async function placeBuy(p: { reference: string; userId: string; token: StockToken; cashAmount: number; currency: string }): Promise<StockOrderRow> {
  const existing = await load(p.reference);
  if (existing) {
    // A retry must be the SAME order. A reference reused for a different one is a caller bug: never merge them.
    if (
      existing.userId !== p.userId || existing.side !== "buy" || existing.tokenAddress !== p.token.address ||
      existing.currency !== p.currency || existing.cashAmount !== p.cashAmount
    ) {
      throw new Error(`Order reference ${p.reference} was already used for a different order`);
    }
    return advanceOrder(p.reference);
  }

  const venue = requireVenue();
  const preview = await previewBuy({ token: p.token, cashAmount: p.cashAmount, currency: p.currency });
  await checkTreasury(preview.usd);

  await createOrFind({
    reference: p.reference,
    userId: p.userId,
    side: "buy",
    tokenAddress: p.token.address,
    tokenDecimals: p.token.decimals,
    currency: p.currency,
    cashAmount: p.cashAmount,
    cashAmountMinor: toMinor(p.cashAmount, p.currency),
    usdcUnits: preview.usdcUnits,
    tokenUnits: 0n,
    minTokenUnits: preview.minTokenUnits,
    minUsdcUnits: 0n,
    venue: venue.id,
    fx: preview.fx,
  });
  return advanceOrder(p.reference);
}

/**
 * Sell `units` (raw token units) of a stock, paid to the user's balance in
 * `currency`. Safe to call again with the same `reference`.
 */
export async function placeSell(p: { reference: string; userId: string; token: StockToken; units: bigint; currency: string }): Promise<StockOrderRow> {
  if (typeof p.units !== "bigint") throw new Error("Units must be a bigint: a JS number can silently lose precision");
  if (p.units <= 0n) throw new OrderRefused("Enter an amount above zero.");

  const existing = await load(p.reference);
  if (existing) {
    if (existing.userId !== p.userId || existing.side !== "sell" || existing.tokenUnits !== p.units || existing.tokenAddress !== p.token.address) {
      throw new Error(`Order reference ${p.reference} was already used for a different order`);
    }
    return advanceOrder(p.reference);
  }

  const venue = requireVenue();
  const quote = await venue.quoteSell(p.token, p.units);
  checkImpact(quote.priceImpactBps);
  checkSize(Number(quote.usdcUnits) / 10 ** USDC_DECIMALS, { min: false });
  const fx = staticFx(p.currency);

  await createOrFind({
    reference: p.reference,
    userId: p.userId,
    side: "sell",
    tokenAddress: p.token.address,
    tokenDecimals: p.token.decimals,
    currency: p.currency,
    cashAmount: 0,
    cashAmountMinor: 0n,
    usdcUnits: 0n,
    tokenUnits: p.units,
    minTokenUnits: 0n,
    minUsdcUnits: withSlippage(quote.usdcUnits, settings().maxSlippageBps),
    venue: venue.id,
    fx,
  });
  return advanceOrder(p.reference);
}

// --------------------------------------------
// Moving an order forward
// --------------------------------------------

const venueToken = (o: StockOrderRow) => ({ address: o.tokenAddress, decimals: o.tokenDecimals });
const key = (kind: string, o: StockOrderRow) => `stock-${kind}:${o.reference}`;

/** Take the user's side (cash or units). Not enough of it means nothing moved and the order fails. */
async function fund(o: StockOrderRow): Promise<StockOrderRow> {
  try {
    if (o.side === "buy") {
      await ledger.debit({
        userId: o.userId, amount: o.cashAmount, currency: o.currency, reference: o.reference,
        description: "Buy stock", counter: SYSTEM_ACCOUNTS.stockClearing, metadata: { type: "stock_buy", tokenAddress: o.tokenAddress }, idempotencyKey: key("buy-debit", o),
      });
    } else {
      await positions.debit({
        userId: o.userId, tokenAddress: o.tokenAddress, units: o.tokenUnits, reference: o.reference, idempotencyKey: key("sell-debit", o),
      });
    }
  } catch (error: any) {
    if (/Insufficient/i.test(String(error?.message))) {
      // Nothing was taken, so there is nothing to give back.
      await transition(o.reference, "created", "failed", { failure: String(error.message).slice(0, 300) });
      return (await load(o.reference))!;
    }
    throw error; // an infrastructure problem: leave the order as it is, to be resumed
  }
  await transition(o.reference, "created", "funded");
  return (await load(o.reference))!;
}

/** Hand the order to the venue. Only the caller that wins funded -> submitted does so. */
async function submit(o: StockOrderRow): Promise<StockOrderRow> {
  if (!(await transition(o.reference, "funded", "submitted"))) return (await load(o.reference))!;
  const venue = requireVenue();
  let result: VenueResult;
  try {
    result =
      o.side === "buy"
        ? await venue.buy({ reference: o.reference, token: venueToken(o), usdcUnits: o.usdcUnits, minTokenUnits: o.minTokenUnits })
        : await venue.sell({ reference: o.reference, token: venueToken(o), tokenUnits: o.tokenUnits, minUsdcUnits: o.minUsdcUnits });
  } catch (error: any) {
    // The trade may or may not have happened. Do not refund: reconcile asks the venue later.
    logger.warn("Venue call failed with an unknown outcome; leaving the order submitted", { reference: o.reference, error: error?.message });
    return (await load(o.reference))!;
  }
  return settle(o, result);
}

/** Apply a definite venue answer to a submitted order. */
async function settle(o: StockOrderRow, result: VenueResult, announceResult = false): Promise<StockOrderRow> {
  if (result.status === "rejected") return refund(o, result.reason, announceResult);

  if (result.tokenUnits <= 0n || result.usdcUnits <= 0n) {
    // A fill of nothing is not something to act on in either direction.
    logger.error("Venue reported a fill with no amount; leaving the order for review", { reference: o.reference });
    return (await load(o.reference))!;
  }

  if (o.side === "buy") {
    await positions.credit({
      userId: o.userId, tokenAddress: o.tokenAddress, units: result.tokenUnits, reference: o.reference, idempotencyKey: key("fill", o),
    });
    if (await transition(o.reference, "submitted", "filled", { tokenUnits: result.tokenUnits, usdcUnits: result.usdcUnits, txHash: result.txHash ?? null })) {
      if (announceResult) await announce(o.reference);
    }
  } else {
    const cash = cashFromUsdc(result.usdcUnits, o.currency);
    await ledger.credit({
      userId: o.userId, amount: cash, currency: o.currency, reference: o.reference,
      description: "Sell stock", counter: SYSTEM_ACCOUNTS.stockClearing, metadata: { type: "stock_sell", tokenAddress: o.tokenAddress }, idempotencyKey: key("sell-credit", o),
    });
    const won = await transition(o.reference, "submitted", "filled", {
      usdcUnits: result.usdcUnits, cashAmount: cash, cashAmountMinor: toMinor(cash, o.currency), txHash: result.txHash ?? null,
    });
    if (won && announceResult) await announce(o.reference);
  }
  return (await load(o.reference))!;
}

/** USDC proceeds in the user's currency, rounded DOWN to the smallest unit. */
function cashFromUsdc(usdcUnits: bigint, currency: string): number {
  const scale = 10 ** minorExponent(currency);
  return Math.floor(fromUsd(Number(usdcUnits) / 10 ** USDC_DECIMALS, currency) * scale) / scale;
}

/** Give the user's side back after a definite refusal. Safe to repeat. */
async function refund(o: StockOrderRow, reason: string, announceResult = false): Promise<StockOrderRow> {
  if (o.side === "buy") {
    await ledger.credit({
      userId: o.userId, amount: o.cashAmount, currency: o.currency, reference: o.reference,
      description: "Stock purchase refunded", counter: SYSTEM_ACCOUNTS.stockClearing, metadata: { type: "stock_buy_refund" }, idempotencyKey: key("buy-refund", o),
    });
  } else {
    await positions.credit({
      userId: o.userId, tokenAddress: o.tokenAddress, units: o.tokenUnits, reference: o.reference, idempotencyKey: key("sell-refund", o),
    });
  }
  if (await transition(o.reference, "submitted", "refunded", { failure: reason.slice(0, 300) }) && announceResult) await announce(o.reference);
  return (await load(o.reference))!;
}

/**
 * Drive an order forward from `created` or `funded`. Safe to call any number of
 * times, from any number of workers. A submitted order is returned as it is.
 */
export async function advanceOrder(reference: string): Promise<StockOrderRow> {
  let o = await load(reference);
  if (!o) throw new Error(`No such order: ${reference}`);
  if (o.state === "created") o = await fund(o);
  if (o.state === "funded") o = await submit(o);
  return o;
}

/**
 * Resolve a submitted order from the venue's own record. A fill is completed, a
 * rejection refunded, a pending order left alone, and an order the venue never
 * received is resubmitted under the same reference. If the venue cannot be
 * asked, nothing moves.
 */
export async function reconcileOrder(reference: string): Promise<StockOrderRow> {
  const o = await load(reference);
  if (!o) throw new Error(`No such order: ${reference}`);
  if (o.state !== "submitted") return o;

  const venue = requireVenue();
  let status;
  try {
    status = await venue.status(o.reference);
  } catch (error: any) {
    logger.warn("Could not ask the venue about an order; leaving it", { reference, error: error?.message });
    return o;
  }

  switch (status.state) {
    case "filled":
      return settle(o, { status: "filled", tokenUnits: status.tokenUnits, usdcUnits: status.usdcUnits, txHash: status.txHash }, true);
    case "rejected":
      return refund(o, status.reason, true);
    case "pending":
      return o;
    case "not_found": {
      // The venue never received it, so submitting trades once. It is idempotent on our reference.
      try {
        const result =
          o.side === "buy"
            ? await venue.buy({ reference: o.reference, token: venueToken(o), usdcUnits: o.usdcUnits, minTokenUnits: o.minTokenUnits })
            : await venue.sell({ reference: o.reference, token: venueToken(o), tokenUnits: o.tokenUnits, minUsdcUnits: o.minUsdcUnits });
        return settle(o, result, true);
      } catch (error: any) {
        logger.warn("Resubmitting to the venue failed; leaving the order submitted", { reference, error: error?.message });
        return o;
      }
    }
  }
}

/**
 * Resolve every order that has sat unfinished for `olderThanMs`: submitted ones
 * are reconciled with the venue, created/funded ones are driven forward. Returns
 * how many it looked at.
 */
export async function reconcileStuckOrders(olderThanMs: number, now = Date.now()): Promise<number> {
  const cutoff = new Date(now - olderThanMs);
  let looked = 0;
  for (const state of ["submitted", "funded", "created"] as OrderState[]) {
    const stuck = (await orders().findMany({ where: { state, updatedAt: { lt: cutoff } } })) as StockOrderRow[];
    for (const o of stuck) {
      looked++;
      try {
        if (state === "submitted") await reconcileOrder(o.reference);
        else await advanceOrder(o.reference);
      } catch (error: any) {
        logger.warn("Could not resolve a stuck order", { reference: o.reference, state, error: error?.message });
      }
    }
  }
  return looked;
}

export const isTerminal = (state: OrderState) => TERMINAL.includes(state);
