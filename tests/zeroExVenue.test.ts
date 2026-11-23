import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/config", () => ({ config: { logLevel: "silent", treasury: { rpcUrl: "http://rpc.test" } } }));

import { createZeroExVenue, encodeApprove, type TradeStore, type VenueTradeRow, type ZeroExConfig } from "@/services/venues/zeroEx";
import { transferred, type Receipt } from "@/services/chainRpc";
import { OrderRefused } from "@/services/orderErrors";

const TREASURY = "0x2527D02599Ba641c19FEa793cD0F167589a0f10D";
const USDC = "0x833589fCD6eDb6E08f4c7C32d4f71b54bdA02913";
const TOKEN = "0xb2000000000000000000001e800a7f5189430cD0";
const HOLDER = "0x" + "a".repeat(40); // the allowlisted contract that quotes point to
const OTHER = "0x" + "e".repeat(40); // not allowlisted
const TOKEN_ARG = { address: TOKEN, decimals: 8 };
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const pad = (a: string) => "0x" + "0".repeat(24) + a.slice(2).toLowerCase();
const word = (n: bigint) => "0x" + n.toString(16).padStart(64, "0");
const log = (token: string, from: string, to: string, amount: bigint) => ({ address: token.toLowerCase(), topics: [TRANSFER, pad(from), pad(to)], data: word(amount) });
const USD = (n: number) => BigInt(Math.round(n * 1e6));

// A scripted 0x, signer, chain and trade table.
function world() {
  const trades = new Map<string, VenueTradeRow>();
  const events: string[] = [];
  const receipts = new Map<string, Receipt | null>();
  const sentByKey = new Map<string, string>(); // idempotency key -> hash, like Privy
  const sends: Array<{ to: string; data: string; value?: string; idempotencyKey: string; hash?: string }> = [];
  const script = {
    quote: { liquidityAvailable: true, buyAmount: "100000000", minBuyAmount: "99000000", transaction: { to: HOLDER, data: "0xswapdata", value: "0" }, issues: { allowance: { spender: HOLDER, actual: "0", expected: "10000000" } } } as any,
    quoteFor: undefined as undefined | ((q: URLSearchParams) => any),
    swapReceipt: undefined as undefined | ((tx: any) => Receipt | null),
    sendFails: 0,
    updateFails: 0,
    httpStatus: 200,
  };
  const urls: Array<{ url: string; headers: any }> = [];

  const fetchImpl = (async (url: string, init: any) => {
    urls.push({ url, headers: init?.headers });
    if (script.httpStatus !== 200) return { ok: false, status: script.httpStatus, json: async () => ({}) } as any;
    const params = new URL(url).searchParams;
    return { ok: true, status: 200, json: async () => (script.quoteFor ? script.quoteFor(params) : script.quote) } as any;
  }) as typeof fetch;

  const store: TradeStore = {
    find: async (r) => trades.get(r) ?? null,
    create: async (row) => {
      events.push("store:create");
      const full: VenueTradeRow = { ...row, txHash: null, state: "submitted", failure: null };
      trades.set(row.reference, full);
      return { ...full };
    },
    update: async (r, data) => {
      if (script.updateFails > 0 && data.txHash) {
        script.updateFails--;
        throw new Error("db write failed");
      }
      events.push(`store:update:${Object.keys(data).join(",")}`);
      Object.assign(trades.get(r)!, data);
    },
  };

  const signer = {
    sendTransaction: async (tx: any) => {
      events.push(`sign:${tx.idempotencyKey.split(":").pop()}`);
      if (script.sendFails > 0) {
        script.sendFails--;
        throw new Error("signer unavailable");
      }
      let hash = sentByKey.get(tx.idempotencyKey);
      if (!hash) {
        hash = "0x" + (sentByKey.size + 1).toString(16).padStart(64, "0");
        sentByKey.set(tx.idempotencyKey, hash);
        const isApprove = tx.data.startsWith("0x095ea7b3");
        receipts.set(hash, isApprove ? { success: true, blockNumber: 1, logs: [] } : script.swapReceipt ? script.swapReceipt(tx) : null);
      }
      sends.push({ ...tx, hash });
      return { txHash: hash };
    },
  };

  const cfg: ZeroExConfig = {
    apiKey: "key-123", treasury: TREASURY, usdc: USDC, allowedTargets: [HOLDER], slippageBps: 100,
    maxBuyUsdcUnits: USD(525), signer, store, fetchImpl,
    getReceipt: async (h) => receipts.get(h) ?? null,
    sleep: async () => {}, confirmTimeoutMs: 5, pollMs: 1,
  };
  return { trades, events, receipts, sends, script, urls, cfg, store, signer };
}

