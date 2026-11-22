import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mutable, so each test can set the config it wants.
const cfg: any = vi.hoisted(() => ({
  logLevel: "silent",
  treasury: { minWithdrawUsd: 5, maxWithdrawUsd: 2000 },
  nearIntents: {},
  rails: {},
}));
vi.mock("@/config", () => ({ config: cfg }));

const requestQuote = vi.fn();
vi.mock("@/services/nearIntents", () => ({
  nearIntents: { requestQuote: (...a: any[]) => requestQuote(...a), getStatus: vi.fn() },
}));
const initializeOffRamp = vi.fn();
vi.mock("@/services/autoramp", () => ({ autoramp: { initializeOffRamp: (...a: any[]) => initializeOffRamp(...a) } }));

import { configuredLimits, checkLimits } from "@/rails/limits";
import { registerRail, unregisterRail } from "@/rails/registry";
import { pickRail, initiateOn, ensureRails } from "@/rails/router";
import { oneClickRail, oneClickPayoutRail } from "@/rails/oneClick";
import { autoRampOfframpRail } from "@/rails/autoRamp";
import type { Rail } from "@/rails/types";

beforeEach(() => {
  cfg.treasury = { minWithdrawUsd: 5, maxWithdrawUsd: 2000 };
  cfg.nearIntents = {};
  cfg.rails = {};
  vi.clearAllMocks();
  ensureRails();
});

describe("configuredLimits: each rail has its own", () => {
  it("1Click's inbound minimum is 5 USD by default, the old top-up minimum", () => {
    expect(configuredLimits("1click").minUsd).toBe(5);
  });

  it("inbound is capped like withdrawals unless the rail says otherwise", () => {
    expect(configuredLimits("1click").maxUsd).toBe(2000);
    cfg.rails = { "1click": { maxUsd: 500 } };
    expect(configuredLimits("1click").maxUsd).toBe(500);
  });

  it("a rail's own setting beats the shared payout defaults, without touching the others", () => {
    cfg.rails = { autoramp: { minUsd: 7, maxUsd: 1500 } };
    expect(configuredLimits("autoramp")).toEqual({ minUsd: 7, maxUsd: 1500 });
    expect(configuredLimits("1click-payout")).toEqual({ minUsd: 5, maxUsd: 2000 });
    expect(configuredLimits("1click").minUsd).toBe(5);
  });

  it("the testnet demo network is not capped, but still has the minimum", () => {
    cfg.nearIntents = { network: "tidepool" };
    expect(configuredLimits("1click")).toEqual({ minUsd: 5, maxUsd: undefined });
  });

  it("a rail with no config has no limits", () => {
    expect(configuredLimits("something-new")).toEqual({ minUsd: undefined, maxUsd: undefined });
  });

  it("tolerates a config with no rails or treasury at all", () => {
    delete cfg.rails;
    delete cfg.treasury;
    expect(configuredLimits("1click").minUsd).toBe(5);
    expect(configuredLimits("autoramp").minUsd).toBeUndefined();
  });
});

describe("checkLimits", () => {
  it("lets an amount through when a rail can carry it, best rail first", () => {
    const r = checkLimits("in", { kind: "swap", usd: 20 });
    expect(r.ok && r.rails[0].id).toBe("1click");
  });

  it("says below the minimum, with the rail's number", () => {
    expect(checkLimits("in", { kind: "swap", usd: 1 })).toEqual({ ok: false, reason: "below_min", minUsd: 5 });
  });

  it("says above the maximum, with the rail's number", () => {
    expect(checkLimits("in", { kind: "swap", usd: 5000 })).toEqual({ ok: false, reason: "above_max", maxUsd: 2000 });
  });

  it("follows a changed minimum immediately", () => {
    cfg.rails = { "1click": { minUsd: 25 } };
    expect(checkLimits("in", { kind: "swap", usd: 20 })).toEqual({ ok: false, reason: "below_min", minUsd: 25 });
  });

  it("does not offer a bank rail for a crypto payout, or a swap rail for a bank payout", () => {
    const crypto = checkLimits("out", { kind: "swap", chain: "base", usd: 20 });
    expect(crypto.ok && crypto.rails.map((r) => r.id)).toEqual(["1click-payout"]);
    const bank = checkLimits("out", { kind: "bank_payout", currency: "NGN", usd: 20 });
    expect(bank.ok && bank.rails.map((r) => r.id)).toEqual(["autoramp"]);
  });

  it("says unsupported when no rail serves the currency or chain at all", () => {
    expect(checkLimits("out", { kind: "bank_payout", currency: "KES", usd: 20 })).toEqual({ ok: false, reason: "unsupported" });
    expect(checkLimits("in", { kind: "swap", chain: "bsc", usd: 20 })).toEqual({ ok: false, reason: "unsupported" });
  });
});

