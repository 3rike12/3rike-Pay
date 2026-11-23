import { describe, it, expect, vi } from "vitest";

vi.mock("@/config", () => ({ config: { logLevel: "silent" } }));
vi.mock("@/db/prisma", () => ({ prisma: {} }));
vi.mock("@/services/treasury", () => ({ liabilities: async () => ({ totalUsd: 0 }), onChainBalanceUsd: async () => 0 }));
vi.mock("@/services/positions", () => ({ positions: { totals: async () => [] } }));
vi.mock("@/services/stockSolvency", () => ({ onChainTokenBalance: async () => 0n }));

import { buildTrialBalance, gatherTrialBalance, USDC_DUST_USD, type TrialDeps, type TrialInputs } from "@/services/trialBalance";

const A = "0x" + "1".repeat(40);
const B = "0x" + "2".repeat(40);
const ONE = 100_000_000n;
const inputs = (over: Partial<TrialInputs> = {}): TrialInputs => ({ heldUsd: 1000, cashOwedUsd: 900, inFlightBuyUsd: 0, tokens: [], inFlightOrders: 0, ...over });

describe("buildTrialBalance: USDC", () => {
  it("balances with a surplus: holding more than is owed is fine", () => {
    const t = buildTrialBalance(inputs());
    expect(t.usdc).toMatchObject({ expectedUsd: 900, differenceUsd: 100, ok: true });
    expect(t.ok).toBe(true);
  });

  it("balances exactly", () => {
    expect(buildTrialBalance(inputs({ heldUsd: 900 })).usdc.ok).toBe(true);
  });

  it("USDC committed to a buy in flight is owed even though no balance shows it", () => {
    // $1000 held. $900 owed as cash. A $100 buy is mid-swap: cash is already off the user, USDC not yet spent.
    const t = buildTrialBalance(inputs({ heldUsd: 1000, cashOwedUsd: 900, inFlightBuyUsd: 100 }));
    expect(t.usdc).toMatchObject({ expectedUsd: 1000, differenceUsd: 0, ok: true });
  });

  it("without counting that, the same moment would look like a $100 surplus and the real shortfall below would hide", () => {
    const t = buildTrialBalance(inputs({ heldUsd: 950, cashOwedUsd: 900, inFlightBuyUsd: 100 }));
    expect(t.usdc).toMatchObject({ differenceUsd: -50, ok: false });
  });

  it("a shortfall is not ok, and says by how much", () => {
    const t = buildTrialBalance(inputs({ heldUsd: 899 }));
    expect(t.usdc).toMatchObject({ differenceUsd: -1, ok: false });
    expect(t.ok).toBe(false);
  });

  it("a few cents short is rounding, not a hole; more than that is not", () => {
    expect(buildTrialBalance(inputs({ heldUsd: 900 - USDC_DUST_USD })).usdc.ok).toBe(true);
    expect(buildTrialBalance(inputs({ heldUsd: 900 - USDC_DUST_USD - 0.001 })).usdc.ok).toBe(false);
  });

  it("fails closed when the balance could not be read", () => {
    const t = buildTrialBalance(inputs({ heldUsd: null }));
    expect(t.usdc).toMatchObject({ heldUsd: null, differenceUsd: null, ok: false });
    expect(t.ok).toBe(false);
  });
});

