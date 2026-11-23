import { prisma } from "@/db/prisma";
import type { TradeStore, VenueTradeRow } from "@/services/venues/zeroEx";

/** The trade table, behind the small interface the venue needs. */
export const prismaTradeStore: TradeStore = {
  async find(reference) {
    return ((await (prisma as any).venueTrade.findUnique({ where: { reference } })) as VenueTradeRow | null) ?? null;
  },
  async create(row) {
    try {
      return (await (prisma as any).venueTrade.create({ data: row })) as VenueTradeRow;
    } catch (error) {
      // Two callers recording the same trade: the second just finds the first.
      if ((error as { code?: string })?.code !== "P2002") throw error;
      return (await (prisma as any).venueTrade.findUnique({ where: { reference: row.reference } })) as VenueTradeRow;
    }
  },
  async update(reference, data) {
    await (prisma as any).venueTrade.updateMany({ where: { reference }, data });
  },
};
