import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/config", () => ({
  config: {
    logLevel: "debug",
    redis: {},
    nearIntents: {
      baseUrl: "https://1click.test",
      apiKey: "k",
      recipient: "0xplatform",
      refundTo: "0xrefund",
      originAsset: "nep141:origin",
      destinationAsset: "nep141:dest",
      destinationDecimals: 6,
      fxRates: { USD: 1, RWF: 1450, NGN: 1500 },
      slippageBps: 100,
      referral: "",
      recipientType: "DESTINATION_CHAIN",
    },
  },
}));

import { nearIntents } from "@/services/nearIntents";

describe("nearIntents", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("is enabled when a recipient is set (API key optional)", () => {
    expect(nearIntents.isNearIntentsEnabled()).toBe(true);
  });

  it("converts RWF to USDC base units, rounding up", () => {
    expect(nearIntents.fiatToDestinationUnits(1450, "RWF")).toBe("1000000");
    expect(nearIntents.fiatToDestinationUnits(3000, "rwf")).toBe("2068966"); // 2.0689655 -> up
  });

  it("prices other currencies and rejects unknown ones", () => {
    expect(nearIntents.fiatToDestinationUnits(15000, "NGN")).toBe("10000000");
    expect(nearIntents.fiatToDestinationUnits(5, "USD")).toBe("5000000");
    expect(() => nearIntents.fiatToDestinationUnits(5, "XYZ")).toThrow(/XYZ/);
  });

  it("resolves tokens by symbol/chain and drops non-EVM chains", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { assetId: "a-base", symbol: "USDC", blockchain: "base", decimals: 6, price: 1 },
        { assetId: "a-arb", symbol: "USDT", blockchain: "arb", decimals: 6, price: 1 },
        { assetId: "a-sol", symbol: "USDC", blockchain: "sol", decimals: 6, price: 1 },
      ],
    }));
    expect((await nearIntents.resolveOriginAsset("usdc"))?.assetId).toBe("a-base");
    expect((await nearIntents.resolveOriginAsset("usdt", "arb"))?.assetId).toBe("a-arb");
    expect(await nearIntents.resolveOriginAsset("usdc", "sol")).toBeNull();
  });

  it("requests an EXACT_OUTPUT quote with an X-API-Key header", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ quote: { depositAddress: "0xdep", amountIn: "1", amountOut: "2" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await nearIntents.requestQuote({ amountOut: "2068966", deadline: new Date("2030-01-01") });
    expect(res.quote.depositAddress).toBe("0xdep");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://1click.test/v0/quote");
    expect(init.headers["X-API-Key"]).toBe("k");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      dry: false,
      swapType: "EXACT_OUTPUT",
      depositType: "ORIGIN_CHAIN",
      recipientType: "DESTINATION_CHAIN",
      recipient: "0xplatform",
      amount: "2068966",
    });
  });

  it("throws on a non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => "bad key" }));
    await expect(nearIntents.getStatus("0xdep")).rejects.toThrow(/401/);
  });
});
