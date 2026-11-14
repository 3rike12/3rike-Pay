import { Prisma } from "@prisma/client";
import { config } from "@/config";
import { prisma } from "@/db/prisma";
import { ensureUserEvmWallet } from "@/services/userWallet";
import { nearIntents, type PayableToken } from "@/services/nearIntents";
import { originMetaFor, scheduleCryptoVerification } from "@/services/cryptoInvoice";
import { generateTransactionReference } from "@/utils/helpers";
import { createLogger } from "@/utils/logger";

const logger = createLogger("wallet-topup");

export async function createWalletTopUp(params: {
  userId: string;
  phone: string;
  amount: number;
  currency: string;
  symbol?: string;
  chain?: string;
}) {
  if (!nearIntents.isNearIntentsEnabled()) throw new Error("NEAR Intents top-ups aren't available right now.");
  if (!Number.isFinite(params.amount) || params.amount <= 0) throw new Error("Enter a valid amount.");

  const wallet = await ensureUserEvmWallet(params.userId, params.phone);
  const origin = await chooseOrigin(params.symbol, params.chain);
  const currency = params.currency.toUpperCase();
  const usd = params.amount / (config.nearIntents.fxRates?.[currency] || 0);
  if (!Number.isFinite(usd) || usd <= 0) throw new Error(`Top-ups don't support ${currency} yet.`);
  const amountOut = nearIntents.fiatToDestinationUnits(params.amount, currency);
  const reference = generateTransactionReference();
  const deadline = new Date(Date.now() + 30 * 60_000);

  const transaction = await prisma.transaction.create({
    data: {
      userId: params.userId,
      reference,
      type: "wallet_topup",
      amount: params.amount,
      currency,
      status: "processing",
      description: "NEAR Intents wallet top-up",
      metadata: {
        provider: "near-intents",
        walletAddress: wallet.address,
        source: "whatsapp",
      } as Prisma.InputJsonValue,
    },
  });

  try {
    const { quote } = await nearIntents.requestQuote({
      amount: amountOut,
      originAsset: origin.assetId,
      destinationAsset: config.nearIntents.destinationAsset,
      recipient: wallet.address,
      recipientType: "DESTINATION_CHAIN",
      refundTo: wallet.address,
      deadline,
    });
    if (!quote.depositAddress) throw new Error("NEAR Intents returned no deposit address.");

    const details = {
      depositAddress: quote.depositAddress,
      depositMemo: quote.depositMemo ?? null,
      amountIn: quote.amountIn,
      amountInFormatted: quote.amountInFormatted ?? null,
      amountOut: quote.amountOut,
      originAsset: origin.assetId,
      originLabel: `${origin.symbol} on ${origin.blockchain}`,
      origin: originMetaFor(origin),
      refundTo: wallet.address,
      recipient: wallet.address,
      destinationAsset: config.nearIntents.destinationAsset,
      deadline: deadline.toISOString(),
    };
    await prisma.transaction.update({
      where: { id: transaction.id },
      data: { metadata: { provider: "near-intents", walletAddress: wallet.address, source: "whatsapp", nearIntents: details } as Prisma.InputJsonValue },
    });
    scheduleCryptoVerification(reference);
    return { reference, walletAddress: wallet.address, origin, quote: details, amount: params.amount, currency };
  } catch (error: any) {
    await prisma.transaction.update({ where: { id: transaction.id }, data: { status: "failed" } }).catch(() => {});
    logger.warn("Could not create NEAR Intents wallet top-up", { userId: params.userId, reference, error: error?.message });
    throw error;
  }
}

async function chooseOrigin(symbol?: string, chain?: string): Promise<PayableToken> {
  const preferredSymbol = symbol?.toUpperCase() || (config.nearIntents.network === "tidepool" ? "USDT" : "USDC");
  const preferredChain = chain?.toLowerCase() || "base";
  const token = await nearIntents.resolveOriginAsset(preferredSymbol, preferredChain);
  if (token) return token;
  if (symbol || chain) {
    throw new Error(`That ${preferredSymbol} route isn't available. Choose a supported token and network from the Add money options.`);
  }
  const fallback = await nearIntents.resolveOriginAsset("USDT", "base");
  if (fallback) return fallback;
  throw new Error("No supported NEAR Intents top-up route is available right now.");
}
