import { Prisma } from "@prisma/client";
import { config } from "@/config";
import { prisma } from "@/db/prisma";
import { autoramp } from "@/services/autoramp";
import { ledger, SYSTEM_ACCOUNTS } from "@/services/ledger";
import { getTreasurySigner } from "@/services/withdrawal";
import { mapOfframpEvent } from "@/rails/autoRamp";
import { fromTransactionStatus, isFinal } from "@/rails/state";
import { applyRailEvent } from "@/rails/settlement";
import { checkLimits } from "@/rails/limits";
import { initiateOn, pickRail } from "@/rails/router";
import { getFx, type FxRecord } from "@/services/fx";
import { registerBuiltInFxProviders } from "@/services/fxProviders";
import { formatUsdThreshold, onChainBalanceUsd, liabilities, toUsd } from "@/services/treasury";
import { createLogger } from "@/utils/logger";

const logger = createLogger("cashout");

// ============================================
// Cash out to a Naira bank account (AutoRamp off-ramp)
//
// The merchant's ledger balance (their one currency) is paid out as NGN to a
// Nigerian bank account. Order matters, exactly as for crypto withdrawals:
//
//   1. DEBIT the ledger first (idempotent) - the money can never be spent twice.
//   2. Ask AutoRamp for an off-ramp. It returns the deposit address to fund
//      with USDC; once it receives the USDC it pays the NGN to the bank.
//   3. The treasury sends that USDC (Base). With no signer registered the
//      request is parked as `awaiting_signature` for an operator to fund by
//      hand (`npm run cashout:pending`).
//   4. AutoRamp's offramp.* webhooks settle it: completed -> done, failed ->
//      the merchant is credited back.
//
// Any failure before the USDC leaves the treasury reverses the debit.
// ============================================

export const MIN_PAYOUT_NGN = 1000; // AutoRamp's minimum

export interface CashoutQuote {
  /** Balance currency being spent. */
  currency: string;
  /** Amount in that currency. */
  amount: number;
  usd: number;
  /** What the bank receives. */
  ngn: number;
  /** USDC the treasury must send to AutoRamp. */
  usdc: number;
  /** USD -> NGN rate used. */
  rate: number;
  /** Where that rate came from, and when. */
  fx: FxRecord;
}

/**
 * USD -> NGN. AutoRamp's live rate (cached briefly, and never older than
 * FX_MAX_AGE_SECONDS) when it is available and plausible, otherwise our static
 * table. The record says which, and when.
 */
async function usdNgnRate(): Promise<FxRecord> {
  registerBuiltInFxProviders();
  try {
    return await getFx("NGN");
  } catch {
    throw new Error("No NGN rate available right now.");
  }
}

/** What a cash-out of `amount` (in the merchant's currency) would pay out. Throws on bad limits. */
export async function quoteCashout(currency: string, amount: number): Promise<CashoutQuote> {
  if (config.nearIntents.network === "tidepool") {
    throw new Error("Bank cash-outs are disabled in Tidepool demo mode.");
  }
  const cur = currency.toUpperCase();
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Enter a valid amount.");

  const usd = toUsd(amount, cur);
  // The bank rail owns its minimum and maximum (RAIL_AUTORAMP_MIN_USD / _MAX_USD).
  const limits = checkLimits("out", { kind: "bank_payout", currency: "NGN", usd });
  if (!limits.ok) {
    if (limits.reason === "below_min") throw new Error(`The minimum cash-out is ${formatUsdThreshold(limits.minUsd, cur)}.`);
    if (limits.reason === "above_max") throw new Error(`The maximum cash-out is ${formatUsdThreshold(limits.maxUsd, cur)}.`);
    throw new Error("Bank cash-outs aren't available right now.");
  }

  const fx = await usdNgnRate();
  const rate = fx.perUsd;
  const ngn = Math.floor(usd * rate);
  if (ngn < MIN_PAYOUT_NGN) throw new Error(`The minimum payout is ₦${MIN_PAYOUT_NGN.toLocaleString("en-US")}.`);

  // Round the USDC up to the cent so the off-ramp is never short-funded.
  const usdc = Math.ceil((ngn / rate) * 100) / 100;
  return { currency: cur, amount, usd, ngn, usdc, rate, fx };
}

