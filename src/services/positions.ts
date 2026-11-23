import { prisma } from "@/db/prisma";
import { createLogger } from "@/utils/logger";

const logger = createLogger("positions");

// ============================================
// Stock positions ledger
//
// The treasury holds the stock tokens in one wallet. This ledger says how much
// of each token belongs to each user, in RAW token units (the token's own
// decimals) as whole numbers: never a float, never a percentage. A percentage
// would have to be rewritten every time anyone else trades; units change only
// when that user trades, and a share of the pool is just units / total.
//
// It follows the same rules as the money ledger, because the same things go
// wrong:
//   - A posting with an idempotency key happens at most once, enforced by a
//     unique column written in the same transaction as the change. A retry
//     returns the original; a key reused for something different is an error.
//   - A debit is a conditional update ("only if units >= amount"), so two
//     simultaneous sales cannot sell the same tokens, and nobody can sell what
//     they do not hold.
//   - Units move by atomic increment, never by a value computed from an earlier
//     read, so concurrent postings cannot overwrite each other.
//   - A position changes only together with the entry that explains it, in one
//     transaction: a crash between the two undoes both.
//
// Dividends and splits change a token's multiplier, not anyone's raw units, so
// positions stay correct through corporate actions with no rewrite.
// ============================================

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const isUnique = (e: unknown) => (e as { code?: string } | null)?.code === "P2002";
const MAX_ATTEMPTS = 3;

type Direction = "credit" | "debit";

interface PostingInput {
  userId: string;
  tokenAddress: string;
  units: bigint;
  reference: string;
  description?: string;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
}

interface Posting extends PostingInput {
  direction: Direction;
}

export interface PositionRow {
  id: string;
  userId: string;
  tokenAddress: string;
  units: bigint;
}

function normalise(p: PostingInput): PostingInput {
  if (typeof p.units !== "bigint") throw new Error("Units must be a bigint: a JS number can silently lose precision");
  if (p.units <= 0n) throw new Error("Units must be greater than zero");
  if (typeof p.tokenAddress !== "string" || !ADDRESS_RE.test(p.tokenAddress)) {
    throw new Error("Not a valid token address");
  }
  return { ...p, tokenAddress: p.tokenAddress.toLowerCase() };
}

export class PositionLedger {
  /** The same posting seen again? A different posting under the same key is a caller bug and must be loud. */
  private assertSame(prior: any, position: PositionRow | null, p: Posting) {
    const same =
      position &&
      position.userId === p.userId &&
      position.tokenAddress === p.tokenAddress &&
      prior.direction === p.direction &&
      prior.units === p.units &&
      prior.reference === p.reference;
    if (!same) {
      throw new Error(
        `Idempotency key ${p.idempotencyKey} was already used for a different posting; refusing to treat this one as a retry`
      );
    }
  }

