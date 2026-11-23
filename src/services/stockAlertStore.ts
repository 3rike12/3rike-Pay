import { prisma } from "@/db/prisma";
import type { AlertStore, Snapshot } from "@/services/stockAlerts";

const db = () => prisma as any;
const isUnique = (e: unknown) => (e as { code?: string } | null)?.code === "P2002";

/** The alert tables behind the small interface the alert runner needs. */
export const prismaAlertStore: AlertStore & { optOut(userId: string): Promise<void>; optIn(userId: string): Promise<void> } = {
  async getSnapshot(tokenAddress) {
    return ((await db().stockSnapshot.findUnique({ where: { tokenAddress } })) as Snapshot | null) ?? null;
  },
  async saveSnapshot(s) {
    const { tokenAddress, ...data } = s;
    await db().stockSnapshot.upsert({ where: { tokenAddress }, create: s, update: data });
  },
  async claim(key, userId, kind) {
    try {
      await db().stockAlert.create({ data: { key, userId, kind } });
      return true;
    } catch (error) {
      if (isUnique(error)) return false;
      throw error;
    }
  },
  async release(key) {
    await db().stockAlert.deleteMany({ where: { key } });
  },
  async isOptedOut(userId) {
    return !!(await db().stockAlertOptOut.findUnique({ where: { userId } }));
  },
  async optOut(userId) {
    await db().stockAlertOptOut.upsert({ where: { userId }, create: { userId }, update: {} });
  },
  async optIn(userId) {
    await db().stockAlertOptOut.deleteMany({ where: { userId } });
  },
};
