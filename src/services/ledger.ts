import { prisma } from "@/db/prisma";
import { acquireLock } from "@/utils/idempotency";
import { createLogger } from "@/utils/logger";
import { fromMinor, toMinor } from "@/utils/money";
import { isDrifted, readsFromMinor, walletBalance } from "@/utils/walletBalance";

const logger = createLogger("ledger");

// ============================================
// Internal Ledger Service
//
// - One Wallet per user + currency. Every credit/debit writes a LedgerEntry
//   with the running balance; the Wallet row holds the live balance.
// - The DATABASE keeps this correct, not a cache or a lock:
//     * A posting with an idempotency key happens at most once, forever: the key
//       is a unique column on the entry, written in the same transaction as the
//       balance change. A retry (after a crash, after a day, with no Redis)
//       returns the original entry. A key reused for something different is an
//       error, not a silent replay.
//     * A debit is a conditional update ("only if balance >= amount"), so two
//       simultaneous debits cannot both spend the same money.
//     * Balances move by atomic increments, never by a value computed from an
//       earlier read, so concurrent postings cannot overwrite each other.
// - A Redis wallet lock is still taken when Redis exists, only to reduce
//   contention. Correctness does not depend on it.
// ============================================

type Direction = "credit" | "debit";

interface Posting {
  direction: Direction;
  userId: string;
  amount: number;
  currency: string;
  reference: string;
  description?: string;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
  allowNegative?: boolean;
}

interface WalletRow {
  id: string;
  userId: string;
  currency: string;
  balance: number;
  balanceMinor: bigint;
}

const isUnique = (e: unknown) => (e as { code?: string } | null)?.code === "P2002";
const MAX_ATTEMPTS = 3;

export class LedgerService {
  private walletLockKey(userId: string, currency: string): string {
    return `ledger:wallet:${userId}:${currency}`;
  }

