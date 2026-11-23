import { prisma } from "@/db/prisma";
import { liabilities, onChainBalanceUsd } from "@/services/treasury";
import { positions } from "@/services/positions";
import { onChainTokenBalance } from "@/services/stockSolvency";
import { createLogger } from "@/utils/logger";

const logger = createLogger("trial-balance");

// ============================================
// The trial balance: is every unit accounted for?
//
// Double-entry bookkeeping exists to answer one question: does what we HOLD match
// what we OWE, with nothing unexplained? The ledgers already keep their own
// invariants (balances equal their entries, nobody oversells), so rather than
// rewrite them into journals, this checks the accounting equation across them.
//
//   USDC the treasury holds  =  cash users are owed
//                             + USDC committed to buys still in flight
//                             + surplus (fees, rounding)
//
//   Tokens the treasury holds =  tokens users own
//                             + tokens belonging to sells still in flight
//                             + surplus
//
// "In flight" is the part a plain solvency check misses. While a buy is between
// "cash taken from the user" and "tokens credited to them", that value is owed to
// nobody's balance yet is not surplus either. Ignoring it makes every swap look
// like a shortfall.
//
// A shortfall is a fact for a person to investigate; this only reports it. It
// fails closed: a balance that cannot be read is not "fine".
// ============================================

export const USDC_DUST_USD = 0.01;
const USDC_DECIMALS = 6;

export interface TrialInputs {
  heldUsd: number | null;
  cashOwedUsd: number;
  inFlightBuyUsd: number;
  tokens: Array<{ tokenAddress: string; held: bigint | null; owed: bigint; inFlightSell: bigint }>;
  inFlightOrders: number;
}

export interface TrialBalance {
  usdc: { heldUsd: number | null; cashOwedUsd: number; inFlightBuyUsd: number; expectedUsd: number; differenceUsd: number | null; ok: boolean };
  tokens: Array<{ tokenAddress: string; held: bigint | null; owed: bigint; inFlightSell: bigint; expected: bigint; difference: bigint | null; ok: boolean }>;
  inFlightOrders: number;
  /** Everything is covered. A surplus is fine; a shortfall or an unreadable balance is not. */
  ok: boolean;
}

/** Pure: apply the accounting equation to what was gathered. */
export function buildTrialBalance(i: TrialInputs): TrialBalance {
  const expectedUsd = i.cashOwedUsd + i.inFlightBuyUsd;
  const differenceUsd = i.heldUsd === null ? null : i.heldUsd - expectedUsd;
  const usdc = {
    heldUsd: i.heldUsd,
    cashOwedUsd: i.cashOwedUsd,
    inFlightBuyUsd: i.inFlightBuyUsd,
    expectedUsd,
    differenceUsd,
    // A few cents short is rounding, not a hole; more than that is not.
    ok: differenceUsd !== null && differenceUsd >= -USDC_DUST_USD,
  };
  const tokens = i.tokens.map((t) => {
    const expected = t.owed + t.inFlightSell;
    const difference = t.held === null ? null : t.held - expected;
    return { ...t, expected, difference, ok: difference !== null && difference >= 0n };
  });
  return { usdc, tokens, inFlightOrders: i.inFlightOrders, ok: usdc.ok && tokens.every((t) => t.ok) };
}

export interface TrialDeps {
  heldUsdc(): Promise<number>;
  cashOwedUsd(): Promise<number>;
  tokenTotals(): Promise<Array<{ tokenAddress: string; units: bigint }>>;
  tokenHeld(tokenAddress: string): Promise<bigint>;
  inFlight(): Promise<Array<{ side: "buy" | "sell"; tokenAddress: string; usdcUnits: bigint; tokenUnits: bigint }>>;
}

const realDeps: TrialDeps = {
  heldUsdc: onChainBalanceUsd,
  cashOwedUsd: async () => (await liabilities()).totalUsd,
  tokenTotals: () => positions.totals(),
  tokenHeld: (a) => onChainTokenBalance(a),
  inFlight: async () =>
    ((await (prisma as any).stockOrder.findMany({ where: { state: { in: ["funded", "submitted"] } } })) as any[]).map((o) => ({
      side: o.side, tokenAddress: o.tokenAddress, usdcUnits: o.usdcUnits, tokenUnits: o.tokenUnits,
    })),
};

/** Read the ledgers and the chain, and build the trial balance. Anything unreadable is reported, never assumed. */
export async function gatherTrialBalance(deps: TrialDeps = realDeps): Promise<TrialBalance> {
  const [held, cashOwedUsd, totals, flight] = await Promise.all([
    deps.heldUsdc().catch((e: any) => (logger.error("Could not read the USDC balance", { error: e?.message }), null)),
    deps.cashOwedUsd(),
    deps.tokenTotals(),
    deps.inFlight(),
  ]);

  const inFlightBuyUsd = flight.filter((o) => o.side === "buy").reduce((n, o) => n + Number(o.usdcUnits) / 10 ** USDC_DECIMALS, 0);
  const sellsByToken = new Map<string, bigint>();
  for (const o of flight.filter((x) => x.side === "sell")) sellsByToken.set(o.tokenAddress, (sellsByToken.get(o.tokenAddress) ?? 0n) + o.tokenUnits);

  // Every token that anyone owns OR that has a sale in flight (a sale of someone's last units leaves them owning none).
  const addresses = new Set<string>([...totals.filter((t) => t.units > 0n).map((t) => t.tokenAddress), ...sellsByToken.keys()]);
  const tokens = await Promise.all(
    [...addresses].map(async (tokenAddress) => ({
      tokenAddress,
      owed: totals.find((t) => t.tokenAddress === tokenAddress)?.units ?? 0n,
      inFlightSell: sellsByToken.get(tokenAddress) ?? 0n,
      held: await deps.tokenHeld(tokenAddress).catch((e: any) => (logger.error("Could not read a token balance", { tokenAddress, error: e?.message }), null)),
    }))
  );

  return buildTrialBalance({ heldUsd: held, cashOwedUsd, inFlightBuyUsd, tokens, inFlightOrders: flight.length });
}