export interface CashoutResult {
  reference: string;
  status: "processing" | "awaiting_signature";
  quote: CashoutQuote;
  depositAddress: string;
  txHash?: string;
}

export async function requestCashout(params: {
  userId: string;
  currency: string;
  amount: number;
  bankCode: string;
  accountNumber: string;
  accountName?: string;
  bankName?: string;
}): Promise<CashoutResult> {
  if (config.nearIntents.network === "tidepool") {
    throw new Error("Bank cash-outs are disabled in Tidepool demo mode.");
  }
  if (!/^\d{10}$/.test(params.accountNumber)) {
    throw new Error("A Nigerian account number is exactly 10 digits.");
  }
  const quote = await quoteCashout(params.currency, params.amount);

  // Fail closed: never promise a payout the treasury can't fund.
  const [assets, owed] = await Promise.all([onChainBalanceUsd(), liabilities()]);
  if (assets < quote.usd || assets < owed.totalUsd) {
    logger.error("Treasury cannot cover cash-out", { assets, liabilities: owed.totalUsd, usd: quote.usd });
    throw new Error("Cash-outs are temporarily unavailable. Please try again shortly.");
  }

  // The bank rail is asked first (nothing is spent yet), so a rejected request
  // never touches the merchant's balance.
  let instruction;
  try {
    instruction = await initiateOn(pickRail("out", { kind: "bank_payout", currency: "NGN", usd: quote.usd }), {
      kind: "bank_payout",
      network: "base",
      ngn: quote.ngn,
      bankCode: params.bankCode,
      accountNumber: params.accountNumber,
    });
  } catch (error: any) {
    logger.error("Off-ramp could not be initialised", { error: error?.response?.data || error?.message });
    throw new Error("I couldn't set up that payout. Check the bank details and try again.");
  }
  const reference = instruction.railRef;
  const depositAddress = instruction.depositAddress;

  await ledger.debit({
    userId: params.userId,
    amount: quote.amount,
    currency: quote.currency,
    reference,
    description: `Cash out to bank (₦${quote.ngn})`,
    metadata: { type: "cashout", ngn: quote.ngn },
    counter: SYSTEM_ACCOUNTS.worldOut,
    idempotencyKey: `cashout-debit:${reference}`,
  });

  const reverse = async (why: string) => {
    await ledger.credit({
      userId: params.userId,
      amount: quote.amount,
      currency: quote.currency,
      reference,
      description: `Cash-out reversed: ${why}`,
      metadata: { type: "cashout_reversal" },
      counter: SYSTEM_ACCOUNTS.worldOut,
      idempotencyKey: `cashout-reversal:${reference}`,
    });
    await prisma.transaction.updateMany({ where: { reference }, data: { status: "failed" } });
  };

  try {
    await prisma.transaction.create({
      data: {
        userId: params.userId,
        reference,
        autorampRef: reference,
        type: "cashout",
        amount: quote.amount,
        currency: quote.currency,
        status: "processing",
        description: `Cash out ₦${quote.ngn} to bank`,
        bankCode: params.bankCode,
        bankAccount: params.accountNumber,
        bankName: params.bankName ?? null,
        accountName: params.accountName ?? null,
        metadata: {
          provider: "autoramp",
          usd: quote.usd,
          ngn: quote.ngn,
          usdc: quote.usdc,
          rate: quote.rate,
          fx: quote.fx,
          depositAddress,
        } as Prisma.InputJsonValue,
      },
    });

    const signer = getTreasurySigner();
    if (!signer) {
      await prisma.transaction.updateMany({ where: { reference }, data: { status: "awaiting_signature" } });
      logger.warn("No treasury signer: cash-out parked for manual funding", { reference, depositAddress, usdc: quote.usdc });
      return { reference, status: "awaiting_signature", quote, depositAddress };
    }

    const { txHash } = await signer.send({
      to: depositAddress,
      amountUnits: BigInt(Math.round(quote.usdc * 10 ** config.treasury.tokenDecimals)).toString(),
      asset: config.treasury.tokenContract,
      reference,
    });
    await prisma.transaction.updateMany({
      where: { reference },
      data: { metadata: { provider: "autoramp", usd: quote.usd, ngn: quote.ngn, usdc: quote.usdc, rate: quote.rate, fx: quote.fx, depositAddress, fundingTx: txHash } },
    });
    return { reference, status: "processing", quote, depositAddress, txHash };
  } catch (error: any) {
    logger.error("Cash-out failed before funds left the treasury; reversing", { reference, error: error?.message });
    await reverse(error?.message || "error");
    throw new Error("The cash-out failed and your balance was restored.");
  }
}

