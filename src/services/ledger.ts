import { prisma } from "@/db/prisma";
import { withIdempotencyKey, acquireLock } from "@/utils/idempotency";
import { createLogger } from "@/utils/logger";

const logger = createLogger("ledger");

// ============================================
// Internal Ledger Service
// Minimal double-entry-ish ledger:
// - One Wallet per user + currency.
// - Every credit/debit creates a LedgerEntry with the running balance.
// - The Wallet row holds the live balance for fast lookups.
// - Redis-backed idempotency + wallet locks for ACID/concurrency.
// ============================================

export class LedgerService {
  private walletLockKey(userId: string, currency: string): string {
    return `ledger:wallet:${userId}:${currency}`;
  }

  private idempotencyKey(key?: string): string | undefined {
    return key ? `ledger:${key}` : undefined;
  }

  /**
   * Acquire an exclusive lock on a wallet. Resolves when the lock is held.
   * Caller must call release().
   */
  private async acquireWalletLock(userId: string, currency: string, ttlSeconds = 10) {
    const key = this.walletLockKey(userId, currency);
    let lock = await acquireLock(key, ttlSeconds);

    let attempts = 0;
    while (!lock && attempts < 50) {
      // Simple busy-wait retry with 100ms sleep. Good enough for local/small scale.
      await new Promise((resolve) => setTimeout(resolve, 100));
      lock = await acquireLock(key, ttlSeconds);
      attempts++;
    }

    if (!lock) {
      throw new Error(`Could not acquire wallet lock for ${userId}/${currency}`);
    }

    return lock;
  }

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
   * Every wallet this user holds, one row per currency.
   *
   * Read-only on purpose: a balance peek must not create a wallet row, so a
   * user who has never been credited gets the synthetic zero line instead of
   * a write. Callers rendering "your balance" want the whole set - a merchant
   * collecting RWF invoices and a user holding NGN both show up here.
   */
  async listBalances(userId: string): Promise<Array<{ currency: string; balance: number }>> {
    const wallets = await prisma.wallet.findMany({
      where: { userId },
      orderBy: { currency: "asc" },
      select: { currency: true, balance: true },
    });

    return wallets.length > 0 ? wallets : [{ currency: "RWF", balance: 0 }];
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
    idempotencyKey?: string;
  }) {
    const { userId, amount, currency = "RWF", reference, description, metadata, idempotencyKey } = params;

    if (amount <= 0) {
      throw new Error("Credit amount must be greater than zero");
    }

    const execute = async () => {
      const lock = await this.acquireWalletLock(userId, currency, 10);

      try {
        return await prisma.$transaction(async (tx) => {
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
      } finally {
        await lock.release();
      }
    };

    if (idempotencyKey) {
      return withIdempotencyKey(this.idempotencyKey(idempotencyKey)!, execute, {
        lockTtlSeconds: 10,
        resultTtlSeconds: 24 * 60 * 60,
      });
    }

    return execute();
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
    idempotencyKey?: string;
  }) {
    const { userId, amount, currency = "RWF", reference, description, metadata, allowNegative = false, idempotencyKey } = params;

    if (amount <= 0) {
      throw new Error("Debit amount must be greater than zero");
    }

    const execute = async () => {
      const lock = await this.acquireWalletLock(userId, currency, 10);

      try {
        const wallet = await prisma.wallet.findUnique({
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

        return prisma.$transaction(async (tx) => {
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
      } finally {
        await lock.release();
      }
    };

    if (idempotencyKey) {
      return withIdempotencyKey(this.idempotencyKey(idempotencyKey)!, execute, {
        lockTtlSeconds: 10,
        resultTtlSeconds: 24 * 60 * 60,
      });
    }

    return execute();
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
    idempotencyKey?: string;
  }) {
    const { fromUserId, toUserId, amount, currency = "RWF", reference, description, idempotencyKey } = params;

    if (fromUserId === toUserId) {
      throw new Error("Cannot transfer to the same user");
    }

    const execute = async () => {
      // Acquire both wallet locks in a consistent order to avoid deadlocks.
      const lockKeys = [
        this.walletLockKey(fromUserId, currency),
        this.walletLockKey(toUserId, currency),
      ].sort();

      const fromLock = await this.acquireLock(lockKeys[0], 10);
      const toLock = await this.acquireLock(lockKeys[1], 10);

      try {
        // Pre-check balance outside the DB transaction to fail fast.
        const fromWallet = await prisma.wallet.findUnique({
          where: { userId_currency: { userId: fromUserId, currency } },
        });

        if (!fromWallet || fromWallet.balance < amount) {
          throw new Error(
            `Insufficient balance: ${fromWallet?.balance ?? 0} ${currency} available, ${amount} ${currency} requested`
          );
        }

        return await prisma.$transaction(async (tx) => {
          const debitWallet = await tx.wallet.update({
            where: { id: fromWallet.id },
            data: { balance: { decrement: amount } },
          });

          const debitEntry = await tx.ledgerEntry.create({
            data: {
              walletId: debitWallet.id,
              direction: "debit",
              amount,
              currency,
              runningBalance: debitWallet.balance,
              reference,
              description: description || `Transfer to ${toUserId}`,
              metadata: { toUserId } as any,
            },
          });

          let creditWallet = await tx.wallet.findUnique({
            where: { userId_currency: { userId: toUserId, currency } },
          });

          if (!creditWallet) {
            creditWallet = await tx.wallet.create({
              data: { userId: toUserId, currency, balance: amount },
            });
          } else {
            creditWallet = await tx.wallet.update({
              where: { id: creditWallet.id },
              data: { balance: { increment: amount } },
            });
          }

          const creditEntry = await tx.ledgerEntry.create({
            data: {
              walletId: creditWallet.id,
              direction: "credit",
              amount,
              currency,
              runningBalance: creditWallet.balance,
              reference,
              description: description || `Transfer from ${fromUserId}`,
              metadata: { fromUserId } as any,
            },
          });

          logger.info("Ledger transfer", {
            fromUserId,
            toUserId,
            amount,
            currency,
            reference,
            fromBalance: debitWallet.balance,
            toBalance: creditWallet.balance,
          });

          return {
            fromUserId,
            toUserId,
            amount,
            currency,
            reference,
            debit: { wallet: debitWallet, entry: debitEntry },
            credit: { wallet: creditWallet, entry: creditEntry },
          };
        });
      } finally {
        await fromLock.release();
        await toLock.release();
      }
    };

    if (idempotencyKey) {
      return withIdempotencyKey(this.idempotencyKey(idempotencyKey)!, execute, {
        lockTtlSeconds: 10,
        resultTtlSeconds: 24 * 60 * 60,
      });
    }

    return execute();
  }

  private async acquireLock(key: string, ttlSeconds = 10) {
    const lock = await acquireLock(key, ttlSeconds);
    if (!lock) {
      throw new Error(`Could not acquire lock ${key}`);
    }
    return lock;
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
