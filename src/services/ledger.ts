import { prisma } from "@/db/prisma";
import { withIdempotencyKey, acquireLock } from "@/utils/idempotency";
import { createLogger } from "@/utils/logger";
import { fromMinor, toMinor } from "@/utils/money";
import { useMinor, walletBalance } from "@/utils/walletBalance";

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
   * Move a wallet by `delta` (negative for a debit) and report the running
   * balance. The representation is decided from the row as it was BEFORE the
   * move: with MONEY_READS=minor and a clean wallet, both columns move together
   * atomically and the integer one is exact; otherwise the float is the source
   * of truth and the integer column is derived from it. Either way both columns
   * are written, so switching the flag never needs a backfill to be re-run.
   */
  private async move(
    tx: any,
    wallet: { id: string; currency: string; balance: number; balanceMinor: bigint },
    delta: number,
    currency: string
  ) {
    const exact = useMinor(wallet);
    const updated = await tx.wallet.update({
      where: { id: wallet.id },
      data: exact
        ? { balance: { increment: delta }, balanceMinor: { increment: toMinor(delta, currency) } }
        : { balance: { increment: delta }, balanceMinor: toMinor(wallet.balance + delta, currency) },
    });
    return {
      updated,
      runningBalance: exact ? fromMinor(updated.balanceMinor, currency) : (updated.balance as number),
      runningBalanceMinor: updated.balanceMinor as bigint,
    };
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
    return walletBalance(wallet);
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
      select: { currency: true, balance: true, balanceMinor: true },
    });

    return wallets.length > 0
      ? wallets.map((w) => ({ currency: w.currency, balance: walletBalance(w) }))
      : [{ currency: "RWF", balance: 0 }];
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
          const existing = (await tx.wallet.findUnique({
            where: { userId_currency: { userId, currency } },
          })) as { id: string; currency: string; balance: number; balanceMinor: bigint } | null;

          let wallet: any;
          let runningBalance: number;
          let runningBalanceMinor: bigint;
          if (!existing) {
            wallet = await tx.wallet.create({
              data: { userId, currency, balance: amount, balanceMinor: toMinor(amount, currency) },
            });
            runningBalance = wallet.balance;
            runningBalanceMinor = wallet.balanceMinor;
          } else {
            const moved = await this.move(tx, existing, amount, currency);
            wallet = moved.updated;
            runningBalance = moved.runningBalance;
            runningBalanceMinor = moved.runningBalanceMinor;
          }

          const entry = await tx.ledgerEntry.create({
            data: {
              walletId: wallet.id,
              direction: "credit",
              amount,
              amountMinor: toMinor(amount, currency),
              currency,
              runningBalance,
              runningBalanceMinor,
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
            runningBalance,
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

        // In minor mode the check is an exact integer comparison.
        const insufficient = useMinor(wallet as any)
          ? wallet.balanceMinor < toMinor(amount, currency)
          : wallet.balance < amount;
        if (!allowNegative && insufficient) {
          throw new Error(
            `Insufficient balance: ${walletBalance(wallet as any)} ${currency} available, ${amount} ${currency} requested`
          );
        }

        return prisma.$transaction(async (tx) => {
          const moved = await this.move(tx, wallet as any, -amount, currency);
          const updatedWallet = moved.updated;

          const entry = await tx.ledgerEntry.create({
            data: {
              walletId: updatedWallet.id,
              direction: "debit",
              amount,
              amountMinor: toMinor(amount, currency),
              currency,
              runningBalance: moved.runningBalance,
              runningBalanceMinor: moved.runningBalanceMinor,
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
            runningBalance: moved.runningBalance,
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

        const insufficient = !fromWallet
          ? true
          : useMinor(fromWallet as any)
            ? fromWallet.balanceMinor < toMinor(amount, currency)
            : fromWallet.balance < amount;
        if (!fromWallet || insufficient) {
          throw new Error(
            `Insufficient balance: ${fromWallet ? walletBalance(fromWallet as any) : 0} ${currency} available, ${amount} ${currency} requested`
          );
        }

        return await prisma.$transaction(async (tx) => {
          const debited = await this.move(tx, fromWallet as any, -amount, currency);
          const debitWallet = debited.updated;

          const debitEntry = await tx.ledgerEntry.create({
            data: {
              walletId: debitWallet.id,
              direction: "debit",
              amount,
              amountMinor: toMinor(amount, currency),
              currency,
              runningBalance: debited.runningBalance,
              runningBalanceMinor: debited.runningBalanceMinor,
              reference,
              description: description || `Transfer to ${toUserId}`,
              metadata: { toUserId } as any,
            },
          });

          const existingCredit = await tx.wallet.findUnique({
            where: { userId_currency: { userId: toUserId, currency } },
          });

          let creditWallet: any;
          let creditRunning: number;
          let creditRunningMinor: bigint;
          if (!existingCredit) {
            creditWallet = await tx.wallet.create({
              data: { userId: toUserId, currency, balance: amount, balanceMinor: toMinor(amount, currency) },
            });
            creditRunning = creditWallet.balance;
            creditRunningMinor = creditWallet.balanceMinor;
          } else {
            const credited = await this.move(tx, existingCredit as any, amount, currency);
            creditWallet = credited.updated;
            creditRunning = credited.runningBalance;
            creditRunningMinor = credited.runningBalanceMinor;
          }

          const creditEntry = await tx.ledgerEntry.create({
            data: {
              walletId: creditWallet.id,
              direction: "credit",
              amount,
              amountMinor: toMinor(amount, currency),
              currency,
              runningBalance: creditRunning,
              runningBalanceMinor: creditRunningMinor,
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