/** A successful buy receipt: USDC leaves the treasury, `tokenOut` arrives. */
const buyReceipt = (usdcIn: bigint, tokenOut: bigint): Receipt => ({
  success: true, blockNumber: 2,
  logs: [log(USDC, TREASURY, HOLDER, usdcIn), log(TOKEN, HOLDER, TREASURY, tokenOut)],
});

let w: ReturnType<typeof world>;
beforeEach(() => {
  w = world();
});
const venue = () => createZeroExVenue(w.cfg);
const buyReq = (over: Record<string, any> = {}) => ({ reference: "buy-1", token: TOKEN_ARG, usdcUnits: USD(10), minTokenUnits: 99_000_000n, ...over });
const sellReq = (over: Record<string, any> = {}) => ({ reference: "sell-1", token: TOKEN_ARG, tokenUnits: 100_000_000n, minUsdcUnits: USD(9.9), ...over });

describe("it refuses to run unsafely configured", () => {
  it("without an API key", () => expect(() => createZeroExVenue({ ...w.cfg, apiKey: "" })).toThrow(/API key/));
  it("without an allowlist, or with one that has no valid address", () => {
    expect(() => createZeroExVenue({ ...w.cfg, allowedTargets: [] })).toThrow(/allowlist/);
    expect(() => createZeroExVenue({ ...w.cfg, allowedTargets: ["nope", "0x123"] })).toThrow(/allowlist/);
  });
  it("with bad treasury or USDC addresses", () => {
    expect(() => createZeroExVenue({ ...w.cfg, treasury: "x" })).toThrow(/valid treasury/);
    expect(() => createZeroExVenue({ ...w.cfg, usdc: "x" })).toThrow(/valid treasury/);
  });
});

