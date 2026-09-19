import Redis from "ioredis";
import { config } from "@/config";
import { createLogger } from "@/utils/logger";

const logger = createLogger("redis");

export const redis = config.redis.url ? new Redis(config.redis.url) : null;

if (redis) {
  redis.on("error", (err) => {
    logger.error("Redis error", { error: err.message });
  });
}

export const SESSION_TTL_SECONDS = 60 * 60 * 24; // 24 hours
export const SESSION_KEY_PREFIX = "3rike:session:";

export function sessionKey(userId: string): string {
  return `${SESSION_KEY_PREFIX}${userId}`;
}
