import { Prisma } from "@prisma/client";
import { config } from "@/config";
import { prisma } from "@/db/prisma";
import { ledger } from "@/services/ledger";
import { nearIntents } from "@/services/nearIntents";
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
  const { minWithdrawUsd, maxWithdrawUsd } = config.treasury;
  if (usd < minWithdrawUsd) throw new Error(`Minimum withdrawal is ${formatUsdThreshold(minWithdrawUsd, currency)}.`);
  if (usd > maxWithdrawUsd) throw new Error(`Maximum withdrawal is ${formatUsdThreshold(maxWithdrawUsd, currency)}.`);

  const token = await nearIntents.resolveOriginAsset(params.symbol, params.chain);
  if (!token) throw new Error(`I can't pay out ${params.symbol.toUpperCase()}${params.chain ? ` on ${params.chain}` : ""}.`);

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
    const { quote } = await nearIntents.requestQuote({
      swapType: "EXACT_INPUT",
      amount: treasuryUnits,
      originAsset: config.nearIntents.originAsset,
      destinationAsset: token.assetId,
      recipient: params.address,
      recipientType: "DESTINATION_CHAIN",
      refundTo: config.treasury.address,
      deadline: new Date(Date.now() + 30 * 60 * 1000),
    });
    if (!quote.depositAddress) throw new Error("No deposit address returned");

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
          address: params.address,
          symbol: token.symbol,
          chain: token.blockchain,
          nearIntents: {
            depositAddress: quote.depositAddress,
            depositMemo: quote.depositMemo ?? null,
            amountIn: quote.amountIn,
            amountOut: quote.amountOut,
          },
        } as Prisma.InputJsonValue,
      },
    });

    const base = { reference, usd, depositAddress: quote.depositAddress, amountInFormatted: quote.amountInFormatted };
    if (!signer) {
      await prisma.transaction.updateMany({ where: { reference }, data: { status: "awaiting_signature" } });
      logger.warn("No treasury signer: withdrawal parked for manual funding", { reference });
      return { ...base, status: "awaiting_signature" };
    }

    const { txHash } = await signer.send({
      to: quote.depositAddress,
      amountUnits: quote.amountIn,
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
    if (res.status === "SUCCESS") {
      await prisma.transaction.updateMany({ where: { reference }, data: { status: "completed" } });
      return "completed";
    }
    if (res.status === "REFUNDED" || res.status === "FAILED") {
      // The swap's input comes back to the treasury, so the merchant is made whole.
      await ledger.credit({
        userId: tx.userId,
        amount: tx.amount,
        currency: tx.currency,
        reference,
        description: `Withdrawal ${res.status.toLowerCase()}: balance restored`,
        metadata: { type: "withdrawal_reversal", status: res.status },
        idempotencyKey: `withdraw-reversal:${reference}`,
      });
      await prisma.transaction.updateMany({ where: { reference }, data: { status: "failed" } });
      return "failed";
    }
    return "pending";
  } catch (error: any) {
    logger.warn("Withdrawal poll failed", { reference, error: error?.message });
    return "pending";
  }
}

const POLL_DELAYS_MS = [20_000, 40_000, 60_000, 120_000, 180_000, 300_000, 600_000];

export function scheduleWithdrawalVerification(reference: string, delaysMs: number[] = POLL_DELAYS_MS): void {
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
