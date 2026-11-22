// Runs against a REAL Redis (127.0.0.1:6379 or REDIS_URL). Skipped when none is reachable.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import Redis from "ioredis";

vi.mock("@/config", () => ({ config: { logLevel: "debug", redis: {} } }));

const getState = vi.fn();
vi.mock("@/services/cryptoInvoice", () => ({
  getCryptoPaymentState: (...a: any[]) => getState(...a),
  setVerificationScheduler: vi.fn(),
}));
const trackable = vi.fn();
const verifyWd = vi.fn();
const pendingWd = vi.fn();
vi.mock("@/services/withdrawal", () => ({
  verifyWithdrawal: (...a: any[]) => verifyWd(...a),
  setWithdrawalScheduler: vi.fn(),
  listPendingWithdrawalReferences: (...a: any[]) => pendingWd(...a),
}));
vi.mock("@/services/cryptoSweep", () => ({ listTrackableReferences: (...a: any[]) => trackable(...a) }));

import { startCryptoQueue, stopCryptoQueue, enqueueCheck, trackedReferences } from "@/services/cryptoQueue";

const URL = process.env.TEST_REDIS_URL || "redis://127.0.0.1:6379";
const probe = new Redis(URL, { lazyConnect: true, retryStrategy: () => null, connectTimeout: 800, maxRetriesPerRequest: 1 });
probe.on("error", () => {});
let up = false;
try { await probe.connect(); up = (await probe.ping()) === "PONG"; } catch { up = false; }

const PREFIX = `3rike-test-${Date.now()}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean | Promise<boolean>, ms = 8000) {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await fn()) return; await sleep(40); }
  throw new Error("timed out waiting");
}

describe.skipIf(!up)("crypto queue (real Redis)", () => {
  beforeAll(async () => {
    await startCryptoQueue({ redisUrl: URL, prefix: PREFIX, delayMs: () => 60, retryDelayMs: 50, sweepEveryMs: 200 });
  });
  afterAll(async () => {
    await stopCryptoQueue();
    const keys = await probe.keys(`${PREFIX}*`);
    if (keys.length) await probe.del(...keys);
    probe.disconnect();
  });
  beforeEach(() => {
    getState.mockReset(); trackable.mockReset(); trackable.mockResolvedValue([]);
    verifyWd.mockReset(); pendingWd.mockReset(); pendingWd.mockResolvedValue([]);
  });

  it("keeps re-checking the SAME job until the payment is paid, then stops", async () => {
    getState.mockResolvedValueOnce({ state: "awaiting_payment" }).mockResolvedValueOnce({ state: "processing" }).mockResolvedValue({ state: "paid" });
    await enqueueCheck("PAY-1");
    await until(() => getState.mock.calls.filter((c) => c[0] === "PAY-1").length >= 3);
    await sleep(300);
    expect(getState.mock.calls.filter((c) => c[0] === "PAY-1")).toHaveLength(3); // stopped after "paid"
    expect(await trackedReferences()).not.toContain("PAY-1"); // finished, so no longer tracked
  });

  it("does not create a second job when the same invoice is scheduled again", async () => {
    getState.mockResolvedValue({ state: "awaiting_payment" });
    await enqueueCheck("DUP-1", 60_000);
    await enqueueCheck("DUP-1", 60_000);
    await enqueueCheck("DUP-1", 60_000);
    expect((await trackedReferences()).filter((r) => r === "DUP-1")).toHaveLength(1);
  });

  it("keeps watching an expired invoice, because a late payment can still arrive", async () => {
    getState.mockResolvedValue({ state: "expired" });
    await enqueueCheck("LATE-1");
    await until(() => getState.mock.calls.filter((c) => c[0] === "LATE-1").length >= 3);
  });

  it("stops for refunded and failed payments", async () => {
    getState.mockResolvedValue({ state: "refunded" });
    await enqueueCheck("REF-1");
    await until(() => getState.mock.calls.some((c) => c[0] === "REF-1"));
    await sleep(250);
    expect(getState.mock.calls.filter((c) => c[0] === "REF-1")).toHaveLength(1);
  });

  it("retries after an error with back-off instead of losing the payment", async () => {
    getState.mockRejectedValueOnce(new Error("1Click down")).mockResolvedValue({ state: "paid" });
    await enqueueCheck("ERR-1");
    await until(() => getState.mock.calls.filter((c) => c[0] === "ERR-1").length >= 2);
  });

  it("the sweep re-adds a check for an open invoice that lost its job", async () => {
    getState.mockResolvedValue({ state: "paid" });
    trackable.mockResolvedValue(["LOST-1"]);
    await until(() => getState.mock.calls.some((c) => c[0] === "LOST-1"));
  });

  it("keeps checking a withdrawal until the payout is final, and never asks the invoice checker", async () => {
    verifyWd.mockResolvedValueOnce("pending").mockResolvedValueOnce("pending").mockResolvedValue("completed");
    await enqueueCheck("WD-1", 0, "withdrawal");
    await until(() => verifyWd.mock.calls.filter((c) => c[0] === "WD-1").length >= 3);
    await sleep(300);
    expect(verifyWd.mock.calls.filter((c) => c[0] === "WD-1")).toHaveLength(3); // stopped once completed
    expect(getState).not.toHaveBeenCalled();
  });

  it("stops watching a withdrawal that failed and was credited back", async () => {
    verifyWd.mockResolvedValue("failed");
    await enqueueCheck("WD-2", 0, "withdrawal");
    await until(() => verifyWd.mock.calls.some((c) => c[0] === "WD-2"));
    await sleep(250);
    expect(verifyWd.mock.calls.filter((c) => c[0] === "WD-2")).toHaveLength(1);
  });

  it("the sweep re-adds a withdrawal that lost its job (e.g. after a Redis flush)", async () => {
    verifyWd.mockResolvedValue("completed");
    pendingWd.mockResolvedValue(["WD-LOST"]);
    await until(() => verifyWd.mock.calls.some((c) => c[0] === "WD-LOST"));
    expect(getState).not.toHaveBeenCalled();
  });
});
