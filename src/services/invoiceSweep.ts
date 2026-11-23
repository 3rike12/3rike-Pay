import { prisma } from "@/db/prisma";
import { getStocks } from "@/services/stocks";
import { placeBuy } from "@/services/stockOrders";
import { getSweep, getTargets } from "@/services/stockTargets";
import { runSweep, sweepMessage } from "@/services/stockSweep";
import { whatsapp } from "@/services/whatsapp";
import { createLogger } from "@/utils/logger";

const logger = createLogger("invoice-sweep");

/**
 * The real wiring for investing a share of a paid invoice, and telling the merchant.
 * Called after settlement, in the background. Never throws.
 */
export async function sweepPaidInvoice(p: { merchantId: string; invoiceId: string; amount: number; currency: string; phone: string | null }): Promise<void> {
  try {
    const outcome = await runSweep(
      { merchantId: p.merchantId, invoiceId: p.invoiceId, amount: p.amount, currency: p.currency },
      {
        getRule: async (userId) => {
          const rule = await getSweep(userId);
          return rule ? { percent: rule.percent, tokenAddress: rule.tokenAddress } : null;
        },
        targets: getTargets,
        stocks: () => getStocks(),
        user: (userId) => (prisma as any).user.findUnique({ where: { id: userId }, include: { business: true } }),
        place: (order) => placeBuy(order),
      }
    );
    const text = sweepMessage(outcome, (n) => `${p.currency} ${n}`);
    if (text && p.phone) await whatsapp.sendTextMessage(p.phone, text);
  } catch (error: any) {
    logger.warn("Sweep for a paid invoice failed", { invoiceId: p.invoiceId, error: error?.message });
  }
}
