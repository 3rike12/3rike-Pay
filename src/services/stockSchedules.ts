import { prisma } from "@/db/prisma";
import { checkOrderCash, type StockOrderRow } from "@/services/stockOrders";
import { OrderRefused } from "@/services/orderErrors";
import type { StockToken } from "@/services/stocks";
import { createLogger } from "@/utils/logger";

const logger = createLogger("stock-schedules");

// ============================================
// Recurring stock buys
//
// "Buy 2000 of Apple every Friday". A schedule is a row with a `nextRunAt`. A
// runner looks for due ones and places an order for each. Rules that keep it safe:
//
//  - Exactly once per occurrence. The order's reference is derived from the
//    schedule and the SCHEDULED time, and placing an order is idempotent on its
//    reference, so a crash and retry resumes the same order.
//  - Place the order FIRST, then advance the schedule. A crash in between leaves
//    the schedule due, and the retry resumes the same order. The other way round
//    would lose a run.
//  - Advancing is a guarded update (only if nextRunAt is still what we read), so
//    two overlapping runners cannot both advance, or both announce.
//  - Missed runs are not piled up: after downtime only the oldest due occurrence
//    runs, and the schedule jumps to the next one after now.
//  - A definite failure (refused, refunded, not enough cash) counts and the
//    schedule moves on; three in a row pause it and tell the person. An error that
//    does not say what happened (the venue unreachable) does NOT skip the run: it
//    stays due and retries, until it is more than six hours late, then it counts.
//
// Runs happen at 08:00 UTC, which is 11:00 in Nairobi and Dar es Salaam and 09:00
// in Lagos. Weekdays and days of the month are UTC.
// ============================================

export type Frequency = "daily" | "weekly" | "monthly";

export interface ScheduleRule {
  frequency: Frequency;
  /** 0 = Sunday .. 6 = Saturday. Weekly only. Defaults to the day it is created on. */
  weekday?: number;
  /** 1..28. Monthly only. Defaults to the day it is created on, capped at 28. */
  dayOfMonth?: number;
}

export const RUN_HOUR_UTC = 8;
export const MAX_ACTIVE_SCHEDULES = 10;
export const MAX_FAILURES = 3;
/** An error that does not say what happened keeps a run due this long before it counts as a failure. */
export const RETRY_WINDOW_MS = 6 * 60 * 60 * 1000;

const at = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d, RUN_HOUR_UTC, 0, 0, 0));

