import { Prisma } from "@prisma/client";
import { prisma } from "@/db/prisma";
import { redis, SESSION_TTL_SECONDS, sessionKey, sessionTtlForState } from "@/services/redis";
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
      const ttl = sessionTtlForState(state);
      await redis!.setex(sessionKey(userId), ttl, JSON.stringify(data));
      return;
    } catch (error: any) {
      logger.error("Redis updateSession failed, falling back to DB", { userId, error: error.message });
    }
  }

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

export async function resetSession(userId: string) {
  return updateSession(userId, "idle", {});
}
