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

export const SESSION_TTL_SECONDS = 60 * 60 * 24; // fallback / idle
export const KYC_SESSION_TTL_SECONDS = 30 * 60; // 30 minutes
export const TRANSFER_SESSION_TTL_SECONDS = 10 * 60; // 10 minutes
export const SESSION_KEY_PREFIX = "3rike:session:";

export function sessionKey(userId: string): string {
  return `${SESSION_KEY_PREFIX}${userId}`;
}

export function sessionTtlForState(state: string): number {
  if (state === "kyc_flow") return KYC_SESSION_TTL_SECONDS;
  if (["confirm_transfer", "send_money", "select_bank", "enter_account"].includes(state)) return TRANSFER_SESSION_TTL_SECONDS;
  return SESSION_TTL_SECONDS;
}
