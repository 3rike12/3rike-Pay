import { describe, it, expect, vi, beforeEach } from "vitest";

const cfg: any = vi.hoisted(() => ({
  logLevel: "silent",
  nearIntents: { fxRates: { USD: 1, KES: 130 } },
  stocks: { minOrderUsd: 5, maxOrderUsd: 500 },
}));
vi.mock("@/config", () => ({ config: cfg }));
vi.mock("@/services/ledger", () => ({ ledger: {} }));
vi.mock("@/services/positions", () => ({ positions: {} }));
vi.mock("@/services/stockVenue", () => ({ getStockVenue: () => null }));
vi.mock("@/services/treasury", () => ({
  toUsd: (a: number, c: string) => a / ({ USD: 1, KES: 130 } as Record<string, number>)[c],
  fromUsd: (a: number, c: string) => a * ({ USD: 1, KES: 130 } as Record<string, number>)[c],
  onChainBalanceUsd: async () => 0,
  liabilities: async () => ({ totalUsd: 0, byCurrency: {} }),
}));

const rows = vi.hoisted(() => new Map<string, any>());
const tick = () => new Promise<void>((r) => setImmediate(r));
vi.mock("@/db/prisma", () => ({
  prisma: {
    stockSchedule: {
      findUnique: async ({ where }: any) => { await tick(); const r = [...rows.values()].find((x) => x.reference === where.reference); return r ? { ...r } : null; },
      create: async ({ data }: any) => {
        await tick();
        if ([...rows.values()].some((x) => x.reference === data.reference)) throw Object.assign(new Error("unique"), { code: "P2002" });
        const r = { id: `s${rows.size + 1}`, state: "active", lastRunAt: null, failures: 0, ...data };
        rows.set(r.id, r);
        return { ...r };
      },
      count: async ({ where }: any) => { await tick(); return [...rows.values()].filter((r) => r.userId === where.userId && r.state === where.state).length; },
      findMany: async ({ where }: any) => {
        await tick();
        return [...rows.values()].filter((r) =>
          (!where.userId || r.userId === where.userId) &&
          (!where.state || (typeof where.state === "string" ? r.state === where.state : where.state.in.includes(r.state))) &&
          (!where.nextRunAt?.lte || r.nextRunAt <= where.nextRunAt.lte)
        ).map((r) => ({ ...r }));
      },
      updateMany: async ({ where, data }: any) => {
        await tick();
        let count = 0;
        for (const r of rows.values()) {
          const stateOk = !where.state || (typeof where.state === "string" ? r.state === where.state : where.state.in.includes(r.state));
          if ((!where.id || r.id === where.id) && (!where.userId || r.userId === where.userId) && stateOk &&
              (!where.nextRunAt || r.nextRunAt.getTime() === where.nextRunAt.getTime()) && (!where.tokenAddress || r.tokenAddress === where.tokenAddress)) {
            Object.assign(r, data);
            count++;
          }
        }
        return { count };
      },
    },
  },
}));

import { nextRunAfter, scheduleLabel, createSchedule, cancelSchedules, listSchedules, runDueSchedules, MAX_ACTIVE_SCHEDULES, MAX_FAILURES, RETRY_WINDOW_MS, type RunEvent } from "@/services/stockSchedules";
import { OrderRefused } from "@/services/stockOrders";

const D = (s: string) => new Date(s);
const iso = (d: Date) => d.toISOString();
const TOKEN = { address: "0x" + "1".repeat(40), decimals: 8, ticker: "AAPL", name: "Apple Inc." };

beforeEach(() => rows.clear());

