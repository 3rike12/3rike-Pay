import { prisma } from "@/db/prisma";
import { createLogger } from "@/utils/logger";

const logger = createLogger("ledger");

// ============================================
// Internal Ledger Service
// Minimal double-entry-ish ledger:
// - One Wallet per user + currency.
// - Every credit/debit creates a LedgerEntry with the running balance.
// - The Wallet row holds the live balance for fast lookups.
// ============================================

export class LedgerService {
  /**
   * Get or create a wallet for a user in a given currency.
   */
  async getOrCreateWallet(userId: string, currency = "RWF") {
    let wallet = await prisma.wallet.findUnique({
      where: { userId_currency: { userId, currency } },
    });

    if (!wallet) {
      wallet = await prisma.wallet.create({
        data: { userId, currency, balance: 0 },
      });
      logger.info("Wallet created", { walletId: wallet.id, userId, currency });
    }

    return wallet;
  }

  /**
   * Get the current balance for a user in a currency.
   */
  async getBalance(userId: string, currency = "RWF") {
    const wallet = await this.getOrCreateWallet(userId, currency);
    return wallet.balance;
  }

  /**
   * Credit a user's wallet.
   */
  async credit(params: {
    userId: string;
    amount: number;
    currency?: string;
    reference: string;
    description?: string;
    metadata?: Record<string, unknown>;
  }) {
    const { userId, amount, currency = "RWF", reference, description, metadata } = params;

    if (amount <= 0) {
      throw new Error("Credit amount must be greater than zero");
    }

    return prisma.$transaction(async (tx) => {
      // Lock the wallet row with a pessimistic write to prevent race conditions.
      let wallet = (await tx.wallet.findUnique({
        where: { userId_currency: { userId, currency } },
      })) as { id: string; balance: number } | null;

      if (!wallet) {
        wallet = await tx.wallet.create({
          data: { userId, currency, balance: amount },
        });
      } else {
        wallet = await tx.wallet.update({
          where: { id: wallet.id },
          data: { balance: { increment: amount } },
        });
      }

      const entry = await tx.ledgerEntry.create({
        data: {
          walletId: wallet.id,
          direction: "credit",
          amount,
          currency,
          runningBalance: wallet.balance,
          reference,
          description,
          metadata: (metadata ?? {}) as any,
        },
      });

      logger.info("Ledger credited", {
        walletId: wallet.id,
        userId,
        amount,
        currency,
        reference,
        runningBalance: wallet.balance,
      });

      return { wallet, entry };
    });
  }

  /**
   * Debit a user's wallet. Throws if insufficient balance.
   */
  async debit(params: {
    userId: string;
    amount: number;
    currency?: string;
    reference: string;
    description?: string;
    metadata?: Record<string, unknown>;
    allowNegative?: boolean;
  }) {
    const { userId, amount, currency = "RWF", reference, description, metadata, allowNegative = false } = params;

    if (amount <= 0) {
      throw new Error("Debit amount must be greater than zero");
    }

    return prisma.$transaction(async (tx) => {
      const wallet = await tx.wallet.findUnique({
        where: { userId_currency: { userId, currency } },
      });

      if (!wallet) {
        throw new Error(`Insufficient balance: no ${currency} wallet for user ${userId}`);
      }

      if (!allowNegative && wallet.balance < amount) {
        throw new Error(
          `Insufficient balance: ${wallet.balance} ${currency} available, ${amount} ${currency} requested`
        );
      }

      const updatedWallet = await tx.wallet.update({
        where: { id: wallet.id },
        data: { balance: { decrement: amount } },
      });

      const entry = await tx.ledgerEntry.create({
        data: {
          walletId: updatedWallet.id,
          direction: "debit",
          amount,
          currency,
          runningBalance: updatedWallet.balance,
          reference,
          description,
          metadata: (metadata ?? {}) as any,
        },
      });

      logger.info("Ledger debited", {
        walletId: updatedWallet.id,
        userId,
        amount,
        currency,
        reference,
        runningBalance: updatedWallet.balance,
      });

      return { wallet: updatedWallet, entry };
    });
  }

  /**
   * Move funds between two users' wallets (internal transfer).
   */
  async transfer(params: {
    fromUserId: string;
    toUserId: string;
    amount: number;
    currency?: string;
    reference: string;
    description?: string;
  }) {
    const { fromUserId, toUserId, amount, currency = "RWF", reference, description } = params;

    if (fromUserId === toUserId) {
      throw new Error("Cannot transfer to the same user");
    }

    const debitResult = await this.debit({
      userId: fromUserId,
      amount,
      currency,
      reference,
      description: description || `Transfer to ${toUserId}`,
      metadata: { toUserId },
    });

    const creditResult = await this.credit({
      userId: toUserId,
      amount,
      currency,
      reference,
      description: description || `Transfer from ${fromUserId}`,
      metadata: { fromUserId },
    });

    return { debit: debitResult.entry, credit: creditResult.entry };
  }

  /**
   * Get ledger history for a user in a currency.
   */
  async getLedger(userId: string, currency = "RWF", limit = 50, offset = 0) {
    const wallet = await this.getOrCreateWallet(userId, currency);

    const entries = await prisma.ledgerEntry.findMany({
      where: { walletId: wallet.id },
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    });

    return { wallet, entries };
  }
}

export const ledger = new LedgerService();