describe("quotes", () => {
  it("asks 0x the documented way: chain, tokens, amount, taker, slippage, key and version", async () => {
    w.script.quoteFor = () => ({ ...w.script.quote, buyAmount: "100000000" });
    await venue().quoteBuy(TOKEN_ARG, USD(10));
    const { url, headers } = w.urls[0];
    const u = new URL(url);
    expect(`${u.origin}${u.pathname}`).toBe("https://api.0x.org/swap/allowance-holder/quote");
    expect(Object.fromEntries(u.searchParams)).toEqual({ chainId: "8453", sellToken: USDC, buyToken: TOKEN, sellAmount: "10000000", taker: TREASURY, slippageBps: "100" });
    expect(headers).toEqual({ "0x-api-key": "key-123", "0x-version": "v2" });
  });

  it("a buy quote gives the token units, and no price impact when the size matches the reference", async () => {
    w.script.quoteFor = () => ({ ...w.script.quote, buyAmount: "100000000" });
    expect(await venue().quoteBuy(TOKEN_ARG, USD(10))).toEqual({ tokenUnits: 100_000_000n, priceImpactBps: 0 });
  });

  it("measures price impact against a small reference quote", async () => {
    // $10 gets 1 token ($10/token). $400 gets 38 tokens ($10.53/token): 5% worse.
    w.script.quoteFor = (q) => ({ ...w.script.quote, buyAmount: q.get("sellAmount") === "10000000" ? "100000000" : "3800000000" });
    const r = await venue().quoteBuy(TOKEN_ARG, USD(400));
    expect(r.tokenUnits).toBe(3_800_000_000n);
    expect(r.priceImpactBps).toBe(500);
  });

  it("never reports a negative impact when the bigger trade gets a better price", async () => {
    w.script.quoteFor = (q) => ({ ...w.script.quote, buyAmount: q.get("sellAmount") === "10000000" ? "100000000" : "4200000000" });
    expect((await venue().quoteBuy(TOKEN_ARG, USD(400))).priceImpactBps).toBe(0);
  });

  it("reuses the reference quote instead of asking again every time", async () => {
    w.script.quoteFor = () => ({ ...w.script.quote });
    const v = venue();
    await v.quoteBuy(TOKEN_ARG, USD(20));
    const first = w.urls.length;
    await v.quoteBuy(TOKEN_ARG, USD(30));
    expect(w.urls.length - first).toBe(1); // one new quote, the reference was cached
  });

  it("a sell quote gives the USDC the treasury would receive", async () => {
    w.script.quoteFor = (q) => (q.get("sellToken") === USDC ? { ...w.script.quote, buyAmount: "100000000" } : { ...w.script.quote, buyAmount: "10000000" });
    expect(await venue().quoteSell(TOKEN_ARG, 100_000_000n)).toEqual({ usdcUnits: 10_000_000n, priceImpactBps: 0 });
  });

  it("no liquidity is a refusal the person can read, not a crash", async () => {
    w.script.quote = { liquidityAvailable: false };
    await expect(venue().quoteBuy(TOKEN_ARG, USD(10))).rejects.toBeInstanceOf(OrderRefused);
    await expect(venue().quoteSell(TOKEN_ARG, 1n)).rejects.toBeInstanceOf(OrderRefused);
  });

  it("an HTTP failure or a garbage amount is an ordinary error, never shown to the person as written", async () => {
    w.script.httpStatus = 503;
    await expect(venue().quoteBuy(TOKEN_ARG, USD(10))).rejects.toThrow("503");
    await expect(venue().quoteBuy(TOKEN_ARG, USD(10))).rejects.not.toBeInstanceOf(OrderRefused);
    w.script.httpStatus = 200;
    w.script.quote = { liquidityAvailable: true, buyAmount: "lots", minBuyAmount: "1", transaction: {} };
    await expect(venue().quoteBuy(TOKEN_ARG, USD(10))).rejects.toThrow(/not a number/);
  });
});

describe("buying", () => {
  beforeEach(() => {
    w.script.swapReceipt = () => buyReceipt(USD(10), 99_500_000n);
  });

  it("approves exactly what is being sold, swaps, and reports what the RECEIPT says moved, not the quote", async () => {
    const r = await venue().buy(buyReq());
    expect(r).toEqual({ status: "filled", tokenUnits: 99_500_000n, usdcUnits: USD(10), txHash: expect.stringMatching(/^0x/) });
    // The quote promised 100 tokens; 99.5 arrived. The report is 99.5.
    expect(w.sends).toHaveLength(2);
    expect(w.sends[0]).toMatchObject({ to: USDC, data: encodeApprove(HOLDER, USD(10)), value: "0x0" });
    expect(w.sends[1]).toMatchObject({ to: HOLDER, data: "0xswapdata", value: "0x0" });
  });

  it("the approval is for the exact amount and never unlimited", async () => {
    await venue().buy(buyReq());
    const amount = BigInt("0x" + w.sends[0].data.slice(-64));
    expect(amount).toBe(USD(10));
    expect(amount).toBeLessThan(2n ** 255n);
  });

  it("uses a distinct idempotency key per step, derived from the order reference", async () => {
    await venue().buy(buyReq());
    expect(w.sends.map((s) => s.idempotencyKey)).toEqual(["buy-1:approve", "buy-1:swap"]);
  });

  it("skips the approval when the allowance already covers it", async () => {
    w.script.quote = { ...w.script.quote, issues: { allowance: { spender: HOLDER, actual: "10000000", expected: "10000000" } } };
    await venue().buy(buyReq());
    expect(w.sends).toHaveLength(1);
    expect(w.sends[0].to).toBe(HOLDER);
  });

  it("writes the trade down BEFORE anything is broadcast", async () => {
    await venue().buy(buyReq());
    expect(w.events.indexOf("store:create")).toBeLessThan(w.events.indexOf("sign:approve"));
    expect(w.events.indexOf("store:create")).toBeLessThan(w.events.indexOf("sign:swap"));
    expect(w.trades.get("buy-1")).toMatchObject({ side: "buy", venue: "0x", tokenAddress: TOKEN.toLowerCase(), sellAmount: USD(10), state: "filled" });
    expect(w.trades.get("buy-1")!.txHash).toMatch(/^0x/);
  });

  it("is idempotent: asking again after the fill sends nothing and gives the same answer", async () => {
    const v = venue();
    const first = await v.buy(buyReq());
    const sendsAfterFirst = w.sends.length;
    const second = await v.buy(buyReq());
    expect(second).toEqual(first);
    expect(w.sends).toHaveLength(sendsAfterFirst);
  });
});