/** The first run time strictly after `from`. Pure. */
export function nextRunAfter(from: Date, rule: ScheduleRule): Date {
  const y = from.getUTCFullYear();
  const m = from.getUTCMonth();
  const d = from.getUTCDate();

  if (rule.frequency === "daily") {
    const today = at(y, m, d);
    return today > from ? today : at(y, m, d + 1);
  }
  if (rule.frequency === "weekly") {
    const wd = rule.weekday ?? from.getUTCDay();
    const ahead = (wd - from.getUTCDay() + 7) % 7;
    const candidate = at(y, m, d + ahead);
    return candidate > from ? candidate : at(y, m, d + ahead + 7);
  }
  const dom = Math.min(rule.dayOfMonth ?? d, 28);
  const thisMonth = at(y, m, dom);
  return thisMonth > from ? thisMonth : at(y, m + 1, dom);
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ordinal = (n: number) => `${n}${["th", "st", "nd", "rd"][n % 100 > 10 && n % 100 < 14 ? 0 : Math.min(n % 10, 4) % 4] ?? "th"}`;

/** "every day", "every Friday", "on the 15th of every month". */
export function scheduleLabel(rule: ScheduleRule, createdOn: Date = new Date()): string {
  if (rule.frequency === "daily") return "every day";
  if (rule.frequency === "weekly") return `every ${DAYS[rule.weekday ?? createdOn.getUTCDay()]}`;
  return `on the ${ordinal(Math.min(rule.dayOfMonth ?? createdOn.getUTCDate(), 28))} of every month`;
}

export interface ScheduleRow {
  id: string;
  reference: string;
  userId: string;
  tokenAddress: string;
  tokenDecimals: number;
  ticker: string;
  name: string;
  cashAmount: number;
  currency: string;
  frequency: Frequency;
  weekday: number | null;
  dayOfMonth: number | null;
  state: "active" | "paused" | "cancelled";
  nextRunAt: Date;
  lastRunAt: Date | null;
  failures: number;
}

const table = () => (prisma as any).stockSchedule;
const isUnique = (e: unknown) => (e as { code?: string } | null)?.code === "P2002";

export async function createSchedule(p: {
  reference: string;
  userId: string;
  token: Pick<StockToken, "address" | "decimals" | "ticker" | "name">;
  cashAmount: number;
  currency: string;
  rule: ScheduleRule;
  now?: Date;
}): Promise<ScheduleRow> {
  const now = p.now ?? new Date();
  const { frequency, weekday, dayOfMonth } = p.rule;
  if (!["daily", "weekly", "monthly"].includes(frequency)) throw new OrderRefused("That isn't a schedule I understand.");
  if (weekday !== undefined && (!Number.isInteger(weekday) || weekday < 0 || weekday > 6)) throw new OrderRefused("That isn't a day of the week.");
  if (dayOfMonth !== undefined && (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 28)) {
    throw new OrderRefused("Pick a day from the 1st to the 28th so it exists every month.");
  }
  checkOrderCash(p.cashAmount, p.currency); // a real amount, a supported currency, inside the size limits

  const same = (r: ScheduleRow) =>
    r.userId === p.userId && r.tokenAddress === p.token.address && r.cashAmount === p.cashAmount && r.currency === p.currency && r.frequency === frequency;
  const existing = (await table().findUnique({ where: { reference: p.reference } })) as ScheduleRow | null;
  if (existing) {
    if (!same(existing)) throw new Error(`Schedule reference ${p.reference} was already used for a different schedule`);
    return existing; // pressing yes twice is one schedule
  }

  const open = await table().count({ where: { userId: p.userId, state: "active" } });
  if (open >= MAX_ACTIVE_SCHEDULES) throw new OrderRefused(`You can have up to ${MAX_ACTIVE_SCHEDULES} recurring buys at once. Stop one to add another.`);

  const data = {
    reference: p.reference,
    userId: p.userId,
    tokenAddress: p.token.address,
    tokenDecimals: p.token.decimals,
    ticker: p.token.ticker,
    name: p.token.name,
    cashAmount: p.cashAmount,
    currency: p.currency,
    frequency,
    weekday: frequency === "weekly" ? (weekday ?? now.getUTCDay()) : null,
    dayOfMonth: frequency === "monthly" ? Math.min(dayOfMonth ?? now.getUTCDate(), 28) : null,
    nextRunAt: nextRunAfter(now, { frequency, weekday, dayOfMonth }),
  };
  try {
    return (await table().create({ data })) as ScheduleRow;
  } catch (error) {
    if (!isUnique(error)) throw error;
    const raced = (await table().findUnique({ where: { reference: p.reference } })) as ScheduleRow | null;
    if (raced && same(raced)) return raced;
    throw error;
  }
}

/** Stop the person's recurring buys: one stock, or all. Returns how many were stopped. */
export async function cancelSchedules(userId: string, tokenAddress?: string): Promise<number> {
  const { count } = await table().updateMany({
    where: { userId, state: { in: ["active", "paused"] }, ...(tokenAddress ? { tokenAddress } : {}) },
    data: { state: "cancelled" },
  });
  return count;
}

export async function listSchedules(userId: string): Promise<ScheduleRow[]> {
  return (await table().findMany({ where: { userId, state: { in: ["active", "paused"] } } })) as ScheduleRow[];
}

export type RunEvent =
  | { kind: "bought"; schedule: ScheduleRow; order: StockOrderRow }
  | { kind: "processing"; schedule: ScheduleRow; order: StockOrderRow }
  | { kind: "failed"; schedule: ScheduleRow; reason: string; paused: boolean; nextRunAt: Date };

export interface RunDeps {
  now?: Date;
  place(p: { reference: string; userId: string; token: StockToken; cashAmount: number; currency: string }): Promise<StockOrderRow>;
  notify?(event: RunEvent): Promise<void> | void;
}

const tokenOf = (s: ScheduleRow): StockToken => ({
  address: s.tokenAddress, symbol: s.ticker, ticker: s.ticker, name: s.name, decimals: s.tokenDecimals,
  multiplier: 1, navPrice: null, navUpdatedAt: null, isin: null, totalSupply: null,
});

function reasonFor(error: unknown, order?: StockOrderRow): string {
  if (order?.failure) return /Insufficient/i.test(order.failure) ? "your balance was too low" : "the market wasn't right for the trade";
  if (error instanceof OrderRefused) return error.message;
  return "something went wrong on our side";
}

/**
 * Place an order for every schedule that is due. Safe to call as often and from
 * as many workers as you like. Returns how many it advanced.
 */
export async function runDueSchedules(deps: RunDeps): Promise<number> {
  const now = deps.now ?? new Date();
  const due = (await table().findMany({ where: { state: "active", nextRunAt: { lte: now } }, take: 100 })) as ScheduleRow[];
  let advanced = 0;

  for (const s of due) {
    const scheduledFor = s.nextRunAt;
    const reference = `stk-sched:${s.id}:${scheduledFor.toISOString()}`;

    let order: StockOrderRow | undefined;
    let thrown: unknown;
    try {
      order = await deps.place({ reference, userId: s.userId, token: tokenOf(s), cashAmount: s.cashAmount, currency: s.currency });
    } catch (error) {
      thrown = error;
    }

    // An error that does not say what happened is retried, not skipped, until it is too late to matter.
    if (thrown && now.getTime() - scheduledFor.getTime() < RETRY_WINDOW_MS) {
      logger.warn("Recurring buy could not be placed; will retry", { schedule: s.id, error: (thrown as Error)?.message });
      continue;
    }

    const ok = !thrown && !!order && (order.state === "filled" || order.state === "submitted");
    const failures = ok ? 0 : s.failures + 1;
    const pause = !ok && failures >= MAX_FAILURES;
    const nextRunAt = nextRunAfter(now > scheduledFor ? now : scheduledFor, { frequency: s.frequency, weekday: s.weekday ?? undefined, dayOfMonth: s.dayOfMonth ?? undefined });

    // Only one runner gets to advance this occurrence, and only it announces.
    const { count } = await table().updateMany({
      where: { id: s.id, state: "active", nextRunAt: scheduledFor },
      data: { nextRunAt, lastRunAt: now, failures, ...(pause ? { state: "paused" } : {}) },
    });
    if (count !== 1) continue;
    advanced++;

    try {
      if (ok && order) await deps.notify?.({ kind: order.state === "filled" ? "bought" : "processing", schedule: s, order });
      else await deps.notify?.({ kind: "failed", schedule: s, reason: reasonFor(thrown, order), paused: pause, nextRunAt });
    } catch (error: any) {
      logger.warn("Could not announce a recurring buy", { schedule: s.id, error: error?.message });
    }
  }
  return advanced;
}
