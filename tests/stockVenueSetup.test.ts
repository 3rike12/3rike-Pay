import { describe, it, expect, vi, beforeEach } from "vitest";

const cfg: any = vi.hoisted(() => ({
  logLevel: "silent",
  treasury: { address: "0x2527D02599Ba641c19FEa793cD0F167589a0f10D", tokenContract: "0x833589fCD6eDb6E08f4c7C32d4f71b54bdA02913", tokenDecimals: 6 },
  privy: { enabled: true, appId: "a", appSecret: "b", authorizationKey: "k", walletId: "w", sponsorGas: false },
  stocks: { maxSlippageBps: 100, maxOrderUsd: 500, venue: { kind: "0x", zeroExApiKey: "key", zeroExAllowedTargets: ["0x" + "a".repeat(40)], zeroExBaseUrl: "https://api.0x.org" } },
}));
vi.mock("@/config", () => ({ config: cfg }));
vi.mock("@/db/prisma", () => ({ prisma: {} }));
vi.mock("@privy-io/node", () => ({ PrivyClient: class { wallets() { return { ethereum: () => ({}) }; } } }));

import { registerConfiguredVenue } from "@/services/stockVenueSetup";
import { getStockVenue, setStockVenue } from "@/services/stockVenue";

const reset = () => {
  setStockVenue(null);
  cfg.privy.enabled = true;
  cfg.treasury.address = "0x2527D02599Ba641c19FEa793cD0F167589a0f10D";
  cfg.stocks.venue = { kind: "0x", zeroExApiKey: "key", zeroExAllowedTargets: ["0x" + "a".repeat(40)], zeroExBaseUrl: "https://api.0x.org" };
};
beforeEach(reset);

describe("registerConfiguredVenue", () => {
  it("registers the 0x venue when everything it needs is configured", () => {
    expect(registerConfiguredVenue()).toBe(true);
    expect(getStockVenue()?.id).toBe("0x");
  });

  it("stays off, quietly, when no venue is chosen", () => {
    cfg.stocks.venue.kind = "";
    expect(registerConfiguredVenue()).toBe(false);
    expect(getStockVenue()).toBeNull();
  });

  it("stays off for a venue it does not know", () => {
    cfg.stocks.venue.kind = "somewhere-else";
    expect(registerConfiguredVenue()).toBe(false);
    expect(getStockVenue()).toBeNull();
  });

  it.each([
    ["the API key", (v: any) => (v.zeroExApiKey = "")],
    ["the allowlist", (v: any) => (v.zeroExAllowedTargets = [])],
  ])("stays off without %s", (_n, breakIt) => {
    breakIt(cfg.stocks.venue);
    expect(registerConfiguredVenue()).toBe(false);
    expect(getStockVenue()).toBeNull();
  });

  it("stays off without the Privy treasury wallet", () => {
    cfg.privy.enabled = false;
    expect(registerConfiguredVenue()).toBe(false);
    expect(getStockVenue()).toBeNull();
  });

  it("stays off without a treasury address", () => {
    cfg.treasury.address = "";
    expect(registerConfiguredVenue()).toBe(false);
  });

  it("never throws: a bad allowlist address cannot stop the app from starting", () => {
    cfg.stocks.venue.zeroExAllowedTargets = ["not-an-address"];
    expect(() => registerConfiguredVenue()).not.toThrow();
    expect(registerConfiguredVenue()).toBe(false);
    expect(getStockVenue()).toBeNull();
  });
});