describe("a new rail brings its own rules", () => {
  const added: string[] = [];
  const add = (r: Rail) => {
    registerRail(r);
    added.push(r.id);
  };
  afterEach(() => {
    for (const id of added.splice(0)) unregisterRail(id);
  });

  it("a second inbound rail with a lower minimum makes small amounts payable, and the user is told the lowest minimum", () => {
    add({ id: "cheap", direction: "in", priority: 50, capabilities: () => ({ kinds: ["swap"], minUsd: 1, maxUsd: 100 }) });
    // 3 USD: 1Click (min 5) cannot, the new rail can.
    const small = checkLimits("in", { kind: "swap", usd: 3 });
    expect(small.ok && small.rails.map((r) => r.id)).toEqual(["cheap"]);
    // 20 USD: both fit, 1Click first by priority.
    const mid = checkLimits("in", { kind: "swap", usd: 20 });
    expect(mid.ok && mid.rails.map((r) => r.id)).toEqual(["1click", "cheap"]);
    // 500 USD: only 1Click (cheap tops out at 100).
    const big = checkLimits("in", { kind: "swap", usd: 500 });
    expect(big.ok && big.rails.map((r) => r.id)).toEqual(["1click"]);
    // Below every minimum: the user is told the easiest one to reach.
    expect(checkLimits("in", { kind: "swap", usd: 0.5 })).toEqual({ ok: false, reason: "below_min", minUsd: 1 });
  });

  it("a rail with no limits never blocks", () => {
    add({ id: "open", direction: "in", capabilities: () => ({ kinds: ["swap"] }) });
    const r = checkLimits("in", { kind: "swap", usd: 0.01 });
    expect(r.ok && r.rails.map((x) => x.id)).toContain("open");
  });
});

describe("initiating on a rail", () => {
  it("1Click returns the deposit address and keeps the provider response", async () => {
    requestQuote.mockResolvedValue({ quote: { depositAddress: "0xdep", depositMemo: "m", amountIn: "10", amountInFormatted: "0.00001", amountOut: "9" } });
    const deadline = new Date("2030-01-01");
    const out = await initiateOn(pickRail("in", { kind: "swap" }), { kind: "swap", swapType: "EXACT_OUTPUT", amount: "9", deadline });
    expect(out).toMatchObject({ rail: "1click", railRef: "0xdep", depositAddress: "0xdep", depositMemo: "m", amountIn: "10", amountOut: "9" });
    expect(requestQuote).toHaveBeenCalledWith(expect.objectContaining({ dry: false, swapType: "EXACT_OUTPUT", amount: "9", deadline }));
  });

  it("a quote creates nothing at the provider", async () => {
    requestQuote.mockResolvedValue({ quote: { amountIn: "10", amountOut: "9" } });
    const q = await oneClickRail.quote!({ kind: "swap", swapType: "EXACT_OUTPUT", amount: "9", deadline: new Date() });
    expect(q).toMatchObject({ rail: "1click", amountIn: "10" });
    expect(requestQuote).toHaveBeenCalledWith(expect.objectContaining({ dry: true }));
  });

  it("1Click refuses without a deposit address, so nothing is promised to a customer", async () => {
    requestQuote.mockResolvedValue({ quote: { amountIn: "10", amountOut: "9" } });
    await expect(oneClickRail.initiate!({ kind: "swap", swapType: "EXACT_OUTPUT", amount: "9", deadline: new Date() })).rejects.toThrow("no deposit address");
  });

  it("the payout rail reports its own id", async () => {
    requestQuote.mockResolvedValue({ quote: { depositAddress: "0xd", amountIn: "1" } });
    const out = await oneClickPayoutRail.initiate!({ kind: "swap", swapType: "EXACT_INPUT", amount: "1", deadline: new Date() });
    expect(out.rail).toBe("1click-payout");
  });

  it("AutoRamp pays a bank and returns the reference and where to send USDC", async () => {
    initializeOffRamp.mockResolvedValue({ data: { depositAddress: "0xramp" }, databaseRecord: { reference: "OFR-1" } });
    const out = await autoRampOfframpRail.initiate!({ kind: "bank_payout", network: "base", ngn: 150000, bankCode: "000013", accountNumber: "0123456789" });
    expect(out).toMatchObject({ rail: "autoramp", railRef: "OFR-1", depositAddress: "0xramp" });
    expect(initializeOffRamp).toHaveBeenCalledWith({ network: "base", amount: 150000, bankCode: "000013", accountNumber: "0123456789" });
  });

  it("AutoRamp refuses a response with no reference or address", async () => {
    initializeOffRamp.mockResolvedValue({ data: {} });
    await expect(autoRampOfframpRail.initiate!({ kind: "bank_payout", network: "base", ngn: 1, bankCode: "x", accountNumber: "0123456789" })).rejects.toThrow("missing");
  });

  it("each rail refuses the other's kind of request", async () => {
    await expect(oneClickRail.initiate!({ kind: "bank_payout", network: "base", ngn: 1, bankCode: "x", accountNumber: "1" })).rejects.toThrow("cannot make a bank payout");
    await expect(autoRampOfframpRail.initiate!({ kind: "swap", swapType: "EXACT_INPUT", amount: "1", deadline: new Date() })).rejects.toThrow("cannot swap");
  });

  it("pickRail fails loudly when nothing can carry the request", () => {
    expect(() => pickRail("out", { kind: "bank_payout", currency: "KES" })).toThrow("No payment route");
  });

  it("initiateOn refuses a rail that cannot initiate", async () => {
    await expect(initiateOn({ id: "x", direction: "in", capabilities: () => ({}) }, { kind: "swap", swapType: "EXACT_INPUT", amount: "1", deadline: new Date() })).rejects.toThrow("cannot initiate");
  });
});