describe("nextRunAfter: daily", () => {
  it("is today at 08:00 UTC when that is still ahead", () => {
    expect(iso(nextRunAfter(D("2026-11-23T05:00:00Z"), { frequency: "daily" }))).toBe("2026-11-23T08:00:00.000Z");
  });
  it("is tomorrow once 08:00 has passed, and never the same instant", () => {
    expect(iso(nextRunAfter(D("2026-11-23T08:00:00Z"), { frequency: "daily" }))).toBe("2026-11-24T08:00:00.000Z");
    expect(iso(nextRunAfter(D("2026-11-23T23:59:59Z"), { frequency: "daily" }))).toBe("2026-11-24T08:00:00.000Z");
  });
  it("rolls over month and year ends", () => {
    expect(iso(nextRunAfter(D("2026-12-31T09:00:00Z"), { frequency: "daily" }))).toBe("2027-01-01T08:00:00.000Z");
    expect(iso(nextRunAfter(D("2028-02-28T09:00:00Z"), { frequency: "daily" }))).toBe("2028-02-29T08:00:00.000Z"); // a leap year
  });
});

describe("nextRunAfter: weekly", () => {
  // 2026-11-23 is a Monday.
  it("finds the named weekday later this week", () => {
    expect(iso(nextRunAfter(D("2026-11-23T10:00:00Z"), { frequency: "weekly", weekday: 5 }))).toBe("2026-11-27T08:00:00.000Z"); // Friday
  });
  it("is a week on when it is that day but 08:00 has passed", () => {
    expect(iso(nextRunAfter(D("2026-11-27T09:00:00Z"), { frequency: "weekly", weekday: 5 }))).toBe("2026-12-04T08:00:00.000Z");
  });
  it("is today when it is that day and 08:00 is still ahead", () => {
    expect(iso(nextRunAfter(D("2026-11-27T07:00:00Z"), { frequency: "weekly", weekday: 5 }))).toBe("2026-11-27T08:00:00.000Z");
  });
  it("wraps past the end of the week and of the month", () => {
    expect(iso(nextRunAfter(D("2026-11-29T10:00:00Z"), { frequency: "weekly", weekday: 1 }))).toBe("2026-11-30T08:00:00.000Z"); // Sunday -> Monday
    expect(iso(nextRunAfter(D("2026-12-30T10:00:00Z"), { frequency: "weekly", weekday: 5 }))).toBe("2027-01-01T08:00:00.000Z");
  });
  it("handles Sunday (0) and Saturday (6)", () => {
    expect(nextRunAfter(D("2026-11-23T10:00:00Z"), { frequency: "weekly", weekday: 0 }).getUTCDay()).toBe(0);
    expect(nextRunAfter(D("2026-11-23T10:00:00Z"), { frequency: "weekly", weekday: 6 }).getUTCDay()).toBe(6);
  });
  it("with no weekday it is the weekday of the moment it was set up", () => {
    expect(iso(nextRunAfter(D("2026-11-23T10:00:00Z"), { frequency: "weekly" }))).toBe("2026-11-30T08:00:00.000Z");
  });
  it("is always strictly after, and always 08:00 UTC, over a whole year of starting points", () => {
    for (let h = 0; h < 24 * 365; h += 7) {
      const from = new Date(Date.UTC(2026, 0, 1) + h * 3600_000);
      for (let weekday = 0; weekday < 7; weekday++) {
        const next = nextRunAfter(from, { frequency: "weekly", weekday });
        expect(next.getTime()).toBeGreaterThan(from.getTime());
        expect(next.getUTCHours()).toBe(8);
        expect(next.getUTCDay()).toBe(weekday);
        expect(next.getTime() - from.getTime()).toBeLessThanOrEqual(7 * 24 * 3600_000);
      }
    }
  });
});

