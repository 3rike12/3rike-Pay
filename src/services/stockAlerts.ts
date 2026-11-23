import { navFreshness, type StockToken } from "@/services/stocks";
import { createLogger } from "@/utils/logger";

const logger = createLogger("stock-alerts");

// ============================================
// Stock alerts
//
// Tells people about things that matter to a stock they hold, and how to act on
// them in plain words. Deliberately rule-based, not an AI deciding what to say:
// a message here is a fact we can point to, never a guess, and it never trades
// anything on its own.
//
//  - CORPORATE ACTION: the share-to-token ratio (multiplier) changed. This is how
//    dividends and splits arrive. Nobody has to do anything, but their share count
//    just changed and they should know.
//  - PRICE MOVE: the reference price moved by at least a set percentage. Only the
//    PERCENTAGE is reported: Coinbase's nav_price units (per token or per share)
//    are unconfirmed, and a percentage is the same either way. Only a fresh price
//    counts, and a move is measured from a reference that resets after an alert
//    and rolls forward each day, so it means "a big move recently", not "ever".
//
// Safe to run often and from several instances:
//  - each person is told about each event once (a unique key, taken BEFORE the
//    message is sent; a failed send gives the key back so the next pass retries);
//  - anyone who opted out is never messaged;
//  - the first sight of a token only records a baseline, it never alerts.
// ============================================

/**
 * A person we can never reach (no phone number on record). Unlike a failed send, this
 * is not worth retrying, and must not hold the rest of the alert back.
 */
export class Undeliverable extends Error {
  constructor(message = "This person cannot be reached") {
    super(message);
    this.name = "Undeliverable";
  }
}

/** How long failed sends are retried before the alert is dropped, so one bad number cannot freeze a token. */
export const GIVE_UP_AFTER_MS = 6 * 60 * 60 * 1000;

export const PRICE_MOVE_PCT = 5;
/** At most one price alert per token in this long, however much it moves. */
export const PRICE_COOLDOWN_MS = 12 * 60 * 60 * 1000;
/** The reference a move is measured from rolls forward after this long. */
export const REFERENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface Snapshot {
  tokenAddress: string;
  multiplier: number;
  navPrice: number | null;
  navUpdatedAt: string | null;
  refPrice: number | null;
  refAt: Date | null;
  lastMoveAlertAt: Date | null;
  /** Set while an alert could not be delivered to everyone; cleared when it has been. */
  pendingSince: Date | null;
}

export interface Detected {
  multiplierChange?: { from: number; to: number };
  priceMove?: { pct: number };
  /** What to store as the snapshot now. */
  next: Snapshot;
}

const sameMultiplier = (a: number, b: number) => Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b)) * 1e-9;

/** Compare what a token looks like now with the last snapshot. Pure. */
export function detectChanges(prev: Snapshot | null, token: StockToken, now: Date, thresholdPct = PRICE_MOVE_PCT): Detected {
  const fresh = token.navPrice !== null && navFreshness(token, now.getTime()).fresh;
  const nav = fresh ? token.navPrice : null;

  const next: Snapshot = {
    tokenAddress: token.address,
    multiplier: token.multiplier,
    navPrice: token.navPrice,
    navUpdatedAt: token.navUpdatedAt,
    refPrice: prev?.refPrice ?? nav,
    refAt: prev?.refAt ?? (nav !== null ? now : null),
    lastMoveAlertAt: prev?.lastMoveAlertAt ?? null,
    pendingSince: prev?.pendingSince ?? null,
  };

  // The first time we see a token is a baseline, never an alert.
  if (!prev) return { next };

  const out: Detected = { next };
  if (!sameMultiplier(prev.multiplier, token.multiplier)) out.multiplierChange = { from: prev.multiplier, to: token.multiplier };

  if (nav !== null) {
    // Only a price we have not already weighed (a newer data point) can be a move.
    const isNewPoint = token.navUpdatedAt !== prev.navUpdatedAt;
    const ref = prev.refPrice;
    if (ref === null || ref <= 0) {
      next.refPrice = nav;
      next.refAt = now;
    } else {
      const pct = ((nav - ref) / ref) * 100;
      const cooledDown = !prev.lastMoveAlertAt || now.getTime() - prev.lastMoveAlertAt.getTime() >= PRICE_COOLDOWN_MS;
      if (isNewPoint && Math.abs(pct) >= thresholdPct && cooledDown) {
        out.priceMove = { pct };
        next.refPrice = nav; // measure the next move from here
        next.refAt = now;
        next.lastMoveAlertAt = now;
      } else if (!prev.refAt || now.getTime() - prev.refAt.getTime() >= REFERENCE_MAX_AGE_MS) {
        next.refPrice = nav; // roll the reference forward so a slow drift does not read as a sudden move
        next.refAt = now;
      }
    }
  }
  return out;
}

// --------------------------------------------
// What we say
// --------------------------------------------

const sharesText = (units: bigint, t: Pick<StockToken, "decimals">, multiplier: number) => {
  const n = (Number(units) / 10 ** t.decimals) * multiplier;
  return n >= 100 ? n.toFixed(2) : n.toFixed(4).replace(/\.?0+$/, "") || "0";
};
const label = (t: StockToken) => `${t.name} (${t.ticker})`;