/**
 * Cash-outs whose USDC was sent but that AutoRamp never closed. AutoRamp
 * reports by webhook only, so a missed webhook leaves the user's balance
 * debited and the payout open forever. Oldest first, for an operator to check
 * against AutoRamp and settle by hand.
 */
export async function listStuckCashouts(olderThanMs = 60 * 60 * 1000, now = Date.now()) {
  return prisma.transaction.findMany({
    where: { type: "cashout", status: "processing", createdAt: { lt: new Date(now - olderThanMs) } },
    orderBy: { createdAt: "asc" },
    take: 200,
  });
}

/**
 * Apply an AutoRamp offramp.* webhook to a cash-out. Returns what happened so
 * the caller can message the merchant; null when the event isn't ours.
 */
export async function applyOfframpEvent(
  event: string,
  reference: string
): Promise<{ outcome: "completed" | "failed"; userId: string; amount: number; currency: string; ngn: number } | null> {
  const tx = await prisma.transaction.findFirst({ where: { reference, type: "cashout" } });
  if (!tx) return null;
  const ngn = Number((tx.metadata as any)?.ngn ?? 0);

  const to = mapOfframpEvent(event);
  if (!to) return null;

  // Webhooks repeat and can arrive out of order. The rail event engine decides whether this report is new. A repeat is a
  // no-op. A contradiction (completed after we refunded, failed after the bank
  // paid) is refused and logged for a person: acting on it would pay the user
  // twice or take back money already delivered. A failed payout's refund is
  // posted by the engine, once, before the state moves.
  const before = fromTransactionStatus(tx.status);
  const applied = await applyRailEvent({
    reference,
    kind: "cashout",
    direction: "out",
    rail: "autoramp",
    userId: tx.userId,
    railRef: reference,
    initialState: before,
    event: { type: to, providerStatus: event },
    post:
      to === "failed"
        ? async () => {
            await ledger.credit({
              userId: tx.userId,
              amount: tx.amount,
              currency: tx.currency,
              reference,
              description: "Cash-out failed: balance restored",
              metadata: { type: "cashout_reversal", event },
              counter: SYSTEM_ACCOUNTS.worldOut,
              idempotencyKey: `cashout-reversal:${reference}`,
            });
          }
        : undefined,
  });
  if (applied.move.kind === "conflict") return null;
  if (applied.move.kind === "duplicate") {
    // Already handled. If a crash left the Transaction behind the engine, catch it up quietly.
    if (applied.state === to && !isFinal(before)) {
      await prisma.transaction.update({ where: { id: tx.id }, data: { status: to === "settled" ? "completed" : "failed" } });
    }
    return null;
  }

  if (to === "settled") {
    await prisma.transaction.update({ where: { id: tx.id }, data: { status: "completed" } });
    return { outcome: "completed", userId: tx.userId, amount: tx.amount, currency: tx.currency, ngn };
  }

  await prisma.transaction.update({ where: { id: tx.id }, data: { status: "failed" } });
  return { outcome: "failed", userId: tx.userId, amount: tx.amount, currency: tx.currency, ngn };
}