describe("buildTrialBalance: tokens", () => {
  const tok = (over: Record<string, any> = {}) => ({ tokenAddress: A, held: 10n * ONE, owed: 10n * ONE, inFlightSell: 0n, ...over });

  it("balances when the treasury holds exactly what users own", () => {
    const t = buildTrialBalance(inputs({ tokens: [tok()] }));
    expect(t.tokens[0]).toMatchObject({ expected: 10n * ONE, difference: 0n, ok: true });
  });

  it("tokens belonging to a sale in flight are still in the treasury: they are expected", () => {
    // Users own 7. A sale of 3 is mid-swap (units already taken off the seller), tokens still held: 10 held.
    const t = buildTrialBalance(inputs({ tokens: [tok({ owed: 7n * ONE, inFlightSell: 3n * ONE, held: 10n * ONE })] }));
    expect(t.tokens[0]).toMatchObject({ expected: 10n * ONE, difference: 0n, ok: true });
  });

  it("a single missing unit is a shortfall", () => {
    const t = buildTrialBalance(inputs({ tokens: [tok({ held: 10n * ONE - 1n })] }));
    expect(t.tokens[0]).toMatchObject({ difference: -1n, ok: false });
    expect(t.ok).toBe(false);
  });

  it("each token stands on its own: a surplus in one cannot cover a shortfall in another", () => {
    const t = buildTrialBalance(inputs({ tokens: [tok({ tokenAddress: A, held: 100n * ONE }), tok({ tokenAddress: B, held: 0n })] }));
    expect(t.tokens.map((x) => x.ok)).toEqual([true, false]);
    expect(t.ok).toBe(false);
  });

  it("fails closed for a token whose balance could not be read, and the others are still judged", () => {
    const t = buildTrialBalance(inputs({ tokens: [tok({ held: null }), tok({ tokenAddress: B })] }));
    expect(t.tokens[0]).toMatchObject({ held: null, difference: null, ok: false });
    expect(t.tokens[1].ok).toBe(true);
    expect(t.ok).toBe(false);
  });

  it("is exact past the size of a float", () => {
    const huge = 10n ** 24n + 1n;
    expect(buildTrialBalance(inputs({ tokens: [tok({ held: huge, owed: huge })] })).tokens[0].ok).toBe(true);
    expect(buildTrialBalance(inputs({ tokens: [tok({ held: huge - 1n, owed: huge })] })).tokens[0].ok).toBe(false);
  });
});

describe("gatherTrialBalance", () => {
  const deps = (over: Partial<TrialDeps> = {}): TrialDeps => ({
    heldUsdc: async () => 1000,
    cashOwedUsd: async () => 900,
    tokenTotals: async () => [{ tokenAddress: A, units: 10n * ONE }],
    tokenHeld: async () => 10n * ONE,
    inFlight: async () => [],
    ...over,
  });

  it("reads everything and balances", async () => {
    const t = await gatherTrialBalance(deps());
    expect(t.ok).toBe(true);
    expect(t.tokens).toHaveLength(1);
  });

  it("counts the USDC of buys in flight, in USD, and the tokens of sells in flight", async () => {
    const t = await gatherTrialBalance(deps({
      inFlight: async () => [
        { side: "buy", tokenAddress: A, usdcUnits: 40_000_000n, tokenUnits: 0n },
        { side: "buy", tokenAddress: B, usdcUnits: 60_000_000n, tokenUnits: 0n },
        { side: "sell", tokenAddress: A, usdcUnits: 0n, tokenUnits: 2n * ONE },
      ],
      tokenHeld: async () => 12n * ONE,
    }));
    expect(t.usdc.inFlightBuyUsd).toBe(100);
    expect(t.inFlightOrders).toBe(3);
    expect(t.tokens.find((x) => x.tokenAddress === A)).toMatchObject({ owed: 10n * ONE, inFlightSell: 2n * ONE, expected: 12n * ONE, ok: true });
  });

  it("includes a token whose only remaining claim is a sale in flight (someone's last units)", async () => {
    const t = await gatherTrialBalance(deps({
      tokenTotals: async () => [],
      inFlight: async () => [{ side: "sell", tokenAddress: B, usdcUnits: 0n, tokenUnits: 5n * ONE }],
      tokenHeld: async () => 5n * ONE,
    }));
    expect(t.tokens).toEqual([expect.objectContaining({ tokenAddress: B, owed: 0n, inFlightSell: 5n * ONE, ok: true })]);
  });

  it("skips tokens nobody owns and nothing is selling", async () => {
    const t = await gatherTrialBalance(deps({ tokenTotals: async () => [{ tokenAddress: A, units: 0n }] }));
    expect(t.tokens).toEqual([]);
  });

  it("an unreadable USDC balance or token balance is reported as not ok, not thrown", async () => {
    const t = await gatherTrialBalance(deps({
      heldUsdc: async () => { throw new Error("rpc down"); },
      tokenHeld: async () => { throw new Error("rpc down"); },
    }));
    expect(t.usdc.heldUsd).toBeNull();
    expect(t.tokens[0].held).toBeNull();
    expect(t.ok).toBe(false);
  });

  it("surfaces a real shortfall", async () => {
    const t = await gatherTrialBalance(deps({ tokenHeld: async () => 9n * ONE }));
    expect(t.ok).toBe(false);
    expect(t.tokens[0].difference).toBe(-ONE);
  });
});
