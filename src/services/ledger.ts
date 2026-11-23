import { prisma } from "@/db/prisma";
import { acquireLock } from "@/utils/idempotency";
import { createLogger } from "@/utils/logger";
import { fromMinor, toMinor } from "@/utils/money";
import { isDrifted, readsFromMinor, walletBalance } from "@/utils/walletBalance";

const logger = createLogger("ledger");

// ============================================
// Internal Ledger Service: double-entry
//
// Every movement of money is a JOURNAL: two or more entries that balance (debits
// equal credits) in each currency. Money is never created or lost by a posting: it
// only moves between accounts. An account is a Wallet row:
//
//   - a USER wallet is what we owe a person;
//   - a SYSTEM wallet is a counter-account (money from outside, foreign-exchange
//     clearing, fees, ...).
//
// Every account's balance is credits minus debits, so a user who is owed 100 has
// +100 and the account that represents "money came in from outside" has -100. The
// invariant that follows is the one worth checking: ALL balances in a currency add
// up to exactly zero, forever. (See ledgerVerify.)
//
// The DATABASE keeps this correct, not a cache or a lock:
//   * A journal with an idempotency key exists at most once, enforced by a unique
//     column written in the same transaction as the balance changes. A retry
//     returns the original; a key reused for something different is an error.
//   * A journal is all-or-nothing: if any line fails, none of it happened.
//   * A user's balance can never go below zero: a debit is a conditional update.
//   * Balances move by atomic increments, never by a value computed from a read.
//   * Lines are applied in a fixed order, so two journals cannot deadlock.
// A Redis wallet lock is still taken when Redis exists, only to reduce contention.
//
// `credit`, `debit` and `transfer` keep their signatures and build journals for
// you (against a counter-account); `post` takes any balanced set of lines.
// ============================================

export interface JournalLine {
  userId: string;
  currency: string;
  direction: "credit" | "debit";
  amount: number;
  /** A counter-account, not a person: it may go negative, and is not a liability to anyone. */
  system?: boolean;
  /** Let a USER account go below zero on this line (a bookkeeping fee already owed). */
  allowNegative?: boolean;
}

export interface JournalInput {
  reference: string;
  description?: string;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
  lines: JournalLine[];
}

export interface PostedJournal {
  journalId: string;
  /** One per line, in the order the lines were given. */
  entries: any[];
  wallets: any[];
  replayed: boolean;
}

/**
 * The counter-accounts the facade uses, written @name. `@world_in` is money arriving from outside
 * and `@world_out` is money leaving to accounts we do not own; `@external` is the older shared
 * account and still reads as before.
 *
 * The counter-accounts the facade uses. A flow may name its own (fees, stock clearing, ...). */
export const SYSTEM_ACCOUNTS = { worldIn: "world_in", worldOut: "world_out", external: "external", opening: "opening", fxClearing: "fx_clearing", fees: "fees", stockClearing: "stock_clearing" } as const;

/** Counter-accounts are spread over this many rows per account, so no single row serialises every posting. */
const SHARDS = 8;

const isUnique = (e: unknown) => (e as { code?: string } | null)?.code === "P2002";
const MAX_ATTEMPTS = 3;

/** A small stable hash, so the same person always lands on the same shard. */
function shardOf(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return (h >>> 0) % SHARDS;
}

const systemUsers = new Map<string, string>();

/** The reserved user that owns a counter-account. Created on first use. */
async function systemUserId(phone: string): Promise<string> {
  const known = systemUsers.get(phone);
  if (known) return known;
  const p = prisma as any;
  let user = await p.user.findUnique({ where: { phone } });
  if (!user) {
    try {
      user = await p.user.create({ data: { phone, name: phone } });
    } catch (error) {
      if (!isUnique(error)) throw error;
      user = await p.user.findUnique({ where: { phone } }); // lost a first-boot race
    }
  }
  systemUsers.set(phone, user.id);
  return user.id;
}

/** Test hook: forget remembered system users (a fresh database has different ids). */
export function resetSystemUserCache() {
  systemUsers.clear();
}

