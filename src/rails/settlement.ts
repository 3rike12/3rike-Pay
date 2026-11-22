import { Prisma } from "@prisma/client";
import { prisma } from "@/db/prisma";
import { createLogger } from "@/utils/logger";
import { isFinal, transition, type Transition } from "@/rails/state";
import type { IntentState, RailDirection, RailEventInput } from "@/rails/types";

const logger = createLogger("rail-events");

// ============================================
// Rail events
//
// One place that records what a rail reported and moves the payment's state.
// Webhooks and pollers both call applyRailEvent, so the rules for duplicates
// and contradictions live in the state machine and nowhere else.
//
// A flow that must move money on a report (credit a balance back after a
// failed payout) hands the engine a `post` function. The engine runs it only
// for a report that is genuinely new, so a repeated or contradictory report can
// never post twice.
//
// ORDER MATTERS: post first, then advance. If the process dies in between, the
// state has not moved, so the next report tries again, and the posting is safe
// to repeat because every ledger call carries an idempotency key. The other
// order would mark a payout failed and then lose the refund.
// ============================================

export interface AppliedEvent {
  intentId: string;
  /** The payment's state after this report. */
  state: IntentState;
  move: Transition;
}

export interface RailEventParams {
  /** Our payment reference: unique per payment. */
  reference: string;
  kind: "invoice" | "topup" | "withdrawal" | "cashout";
  direction: RailDirection;
  rail: string;
  userId?: string;
  /** The provider's id for this payment (deposit address, off-ramp reference). */
  railRef?: string;
  /** Where the payment already is, when it predates event tracking. Defaults to "created". */
  initialState?: IntentState;
  payload?: Record<string, unknown>;
  event: RailEventInput;
  /**
   * Money to move because of this report. Runs only when the report advances
   * the payment, before the state changes. MUST be idempotent (use ledger
   * idempotency keys). If it throws, nothing is recorded and the error is
   * raised, so a webhook can be retried by the provider.
   */
  post?: (move: Extract<Transition, { kind: "advance" }>) => Promise<void>;
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "P2002";
}

export async function applyRailEvent(p: RailEventParams): Promise<AppliedEvent> {
  let intent = await prisma.paymentIntent.findUnique({ where: { reference: p.reference } });
  if (!intent) {
    try {
      intent = await prisma.paymentIntent.create({
        data: {
          reference: p.reference,
          direction: p.direction,
          kind: p.kind,
          userId: p.userId ?? null,
          rail: p.rail,
          railRef: p.railRef ?? null,
          state: p.initialState ?? "created",
          payload: (p.payload ?? {}) as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      // Another worker created it between our read and our write.
      if (!isUniqueViolation(error)) throw error;
      intent = await prisma.paymentIntent.findUnique({ where: { reference: p.reference } });
      if (!intent) throw error;
    }
  }

  const from = intent.state as IntentState;
  const move = transition(from, p.event.type);

  // Nothing new to record.
  if (move.kind === "duplicate") return { intentId: intent.id, state: from, move };

  let state = from;
  if (move.kind === "advance") {
    await p.post?.(move);
    // Guarded on the state we read, so two workers cannot both move the payment.
    const { count } = await prisma.paymentIntent.updateMany({
      where: { id: intent.id, state: from },
      data: {
        state: p.event.type,
        ...(p.railRef && !intent.railRef ? { railRef: p.railRef } : {}),
        // A finished payment no longer holds its tagged amount, so the amount can be reused.
        ...(isFinal(p.event.type) ? { openKey: null } : {}),
      },
    });
    if (count === 0) {
      const current = await prisma.paymentIntent.findUnique({ where: { id: intent.id } });
      const now = (current?.state as IntentState | undefined) ?? from;
      return { intentId: intent.id, state: now, move: { kind: "duplicate", state: now } };
    }
    state = p.event.type;
  } else {
    logger.error("Conflicting rail event refused; needs manual review", {
      reference: p.reference,
      rail: p.rail,
      from,
      reported: p.event.type,
      providerStatus: p.event.providerStatus,
    });
  }

  try {
    await prisma.railEvent.create({
      data: {
        intentId: intent.id,
        rail: p.rail,
        type: p.event.type,
        providerStatus: p.event.providerStatus,
        dedupeKey: p.event.dedupeKey ?? "",
        applied: move.kind === "advance",
        detail: (p.event.detail ?? {}) as Prisma.InputJsonValue,
      },
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error; // the same report, seen twice
  }

  return { intentId: intent.id, state, move };
}

/**
 * Like applyRailEvent, but never throws. Used beside flows that already move
 * money safely on their own: a bookkeeping failure here must not undo or
 * block a payment. Returns null when it could not record.
 */
export async function recordRailEvent(p: Omit<RailEventParams, "post">): Promise<AppliedEvent | null> {
  try {
    return await applyRailEvent(p);
  } catch (error: any) {
    logger.warn("Could not record rail event", { reference: p.reference, error: error?.message });
    return null;
  }
}
