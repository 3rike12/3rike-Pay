import { DelayedError, Queue, Worker, type ConnectionOptions, type Job } from "bullmq";
import { config } from "@/config";
import { getCryptoPaymentState, setVerificationScheduler } from "@/services/cryptoInvoice";
import { listTrackableReferences } from "@/services/cryptoSweep";
import { listPendingWithdrawalReferences, setWithdrawalScheduler, verifyWithdrawal } from "@/services/withdrawal";
import { createLogger } from "@/utils/logger";

const logger = createLogger("crypto-queue");

// ============================================
// Durable payment tracking (BullMQ over Redis)
//
// NEAR Intents has no webhooks, so "did the customer pay?" is answered by
// polling. This queue owns that polling:
//
//   - ONE job per invoice (id `check-<reference>`), so scheduling is idempotent
//     however many quotes the customer creates.
//   - The job re-schedules ITSELF (moveToDelayed) until the payment is paid,
//     refunded or failed, so there is no chain of jobs to lose.
//   - Errors are retried with exponential back-off; a rate limiter keeps us
//     polite to the 1Click API.
//   - A repeating "sweep" job re-adds checks for any open invoice that has none
//     (e.g. after a Redis flush), so nothing falls through.
//   - It survives restarts and deploys, and several instances share the work.
//
// Without REDIS_URL none of this starts and cryptoSweep's in-process timers
// are used instead, so the project still runs with no Redis at all.
// ============================================

const QUEUE_NAME = "crypto-payments";
const PREFIX = "3rike";

/** Stop tracking this long after the first check: the invoice window plus 24h of late-payment grace. */
export const MAX_TRACK_MS = 25 * 60 * 60 * 1000;

/** Poll fast while a customer is likely paying, then slow right down. */
export function nextDelayMs(attempt: number): number {
  if (attempt < 10) return 15_000; // first ~2.5 min
  if (attempt < 40) return 30_000; // to ~17 min
  if (attempt < 60) return 60_000; // to ~37 min
  return 5 * 60_000; // late-payment watch
}

/** What a check job is watching. Absent means an invoice payment, as before. */
export type CheckKind = "invoice" | "withdrawal";

export interface CheckJobData {
  reference: string;
  attempt: number;
  startedAt: number;
  kind?: CheckKind;
}

export function connectionFromUrl(url: string): ConnectionOptions {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : 6379,
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    db: u.pathname.length > 1 ? Number(u.pathname.slice(1)) : 0,
    tls: u.protocol === "rediss:" ? {} : undefined,
    maxRetriesPerRequest: null, // required by BullMQ workers
  };
}

/** True when polling should stop for this state. "expired" keeps going: a late payment can still land. */
export function isFinished(state: string, startedAt: number, now = Date.now()): boolean {
  if (state === "paid" || state === "refunded" || state === "failed" || state === "unknown") return true;
  return now - startedAt > MAX_TRACK_MS;
}

let queue: Queue | null = null;
let worker: Worker | null = null;

/** Add (or keep) the single check job for an invoice. No-op if one already exists. */
export async function enqueueCheck(reference: string, delayMs = 0, kind: CheckKind = "invoice"): Promise<void> {
  if (!queue) throw new Error("crypto queue is not running");
  await queue.add(
    "check",
    { reference, attempt: 0, startedAt: Date.now(), kind } satisfies CheckJobData,
    { jobId: `check-${reference}`, delay: delayMs }
  );
}

async function processJob(job: Job, token?: string): Promise<unknown> {
  if (job.name === "sweep") {
    const [refs, withdrawals] = await Promise.all([listTrackableReferences(true), listPendingWithdrawalReferences()]);
    await Promise.all([
      ...refs.map((r) => enqueueCheck(r).catch(() => {})),
      ...withdrawals.map((r) => enqueueCheck(r, 0, "withdrawal").catch(() => {})),
    ]);
    return { tracked: refs.length, withdrawals: withdrawals.length };
  }

  const data = job.data as CheckJobData;
  if (data.kind === "withdrawal") {
    const outcome = await verifyWithdrawal(data.reference);
    if (outcome !== "pending" || Date.now() - data.startedAt > MAX_TRACK_MS) return outcome;
  } else {
    const { state } = await getCryptoPaymentState(data.reference);
    if (isFinished(state, data.startedAt)) return state;
  }

  // Not done yet: wake this same job up later instead of creating another one.
  const attempt = (data.attempt ?? 0) + 1;
  await job.updateData({ ...data, attempt });
  await job.moveToDelayed(Date.now() + delayFn(attempt), token);
  throw new DelayedError();
}

let delayFn: (attempt: number) => number = nextDelayMs;

export interface QueueOptions {
  redisUrl?: string;
  /** Override the poll schedule (tests). */
  delayMs?: (attempt: number) => number;
  concurrency?: number;
  sweepEveryMs?: number;
  /** Base back-off between retries after an error (tests). */
  retryDelayMs?: number;
  /** Isolate keys (tests). */
  prefix?: string;
}

/** Start the queue + worker. Returns false (and does nothing) when Redis is not configured. */
export async function startCryptoQueue(options: QueueOptions = {}): Promise<boolean> {
  const url = options.redisUrl ?? config.redis?.url;
  if (!url) return false;
  if (queue) return true;

  const connection = connectionFromUrl(url);
  const prefix = options.prefix ?? PREFIX;
  delayFn = options.delayMs ?? nextDelayMs;

  queue = new Queue(QUEUE_NAME, {
    connection,
    prefix,
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: "exponential", delay: options.retryDelayMs ?? 5_000 },
      removeOnComplete: true, // a finished invoice can be re-tracked later
      // A failed job keeps its id, which would block re-tracking that invoice.
      // Drop it instead; the sweep re-adds a fresh check within a minute.
      removeOnFail: true,
    },
  });
  queue.on("error", (e) => logger.error("Queue error", { error: e.message }));

  worker = new Worker(QUEUE_NAME, processJob, {
    connection,
    prefix,
    concurrency: options.concurrency ?? 5,
    limiter: { max: 20, duration: 1_000 }, // stay polite to the 1Click API
  });
  worker.on("error", (e) => logger.error("Worker error", { error: e.message }));
  worker.on("failed", (job, e) => logger.warn("Check job failed", { job: job?.id, error: e.message }));

  // Re-adds a check for any open invoice that lost its job. One scheduler for
  // the whole fleet, however many instances run.
  await queue.upsertJobScheduler("sweep", { every: options.sweepEveryMs ?? 60_000 }, { name: "sweep", data: {} });

  setVerificationScheduler((reference) => enqueueCheck(reference));
  setWithdrawalScheduler((reference) => enqueueCheck(reference, 0, "withdrawal"));
  logger.info("Durable crypto payment queue started");
  return true;
}

export async function stopCryptoQueue(): Promise<void> {
  setVerificationScheduler(null);
  setWithdrawalScheduler(null);
  await worker?.close().catch(() => {});
  await queue?.close().catch(() => {});
  worker = null;
  queue = null;
  delayFn = nextDelayMs;
}

/** Ops/test helper: the invoices currently being tracked (the sweep scheduler's own job is excluded). */
export async function trackedReferences(): Promise<string[]> {
  if (!queue) return [];
  const jobs = await queue.getJobs(["waiting", "delayed", "active"]);
  return jobs.filter((j) => j.name === "check").map((j) => (j.data as CheckJobData).reference);
}
