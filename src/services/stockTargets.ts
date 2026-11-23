import { prisma } from "@/db/prisma";

const db = () => prisma as any;

// ============================================
// A person's target mix, and the rule that invests a share of each paid invoice.
// Plain storage: nothing here trades.
// ============================================

export interface TargetRow {
  tokenAddress: string;
  percent: number;
}

/** Replace the person's whole target mix in one step. */
export async function setTargets(userId: string, rows: TargetRow[]): Promise<void> {
  await db().$transaction([
    db().stockTarget.deleteMany({ where: { userId } }),
    db().stockTarget.createMany({ data: rows.map((r) => ({ userId, tokenAddress: r.tokenAddress, percent: r.percent })) }),
  ]);
}

export async function getTargets(userId: string): Promise<TargetRow[]> {
  const rows = (await db().stockTarget.findMany({ where: { userId }, orderBy: { percent: "desc" } })) as TargetRow[];
  return rows.map((r) => ({ tokenAddress: r.tokenAddress, percent: r.percent }));
}

export async function clearTargets(userId: string): Promise<number> {
  return (await db().stockTarget.deleteMany({ where: { userId } })).count;
}

/** Everyone who has a target mix, for the daily drift check. */
export async function usersWithTargets(): Promise<string[]> {
  const rows = (await db().stockTarget.findMany({ distinct: ["userId"], select: { userId: true } })) as Array<{ userId: string }>;
  return rows.map((r) => r.userId);
}

export interface SweepRule {
  userId: string;
  percent: number;
  tokenAddress: string | null;
}

export async function setSweep(userId: string, percent: number, tokenAddress: string | null): Promise<void> {
  await db().stockSweep.upsert({ where: { userId }, create: { userId, percent, tokenAddress }, update: { percent, tokenAddress } });
}

export async function getSweep(userId: string): Promise<SweepRule | null> {
  return ((await db().stockSweep.findUnique({ where: { userId } })) as SweepRule | null) ?? null;
}

export async function clearSweep(userId: string): Promise<boolean> {
  return (await db().stockSweep.deleteMany({ where: { userId } })).count > 0;
}