describe("nextRunAfter: monthly", () => {
  it("is this month when the day is still ahead, next month when it has passed", () => {
    expect(iso(nextRunAfter(D("2026-11-10T00:00:00Z"), { frequency: "monthly", dayOfMonth: 15 }))).toBe("2026-11-15T08:00:00.000Z");
    expect(iso(nextRunAfter(D("2026-11-15T09:00:00Z"), { frequency: "monthly", dayOfMonth: 15 }))).toBe("2026-12-15T08:00:00.000Z");
  });
  it("rolls from December into January", () => {
    expect(iso(nextRunAfter(D("2026-12-20T00:00:00Z"), { frequency: "monthly", dayOfMonth: 1 }))).toBe("2027-01-01T08:00:00.000Z");
  });
  it("never uses a day that does not exist in every month: 29 to 31 become 28", () => {
    expect(iso(nextRunAfter(D("2026-01-30T00:00:00Z"), { frequency: "monthly", dayOfMonth: 31 }))).toBe("2026-02-28T08:00:00.000Z");
    expect(nextRunAfter(D("2026-01-01T00:00:00Z"), { frequency: "monthly", dayOfMonth: 30 }).getUTCDate()).toBe(28);
  });
  it("with no day it is the day of the month it was set up, capped at 28", () => {
    expect(iso(nextRunAfter(D("2026-11-12T10:00:00Z"), { frequency: "monthly" }))).toBe("2026-12-12T08:00:00.000Z");
    expect(nextRunAfter(D("2026-10-31T10:00:00Z"), { frequency: "monthly" }).getUTCDate()).toBe(28);
  });
  it("is always strictly after and on the right day, across several years", () => {
    for (let day = 1; day <= 28; day++) {
      for (let h = 0; h < 24 * 365 * 3; h += 53) {
        const from = new Date(Date.UTC(2026, 0, 1) + h * 3600_000);
        const next = nextRunAfter(from, { frequency: "monthly", dayOfMonth: day });
        expect(next.getTime()).toBeGreaterThan(from.getTime());
        expect(next.getUTCDate()).toBe(day);
        expect(next.getUTCHours()).toBe(8);
      }
    }
  });
});

describe("scheduleLabel", () => {
  it("reads naturally", () => {
    expect(scheduleLabel({ frequency: "daily" })).toBe("every day");
    expect(scheduleLabel({ frequency: "weekly", weekday: 5 })).toBe("every Friday");
    expect(scheduleLabel({ frequency: "weekly" }, D("2026-11-23T10:00:00Z"))).toBe("every Monday");
    expect(scheduleLabel({ frequency: "monthly", dayOfMonth: 1 })).toBe("on the 1st of every month");
    expect(scheduleLabel({ frequency: "monthly", dayOfMonth: 2 })).toBe("on the 2nd of every month");
    expect(scheduleLabel({ frequency: "monthly", dayOfMonth: 3 })).toBe("on the 3rd of every month");
    expect(scheduleLabel({ frequency: "monthly", dayOfMonth: 11 })).toBe("on the 11th of every month");
    expect(scheduleLabel({ frequency: "monthly", dayOfMonth: 22 })).toBe("on the 22nd of every month");
  });
});

describe("createSchedule", () => {
  const make = (over: Record<string, any> = {}) => createSchedule({ reference: "c1", userId: "u1", token: TOKEN, cashAmount: 2_000, currency: "KES", rule: { frequency: "weekly", weekday: 5 }, now: D("2026-11-23T10:00:00Z"), ...over });

  it("stores the schedule and works out the first run", async () => {
    const s = await make();
    expect(s).toMatchObject({ userId: "u1", tokenAddress: TOKEN.address, ticker: "AAPL", cashAmount: 2_000, currency: "KES", frequency: "weekly", weekday: 5, state: "active", failures: 0 });
    expect(iso(s.nextRunAt)).toBe("2026-11-27T08:00:00.000Z");
  });

  it("pressing yes twice makes one schedule", async () => {
    const a = await make();
    const b = await make();
    expect(b.id).toBe(a.id);
    expect(rows.size).toBe(1);
  });

  it("two simultaneous creations make one", async () => {
    await Promise.all(Array.from({ length: 4 }, () => make()));
    expect(rows.size).toBe(1);
  });

  it("a reference reused for a different schedule is refused", async () => {
    await make();
    await expect(make({ cashAmount: 9_000 })).rejects.toThrow(/reference/i);
    await expect(make({ userId: "u2" })).rejects.toThrow(/reference/i);
  });

  it("refuses an amount below the minimum or above the maximum order, and a bad one", async () => {
    await expect(make({ reference: "a", cashAmount: 130 })).rejects.toThrow(/minimum/i);
    await expect(make({ reference: "b", cashAmount: 130 * 600 })).rejects.toThrow(/maximum/i);
    await expect(make({ reference: "c", cashAmount: 0 })).rejects.toThrow();
    await expect(make({ reference: "d", currency: "XYZ" })).rejects.toThrow();
    expect(rows.size).toBe(0);
  });

  it("refuses a day that does not exist every month, a bad weekday, and a bad frequency", async () => {
    await expect(make({ reference: "a", rule: { frequency: "monthly", dayOfMonth: 31 } })).rejects.toThrow(/1st to the 28th/);
    await expect(make({ reference: "b", rule: { frequency: "weekly", weekday: 7 } })).rejects.toThrow(/day of the week/);
    await expect(make({ reference: "c", rule: { frequency: "hourly" as any } })).rejects.toThrow(/understand/);
  });

  it("limits how many a person can have, and says so kindly", async () => {
    for (let i = 0; i < MAX_ACTIVE_SCHEDULES; i++) await make({ reference: `r${i}` });
    await expect(make({ reference: "one-too-many" })).rejects.toThrow(new RegExp(`up to ${MAX_ACTIVE_SCHEDULES}`));
  });

  it("fills in the weekday or day of month from today when none was named", async () => {
    expect((await make({ reference: "w", rule: { frequency: "weekly" } })).weekday).toBe(1); // Monday
    expect((await make({ reference: "m", rule: { frequency: "monthly" } })).dayOfMonth).toBe(23);
  });
});

