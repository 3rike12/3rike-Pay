import { redis } from "@/services/redis";
import { createLogger } from "@/utils/logger";

const logger = createLogger("idempotency");

const DEFAULT_LOCK_TTL_SECONDS = 30;
const DEFAULT_RESULT_TTL_SECONDS = 24 * 60 * 60; // 24 hours

function lockKey(key: string): string {
  return `idempotency:lock:${key}`;
}

function resultKey(key: string): string {
  return `idempotency:result:${key}`;
}

/**
 * Acquire a Redis-backed distributed lock.
 * Returns a release function, or null if the lock is already held.
 */
export async function acquireLock(key: string, ttlSeconds = DEFAULT_LOCK_TTL_SECONDS) {
  if (!redis) {
    // No Redis means we can't lock; the caller should still proceed.
    return { release: async () => {} };
  }

  const acquired = await redis.set(lockKey(key), "1", "EX", ttlSeconds, "NX");

  if (acquired !== "OK") {
    return null;
  }

  return {
    release: async () => {
      try {
        await redis?.del(lockKey(key));
      } catch (error: any) {
        logger.error("Failed to release lock", { key, error: error.message });
      }
    },
  };
}

/**
 * Check if an idempotency key already has a stored result.
 */
export async function getIdempotencyResult<T = unknown>(key: string): Promise<T | null> {
  if (!redis) return null;

  try {
    const raw = await redis.get(resultKey(key));
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch (error: any) {
    logger.error("Failed to parse idempotency result", { key, error: error.message });
    return null;
  }
}

/**
 * Store the result of an idempotent operation.
 */
export async function setIdempotencyResult<T = unknown>(key: string, result: T, ttlSeconds = DEFAULT_RESULT_TTL_SECONDS) {
  if (!redis) return;

  try {
    await redis.set(resultKey(key), JSON.stringify(result), "EX", ttlSeconds);
  } catch (error: any) {
    logger.error("Failed to store idempotency result", { key, error: error.message });
  }
}

/**
 * Execute a function exactly once for a given idempotency key.
 * If the key has been seen before, the cached result is returned.
 * If another process is currently processing the same key, this throws an error.
 *
 * Note: this is for short-lived operations. The lock is released after the result
 * is stored, so concurrent callers either wait or retry. For long-running work,
 * acquire a lock manually and keep it held until completion.
 */
export async function withIdempotencyKey<T>(
  key: string,
  fn: () => Promise<T>,
  options: { lockTtlSeconds?: number; resultTtlSeconds?: number } = {}
): Promise<T> {
  const { lockTtlSeconds = DEFAULT_LOCK_TTL_SECONDS, resultTtlSeconds = DEFAULT_RESULT_TTL_SECONDS } = options;

  // Fast path: already processed.
  const cached = await getIdempotencyResult<T>(key);
  if (cached !== null) {
    logger.debug("Idempotency cache hit", { key });
    return cached;
  }

  // Acquire lock to prevent duplicate processing.
  const lock = await acquireLock(key, lockTtlSeconds);
  if (!lock) {
    throw new Error(`Idempotency key ${key} is already being processed`);
  }

  try {
    // Double-check inside the lock in case another process just finished.
    const cachedInside = await getIdempotencyResult<T>(key);
    if (cachedInside !== null) {
      return cachedInside;
    }

    const result = await fn();
    await setIdempotencyResult(key, result, resultTtlSeconds);
    return result;
  } finally {
    await lock.release();
  }
}
