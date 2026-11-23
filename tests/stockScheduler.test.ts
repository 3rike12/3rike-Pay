import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/config", () => ({ config: { logLevel: "silent" } }));

const lock = vi.hoisted(() => ({ held: false, acquired: 0, released: 0 }));
vi.mock("@/utils/idempotency", () => ({
  acquireLock: async () => {
    if (lock.held) return null;
    lock.acquired++;
    return { release: async () => void lock.released++ };
  },
}));

const venue = vi.hoisted(() => ({ present: true }));
vi.mock("@/services/stockVenue", () => ({ getStockVenue: () => (venue.present ? { id: "v" } : null) }));

const orders = vi.hoisted(() => ({ reconcile: vi.fn(), placeBuy: vi.fn() }));
vi.mock("@/services/stockOrders", () => ({ reconcileStuckOrders: (...a: any[]) => orders.reconcile(...a), placeBuy: (...a: any[]) => orders.placeBuy(...a) }));
const sched = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("@/services/stockSchedules", () => ({ runDueSchedules: (...a: any[]) => sched.run(...a) }));
const alerts = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("@/services/stockAlerts", () => ({ runStockAlerts: (...a: any[]) => alerts.run(...a) }));
vi.mock("@/services/stockAlertStore", () => ({ prismaAlertStore: { tag: "store" } }));
vi.mock("@/services/stocks", () => ({ getStocks: async () => [] }));
vi.mock("@/services/positions", () => ({ positions: { tag: "positions" } }));

import { runStockJobs, startStockScheduler, STUCK_AFTER_MS } from "@/services/stockScheduler";

const notify = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  lock.held = false;
  lock.acquired = 0;
  lock.released = 0;
  venue.present = true;
  orders.reconcile.mockResolvedValue(2);
  sched.run.mockResolvedValue(3);
  alerts.run.mockResolvedValue({ checked: 4, sent: 0 });
});
afterEach(() => vi.useRealTimers());

describe("runStockJobs", () => {
  it("resolves stuck orders and then runs the recurring buys that are due", async () => {
    expect(await runStockJobs({ notify })).toEqual({ stuck: 2, ran: 3, alerted: 0 });
    expect(orders.reconcile).toHaveBeenCalledWith(STUCK_AFTER_MS);
    const passed = sched.run.mock.calls[0][0];
    expect(passed.notify).toBe(notify);
    await passed.place({ reference: "r" }); // the runner places orders through the real order service
    expect(orders.placeBuy).toHaveBeenCalledWith({ reference: "r" });
    expect(orders.reconcile.mock.invocationCallOrder[0]).toBeLessThan(sched.run.mock.invocationCallOrder[0]);
  });

  it("does nothing at all without a venue, so a due recurring buy waits instead of failing against the person", async () => {
    venue.present = false;
    expect(await runStockJobs({ notify })).toBeNull();
    expect(orders.reconcile).not.toHaveBeenCalled();
    expect(sched.run).not.toHaveBeenCalled();
  });

  const notifyUser = vi.fn();

  it("runs alerts with the real holdings and store, and counts what it sent", async () => {
    alerts.run.mockResolvedValue({ checked: 2, sent: 5 });
    expect(await runStockJobs({ notify, notifyUser })).toEqual({ stuck: 2, ran: 3, alerted: 5 });
    expect(alerts.run).toHaveBeenCalledWith(expect.objectContaining({ notify: notifyUser, store: { tag: "store" }, positions: { tag: "positions" } }));
  });

  it("does not run alerts when nobody can be messaged", async () => {
    await runStockJobs({ notify });
    expect(alerts.run).not.toHaveBeenCalled();
  });

  it("still sends alerts with no venue: they only need holdings to exist", async () => {
    venue.present = false;
    alerts.run.mockResolvedValue({ checked: 1, sent: 2 });
    expect(await runStockJobs({ notify, notifyUser })).toEqual({ stuck: 0, ran: 0, alerted: 2 });
    expect(orders.reconcile).not.toHaveBeenCalled();
    expect(sched.run).not.toHaveBeenCalled();
  });

  it("does nothing at all without a venue and with nothing to alert about", async () => {
    venue.present = false;
    expect(await runStockJobs({ notify, notifyUser })).toBeNull();
  });

  it("a failing alert pass never stops stuck orders and recurring buys from being resolved", async () => {
    alerts.run.mockRejectedValue(new Error("whatsapp down"));
    expect(await runStockJobs({ notify, notifyUser })).toEqual({ stuck: 2, ran: 3, alerted: 0 });
    expect(orders.reconcile).toHaveBeenCalled();
    expect(sched.run).toHaveBeenCalled();
  });

  it("waits several minutes before touching an order, so it never races the call that is still placing it", () => {
    expect(STUCK_AFTER_MS).toBeGreaterThanOrEqual(5 * 60_000);
  });
});

describe("startStockScheduler", () => {
  it("runs on every interval, and stops when asked", async () => {
    vi.useFakeTimers();
    const stop = startStockScheduler({ notify }, 60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sched.run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sched.run).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(sched.run).toHaveBeenCalledTimes(2);
  });

  it("takes the lock for a pass and always releases it", async () => {
    vi.useFakeTimers();
    startStockScheduler({ notify }, 60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(lock.acquired).toBe(1);
    expect(lock.released).toBe(1);
  });

  it("skips a pass when another instance holds the lock", async () => {
    vi.useFakeTimers();
    lock.held = true;
    startStockScheduler({ notify }, 60_000);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(sched.run).not.toHaveBeenCalled();
  });

  it("a failing pass is survived, releases the lock, and the next one still runs", async () => {
    vi.useFakeTimers();
    sched.run.mockRejectedValueOnce(new Error("db down")).mockResolvedValue(0);
    startStockScheduler({ notify }, 60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(lock.released).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sched.run).toHaveBeenCalledTimes(2);
    expect(lock.released).toBe(2);
  });
});