  private async post(tx: any, p: Posting) {
    if (p.idempotencyKey) {
      const prior = await tx.positionEntry.findUnique({ where: { idempotencyKey: p.idempotencyKey } });
      if (prior) {
        const position = await tx.stockPosition.findUnique({ where: { id: prior.positionId } });
        this.assertSame(prior, position, p);
        return { position, entry: prior, replayed: true };
      }
    }

    const existing = (await tx.stockPosition.findUnique({
      where: { userId_tokenAddress: { userId: p.userId, tokenAddress: p.tokenAddress } },
    })) as PositionRow | null;

    let position: any;
    if (p.direction === "credit") {
      position = existing
        ? await tx.stockPosition.update({ where: { id: existing.id }, data: { units: { increment: p.units } } })
        : await tx.stockPosition.create({ data: { userId: p.userId, tokenAddress: p.tokenAddress, units: p.units } });
    } else {
      if (!existing) throw new Error(`Insufficient units: none of ${p.tokenAddress} held`);
      // The check and the spend are one statement: they cannot be separated by another caller.
      const { count } = await tx.stockPosition.updateMany({
        where: { id: existing.id, units: { gte: p.units } },
        data: { units: { decrement: p.units } },
      });
      if (count === 0) {
        const now = await tx.stockPosition.findUnique({ where: { id: existing.id } });
        throw new Error(`Insufficient units: ${now?.units ?? 0n} held, ${p.units} requested`);
      }
      position = await tx.stockPosition.findUnique({ where: { id: existing.id } });
    }

    const entry = await tx.positionEntry.create({
      data: {
        positionId: position.id,
        direction: p.direction,
        units: p.units,
        runningUnits: position.units,
        reference: p.reference,
        description: p.description,
        metadata: (p.metadata ?? {}) as any,
        ...(p.idempotencyKey ? { idempotencyKey: p.idempotencyKey } : {}),
      },
    });

    // Never log a bigint with JSON.stringify: it throws. Strings only.
    logger.info(p.direction === "credit" ? "Position credited" : "Position debited", {
      userId: p.userId,
      tokenAddress: p.tokenAddress,
      units: p.units.toString(),
      reference: p.reference,
      holding: position.units.toString(),
    });
    return { position, entry, replayed: false };
  }

  private async run(input: PostingInput, direction: Direction) {
    const p: Posting = { ...normalise(input), direction };
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const r = await (prisma as any).$transaction((tx: any) => this.post(tx, p));
        return { position: r.position as PositionRow, entry: r.entry };
      } catch (error) {
        lastError = error;
        if (!isUnique(error)) throw error;
        // Everything rolled back. If another call already recorded this key, its result is our answer.
        if (p.idempotencyKey) {
          const prior = await prisma.positionEntry.findUnique({ where: { idempotencyKey: p.idempotencyKey } });
          if (prior) {
            const position = await prisma.stockPosition.findUnique({ where: { id: prior.positionId } });
            this.assertSame(prior, position as PositionRow | null, p);
            return { position: position as PositionRow, entry: prior };
          }
        }
        // Otherwise two first credits raced to create the position: try again, it exists now.
      }
    }
    throw lastError;
  }

  /** Add units to a user's position. With an idempotencyKey it happens at most once. */
  credit(input: PostingInput) {
    return this.run(input, "credit");
  }

  /** Remove units. Refused if the user does not hold that many. With an idempotencyKey it happens at most once. */
  debit(input: PostingInput) {
    return this.run(input, "debit");
  }

  /** Units of a token a user holds; 0 if none. */
  async get(userId: string, tokenAddress: string): Promise<bigint> {
    if (!ADDRESS_RE.test(tokenAddress)) return 0n;
    const p = await prisma.stockPosition.findUnique({
      where: { userId_tokenAddress: { userId, tokenAddress: tokenAddress.toLowerCase() } },
    });
    return p?.units ?? 0n;
  }

  /** What a user holds, skipping tokens sold down to zero. */
  async list(userId: string): Promise<PositionRow[]> {
    return (await prisma.stockPosition.findMany({ where: { userId, units: { gt: 0n } } })) as PositionRow[];
  }

  /** Everyone who holds some of a token. */
  async holders(tokenAddress: string): Promise<Array<{ userId: string; units: bigint }>> {
    if (!ADDRESS_RE.test(tokenAddress)) return [];
    const rows = await prisma.stockPosition.findMany({ where: { tokenAddress: tokenAddress.toLowerCase(), units: { gt: 0n } } });
    return rows.map((r) => ({ userId: r.userId, units: r.units }));
  }

  /** What every user owns of each token together: what the treasury must hold. */
  async totals(): Promise<Array<{ tokenAddress: string; units: bigint }>> {
    const rows = await prisma.stockPosition.groupBy({ by: ["tokenAddress"], _sum: { units: true } });
    return rows.map((r) => ({ tokenAddress: r.tokenAddress, units: r._sum.units ?? 0n }));
  }
}

export const positions = new PositionLedger();