interface WalletRow {
  id: string;
  userId: string;
  currency: string;
  balance: number;
  balanceMinor: bigint;
  kind: string;
}

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

  /**
   * Round every line to its currency's minor unit. The float balance and the integer balance
   * are both moved by this amount, so they can never drift apart on an amount like 20.3 / 130
   * (0.156153...), where the float would otherwise keep the extra digits the integer drops.
   */
  private normalise(lines: JournalLine[]): JournalLine[] {
    return lines.map((l) => (Number.isFinite(l.amount) && l.amount > 0 && l.currency ? { ...l, amount: fromMinor(toMinor(l.amount, l.currency), l.currency) } : l));
  }

  /** Reject anything that is not a well-formed, balanced set of lines. Nothing is written. */
  private validate(lines: JournalLine[]) {
    if (!Array.isArray(lines) || lines.length < 2) throw new Error("A journal needs at least two lines");
    const net = new Map<string, bigint>();
    for (const l of lines) {
      if (!l.userId || !l.currency) throw new Error("Every journal line needs an account and a currency");
      if (l.direction !== "credit" && l.direction !== "debit") throw new Error("Every journal line is a credit or a debit");
      if (!Number.isFinite(l.amount) || l.amount <= 0) throw new Error("Every journal line amount must be greater than zero");
      const minor = toMinor(l.amount, l.currency);
      if (minor <= 0n) throw new Error(`${l.amount} ${l.currency} is too small to record`);
      net.set(l.currency, (net.get(l.currency) ?? 0n) + (l.direction === "credit" ? minor : -minor));
    }
    for (const [currency, n] of net) {
      if (n !== 0n) throw new Error(`Journal does not balance in ${currency}: credits and debits differ by ${n}`);
    }
  }

  /**
   * Move a wallet by `delta` (negative for a debit) and report the balance right
   * after, as read back from the row that was updated. Atomic increments on both
   * columns, so concurrent postings cannot overwrite each other. A wallet whose two
   * columns disagree (one that predates the integer column) is healed by writing the
   * integer column absolutely from the float. A user debit that may not go negative
   * is a CONDITIONAL update: it applies only if the balance still covers it.
   */
  private async move(tx: any, wallet: WalletRow, delta: number, currency: string, guard: boolean) {
    const clean = !isDrifted(wallet);
    const exact = readsFromMinor() && clean;
    const data = clean
      ? { balance: { increment: delta }, balanceMinor: { increment: toMinor(delta, currency) } }
      : { balance: { increment: delta }, balanceMinor: toMinor(wallet.balance + delta, currency) };

    let updated: any;
    if (guard) {
      const need = -delta;
      const { count } = await tx.wallet.updateMany({
        where: { id: wallet.id, ...(exact ? { balanceMinor: { gte: toMinor(need, currency) } } : { balance: { gte: need } }) },
        data,
      });
      if (count === 0) {
        const now = await tx.wallet.findUnique({ where: { id: wallet.id } });
        throw new Error(`Insufficient balance: ${now ? walletBalance(now) : 0} ${currency} available, ${need} ${currency} requested`);
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

  /** What a set of lines looks like, for telling a replay from a different journal under the same key. */
  private static signature(parts: Array<{ userId: string; currency: string; direction: string; minor: bigint }>): string {
    return parts.map((p) => `${p.userId}|${p.currency}|${p.direction}|${p.minor}`).sort().join(";");
  }

  /** The journal already recorded under `key`, as a result, if it is the same journal. Throws if it is a different one. */
  private async existing(tx: any, key: string, input: JournalInput, lines: JournalLine[]): Promise<PostedJournal | null> {
    const journal = await tx.journal.findUnique({ where: { idempotencyKey: key } });
    if (!journal) return null;
    const entries = await tx.ledgerEntry.findMany({ where: { journalId: journal.id } });
    const wallets: any[] = [];
    for (const e of entries) wallets.push(await tx.wallet.findUnique({ where: { id: e.walletId } }));
    const recorded = LedgerService.signature(entries.map((e: any, i: number) => ({ userId: wallets[i].userId, currency: e.currency, direction: e.direction, minor: e.amountMinor })));
    const asked = LedgerService.signature(lines.map((l) => ({ userId: l.userId, currency: l.currency, direction: l.direction, minor: toMinor(l.amount, l.currency) })));
    if (journal.reference !== input.reference || recorded !== asked) {
      throw new Error(`Idempotency key ${key} was already used for a different posting; refusing to treat this one as a retry`);
    }
    return { journalId: journal.id, entries, wallets, replayed: true };
  }

  /** Write one journal inside a transaction the caller owns. */
  private async write(tx: any, input: JournalInput, lines: JournalLine[], ordered: JournalLine[]): Promise<PostedJournal> {
    if (input.idempotencyKey) {
      const prior = await this.existing(tx, input.idempotencyKey, input, lines);
      if (prior) return prior;
    }

    const journal = await tx.journal.create({
      data: { reference: input.reference, description: input.description, ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}) },
    });

    const results = new Map<JournalLine, { entry: any; wallet: any }>();
    for (const line of ordered) {
      const delta = line.direction === "credit" ? line.amount : -line.amount;
      const existing = (await tx.wallet.findUnique({ where: { userId_currency: { userId: line.userId, currency: line.currency } } })) as WalletRow | null;

      let wallet: any;
      let runningBalance: number;
      let runningBalanceMinor: bigint;
      if (!existing) {
        const isSystem = !!line.system;
        // A debit may only open a wallet at a negative balance if nothing says the account must stay positive.
        if (delta < 0 && !isSystem && !line.allowNegative) throw new Error(`Insufficient balance: no ${line.currency} wallet for user ${line.userId}`);
        wallet = await tx.wallet.create({
          data: { userId: line.userId, currency: line.currency, balance: delta, balanceMinor: toMinor(delta, line.currency), kind: isSystem ? "system" : "user" },
        });
        runningBalance = wallet.balance;
        runningBalanceMinor = wallet.balanceMinor;
      } else {
        const guard = delta < 0 && existing.kind === "user" && !line.system && !line.allowNegative;
        const moved = await this.move(tx, existing, delta, line.currency, guard);
        wallet = moved.updated;
        runningBalance = moved.runningBalance;
        runningBalanceMinor = moved.runningBalanceMinor;
      }

      const entry = await tx.ledgerEntry.create({
        data: {
          walletId: wallet.id,
          journalId: journal.id,
          direction: line.direction,
          amount: line.amount,
          amountMinor: toMinor(line.amount, line.currency),
          currency: line.currency,
          runningBalance,
          runningBalanceMinor,
          reference: input.reference,
          description: input.description,
          metadata: (input.metadata ?? {}) as any,
        },
      });
      results.set(line, { entry, wallet });
    }

    logger.info("Journal posted", { journalId: journal.id, reference: input.reference, lines: lines.length });
    return {
      journalId: journal.id,
      entries: lines.map((l) => results.get(l)!.entry),
      wallets: lines.map((l) => results.get(l)!.wallet),
      replayed: false,
    };
  }

  /**
   * Post a balanced journal: all of its lines, or none. With an idempotencyKey it
   * happens at most once. This is the one way money moves.
   */
  async post(input: JournalInput): Promise<PostedJournal> {
    const lines = this.normalise(input.lines);
    this.validate(lines);
    // A fixed order, so two journals touching the same accounts cannot wait on each other.
    const ordered = [...lines].sort((a, b) => `${a.currency}/${a.userId}/${a.direction}`.localeCompare(`${b.currency}/${b.userId}/${b.direction}`));

    const locks: Array<{ release: () => Promise<void> }> = [];
    try {
      const people = [...new Set(ordered.filter((l) => !l.system).map((l) => `${l.userId}\u0000${l.currency}`))].sort();
      for (const p of people) {
        const [userId, currency] = p.split("\u0000");
        locks.push(await this.acquireWalletLock(userId, currency, 10));
      }

      let lastError: unknown;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        try {
          return (await (prisma as any).$transaction((tx: any) => this.write(tx, input, lines, ordered))) as PostedJournal;
        } catch (error) {
          lastError = error;
          if (!isUnique(error)) throw error;
          // Everything rolled back. If another call already recorded this key, its journal is our answer;
          // otherwise two first postings raced to create a wallet, and the retry finds it.
          if (input.idempotencyKey) {
            const replay = await this.existing(prisma as any, input.idempotencyKey, input, lines);
            if (replay) return replay;
          }
        }
      }
      throw lastError;
    } finally {
      for (const l of locks) await l.release();
    }
  }

  /** The counter-account for a posting against `userId`, spread over shards. */
  private async counterFor(code: string, userId: string): Promise<string> {
    // "@world_out" and "world_out" are the same account.
    return systemUserId(`system:${code.replace(/^@/, "")}:${shardOf(userId)}`);
  }

  /**
   * Get or create a wallet for a user in a given currency.
   */
  async getOrCreateWallet(userId: string, currency = "RWF") {
    let wallet = await prisma.wallet.findUnique({ where: { userId_currency: { userId, currency } } });
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

  private async single(p: {
    direction: "credit" | "debit";
    userId: string;
    amount: number;
    currency: string;
    reference: string;
    description?: string;
    metadata?: Record<string, unknown>;
    idempotencyKey?: string;
    allowNegative?: boolean;
    system?: boolean;
    counter?: string;
  }) {
    if (!Number.isFinite(p.amount) || p.amount <= 0) {
      throw new Error(`${p.direction === "credit" ? "Credit" : "Debit"} amount must be greater than zero`);
    }
    // Money arriving from outside comes from @world_in; money leaving goes to @world_out (accounts we do not own).
    const counterUser = await this.counterFor(p.counter ?? (p.direction === "credit" ? SYSTEM_ACCOUNTS.worldIn : SYSTEM_ACCOUNTS.worldOut), p.userId);
    const opposite = p.direction === "credit" ? "debit" : "credit";
    const user: JournalLine = { userId: p.userId, currency: p.currency, direction: p.direction, amount: p.amount, system: p.system, allowNegative: p.allowNegative };
    const counter: JournalLine = { userId: counterUser, currency: p.currency, direction: opposite, amount: p.amount, system: true };
    const posted = await this.post({
      reference: p.reference,
      description: p.description,
      metadata: p.metadata,
      idempotencyKey: p.idempotencyKey,
      lines: [user, counter],
    });
    return { wallet: posted.wallets[0], entry: posted.entries[0], journalId: posted.journalId };
  }

  /**
   * Credit a user's wallet, against a counter-account (money arriving from outside
   * unless `counter` names another). With an idempotencyKey it happens at most once.
   */
  async credit(params: {
    userId: string;
    amount: number;
    currency?: string;
    reference: string;
    description?: string;
    metadata?: Record<string, unknown>;
    idempotencyKey?: string;
    /** The account on the other side. Defaults to money coming in from outside. */
    counter?: string;
    /** This account is the platform's own, not a person's. */
    system?: boolean;
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
    counter?: string;
    system?: boolean;
  }) {
    const { currency = "RWF", ...rest } = params;
    return this.single({ direction: "debit", currency, ...rest });
  }

  /**
   * Move funds between two users' wallets (internal transfer): one journal, both
   * lines or neither. With an idempotencyKey it happens at most once.
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
    if (!Number.isFinite(amount) || amount <= 0) throw new Error("Transfer amount must be greater than zero");

    const posted = await this.post({
      reference,
      description: description || `Transfer ${fromUserId} to ${toUserId}`,
      metadata: { fromUserId, toUserId },
      idempotencyKey,
      lines: [
        { userId: fromUserId, currency, direction: "debit", amount },
        { userId: toUserId, currency, direction: "credit", amount },
      ],
    });
    logger.info("Ledger transfer", { fromUserId, toUserId, amount, currency, reference });
    return {
      fromUserId,
      toUserId,
      amount,
      currency,
      reference,
      debit: { wallet: posted.wallets[0], entry: posted.entries[0] },
      credit: { wallet: posted.wallets[1], entry: posted.entries[1] },
    };
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