describe("cancelling and listing", () => {
  const make = (reference: string, ticker: string, address: string) =>
    createSchedule({ reference, userId: "u1", token: { ...TOKEN, ticker, address }, cashAmount: 2_000, currency: "KES", rule: { frequency: "daily" }, now: D("2026-11-23T10:00:00Z") });

  it("stops one stock's buys, or all of them, and says how many", async () => {
    await make("a", "AAPL", "0x" + "1".repeat(40));
    await make("b", "TSLA", "0x" + "2".repeat(40));
    expect(await cancelSchedules("u1", "0x" + "1".repeat(40))).toBe(1);
    expect((await listSchedules("u1")).map((s) => s.ticker)).toEqual(["TSLA"]);
    expect(await cancelSchedules("u1")).toBe(1);
    expect(await listSchedules("u1")).toEqual([]);
  });

  it("only touches that person's schedules", async () => {
    await make("a", "AAPL", "0x" + "1".repeat(40));
    expect(await cancelSchedules("someone-else")).toBe(0);
    expect(await listSchedules("u1")).toHaveLength(1);
  });

  it("also stops a paused one", async () => {
    await make("a", "AAPL", "0x" + "1".repeat(40));
    [...rows.values()][0].state = "paused";
    expect(await cancelSchedules("u1")).toBe(1);
  });
});