export function corporateActionMessage(token: StockToken, change: { from: number; to: number }, units: bigint): string {
  const before = sharesText(units, token, change.from);
  const after = sharesText(units, token, change.to);
  return (
    `*${label(token)}: your share count changed*\n\n` +
    `Coinbase updated the share-to-token ratio from ${change.from.toFixed(4)} to ${change.to.toFixed(4)}. ` +
    `This is how dividends and stock splits show up in the token.\n\n` +
    `You hold the same tokens as before. They now represent about ${after} shares (before: ${before}).\n\n` +
    `You don't need to do anything. To sell some, say *sell half my ${token.ticker}*. To stop these alerts, say *stop stock alerts*.`
  );
}

export function priceMoveMessage(token: StockToken, pct: number, units: bigint): string {
  const up = pct > 0;
  const shares = sharesText(units, token, token.multiplier);
  return (
    `*${label(token)} ${up ? "is up" : "is down"} ${Math.abs(pct).toFixed(1)}%*\n\n` +
    `The reference price has moved ${up ? "up" : "down"} by about ${Math.abs(pct).toFixed(1)}% recently. You hold about ${shares} shares.\n\n` +
    `Prices move, and this isn't advice. If you want to act, you can say *sell half my ${token.ticker}* or *buy 2000 of ${token.ticker}*. To stop these alerts, say *stop stock alerts*.`
  );
}

// --------------------------------------------
// Running it
// --------------------------------------------

export interface AlertStore {
  getSnapshot(tokenAddress: string): Promise<Snapshot | null>;
  saveSnapshot(s: Snapshot): Promise<void>;
  /** Take the right to alert this person about this event. False if already taken. */
  claim(key: string, userId: string, kind: string): Promise<boolean>;
  /** Give the right back (the message could not be sent). */
  release(key: string): Promise<void>;
  isOptedOut(userId: string): Promise<boolean>;
}

export interface AlertDeps {
  now?: Date;
  stocks(): Promise<StockToken[]>;
  positions: {
    totals(): Promise<Array<{ tokenAddress: string; units: bigint }>>;
    holders(tokenAddress: string): Promise<Array<{ userId: string; units: bigint }>>;
  };
  store: AlertStore;
  notify(userId: string, text: string): Promise<void>;
}

export interface AlertResult {
  checked: number;
  sent: number;
}

/** Look at every held token and tell its holders about anything that changed. */
export async function runStockAlerts(deps: AlertDeps): Promise<AlertResult> {
  const now = deps.now ?? new Date();
  const result: AlertResult = { checked: 0, sent: 0 };
  const held = (await deps.positions.totals()).filter((t) => t.units > 0n);
  if (held.length === 0) return result;

  const stocks = await deps.stocks();
  for (const { tokenAddress } of held) {
    const token = stocks.find((s) => s.address === tokenAddress);
    if (!token) continue; // no longer listed: nothing to compare
    result.checked++;

    const prev = await deps.store.getSnapshot(token.address);
    const found = detectChanges(prev, token, now);
    if (!found.multiplierChange && !found.priceMove) {
      await deps.store.saveSnapshot({ ...found.next, pendingSince: null });
      continue;
    }

    // The snapshot only moves on once EVERY holder has been dealt with. If a send fails it stays
    // where it was, so the next pass sees the same change again and tries again. Nobody is told
    // twice because each person's alert has a key tied to the event itself, not to the clock.
    let blocked = false;
    for (const holder of await deps.positions.holders(token.address)) {
      if (await deps.store.isOptedOut(holder.userId)) continue;
      const jobs: Array<{ kind: string; event: string; text: string }> = [];
      if (found.multiplierChange) {
        jobs.push({ kind: "corporate_action", event: String(found.multiplierChange.to), text: corporateActionMessage(token, found.multiplierChange, holder.units) });
      }
      if (found.priceMove) {
        jobs.push({ kind: "price_move", event: token.navUpdatedAt ?? "unknown", text: priceMoveMessage(token, found.priceMove.pct, holder.units) });
      }
      for (const job of jobs) {
        const key = `${job.kind}:${token.address}:${job.event}:${holder.userId}`;
        if (!(await deps.store.claim(key, holder.userId, job.kind))) continue; // already told
        try {
          await deps.notify(holder.userId, job.text);
          result.sent++;
        } catch (error: any) {
          if (error instanceof Undeliverable) {
            logger.warn("Cannot reach a holder; not retrying", { userId: holder.userId });
            continue; // keep the claim: there is nothing to retry
          }
          logger.warn("Could not send a stock alert; will try again", { userId: holder.userId, kind: job.kind, error: error?.message });
          await deps.store.release(key);
          blocked = true;
        }
      }
    }

    if (!blocked) {
      await deps.store.saveSnapshot({ ...found.next, pendingSince: null });
      continue;
    }
    const since = prev?.pendingSince ?? now;
    if (now.getTime() - since.getTime() < GIVE_UP_AFTER_MS) {
      await deps.store.saveSnapshot({ ...(prev as Snapshot), pendingSince: since });
    } else {
      logger.error("Giving up on an alert that could not be delivered to everyone", { token: token.address });
      await deps.store.saveSnapshot({ ...found.next, pendingSince: null });
    }
  }
  return result;
}
