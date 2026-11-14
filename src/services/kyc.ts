import { prisma } from "@/db/prisma";
import { KYC_STATUS } from "@/config/constants";
import { acquireLock } from "@/utils/idempotency";
import { createLogger } from "@/utils/logger";
import { createVerificationSession, outcomeFromEvent, type KycOutcome, type VerificationSession } from "@/services/toden";

const logger = createLogger("kyc");

// ============================================
// Idempotent identity-check handling
//
// Three layers, so a retry, a duplicate delivery, a double-tap or an
// out-of-order event can never message someone twice or undo a verification:
//
//   1. The event is recorded in `WebhookEvent` (source "toden", reference = the
//      event id) and marked `processed` only after it has been applied, so a
//      failure is retried and a repeat is acknowledged and skipped. A short
//      Redis lock stops two simultaneous deliveries running side by side.
//   2. Every state change is a conditional update (a compare-and-set in the
//      database), so replaying a change finds nothing to do and sends nothing.
//   3. `verified` is terminal: a late or repeated decline never downgrades it.
// ============================================

export const VERIFIED_MESSAGE =
  "*You're verified*\n\nThanks. You can now cash out your balance. Type /cashout to start.";

export interface KycApplyResult {
  /** WhatsApp number to message, and what to say. Null when nothing changed. */
  phone: string | null;
  notify: string | null;
}

/** Apply one identity result to a user. Safe to call any number of times. */
export async function applyKycOutcome(outcome: KycOutcome): Promise<KycApplyResult> {
  const user = await prisma.user.findUnique({
    where: { id: outcome.userId },
    select: { id: true, phone: true, kycStatus: true },
  });
  if (!user) {
    logger.warn("Identity result for an unknown user", { eventId: outcome.eventId });
    return { phone: null, notify: null };
  }

  if (outcome.outcome === "approved") {
    const changed = await prisma.user.updateMany({
      where: { id: user.id, NOT: { kycStatus: KYC_STATUS.VERIFIED } },
      data: { kycStatus: KYC_STATUS.VERIFIED },
    });
    return { phone: user.phone, notify: changed.count === 1 ? VERIFIED_MESSAGE : null };
  }

  if (outcome.outcome === "declined") {
    // Never downgrade a verified person; never repeat a decline that is already recorded.
    const changed = await prisma.user.updateMany({
      where: { id: user.id, kycStatus: { notIn: [KYC_STATUS.VERIFIED, KYC_STATUS.REJECTED] } },
      data: { kycStatus: KYC_STATUS.REJECTED },
    });
    return {
      phone: user.phone,
      notify:
        changed.count === 1
          ? `*We couldn't verify you*\n\n${outcome.reason ? `${outcome.reason}\n\n` : ""}Type /verify to try again.`
          : null,
    };
  }

  // Resubmission: only meaningful while they are not already verified.
  if (user.kycStatus === KYC_STATUS.VERIFIED) return { phone: user.phone, notify: null };
  return {
    phone: user.phone,
    notify:
      `*One more step*\n\n${outcome.reason ? `${outcome.reason}\n\n` : ""}` +
      (outcome.resubmissionUrl ? `Please retake it here:\n${outcome.resubmissionUrl}` : "Type /verify to continue."),
  };
}

export type TodenEventResult =
  | { status: "processed"; phone: string | null; notify: string | null }
  | { status: "duplicate" }
  | { status: "busy" };

/**
 * Handle one verified Toden webhook event exactly once in effect.
 * Throws when applying it failed, so the caller answers 5xx and Toden retries.
 */
export async function processTodenEvent(event: any): Promise<TodenEventResult> {
  const lock = await acquireLock(`toden:event:${event.id}`, 60);
  if (!lock) return { status: "busy" };

  try {
    const existing = await prisma.webhookEvent.findFirst({ where: { source: "toden", reference: event.id } });
    if (existing?.processed) return { status: "duplicate" };
    if (!existing) {
      await prisma.webhookEvent.create({
        data: {
          source: "toden",
          eventType: String(event.type ?? event.event ?? "unknown"),
          reference: event.id,
          payload: { id: event.id }, // no personal data is kept
          processed: false,
        },
      });
    }

    const outcome = outcomeFromEvent(event);
    const result: KycApplyResult = outcome ? await applyKycOutcome(outcome) : { phone: null, notify: null };

    await prisma.webhookEvent.updateMany({
      where: { source: "toden", reference: event.id },
      data: { processed: true },
    });
    return { status: "processed", ...result };
  } finally {
    await lock.release();
  }
}

/** Move someone to "pending" when they start a check, without ever undoing a verification. */
export async function markKycPending(userId: string): Promise<void> {
  await prisma.user.updateMany({
    where: { id: userId, NOT: { kycStatus: KYC_STATUS.VERIFIED } },
    data: { kycStatus: KYC_STATUS.PENDING },
  });
}

const SESSION_REUSE_MS = 30 * 60 * 1000;
const SESSION_MIN_REMAINING_MS = 60 * 1000;

/**
 * A verification link for this user. Tapping /verify twice (or two instances
 * racing) reuses the live link instead of opening a second session.
 */
export async function getOrCreateVerificationSession(userId: string): Promise<VerificationSession> {
  const reusable = async (): Promise<VerificationSession | null> => {
    const last = await prisma.webhookEvent.findFirst({
      where: { source: "toden-session", reference: userId },
      orderBy: { createdAt: "desc" },
    });
    const p = last?.payload as Partial<VerificationSession> | undefined;
    if (!last || !p?.url || !p.sessionId) return null;
    const expiresAt = p.expiresAt ? Date.parse(p.expiresAt) : last.createdAt.getTime() + SESSION_REUSE_MS;
    return expiresAt - Date.now() > SESSION_MIN_REMAINING_MS
      ? { sessionId: p.sessionId, url: p.url, expiresAt: p.expiresAt ?? null }
      : null;
  };

  const lock = await acquireLock(`toden:session:${userId}`, 20);
  if (!lock) {
    const live = await reusable();
    if (live) return live;
    throw new Error("I'm already setting that up. Please try again in a few seconds.");
  }

  try {
    const live = await reusable();
    if (live) return live;

    const session = await createVerificationSession({ externalUserId: userId });
    await prisma.webhookEvent.create({
      data: {
        source: "toden-session",
        eventType: "session_created",
        reference: userId,
        payload: { sessionId: session.sessionId, url: session.url, expiresAt: session.expiresAt },
        processed: true,
      },
    });
    return session;
  } finally {
    await lock.release();
  }
}