describe("runDueSchedules", () => {
  const filled = (over: any = {}) => ({ state: "filled", side: "buy", tokenUnits: 100_000_000n, cashAmount: 2_000, currency: "KES", ...over });
  const NOW = D("2026-11-27T08:00:30Z");
  let events: RunEvent[];
  const placed: any[] = [];
  const notify = (e: RunEvent) => void events.push(e);

  async function dueSchedule(over: Record<string, any> = {}) {
    const s = await createSchedule({ reference: "c1", userId: "u1", token: TOKEN, cashAmount: 2_000, currency: "KES", rule: { frequency: "weekly", weekday: 5 }, now: D("2026-11-23T10:00:00Z") });
    Object.assign(rows.get(s.id), over);
    return rows.get(s.id);
  }

  beforeEach(() => {
    events = [];
    placed.length = 0;
  });

  it("places an order for a due schedule, tells the person, and moves to next week", async () => {
    const s = await dueSchedule();
    const n = await runDueSchedules({ now: NOW, place: async (p) => (placed.push(p), filled() as any), notify });
    expect(n).toBe(1);
    expect(placed[0]).toMatchObject({ userId: "u1", cashAmount: 2_000, currency: "KES", reference: `stk-sched:${s.id}:2026-11-27T08:00:00.000Z`, token: expect.objectContaining({ address: TOKEN.address, decimals: 8 }) });
    expect(events.map((e) => e.kind)).toEqual(["bought"]);
    expect(iso(rows.get(s.id).nextRunAt)).toBe("2026-12-04T08:00:00.000Z");
    expect(rows.get(s.id).failures).toBe(0);
  });

  it("leaves a schedule that is not due yet alone", async () => {
    await dueSchedule({ nextRunAt: D("2026-11-28T08:00:00Z") });
    expect(await runDueSchedules({ now: NOW, place: async () => filled() as any, notify })).toBe(0);
    expect(events).toEqual([]);
  });

  it("does not touch paused or cancelled schedules", async () => {
    await dueSchedule({ state: "paused" });
    expect(await runDueSchedules({ now: NOW, place: async (p) => (placed.push(p), filled() as any), notify })).toBe(0);
    expect(placed).toEqual([]);
  });

  it("an order still being processed is reported as that, and counts as a success", async () => {
    const s = await dueSchedule({ failures: 2 });
    await runDueSchedules({ now: NOW, place: async () => filled({ state: "submitted" }) as any, notify });
    expect(events.map((e) => e.kind)).toEqual(["processing"]);
    expect(rows.get(s.id).failures).toBe(0);
  });

  it("running twice in a row (or two runners at once) places once and tells once", async () => {
    const s = await dueSchedule();
    const place = async (p: any) => (placed.push(p), filled() as any);
    await Promise.all([runDueSchedules({ now: NOW, place, notify }), runDueSchedules({ now: NOW, place, notify }), runDueSchedules({ now: NOW, place, notify })]);
    await runDueSchedules({ now: NOW, place, notify });
    expect(events).toHaveLength(1);
    expect(new Set(placed.map((p) => p.reference)).size).toBe(1); // every attempt used the same order reference
    expect(iso(rows.get(s.id).nextRunAt)).toBe("2026-12-04T08:00:00.000Z");
  });

  it("after downtime, runs only the oldest missed occurrence and jumps to the next one after now", async () => {
    const s = await dueSchedule({ nextRunAt: D("2026-11-06T08:00:00Z") }); // three Fridays missed
    await runDueSchedules({ now: NOW, place: async (p) => (placed.push(p), filled() as any), notify });
    expect(placed).toHaveLength(1);
    expect(placed[0].reference).toContain("2026-11-06");
    expect(iso(rows.get(s.id).nextRunAt)).toBe("2026-12-04T08:00:00.000Z");
  });

  it("a refunded or failed order counts as a failure and the schedule moves on", async () => {
    const s = await dueSchedule();
    await runDueSchedules({ now: NOW, place: async () => filled({ state: "failed", failure: "Insufficient balance: 100 KES available" }) as any, notify });
    expect(events[0]).toMatchObject({ kind: "failed", reason: "your balance was too low", paused: false });
    expect(rows.get(s.id).failures).toBe(1);
    expect(iso(rows.get(s.id).nextRunAt)).toBe("2026-12-04T08:00:00.000Z");
  });

  it("a refund for a bad price is explained without jargon", async () => {
    await dueSchedule();
    await runDueSchedules({ now: NOW, place: async () => filled({ state: "refunded", failure: "slippage" }) as any, notify });
    expect((events[0] as any).reason).toBe("the market wasn't right for the trade");
  });

  it(`pauses after ${MAX_FAILURES} failures in a row, and says so`, async () => {
    const s = await dueSchedule({ failures: MAX_FAILURES - 1 });
    await runDueSchedules({ now: NOW, place: async () => filled({ state: "failed", failure: "Insufficient balance" }) as any, notify });
    expect(rows.get(s.id).state).toBe("paused");
    expect(events[0]).toMatchObject({ kind: "failed", paused: true });
    // A paused schedule does not run again.
    events.length = 0;
    await runDueSchedules({ now: D("2026-12-04T08:00:30Z"), place: async () => filled() as any, notify });
    expect(events).toEqual([]);
  });

  it("a success resets the failure count, so failures must be consecutive to pause", async () => {
    const s = await dueSchedule({ failures: 2 });
    await runDueSchedules({ now: NOW, place: async () => filled() as any, notify });
    expect(rows.get(s.id).failures).toBe(0);
  });

  it("an error that does not say what happened does NOT skip the run: it stays due and retries under the same reference", async () => {
    const s = await dueSchedule();
    const refs: string[] = [];
    await runDueSchedules({ now: NOW, place: async (p) => (refs.push(p.reference), Promise.reject(new Error("ECONNRESET"))), notify });
    expect(events).toEqual([]);
    expect(iso(rows.get(s.id).nextRunAt)).toBe("2026-11-27T08:00:00.000Z"); // unchanged: still due
    expect(rows.get(s.id).failures).toBe(0);
    await runDueSchedules({ now: new Date(NOW.getTime() + 60_000), place: async (p) => (refs.push(p.reference), filled() as any), notify });
    expect(new Set(refs).size).toBe(1);
    expect(events.map((e) => e.kind)).toEqual(["bought"]);
  });

  it("but gives up, as a failure, once it is more than six hours late", async () => {
    const s = await dueSchedule();
    const late = new Date(D("2026-11-27T08:00:00Z").getTime() + RETRY_WINDOW_MS + 1000);
    await runDueSchedules({ now: late, place: async () => Promise.reject(new Error("ECONNRESET")), notify });
    expect(events[0]).toMatchObject({ kind: "failed", reason: "something went wrong on our side" });
    expect(rows.get(s.id).failures).toBe(1);
    expect(rows.get(s.id).nextRunAt.getTime()).toBeGreaterThan(late.getTime());
  });

  it("shows a refusal the person can act on, but never an internal error", async () => {
    await dueSchedule();
    const late = new Date(D("2026-11-27T08:00:00Z").getTime() + RETRY_WINDOW_MS + 1000);
    await runDueSchedules({ now: late, place: async () => Promise.reject(new OrderRefused("Stocks are temporarily unavailable.")), notify });
    expect((events[0] as any).reason).toBe("Stocks are temporarily unavailable.");
    events.length = 0;
    await dueSchedule({ reference: "x" });
    rows.forEach((r) => ((r.nextRunAt = D("2026-11-27T08:00:00Z")), (r.state = "active")));
    await runDueSchedules({ now: late, place: async () => Promise.reject(new Error("P1001: Can't reach database server at db.internal:5432")), notify });
    expect((events.at(-1) as any).reason).toBe("something went wrong on our side");
    expect(JSON.stringify(events)).not.toContain("5432");
  });

  it("a person who stops it before the run is not announced to", async () => {
    const s = await dueSchedule();
    await runDueSchedules({
      now: NOW,
      place: async () => {
        rows.get(s.id).state = "cancelled"; // they cancelled while the order was being placed
        return filled() as any;
      },
      notify,
    });
    expect(events).toEqual([]);
  });

  it("a notification that fails does not stop the run or the others", async () => {
    await dueSchedule();
    await createSchedule({ reference: "c2", userId: "u2", token: TOKEN, cashAmount: 2_000, currency: "KES", rule: { frequency: "weekly", weekday: 5 }, now: D("2026-11-23T10:00:00Z") });
    rows.forEach((r) => (r.nextRunAt = D("2026-11-27T08:00:00Z")));
    const n = await runDueSchedules({ now: NOW, place: async () => filled() as any, notify: async () => { throw new Error("whatsapp down"); } });
    expect(n).toBe(2);
  });

  it("one person's failure does not stop another person's buy", async () => {
    await dueSchedule();
    await createSchedule({ reference: "c2", userId: "u2", token: TOKEN, cashAmount: 2_000, currency: "KES", rule: { frequency: "weekly", weekday: 5 }, now: D("2026-11-23T10:00:00Z") });
    rows.forEach((r) => (r.nextRunAt = D("2026-11-27T08:00:00Z")));
    await runDueSchedules({ now: NOW, place: async (p) => (p.userId === "u1" ? Promise.reject(new OrderRefused("nope")) : (filled() as any)), notify });
    expect(events.filter((e) => e.kind === "bought")).toHaveLength(1);
  });
});
