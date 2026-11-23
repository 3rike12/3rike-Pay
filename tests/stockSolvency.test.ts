import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const cfg: any = vi.hoisted(() => ({
  logLevel: "silent",
  treasury: { address: "0x2527D02599Ba641c19FEa793cD0F167589a0f10D", rpcUrl: "http://rpc.test" },
}));
vi.mock("@/config", () => ({ config: cfg }));
const totals = vi.fn();
vi.mock("@/services/positions", () => ({ positions: { totals: (...a: any[]) => totals(...a) } }));

import { onChainTokenBalance, stockSolvency, coversOwed } from "@/services/stockSolvency";

const TSLA = "0xb20000000000000000000016e38fd364d271ba28";
const NVDA = "0xb20000000000000000000006f910a0e7bbd3c168";
const ONE = 100_000_000n;

/** A fake Base RPC answering eth_call balanceOf per token contract. */
function chain(balances: Record<string, bigint | "error" | "revert">) {
  const calls: any[] = [];
  vi.stubGlobal("fetch", async (_u: string, init: any) => {
    const { params } = JSON.parse(init.body);
    const { to, data } = params[0];
    calls.push({ to: to.toLowerCase(), data });
    const b = balances[to.toLowerCase()];
    if (b === "error") return { ok: false, status: 503, json: async () => ({}) };
    if (b === "revert") return { ok: true, status: 200, json: async () => ({ error: { message: "execution reverted" } }) };
    return { ok: true, status: 200, json: async () => ({ result: `0x${(b ?? 0n).toString(16).padStart(64, "0")}` }) };
  });
  return calls;
}

beforeEach(() => {
  totals.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe("onChainTokenBalance", () => {
  it("asks the token contract for the treasury's balance, addressed correctly", async () => {
    const calls = chain({ [TSLA]: 5n * ONE });
    expect(await onChainTokenBalance(TSLA)).toBe(5n * ONE);
    expect(calls[0].to).toBe(TSLA);
    // balanceOf(address) selector, then the treasury address left-padded to 32 bytes.
    expect(calls[0].data).toBe("0x70a08231" + "0".repeat(24) + "2527d02599ba641c19fea793cd0f167589a0f10d");
  });

  it("reads amounts past what a float can hold exactly", async () => {
    chain({ [TSLA]: 10n ** 24n + 1n });
    expect(await onChainTokenBalance(TSLA)).toBe(10n ** 24n + 1n);
  });

  it("throws when the chain cannot be read, so nothing is assumed", async () => {
    chain({ [TSLA]: "error" });
    await expect(onChainTokenBalance(TSLA)).rejects.toThrow("503");
    chain({ [TSLA]: "revert" });
    await expect(onChainTokenBalance(TSLA)).rejects.toThrow("reverted");
  });

  it("refuses an address that is not one", async () => {
    await expect(onChainTokenBalance("tsla")).rejects.toThrow(/address/i);
  });
});

describe("stockSolvency", () => {
  it("is covered when the treasury holds at least what users own", async () => {
    totals.mockResolvedValue([{ tokenAddress: TSLA, units: 5n * ONE }]);
    chain({ [TSLA]: 5n * ONE });
    expect(await stockSolvency()).toEqual([{ tokenAddress: TSLA, owed: 5n * ONE, held: 5n * ONE, covered: true, surplus: 0n }]);
  });

  it("shows a surplus when the treasury holds more", async () => {
    totals.mockResolvedValue([{ tokenAddress: TSLA, units: 5n * ONE }]);
    chain({ [TSLA]: 7n * ONE });
    expect((await stockSolvency())[0]).toMatchObject({ covered: true, surplus: 2n * ONE });
  });

  it("is NOT covered when users own more than the treasury holds, even by one unit", async () => {
    totals.mockResolvedValue([{ tokenAddress: TSLA, units: 5n * ONE }]);
    chain({ [TSLA]: 5n * ONE - 1n });
    expect((await stockSolvency())[0]).toMatchObject({ covered: false, surplus: -1n });
  });

  it("judges each token on its own: one short token is not hidden by another with a surplus", async () => {
    totals.mockResolvedValue([{ tokenAddress: TSLA, units: ONE }, { tokenAddress: NVDA, units: ONE }]);
    chain({ [TSLA]: 100n * ONE, [NVDA]: 0n });
    const r = Object.fromEntries((await stockSolvency()).map((c) => [c.tokenAddress, c.covered]));
    expect(r).toEqual({ [TSLA]: true, [NVDA]: false });
  });

  it("fails closed: a token whose balance cannot be read is not covered, and the others are still checked", async () => {
    totals.mockResolvedValue([{ tokenAddress: TSLA, units: ONE }, { tokenAddress: NVDA, units: ONE }]);
    chain({ [TSLA]: "error", [NVDA]: 2n * ONE });
    const r = await stockSolvency();
    expect(r.find((c) => c.tokenAddress === TSLA)).toEqual({ tokenAddress: TSLA, owed: ONE, held: null, covered: false, surplus: null });
    expect(r.find((c) => c.tokenAddress === NVDA)!.covered).toBe(true);
  });

  it("skips tokens nobody owns, so there is nothing to check", async () => {
    totals.mockResolvedValue([{ tokenAddress: TSLA, units: 0n }]);
    const calls = chain({});
    expect(await stockSolvency()).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("has nothing to report when there are no positions", async () => {
    totals.mockResolvedValue([]);
    expect(await stockSolvency()).toEqual([]);
  });
});

describe("coversOwed (the gate before selling or paying out)", () => {
  it("is true only when every token is covered", async () => {
    totals.mockResolvedValue([{ tokenAddress: TSLA, units: ONE }, { tokenAddress: NVDA, units: ONE }]);
    chain({ [TSLA]: ONE, [NVDA]: ONE });
    expect(await coversOwed()).toBe(true);
    chain({ [TSLA]: ONE, [NVDA]: ONE - 1n });
    expect(await coversOwed()).toBe(false);
  });

  it("is false when the chain cannot be read: never proceed on a guess", async () => {
    totals.mockResolvedValue([{ tokenAddress: TSLA, units: ONE }]);
    chain({ [TSLA]: "error" });
    expect(await coversOwed()).toBe(false);
  });

  it("is true when nothing is owed", async () => {
    totals.mockResolvedValue([]);
    expect(await coversOwed()).toBe(true);
  });
});