  /** Take a Redis lock if Redis exists, to reduce contention. Resolves when held. Caller must release. */
  private async acquireWalletLock(userId: string, currency: string, ttlSeconds = 10) {
    const key = this.walletLockKey(userId, currency);
    let lock = await acquireLock(key, ttlSeconds);
    let attempts = 0;
    while (!lock && attempts < 50) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      lock = await acquireLock(key, ttlSeconds);
      attempts++;
    }
    if (!lock) throw new Error(`Could not acquire wallet lock for ${userId}/${currency}`);
    return lock;
  }

  /** The idempotency key stored on an entry. A transfer's two legs get distinct, derived keys. */
  private static legKey(key: string | undefined, leg?: "debit" | "credit"): string | undefined {
    if (!key) return undefined;
    return leg ? `${key}:${leg}` : key;
  }

  /**
   * Is this entry the posting we are being asked to make again? If it is a
   * different posting under the same key, that is a bug in the caller and must
   * be loud: silently returning the old result would hide it.
   */
  private assertSamePosting(prior: any, wallet: WalletRow | null, p: Posting) {
    const same =
      wallet &&
      wallet.userId === p.userId &&
      wallet.currency === p.currency &&
      prior.direction === p.direction &&
      prior.amount === p.amount &&
      prior.reference === p.reference;
    if (!same) {
      throw new Error(
        `Idempotency key ${p.idempotencyKey} was already used for a different posting; refusing to treat this one as a retry`
      );
    }
  }

  /**
   * Move a wallet by `delta` (negative for a debit) and report the balance right
   * after, as read back from the row that was updated.
   *
   * Writes are atomic increments on both the float and the integer column, so
   * concurrent postings cannot overwrite each other. A wallet whose two columns
   * disagree (one that predates the integer column) is the exception: it is
   * healed by writing the integer column absolutely from the float, which is
   * rare and happens under the wallet lock.
   *
   * A debit that may not go negative is a CONDITIONAL update: it applies only if
   * the balance still covers it, so the check and the spend cannot be separated.
   */
  private async move(tx: any, wallet: WalletRow, delta: number, currency: string, guard: boolean) {
    const clean = !isDrifted(wallet);
    const exact = readsFromMinor() && clean;
    const data = clean
      ? { balance: { increment: delta }, balanceMinor: { increment: toMinor(delta, currency) } }
      : { balance: { increment: delta }, balanceMinor: toMinor(wallet.balance + delta, currency) };

    let updated: any;
    if (guard) {
      const need = -delta; // a positive amount
      const { count } = await tx.wallet.updateMany({
        where: { id: wallet.id, ...(exact ? { balanceMinor: { gte: toMinor(need, currency) } } : { balance: { gte: need } }) },
        data,
      });
      if (count === 0) {
        const now = await tx.wallet.findUnique({ where: { id: wallet.id } });
        throw new Error(
          `Insufficient balance: ${now ? walletBalance(now) : 0} ${currency} available, ${need} ${currency} requested`
        );
      }
      updated = await tx.wallet.findUnique({ where: { id: wallet.id } });
    } else {
      updated = await tx.wallet.update({ where: { id: wallet.id }, data });
    }
    return {
      updated,
      runningBalance: exact ? fromMinor(updated.balanceMinor, currency) : (updated.balance as number),
      runningBalanceMinor: updated.balanceMinor as bigint,
    };
  }

  /**
   * One posting, inside a transaction the caller owns. Returns `replayed: true`
   * when its idempotency key was already used by the same posting.
   */
  private async post(tx: any, p: Posting, key: string | undefined) {
    if (key) {
      const prior = await tx.ledgerEntry.findUnique({ where: { idempotencyKey: key } });
      if (prior) {
        const wallet = await tx.wallet.findUnique({ where: { id: prior.walletId } });
        this.assertSamePosting(prior, wallet, p);
        return { wallet, entry: prior, replayed: true };
      }
    }

    const existing = (await tx.wallet.findUnique({
      where: { userId_currency: { userId: p.userId, currency: p.currency } },
    })) as WalletRow | null;

    let wallet: any;
    let runningBalance: number;
    let runningBalanceMinor: bigint;

    if (p.direction === "credit") {
      if (!existing) {
        wallet = await tx.wallet.create({
          data: { userId: p.userId, currency: p.currency, balance: p.amount, balanceMinor: toMinor(p.amount, p.currency) },
        });
        runningBalance = wallet.balance;
        runningBalanceMinor = wallet.balanceMinor;
      } else {
        const moved = await this.move(tx, existing, p.amount, p.currency, false);
        wallet = moved.updated;
        runningBalance = moved.runningBalance;
        runningBalanceMinor = moved.runningBalanceMinor;
      }
    } else {
      if (!existing) {
        throw new Error(`Insufficient balance: no ${p.currency} wallet for user ${p.userId}`);
      }
      const moved = await this.move(tx, existing, -p.amount, p.currency, !p.allowNegative);
      wallet = moved.updated;
      runningBalance = moved.runningBalance;
      runningBalanceMinor = moved.runningBalanceMinor;
    }

    const entry = await tx.ledgerEntry.create({
      data: {
        walletId: wallet.id,
        direction: p.direction,
        amount: p.amount,
        amountMinor: toMinor(p.amount, p.currency),
        currency: p.currency,
        runningBalance,
        runningBalanceMinor,
        reference: p.reference,
        description: p.description,
        metadata: (p.metadata ?? {}) as any,
        ...(key ? { idempotencyKey: key } : {}),
      },
    });

    logger.info(p.direction === "credit" ? "Ledger credited" : "Ledger debited", {
      walletId: wallet.id,
      userId: p.userId,
      amount: p.amount,
      currency: p.currency,
      reference: p.reference,
      runningBalance,
    });
    return { wallet, entry, replayed: false };
  }

  /**
   * Run a transaction, retrying when a race on a unique value made it fail:
   *   - the same idempotency key won (so this call is a retry of it): replay it;
   *   - two first credits both tried to create the wallet: try again, it exists now.
   */
  private async run<T>(work: (tx: any) => Promise<T>, onKeyRace?: () => Promise<T | null>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        return (await (prisma as any).$transaction(work)) as T;
      } catch (error) {
        lastError = error;
        if (!isUnique(error)) throw error;
        // The whole transaction rolled back. If another call already recorded this key, return that result.
        const replay = onKeyRace ? await onKeyRace() : null;
        if (replay) return replay;
      }
    }
    throw lastError;
  }

  /**
   * Get or create a wallet for a user in a given currency.
   */
  async getOrCreateWallet(userId: string, currency = "RWF") {
    let wallet = await prisma.wallet.findUnique({
      where: { userId_currency: { userId, currency } },
    });

    if (!wallet) {
      try {
        wallet = await prisma.wallet.create({ data: { userId, currency, balance: 0 } });
        logger.info("Wallet created", { walletId: wallet.id, userId, currency });
      } catch (error) {
        if (!isUnique(error)) throw error;
        wallet = await prisma.wallet.findUnique({ where: { userId_currency: { userId, currency } } });
        if (!wallet) throw error;
      }
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

  private async single(p: Posting) {
    if (p.amount <= 0) throw new Error(`${p.direction === "credit" ? "Credit" : "Debit"} amount must be greater than zero`);
    const key = LedgerService.legKey(p.idempotencyKey);
    const lock = await this.acquireWalletLock(p.userId, p.currency, 10);
    try {
      const result = await this.run(
        (tx) => this.post(tx, p, key),
        key
          ? async () => {
              // Lost a race on the key: the winner's entry is the answer to this retry.
              const prior = await prisma.ledgerEntry.findUnique({ where: { idempotencyKey: key } });
              if (!prior) return null;
              const wallet = await prisma.wallet.findUnique({ where: { id: prior.walletId } });
              this.assertSamePosting(prior, wallet as WalletRow | null, p);
              return { wallet, entry: prior, replayed: true } as any;
            }
          : undefined
      );
      return { wallet: result.wallet, entry: result.entry };
    } finally {
      await lock.release();
    }
  }

  /**
   * Credit a user's wallet. With an idempotencyKey it happens at most once.
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
    const { currency = "RWF", ...rest } = params;
    return this.single({ direction: "credit", currency, ...rest });
  }

  /**
   * Debit a user's wallet. Throws if the balance does not cover it (unless
   * allowNegative). With an idempotencyKey it happens at most once.
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
    const { currency = "RWF", ...rest } = params;
    return this.single({ direction: "debit", currency, ...rest });
  }

  /**
   * Move funds between two users' wallets (internal transfer): one transaction,
   * both legs or neither. With an idempotencyKey it happens at most once.
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

    if (fromUserId === toUserId) throw new Error("Cannot transfer to the same user");
    if (amount <= 0) throw new Error("Transfer amount must be greater than zero");

    const debitKey = LedgerService.legKey(idempotencyKey, "debit");
    const creditKey = LedgerService.legKey(idempotencyKey, "credit");
    const debitP: Posting = {
      direction: "debit", userId: fromUserId, amount, currency, reference,
      description: description || `Transfer to ${toUserId}`, metadata: { toUserId },
    };
    const creditP: Posting = {
      direction: "credit", userId: toUserId, amount, currency, reference,
      description: description || `Transfer from ${fromUserId}`, metadata: { fromUserId },
    };

    // Locks in a fixed order so two opposite transfers cannot wait on each other.
    const order = [fromUserId, toUserId].sort();
    const locks = [] as Array<{ release: () => Promise<void> }>;
    try {
      for (const u of order) locks.push(await this.acquireWalletLock(u, currency, 10));

      const result = await this.run(
        async (tx) => {
          // Update the two wallets in a fixed order so two opposite transfers cannot deadlock the database.
          const first = order[0] === fromUserId ? "debit" : "credit";
          const legs: Record<string, any> = {};
          for (const leg of first === "debit" ? (["debit", "credit"] as const) : (["credit", "debit"] as const)) {
            legs[leg] = await this.post(tx, leg === "debit" ? debitP : creditP, leg === "debit" ? debitKey : creditKey);
          }
          return { debit: legs.debit, credit: legs.credit };
        },
        debitKey
          ? async () => {
              const [d, c] = await Promise.all([
                prisma.ledgerEntry.findUnique({ where: { idempotencyKey: debitKey } }),
                prisma.ledgerEntry.findUnique({ where: { idempotencyKey: creditKey! } }),
              ]);
              if (!d || !c) return null;
              const [dw, cw] = await Promise.all([
                prisma.wallet.findUnique({ where: { id: d.walletId } }),
                prisma.wallet.findUnique({ where: { id: c.walletId } }),
              ]);
              this.assertSamePosting(d, dw as WalletRow | null, debitP);
              return { debit: { wallet: dw, entry: d, replayed: true }, credit: { wallet: cw, entry: c, replayed: true } } as any;
            }
          : undefined
      );

      logger.info("Ledger transfer", { fromUserId, toUserId, amount, currency, reference });
      return {
        fromUserId,
        toUserId,
        amount,
        currency,
        reference,
        debit: { wallet: result.debit.wallet, entry: result.debit.entry },
        credit: { wallet: result.credit.wallet, entry: result.credit.entry },
      };
    } finally {
      for (const l of locks) await l.release();
    }
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