describe("what it refuses to send", () => {
  it("a quote whose guaranteed minimum is worse than the floor the order set: nothing is sent, and it is recorded", async () => {
    w.script.quote = { ...w.script.quote, minBuyAmount: "98000000" };
    const r = await venue().buy(buyReq({ minTokenUnits: 99_000_000n }));
    expect(r).toEqual({ status: "rejected", reason: "The price moved beyond what was allowed." });
    expect(w.sends).toEqual([]);
  });

  it("a quote pointing at a contract that is not on the allowlist", async () => {
    w.script.quote = { ...w.script.quote, transaction: { to: OTHER, data: "0xevil", value: "0" } };
    const r = await venue().buy(buyReq());
    expect(r).toMatchObject({ status: "rejected", reason: expect.stringContaining("not on the allowlist") });
    expect(w.sends).toEqual([]);
  });

  it("a quote asking for an approval to a spender that is not on the allowlist", async () => {
    w.script.quote = { ...w.script.quote, issues: { allowance: { spender: OTHER, actual: "0", expected: "10000000" } } };
    const r = await venue().buy(buyReq());
    expect(r).toMatchObject({ status: "rejected", reason: expect.stringContaining("approval") });
    expect(w.sends).toEqual([]);
  });

  it("a quote that tries to send ether", async () => {
    w.script.quote = { ...w.script.quote, transaction: { to: HOLDER, data: "0xswapdata", value: "1000000000000000000" } };
    expect(await venue().buy(buyReq())).toMatchObject({ status: "rejected", reason: "The quote tried to send ether." });
    expect(w.sends).toEqual([]);
  });

  it("a quote with no transaction at all", async () => {
    w.script.quote = { ...w.script.quote, transaction: undefined };
    expect(await venue().buy(buyReq())).toMatchObject({ status: "rejected" });
    expect(w.sends).toEqual([]);
  });

  it("a treasury that cannot cover the trade", async () => {
    w.script.quote = { ...w.script.quote, issues: { balance: { actual: "0", expected: "10000000" } } };
    expect(await venue().buy(buyReq())).toMatchObject({ status: "rejected", reason: expect.stringContaining("balance") });
    expect(w.sends).toEqual([]);
  });

  it("no liquidity", async () => {
    w.script.quote = { liquidityAvailable: false };
    expect(await venue().buy(buyReq())).toMatchObject({ status: "rejected", reason: expect.stringContaining("liquidity") });
    expect(w.sends).toEqual([]);
  });

  it("a buy above the defensive spending cap, whatever the order service allowed", async () => {
    expect(await venue().buy(buyReq({ usdcUnits: USD(600) }))).toMatchObject({ status: "rejected", reason: expect.stringContaining("most one trade") });
    expect(w.sends).toEqual([]);
  });

  it("a refusal made after the trade was recorded is remembered, and status agrees", async () => {
    w.script.swapReceipt = () => ({ success: false, blockNumber: 3, logs: [] });
    const v = venue();
    expect(await v.buy(buyReq())).toEqual({ status: "rejected", reason: "The swap was reverted on chain." });
    expect(await v.status("buy-1")).toEqual({ state: "rejected", reason: "The swap was reverted on chain." });
    expect(await v.buy(buyReq())).toEqual({ status: "rejected", reason: "The swap was reverted on chain." }); // and it never trades again
    expect(w.sends.filter((s) => s.to === HOLDER)).toHaveLength(1);
  });

  it("a reverted approval: no swap is sent", async () => {
    const originalSend = w.signer.sendTransaction;
    w.signer.sendTransaction = async (tx: any) => {
      const r = await originalSend(tx);
      if (tx.data.startsWith("0x095ea7b3")) w.receipts.set(r.txHash, { success: false, blockNumber: 1, logs: [] });
      return r;
    };
    const r = await venue().buy(buyReq());
    expect(r).toMatchObject({ status: "rejected", reason: "The approval was reverted on chain." });
    expect(w.sends.filter((s) => s.to === HOLDER)).toEqual([]);
  });
});

