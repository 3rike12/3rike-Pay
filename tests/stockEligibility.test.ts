import { describe, it, expect, vi, beforeEach } from "vitest";

const cfg: any = vi.hoisted(() => ({ logLevel: "silent", stocks: { blockUs: true } }));
vi.mock("@/config", () => ({ config: cfg }));

import { isUsPhone, checkStockEligibility, eligibilityMessage } from "@/services/stockEligibility";

beforeEach(() => {
  cfg.stocks = { blockUs: true };
});

describe("isUsPhone", () => {
  it("treats the dialling code 1 as the US, which it shares with Canada", () => {
    expect(isUsPhone("+1 415 555 0100")).toBe(true);
    expect(isUsPhone("14155550100")).toBe(true);
  });
  it("is false for everyone else, including a missing number", () => {
    for (const p of ["254712345678", "2348012345678", "447911123456", "250781234567", "", null, undefined]) expect(isUsPhone(p as any)).toBe(false);
  });
});

describe("checkStockEligibility: every country is open except the US", () => {
  it.each([
    ["Kenya", "254712345678"],
    ["Tanzania", "255712345678"],
    ["Nigeria", "2348012345678"],
    ["Rwanda", "250781234567"],
    ["the UK", "447911123456"],
    ["India", "919876543210"],
    ["a number we cannot place", "99912345"],
  ])("allows %s", (_name, phone) => {
    expect(checkStockEligibility({ phone })).toEqual({ ok: true });
  });

  it("allows someone with no phone on record: not knowing is not a reason to refuse", () => {
    expect(checkStockEligibility({})).toEqual({ ok: true });
    expect(checkStockEligibility({ phone: null })).toEqual({ ok: true });
  });

  it("refuses a US number, and a declared US country even on a Kenyan number", () => {
    expect(checkStockEligibility({ phone: "14155550100" })).toEqual({ ok: false, reason: "us" });
    expect(checkStockEligibility({ phone: "254712345678", country: "US" })).toEqual({ ok: false, reason: "us" });
    expect(checkStockEligibility({ phone: "254712345678", country: "us" })).toEqual({ ok: false, reason: "us" });
  });

  it("allows any other declared country", () => {
    expect(checkStockEligibility({ phone: "254712345678", country: "KE" })).toEqual({ ok: true });
    expect(checkStockEligibility({ country: "GB" })).toEqual({ ok: true });
  });

  it("the US block can be switched off", () => {
    cfg.stocks.blockUs = false;
    expect(checkStockEligibility({ phone: "14155550100" })).toEqual({ ok: true });
  });

  it("blocks the US when the setting is absent: the safe default", () => {
    cfg.stocks = {};
    expect(checkStockEligibility({ phone: "14155550100" })).toEqual({ ok: false, reason: "us" });
  });
});

describe("eligibilityMessage", () => {
  it("says it plainly", () => {
    expect(eligibilityMessage({ ok: false, reason: "us" })).toContain("United States");
  });
});
