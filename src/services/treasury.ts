import { config } from "@/config";
import { prisma } from "@/db/prisma";
import { createLogger } from "@/utils/logger";

const logger = createLogger("treasury");

// ============================================
// Treasury accounting
//
// Merchant balances live in the ledger (per user, per currency). The money
// behind them sits on-chain in one pool. This module answers:
//   - who holds what?        holdingsByUser()
//   - what do we owe?        liabilities()  (all wallets, USD-equivalent)
//   - what do we have?       onChainBalanceUsd()
//   - are we covered?        solvency()
// ============================================

export function toUsd(amount: number, currency: string): number {
  const rate = config.nearIntents.fxRates?.[currency.toUpperCase()];
  if (!rate || rate <= 0) throw new Error(`No FX rate for ${currency}`);
  return amount / rate;
}

/** USD -> amount in `currency` (inverse of toUsd). */
export function fromUsd(usd: number, currency: string): number {
  const rate = config.nearIntents.fxRates?.[currency.toUpperCase()];
  if (!rate || rate <= 0) throw new Error(`No FX rate for ${currency}`);
  return usd * rate;
}

/** ERC-20 balanceOf(treasury) over plain JSON-RPC - no signing library needed. */
export async function onChainBalanceUsd(): Promise<number> {
  const { address, rpcUrl, tokenContract, tokenDecimals } = config.treasury;
  if (!address) throw new Error("TREASURY_ADDRESS is not configured");

  const data = "0x70a08231" + address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: tokenContract, data }, "latest"],
    }),
  });
  if (!res.ok) throw new Error(`Treasury RPC failed (${res.status})`);
  const body: any = await res.json();
  if (body.error || typeof body.result !== "string") {
    throw new Error(`Treasury RPC error: ${body.error?.message ?? "no result"}`);
  }
  // Stablecoin treated as $1; fine for USDC/USDT.
  return Number(BigInt(body.result)) / 10 ** tokenDecimals;
}

export interface Holding {
  userId: string;
  phone: string | null;
  currency: string;
  balance: number;
  usd: number;
}

/** Every non-zero wallet, with its USD value. Platform fee wallet is flagged by phone. */
export async function holdingsByUser(): Promise<Holding[]> {
  const wallets = await prisma.wallet.findMany({
    where: { balance: { not: 0 } },
    include: { user: { select: { phone: true } } },
    orderBy: [{ userId: "asc" }, { currency: "asc" }],
  });
  return wallets.map((w) => {
    let usd = 0;
    try {
      usd = toUsd(w.balance, w.currency);
    } catch (error: any) {
      logger.warn("Wallet currency has no FX rate", { currency: w.currency });
    }
    return {
      userId: w.userId,
      phone: w.user?.phone ?? null,
      currency: w.currency,
      balance: w.balance,
      usd,
    };
  });
}

/** Total owed to holders, per currency and in USD. */
export async function liabilities() {
  const holdings = await holdingsByUser();
  const byCurrency: Record<string, { balance: number; usd: number }> = {};
  for (const h of holdings) {
    const row = (byCurrency[h.currency] ||= { balance: 0, usd: 0 });
    row.balance += h.balance;
    row.usd += h.usd;
  }
  const totalUsd = Object.values(byCurrency).reduce((sum, r) => sum + r.usd, 0);
  return { byCurrency, totalUsd };
}

/**
 * assets (on-chain) vs liabilities (ledger). `covered` is false when the
 * treasury holds less than we owe - the signal to top up or pause payouts.
 */
export async function solvency() {
  const [assetsUsd, owed] = await Promise.all([onChainBalanceUsd(), liabilities()]);
  return {
    assetsUsd,
    liabilitiesUsd: owed.totalUsd,
    surplusUsd: assetsUsd - owed.totalUsd,
    covered: assetsUsd >= owed.totalUsd,
    byCurrency: owed.byCurrency,
  };
}
