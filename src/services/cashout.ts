import { Prisma } from "@prisma/client";
import { config } from "@/config";
import { prisma } from "@/db/prisma";
import { autoramp } from "@/services/autoramp";
import { ledger } from "@/services/ledger";
import { getTreasurySigner } from "@/services/withdrawal";
import { onChainBalanceUsd, liabilities, toUsd } from "@/services/treasury";
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
}

/** USD -> NGN: AutoRamp's live rate when reachable, else our static table. */
async function usdNgnRate(): Promise<number> {
  try {
    const live = Number((await autoramp.getUsdNgnRate())?.rate);
    if (Number.isFinite(live) && live > 0) return live;
  } catch {
    /* fall through to the table */
  }
  const fallback = config.nearIntents.fxRates?.NGN;
  if (!fallback) throw new Error("No NGN rate available right now.");
  return fallback;
}

/** What a cash-out of `amount` (in the merchant's currency) would pay out. Throws on bad limits. */
export async function quoteCashout(currency: string, amount: number): Promise<CashoutQuote> {
  const cur = currency.toUpperCase();
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Enter a valid amount.");

  const usd = toUsd(amount, cur);
  const { minWithdrawUsd, maxWithdrawUsd } = config.treasury;
  if (usd < minWithdrawUsd) throw new Error(`The minimum cash-out is about $${minWithdrawUsd}.`);
  if (usd > maxWithdrawUsd) throw new Error(`The maximum cash-out is about $${maxWithdrawUsd}.`);

  const rate = await usdNgnRate();
  const ngn = Math.floor(usd * rate);
  if (ngn < MIN_PAYOUT_NGN) throw new Error(`The minimum payout is ₦${MIN_PAYOUT_NGN.toLocaleString("en-US")}.`);

  // Round the USDC up to the cent so the off-ramp is never short-funded.
  const usdc = Math.ceil((ngn / rate) * 100) / 100;
  return { currency: cur, amount, usd, ngn, usdc, rate };
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

  // AutoRamp is asked first (nothing is spent yet), so a rejected request
  // never touches the merchant's balance.
  let ramp: any;
  try {
    ramp = await autoramp.initializeOffRamp({
      network: "base",
      amount: quote.ngn,
      bankCode: params.bankCode,
      accountNumber: params.accountNumber,
    });
  } catch (error: any) {
    logger.error("Off-ramp could not be initialised", { error: error?.response?.data || error?.message });
    throw new Error("I couldn't set up that payout. Check the bank details and try again.");
  }

  const reference: string | undefined = ramp?.databaseRecord?.reference || ramp?.reference;
  const depositAddress: string | undefined = ramp?.data?.depositAddress || ramp?.depositAddress;
  if (!reference || !depositAddress) {
    logger.error("Off-ramp response missing reference or deposit address", { keys: Object.keys(ramp || {}) });
    throw new Error("I couldn't set up that payout. Please try again.");
  }

  await ledger.debit({
    userId: params.userId,
    amount: quote.amount,
    currency: quote.currency,
    reference,
    description: `Cash out to bank (₦${quote.ngn})`,
    metadata: { type: "cashout", ngn: quote.ngn },
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
      data: { metadata: { provider: "autoramp", usd: quote.usd, ngn: quote.ngn, usdc: quote.usdc, rate: quote.rate, depositAddress, fundingTx: txHash } },
    });
    return { reference, status: "processing", quote, depositAddress, txHash };
  } catch (error: any) {
    logger.error("Cash-out failed before funds left the treasury; reversing", { reference, error: error?.message });
    await reverse(error?.message || "error");
    throw new Error("The cash-out failed and your balance was restored.");
  }
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

  if (event === "offramp.completed") {
    if (tx.status === "completed") return null; // duplicate webhook
    await prisma.transaction.update({ where: { id: tx.id }, data: { status: "completed" } });
    return { outcome: "completed", userId: tx.userId, amount: tx.amount, currency: tx.currency, ngn };
  }

  if (event === "offramp.failed") {
    if (tx.status === "failed") return null; // duplicate webhook
    await ledger.credit({
      userId: tx.userId,
      amount: tx.amount,
      currency: tx.currency,
      reference,
      description: "Cash-out failed: balance restored",
      metadata: { type: "cashout_reversal", event },
      idempotencyKey: `cashout-reversal:${reference}`,
    });
    await prisma.transaction.update({ where: { id: tx.id }, data: { status: "failed" } });
    return { outcome: "failed", userId: tx.userId, amount: tx.amount, currency: tx.currency, ngn };
  }
  return null;
}