describe("when it cannot tell what happened (the dangerous case)", () => {
  it("a swap not yet mined is an ERROR, never a rejection, so the caller does not refund", async () => {
    w.script.swapReceipt = () => null; // sent, but nothing on chain yet
    await expect(venue().buy(buyReq())).rejects.toThrow(/not confirmed yet/);
    expect(w.trades.get("buy-1")!.txHash).toMatch(/^0x/); // we know the hash, so we can find out
    expect(w.trades.get("buy-1")!.state).toBe("submitted");
  });

  it("status says pending, and then filled once it lands, with the real amounts", async () => {
    w.script.swapReceipt = () => null;
    const v = venue();
    await v.buy(buyReq()).catch(() => {});
    expect(await v.status("buy-1")).toEqual({ state: "pending" });
    const hash = w.trades.get("buy-1")!.txHash!;
    w.receipts.set(hash, buyReceipt(USD(10), 99_200_000n));
    expect(await v.status("buy-1")).toEqual({ state: "filled", tokenUnits: 99_200_000n, usdcUnits: USD(10), txHash: hash });
    expect(w.trades.get("buy-1")!.state).toBe("filled");
  });

  it("asking to buy again while it is pending does not send a second swap", async () => {
    w.script.swapReceipt = () => null;
    const v = venue();
    await v.buy(buyReq()).catch(() => {});
    const swaps = () => w.sends.filter((s) => s.to === HOLDER).length;
    await v.buy(buyReq()).catch(() => {});
    await v.buy(buyReq()).catch(() => {});
    expect(swaps()).toBe(1);
  });

  it("a crash after the trade was recorded but before it was sent: status says the venue never got it, and a retry sends it once", async () => {
    w.script.sendFails = 1; // the signer fails on the very first call (the approval)
    const v = venue();
    await expect(v.buy(buyReq())).rejects.toThrow("signer unavailable");
    expect(w.trades.get("buy-1")!.txHash).toBeNull();
    expect(await v.status("buy-1")).toEqual({ state: "not_found" });
    w.script.swapReceipt = () => buyReceipt(USD(10), 100_000_000n);
    const r = await v.buy(buyReq());
    expect(r.status).toBe("filled");
    expect(w.sends.filter((s) => s.to === HOLDER)).toHaveLength(1);
  });

  it("a crash after the swap was sent but before its hash was saved: the retry gets the SAME transaction back, never a second one", async () => {
    w.script.swapReceipt = () => buyReceipt(USD(10), 100_000_000n);
    w.script.updateFails = 1; // saving the hash fails once
    const v = venue();
    await expect(v.buy(buyReq())).rejects.toThrow("db write failed");
    expect(w.trades.get("buy-1")!.txHash).toBeNull(); // the hash was lost...
    const r = await v.buy(buyReq()); // ...but the signer remembers it by idempotency key
    expect(r.status).toBe("filled");
    const swapSends = w.sends.filter((s) => s.idempotencyKey === "buy-1:swap");
    expect(swapSends.length).toBe(2); // it was asked twice...
    expect(new Set(swapSends.map((s) => s.hash)).size).toBe(1); // ...and it was one transaction
    expect(w.trades.get("buy-1")!.txHash).toBe(swapSends[0].hash); // which is the one now on record
  });

  it("an approval that is not yet mined is also unknown, not a failure", async () => {
    const originalSend = w.signer.sendTransaction;
    w.signer.sendTransaction = async (tx: any) => {
      const r = await originalSend(tx);
      if (tx.data.startsWith("0x095ea7b3")) w.receipts.set(r.txHash, null);
      return r;
    };
    await expect(venue().buy(buyReq())).rejects.toThrow(/Approval not confirmed/);
    expect(w.sends.filter((s) => s.to === HOLDER)).toEqual([]);
  });

  it("status for a trade it has never seen is not_found", async () => {
    expect(await venue().status("never-heard-of-it")).toEqual({ state: "not_found" });
  });
});

