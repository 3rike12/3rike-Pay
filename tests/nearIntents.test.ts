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

describe("the default payment token", () => {
  let clock = Date.now();
  /** The token list 1Click returns, as a list of [symbol, chain]. The service caches it for 10 minutes, so each test moves the clock past that. */
  const offer = (...pairs: Array<[string, string]>) => {
    clock += 11 * 60_000;
    vi.spyOn(Date, "now").mockReturnValue(clock);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => pairs.map(([symbol, blockchain]) => ({ assetId: `${symbol}-${blockchain}`, symbol, blockchain, decimals: 6, price: 1 })),
    }));
  };
  const pick = async () => {
    const t = await nearIntents.resolveDefaultOrigin();
    return t ? `${t.symbol}/${t.blockchain}` : null;
  };

  // The 15 tokens 1Click offered on mainnet when this was written (USDT/USDC on Base are absent, ETH on Base is there).
  const MAINNET: Array<[string, string]> = [
    ["USDT", "eth"], ["USDC", "eth"], ["ETH", "eth"], ["ETH", "arb"], ["USDC", "arb"], ["ETH", "base"], ["USDC", "gnosis"], ["USDT", "gnosis"],
    ["USDC", "pol"], ["USDT", "pol"], ["ETH", "op"], ["USDT", "op"], ["USDC", "op"], ["USDT", "avax"], ["USDC", "avax"],
  ];

  it("on the real mainnet list it is ETH on Base, since a Base stablecoin is not offered", async () => {
    offer(...MAINNET);
    expect(await pick()).toBe("ETH/base");
  });

  it("is a stablecoin on Base when one is offered (as on the testnet)", async () => {
    offer(["ETH", "base"], ["USDT", "base"], ["USDC", "arb"]);
    expect(await pick()).toBe("USDT/base");
  });

  it("falls back down the list when Base has nothing", async () => {
    offer(["USDT", "eth"], ["USDC", "arb"], ["ETH", "eth"]);
    expect(await pick()).toBe("USDC/arb");
    offer(["USDT", "eth"], ["ETH", "eth"]);
    expect(await pick()).toBe("USDT/eth");
  });

  it("with none of the preferences on offer it takes whatever is, and with nothing at all it says so", async () => {
    offer(["USDC", "avax"], ["USDT", "gnosis"]);
    expect(await pick()).toBe("USDC/avax");
    offer();
    expect(await pick()).toBeNull();
  });
});

describe("Stellar", () => {
  it("is offered for USDC and XLM only, alongside the EVM tokens", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60 * 60_000);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { assetId: "eth", symbol: "ETH", blockchain: "base", decimals: 18, price: 3000 },
        { assetId: "xlm", symbol: "XLM", blockchain: "stellar", decimals: 7, price: 0.13 },
        { assetId: "usdc-xlm", symbol: "USDC", blockchain: "stellar", decimals: 7, price: 1 },
        { assetId: "yxlm", symbol: "YXLM", blockchain: "stellar", decimals: 7, price: 1 },
        { assetId: "sol", symbol: "SOL", blockchain: "sol", decimals: 9, price: 150 },
      ],
    }));
    const offered = (await nearIntents.listPayableTokens()).map((t) => `${t.symbol}/${t.blockchain}`);
    expect(offered).toEqual(expect.arrayContaining(["ETH/base", "XLM/stellar", "USDC/stellar"]));
    expect(offered).not.toContain("YXLM/stellar");
    expect(offered).not.toContain("SOL/sol");
  });

  it("deposits with a memo on Stellar and by default address everywhere else", async () => {
    const { depositModeFor } = await import("@/services/nearIntents");
    expect(depositModeFor("stellar")).toBe("MEMO");
    expect(depositModeFor("base")).toBeUndefined();
    expect(depositModeFor(undefined)).toBeUndefined();
  });

  it("recognises Stellar account addresses", async () => {
    const { isStellarAddress } = await import("@/services/nearIntents");
    expect(isStellarAddress("GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7")).toBe(true);
    expect(isStellarAddress("0x2527D02599Ba641c19FEa793cD0F167589a0f10D")).toBe(false);
    expect(isStellarAddress("GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN")).toBe(false);
    expect(isStellarAddress("")).toBe(false);
  });

  it("sends the deposit mode to 1Click only when one is set", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ quote: {} }), text: async () => "" });
    vi.stubGlobal("fetch", fetchMock);
    await nearIntents.requestQuote({ amount: "1", deadline: new Date(), depositMode: "MEMO" });
    await nearIntents.requestQuote({ amount: "1", deadline: new Date() });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).depositMode).toBe("MEMO");
    expect("depositMode" in JSON.parse(fetchMock.mock.calls[1][1].body)).toBe(false);
  });
});

