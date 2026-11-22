import { Prisma } from "@prisma/client";
import { config } from "@/config";
import { prisma } from "@/db/prisma";
import { ledger } from "@/services/ledger";
import { nearIntents } from "@/services/nearIntents";
import { mapOneClickStatus } from "@/rails/oneClick";
import { applyRailEvent } from "@/rails/settlement";
import { fromTransactionStatus, isFinal } from "@/rails/state";
import { checkLimits } from "@/rails/limits";
import { initiateOn, pickRail } from "@/rails/router";
import { staticFx } from "@/services/fx";
import { formatUsdThreshold, onChainBalanceUsd, liabilities, toUsd } from "@/services/treasury";
import { generateTransactionReference } from "@/utils/helpers";
import { createLogger } from "@/utils/logger";

const logger = createLogger("withdrawal");

// ============================================
// Withdraw to crypto
//
// The merchant's ledger balance (any currency) is paid out of the crypto
// treasury as the token + chain + address they choose. Order matters:
//
//   1. DEBIT the ledger first (idempotent) - the money can never be spent twice.
//   2. Quote 1Click (EXACT_INPUT from the treasury asset to their token).
//   3. Have the treasury signer send the input to the quote's deposit address.
//   4. Poll status. SUCCESS -> completed. REFUNDED/FAILED -> credit back.
//
// Any failure before funds leave the treasury reverses the debit.
// ============================================

/**
 * Sends the treasury's input asset to a 1Click deposit address. Implement with
 * a KMS / custody provider / hot wallet. Until one is registered, withdrawals
 * are parked as `awaiting_signature` for an operator to fund by hand.
 */
export interface TreasurySigner {
  send(params: {
    to: string;
    amountUnits: string;
    /** Token to send: an ERC-20 contract address (anything else means the treasury token). */
    asset: string;
    /** Our payout reference: makes a retry safe (the same reference is never sent twice). */
    reference?: string;
  }): Promise<{ txHash: string }>;
}

let signer: TreasurySigner | null = null;
export function setTreasurySigner(s: TreasurySigner | null) {
  signer = s;
}

export function getTreasurySigner(): TreasurySigner | null {
  return signer;
}

export const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;

export interface WithdrawalResult {
  reference: string;
  status: "processing" | "awaiting_signature";
  usd: number;
  depositAddress: string;
  amountInFormatted?: string | null;
  txHash?: string;
}

