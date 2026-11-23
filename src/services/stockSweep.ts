import { checkStockEligibility } from "@/services/stockEligibility";
import { OrderRefused } from "@/services/orderErrors";
import type { StockToken } from "@/services/stocks";
import { createLogger } from "@/utils/logger";

const logger = createLogger("stock-sweep");

// ============================================
// Invest a share of every paid invoice
//
// "Put 10% of my sales into Nvidia": when an invoice is paid, a share of what the
// merchant earned is bought in stocks, through the same order engine as any other
// buy. It runs AFTER the settlement is complete and can never undo or delay it: any
// failure is logged and ends here, and the money simply stays in the merchant's
// wallet. Each invoice buys at most once (the order reference is derived from it).
// ============================================

export const MAX_SWEEP_PERCENT = 50;

export interface SweepDeps {
  getRule(userId: string): Promise<{ percent: number; tokenAddress: string | null } | null>;
  targets(userId: string): Promise<Array<{ tokenAddress: string; percent: number }>>;
  stocks(): Promise<StockToken[]>;
  user(userId: string): Promise<{ phone?: string | null; business?: { country?: string | null } | null } | null>;
  place(p: { reference: string; userId: string; token: StockToken; cashAmount: number; currency: string }): Promise<{ state: string }>;
}

export interface SweepOutcome {
  placed: Array<{ ticker: string; cashAmount: number; state: string }>;
  skipped: string[];
}

const floorCents = (n: number) => Math.floor(n * 100) / 100;

/** Invest the merchant's chosen share of a paid invoice. Never throws. */
export async function runSweep(p: { merchantId: string; invoiceId: string; amount: number; currency: string }, deps: SweepDeps): Promise<SweepOutcome | null> {
  try {
    const rule = await deps.getRule(p.merchantId);
    if (!rule || !(rule.percent > 0) || !(p.amount > 0)) return null;
    const percent = Math.min(rule.percent, MAX_SWEEP_PERCENT);

    const user = await deps.user(p.merchantId);
    const eligibility = checkStockEligibility({ phone: user?.phone ?? "", country: user?.business?.country ?? undefined });
    if (!eligibility.ok) return null;

    const stocks = await deps.stocks();
    const byAddress = new Map(stocks.map((s) => [s.address, s]));
    let shares: Array<{ token: StockToken; weight: number }>;
    if (rule.tokenAddress) {
      const token = byAddress.get(rule.tokenAddress);
      shares = token ? [{ token, weight: 1 }] : [];
    } else {
      shares = (await deps.targets(p.merchantId)).flatMap((t) => (byAddress.has(t.tokenAddress) ? [{ token: byAddress.get(t.tokenAddress)!, weight: t.percent }] : []));
    }
    if (shares.length === 0) return null;

    const pool = floorCents((p.amount * percent) / 100);
    const totalWeight = shares.reduce((n, s) => n + s.weight, 0);
    const out: SweepOutcome = { placed: [], skipped: [] };
    for (const s of shares) {
      const cashAmount = floorCents((pool * s.weight) / totalWeight);
      try {
        const order = await deps.place({ reference: `sweep:${p.invoiceId}:${s.token.address}`, userId: p.merchantId, token: s.token, cashAmount, currency: p.currency });
        out.placed.push({ ticker: s.token.ticker, cashAmount, state: order.state });
      } catch (error) {
        // Usually "below the minimum order". Not an error worth more than a log line.
        out.skipped.push(s.token.ticker);
        if (!(error instanceof OrderRefused)) logger.warn("Sweep buy failed", { invoiceId: p.invoiceId, token: s.token.ticker, error: (error as Error)?.message });
      }
    }
    return out;
  } catch (error: any) {
    logger.error("Invoice sweep failed", { invoiceId: p.invoiceId, error: error?.message });
    return null;
  }
}

/** The message to the merchant about what was invested. Null when nothing was. */
export function sweepMessage(o: SweepOutcome | null, money: (n: number) => string): string | null {
  const done = o?.placed.filter((x) => x.state === "filled") ?? [];
  if (!o || done.length === 0) return null;
  const lines = done.map((x) => `• ${money(x.cashAmount)} into ${x.ticker}`).join("\n");
  return `*Invested from this sale*\n\n${lines}\n\nChange it any time: *invest 10% of my sales in Nvidia*, or *stop investing my sales*.`;
}
