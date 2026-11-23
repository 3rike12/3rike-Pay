import { redis as sharedRedis } from "@/services/redis";
import { createLogger } from "@/utils/logger";

const logger = createLogger("daily-limit");

// ============================================
// A per-person daily allowance
//
// Used to cap how many questions one person can put to the research assistant, so a
// single user (or a script) cannot spend all of your model credits. The day is the
// UTC day. Shared across instances through Redis when it exists; otherwise counted
// in memory on this instance, which is stricter per instance than needed but never
// lets anyone through unlimited.
// ============================================

export interface DailyLimiter {
  /** Count one use for this person. True if they are still within today's allowance. */
  allow(userId: string): Promise<boolean>;
}

interface RedisLike {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
}

export function createDailyLimiter(limit: number, options: { name?: string; now?: () => Date; redis?: RedisLike | null } = {}): DailyLimiter {
  const name = options.name ?? "default";
  const now = options.now ?? (() => new Date());
  const store = options.redis === undefined ? (sharedRedis as unknown as RedisLike | null) : options.redis;
  const memory = new Map<string, number>();

  return {
    async allow(userId) {
      if (!Number.isFinite(limit) || limit <= 0) return false;
      const day = now().toISOString().slice(0, 10);
      const key = `limit:${name}:${userId}:${day}`;

      if (store) {
        try {
          const n = await store.incr(key);
          if (n === 1) await store.expire(key, 25 * 3600);
          return n <= limit;
        } catch (error: any) {
          logger.warn("Limit store failed; counting in memory", { error: error?.message });
        }
      }
      for (const k of memory.keys()) if (!k.endsWith(day)) memory.delete(k); // forget earlier days
      const n = (memory.get(key) ?? 0) + 1;
      memory.set(key, n);
      return n <= limit;
    },
  };
}