export async function requestWithdrawal(params: {
  userId: string;
  /** Ledger currency being spent, e.g. RWF. */
  currency: string;
  amount: number;
  symbol: string;
  chain?: string;
  address: string;
}): Promise<WithdrawalResult> {
  if (config.nearIntents.network === "tidepool") {
    throw new Error("Treasury withdrawals are disabled in Tidepool demo mode.");
  }
  const currency = params.currency.toUpperCase();
  const amount = Number(params.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Enter a valid amount.");
  if (!EVM_ADDRESS.test(params.address)) {
    throw new Error("That doesn't look like a valid wallet address (expected 0x…).");
  }

  const usd = toUsd(amount, currency);

  const token = await nearIntents.resolveOriginAsset(params.symbol, params.chain);
  if (!token) throw new Error(`I can't pay out ${params.symbol.toUpperCase()}${params.chain ? ` on ${params.chain}` : ""}.`);

  // The payout rail owns its minimum and maximum (RAIL_1CLICK_PAYOUT_MIN_USD / _MAX_USD).
  const limits = checkLimits("out", { kind: "swap", chain: token.blockchain, usd });
  if (!limits.ok) {
    if (limits.reason === "below_min") throw new Error(`Minimum withdrawal is ${formatUsdThreshold(limits.minUsd, currency)}.`);
    if (limits.reason === "above_max") throw new Error(`Maximum withdrawal is ${formatUsdThreshold(limits.maxUsd, currency)}.`);
    throw new Error(`I can't pay out on ${token.blockchain} right now.`);
  }

  // Fail closed: never promise a payout the treasury can't fund.
  const [assets, owed] = await Promise.all([onChainBalanceUsd(), liabilities()]);
  if (assets < usd || assets < owed.totalUsd) {
    logger.error("Treasury cannot cover withdrawal", { assets, liabilities: owed.totalUsd, usd });
    throw new Error("Withdrawals are temporarily unavailable. Please try again shortly.");
  }

  const reference = generateTransactionReference();
  const debitKey = `withdraw-debit:${reference}`;

  await ledger.debit({
    userId: params.userId,
    amount,
    currency,
    reference,
    description: `Withdrawal to ${token.symbol} (${token.blockchain})`,
    metadata: { type: "withdrawal", symbol: token.symbol, chain: token.blockchain, address: params.address },
    idempotencyKey: debitKey,
  });

  const refund = async (why: string) => {
    await ledger.credit({
      userId: params.userId,
      amount,
      currency,
      reference,
      description: `Withdrawal reversed: ${why}`,
      metadata: { type: "withdrawal_reversal" },
      idempotencyKey: `withdraw-reversal:${reference}`,
    });
    await prisma.transaction.updateMany({ where: { reference }, data: { status: "failed" } });
  };

  try {
    const treasuryUnits = BigInt(Math.floor(usd * 10 ** config.treasury.tokenDecimals)).toString();
    const instruction = await initiateOn(pickRail("out", { kind: "swap", chain: token.blockchain, usd }), {
      kind: "swap",
      swapType: "EXACT_INPUT",
      amount: treasuryUnits,
      originAsset: config.nearIntents.originAsset,
      destinationAsset: token.assetId,
      recipient: params.address,
      recipientType: "DESTINATION_CHAIN",
      refundTo: config.treasury.address,
      deadline: new Date(Date.now() + 30 * 60 * 1000),
    });
    // An exact-input swap always says how much to send; without it we cannot fund the payout.
    const amountIn = instruction.amountIn;
    if (!amountIn) throw new Error("The payout route returned no amount to send");

    await prisma.transaction.create({
      data: {
        userId: params.userId,
        reference,
        type: "withdrawal",
        amount,
        currency,
        status: "processing",
        description: `Withdraw to ${token.symbol} on ${token.blockchain}`,
        metadata: {
          provider: "near-intents",
          usd,
          fx: (() => {
            try {
              return staticFx(currency);
            } catch {
              return null;
            }
          })(),
          address: params.address,
          symbol: token.symbol,
          chain: token.blockchain,
          nearIntents: {
            depositAddress: instruction.depositAddress,
            depositMemo: instruction.depositMemo ?? null,
            amountIn: instruction.amountIn,
            amountOut: instruction.amountOut,
          },
        } as Prisma.InputJsonValue,
      },
    });

    const base = { reference, usd, depositAddress: instruction.depositAddress, amountInFormatted: instruction.amountInFormatted };
    if (!signer) {
      await prisma.transaction.updateMany({ where: { reference }, data: { status: "awaiting_signature" } });
      logger.warn("No treasury signer: withdrawal parked for manual funding", { reference });
      return { ...base, status: "awaiting_signature" };
    }

    const { txHash } = await signer.send({
      to: instruction.depositAddress,
      amountUnits: amountIn,
      asset: config.treasury.tokenContract,
      reference,
    });
    return { ...base, status: "processing", txHash };
  } catch (error: any) {
    logger.error("Withdrawal failed before funds left treasury; reversing", { reference, error: error?.message });
    await refund(error?.message || "error");
    throw new Error("Withdrawal failed and your balance was restored.");
  }
}

/** Poll 1Click for a withdrawal and settle it. Refunded/failed swaps credit the merchant back. */
export async function verifyWithdrawal(
  reference: string
): Promise<"completed" | "failed" | "pending" | "unknown"> {
  const tx = await prisma.transaction.findUnique({ where: { reference } });
  if (!tx || tx.type !== "withdrawal") return "unknown";
  if (tx.status === "completed") return "completed";
  if (tx.status === "failed") return "failed";
  if (tx.status === "awaiting_signature") return "pending";

  const details = (tx.metadata as any)?.nearIntents;
  if (!details?.depositAddress) return "unknown";

  try {
    const res = await nearIntents.getStatus(details.depositAddress, details.depositMemo ?? undefined);
    const state = mapOneClickStatus(res.status);
    if (state !== "settled" && state !== "refunded" && state !== "failed") return "pending";

    // The engine decides whether this report is new. A swap that did not
    // deliver returns its input to the treasury, so the merchant is made whole;
    // the engine posts that credit once, before the state moves.
    const applied = await applyRailEvent({
      reference,
      kind: "withdrawal",
      direction: "out",
      rail: "1click-payout",
      userId: tx.userId,
      railRef: details.depositAddress,
      initialState: fromTransactionStatus(tx.status),
      event: { type: state, providerStatus: res.status },
      post:
        state === "settled"
          ? undefined
          : async () => {
              await ledger.credit({
                userId: tx.userId,
                amount: tx.amount,
                currency: tx.currency,
                reference,
                description: `Withdrawal ${res.status.toLowerCase()}: balance restored`,
                metadata: { type: "withdrawal_reversal", status: res.status },
                idempotencyKey: `withdraw-reversal:${reference}`,
              });
            },
    });

    // Report the payment's recorded outcome, even when this report was a repeat.
    // Still not final (another worker is mid-way): keep waiting.
    if (!isFinal(applied.state)) return "pending";
    const outcome = applied.state === "settled" ? "completed" : "failed";
    await prisma.transaction.updateMany({ where: { reference }, data: { status: outcome === "completed" ? "completed" : "failed" } });
    return outcome;
  } catch (error: any) {
    logger.warn("Withdrawal poll failed", { reference, error: error?.message });
    return "pending";
  }
}

const POLL_DELAYS_MS = [20_000, 40_000, 60_000, 120_000, 180_000, 300_000, 600_000];

/**
 * When the durable queue (BullMQ over Redis) is running it registers itself
 * here and owns withdrawal polling, so a restart cannot lose a payout that is
 * mid-flight. Without Redis this stays null and the timers below are used.
 */
let queueScheduler: ((reference: string) => Promise<void>) | null = null;
export function setWithdrawalScheduler(fn: ((reference: string) => Promise<void>) | null) {
  queueScheduler = fn;
}

/** Withdrawals that still need watching: swap running, or parked for an operator to fund. */
export async function listPendingWithdrawalReferences(limit = 200): Promise<string[]> {
  const rows = await prisma.transaction.findMany({
    where: { type: "withdrawal", status: { in: ["processing", "awaiting_signature"] } },
    select: { reference: true },
    take: limit,
  });
  return rows.map((r) => r.reference);
}

export function scheduleWithdrawalVerification(reference: string, delaysMs: number[] = POLL_DELAYS_MS): void {
  if (queueScheduler) {
    // A slow or unreachable Redis must not lose the payout: fall back to timers.
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("queue timeout")), 5_000).unref?.());
    Promise.race([queueScheduler(reference), timeout]).catch((error: any) => {
      logger.warn("Queue unavailable, tracking withdrawal with in-process timers", { reference, error: error?.message });
      startTimerChain(reference, delaysMs);
    });
    return;
  }
  startTimerChain(reference, delaysMs);
}

function startTimerChain(reference: string, delaysMs: number[]): void {
  const run = (i: number) => {
    if (i >= delaysMs.length) return;
    const timer = setTimeout(() => {
      verifyWithdrawal(reference)
        .then((r) => (r === "pending" ? run(i + 1) : undefined))
        .catch(() => run(i + 1));
    }, delaysMs[i]);
    timer.unref?.();
  };
  run(0);
}
