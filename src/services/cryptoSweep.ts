import { prisma } from "@/db/prisma";
import { redis } from "@/services/redis";
import { getCryptoPaymentState } from "@/services/cryptoInvoice";
import { createLogger } from "@/utils/logger";

const logger = createLogger("crypto-sweep");

// ============================================
// Background payment check.
//
// NEAR Intents has no webhooks, so "did the money arrive?" is answered by
// polling. Three things do that:
//   1. the customer's open pay page (every few seconds),
//   2. a per-payment timer chain (lost if the server restarts),
//   3. THIS sweep - durable, covers customers who paid and closed the page.
//
// Open invoices are checked every cycle. Recently expired ones are checked on
// a slower cadence, because money can still arrive for a deposit address that
// was minted before the invoice expired.
// ============================================

const OPEN = ["sent", "pending_payment"];
const LATE_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_PER_SWEEP = 200;

let running = false;

const LEADER_KEY = "3rike:crypto-sweeper:leader";

/**
 * With several server instances, only one should sweep per cycle or every
 * invoice is polled N times. A short Redis lock elects one. Without Redis (or
 * if Redis errors) every instance sweeps - wasteful but safe, because
 * settlement is idempotent.
 */
export async function acquireLeader(ttlSeconds: number): Promise<boolean> {
  if (!redis) return true;
  try {
    return (await redis.set(LEADER_KEY, String(process.pid), "EX", ttlSeconds, "NX")) === "OK";
  } catch {
    return true;
  }
}

/**
 * References of invoices that have a crypto payment in flight: open ones, plus
 * (optionally) recently expired ones that could still receive a late payment.
 */
export async function listTrackableReferences(includeExpired = false): Promise<string[]> {
  const invoices = await prisma.invoice.findMany({
    where: includeExpired
      ? {
          OR: [
            { status: { in: OPEN } },
            { status: "expired", updatedAt: { gt: new Date(Date.now() - LATE_WINDOW_MS) } },
          ],
        }
      : { status: { in: OPEN } },
    select: { reference: true },
    take: MAX_PER_SWEEP,
  });
  // Only invoices that actually have a crypto payment in flight.
  const liveInvoices = invoices.length
    ? await prisma.transaction.findMany({
        where: { reference: { in: invoices.map((i) => i.reference) }, status: "processing" },
        select: { reference: true },
      })
    : [];
  return [...new Set(liveInvoices.map((t) => t.reference))].slice(0, MAX_PER_SWEEP);
}

/** One in-process pass. Returns how many invoices were checked. */
export async function sweepCryptoPayments(includeExpired = false): Promise<number> {
  if (running) return 0;
  running = true;
  try {
    const references = await listTrackableReferences(includeExpired);

    let checked = 0;
    for (const reference of references) {
      try {
        await getCryptoPaymentState(reference);
        checked++;
      } catch (error: any) {
        // One bad invoice must never stop the rest.
        logger.warn("Sweep check failed", { reference, error: error?.message });
      }
    }
    return checked;
  } finally {
    running = false;
  }
}

/** Start the recurring sweep. Every 10th pass also re-checks recently expired invoices. */
export function startCryptoSweeper(intervalMs = 30_000): () => void {
  let pass = 0;
  const run = async () => {
    pass += 1;
    // Lock slightly shorter than the interval so leadership can move if an instance dies.
    if (!(await acquireLeader(Math.max(1, Math.floor(intervalMs / 1000) - 5)))) return;
    await sweepCryptoPayments(pass % 10 === 0);
    // Free the tagged amounts of direct USDC payments that can no longer arrive.
    if (pass % 10 === 0) {
      const { releaseStaleDirectPayments } = await import("@/services/directUsdc");
      await releaseStaleDirectPayments().catch((e: any) => logger.warn("Releasing stale direct payments failed", { error: e?.message }));
    }
  };
  // A first full pass shortly after boot catches anything missed while down.
  const boot = setTimeout(() => sweepCryptoPayments(true).catch(() => {}), 5_000);
  const timer = setInterval(() => {
    run().catch((e: any) => logger.warn("Sweep failed", { error: e?.message }));
  }, intervalMs);
  boot.unref?.();
  timer.unref?.();
  logger.info("Crypto payment sweeper started", { everyMs: intervalMs });
  return () => {
    clearTimeout(boot);
    clearInterval(timer);
  };
}