describe("selling", () => {
  const sellReceipt = (tokenIn: bigint, usdcOut: bigint): Receipt => ({
    success: true, blockNumber: 2,
    logs: [log(TOKEN, TREASURY, HOLDER, tokenIn), log(USDC, HOLDER, TREASURY, usdcOut)],
  });

  beforeEach(() => {
    w.script.quote = { ...w.script.quote, buyAmount: "9950000", minBuyAmount: "9900000", issues: { allowance: { spender: HOLDER, actual: "0", expected: "100000000" } } };
    w.script.swapReceipt = () => sellReceipt(100_000_000n, USD(9.93));
  });

  it("approves the TOKEN for the exact units, swaps, and reports what the receipt says", async () => {
    const r = await venue().sell(sellReq());
    expect(r).toEqual({ status: "filled", tokenUnits: 100_000_000n, usdcUnits: USD(9.93), txHash: expect.stringMatching(/^0x/) });
    expect(w.sends[0]).toMatchObject({ to: TOKEN, data: encodeApprove(HOLDER, 100_000_000n) });
    expect(w.trades.get("sell-1")).toMatchObject({ side: "sell", sellAmount: 100_000_000n });
  });

  it("refuses a quote whose guaranteed proceeds are below the floor", async () => {
    expect(await venue().sell(sellReq({ minUsdcUnits: USD(9.95) }))).toMatchObject({ status: "rejected", reason: "The price moved beyond what was allowed." });
    expect(w.sends).toEqual([]);
  });

  it("applies the same allowlist", async () => {
    w.script.quote = { ...w.script.quote, transaction: { to: OTHER, data: "0xevil", value: "0" } };
    expect(await venue().sell(sellReq())).toMatchObject({ status: "rejected" });
    expect(w.sends).toEqual([]);
  });

  it("status of a sale reads the receipt in the sell direction", async () => {
    const v = venue();
    await v.sell(sellReq());
    expect(await v.status("sell-1")).toMatchObject({ state: "filled", tokenUnits: 100_000_000n, usdcUnits: USD(9.93) });
  });
});

describe("encodeApprove", () => {
  it("is the ERC-20 approve call", () => {
    expect(encodeApprove(HOLDER, 255n)).toBe("0x095ea7b3" + "0".repeat(24) + "a".repeat(40) + "0".repeat(62) + "ff");
  });
  it("refuses a bad spender or a non-positive amount", () => {
    expect(() => encodeApprove("nope", 1n)).toThrow();
    expect(() => encodeApprove(HOLDER, 0n)).toThrow();
    expect(() => encodeApprove(HOLDER, -1n)).toThrow();
  });
});

describe("transferred (reading what moved)", () => {
  const r: Receipt = {
    success: true, blockNumber: 1,
    logs: [
      log(TOKEN, HOLDER, TREASURY, 60n),
      log(TOKEN, HOLDER, TREASURY, 40n), // two transfers in one swap add up
      log(TOKEN, TREASURY, HOLDER, 7n), // the other direction
      log(USDC, HOLDER, TREASURY, 999n), // a different token
      { address: TOKEN.toLowerCase(), topics: ["0xdeadbeef", pad(HOLDER), pad(TREASURY)], data: word(500n) }, // not a Transfer
      { address: TOKEN.toLowerCase(), topics: [TRANSFER], data: word(500n) }, // malformed
    ],
  };
  it("sums transfers to a holder, of one token, in one direction only", () => {
    expect(transferred(r, TOKEN, TREASURY, "to")).toBe(100n);
    expect(transferred(r, TOKEN, TREASURY, "from")).toBe(7n);
    expect(transferred(r, USDC, TREASURY, "to")).toBe(999n);
    expect(transferred(r, TOKEN, OTHER, "to")).toBe(0n);
  });
  it("matches addresses regardless of case", () => {
    expect(transferred(r, TOKEN.toUpperCase().replace("0X", "0x"), TREASURY.toLowerCase(), "to")).toBe(100n);
  });
});
