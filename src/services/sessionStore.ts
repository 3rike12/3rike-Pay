import { Prisma } from "@prisma/client";
import { prisma } from "@/db/prisma";
import { redis, SESSION_TTL_SECONDS, sessionKey } from "@/services/redis";
import { createLogger } from "@/utils/logger";

const logger = createLogger("session-store");

interface SessionData {
  state: string;
  flowData: Record<string, unknown>;
  lastActivity: string;
}

function isRedisEnabled(): boolean {
  return redis !== null;
}

async function writeDbSession(userId: string, state: string, flowData?: Record<string, unknown>) {
  const session = await prisma.userSession.findFirst({
    where: { userId },
    orderBy: { updatedAt: "desc" },
  });

  if (session) {
    await prisma.userSession.update({
      where: { id: session.id },
      data: {
        state,
        flowData: (flowData ?? session.flowData) as Prisma.InputJsonValue,
        lastActivity: new Date(),
      },
    });
  } else {
    await prisma.userSession.create({
      data: { userId, state, flowData: (flowData ?? {}) as Prisma.InputJsonValue },
    });
  }
}

export async function getSession(userId: string) {
  if (isRedisEnabled()) {
    try {
      const raw = await redis!.get(sessionKey(userId));
      if (raw) {
        const parsed = JSON.parse(raw) as SessionData;
        return {
          id: userId,
          userId,
          state: parsed.state,
          flowData: parsed.flowData,
          lastActivity: new Date(parsed.lastActivity),
          createdAt: new Date(parsed.lastActivity),
          updatedAt: new Date(parsed.lastActivity),
        };
      }
    } catch (error: any) {
      logger.error("Redis getSession failed, falling back to DB", { userId, error: error.message });
    }
  }

  let session = await prisma.userSession.findFirst({
    where: { userId },
    orderBy: { updatedAt: "desc" },
  });

  if (!session) {
    session = await prisma.userSession.create({
      data: { userId, state: "idle", flowData: Prisma.JsonNull },
    });
  }

  return session;
}

export async function updateSession(
  userId: string,
  state: string,
  flowData?: Record<string, unknown>
) {
  const data: SessionData = {
    state,
    flowData: flowData ?? {},
    lastActivity: new Date().toISOString(),
  };

  if (isRedisEnabled()) {
    try {
      await redis!.setex(sessionKey(userId), SESSION_TTL_SECONDS, JSON.stringify(data));
    } catch (error: any) {
      logger.error("Redis updateSession failed", { userId, error: error.message });
    }
  }

  // Always persist to the DB too so pending transfers and state survive Redis TTL/expiry.
  try {
    await writeDbSession(userId, state, flowData);
  } catch (error: any) {
    logger.error("DB updateSession failed", { userId, error: error.message });
    if (!isRedisEnabled()) throw error;
  }
}

export async function resetSession(userId: string) {
  return updateSession(userId, "idle", {});
}
