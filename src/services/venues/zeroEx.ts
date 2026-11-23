import { OrderRefused } from "@/services/orderErrors";
import { getReceipt as defaultGetReceipt, transferred, type Receipt } from "@/services/chainRpc";
import type { BuyQuote, SellQuote, StockVenue, VenueResult, VenueStatus, VenueToken } from "@/services/stockVenue";
import { createLogger } from "@/utils/logger";

const logger = createLogger("zero-ex-venue");

// ============================================
// A stock venue backed by the 0x Swap API (AllowanceHolder flow)
//
// Documented by Base for trading B20 tokens: request a firm quote, approve the
// sell token to the address the API names, send the quote's transaction, and
// wait for it to be mined. The treasury is the taker.
//
// What keeps this safe with real money:
//
//  - It will not run unless an API key AND an explicit allowlist of contract
//    addresses are configured. Anything the API says to approve or call that is
//    not on the allowlist is refused, so a compromised or buggy API response
//    cannot send treasury funds somewhere else.
//  - Approvals are for the EXACT amount being sold, never unlimited.
//  - A trade row is written BEFORE anything is broadcast. A crash can never
//    lose track of a trade, and `status` can always say what happened.
//  - The swap enforces a minimum on chain (`minBuyAmount`). We refuse a quote
//    whose minimum is worse than the floor the order set.
//  - Amounts reported are read from the transaction receipt (what moved), never
//    taken from the quote (what was promised).
//  - The signer is told an idempotency key per step, so a retry cannot send a
//    second transaction.
//  - A definite refusal is recorded and returned as `rejected`. Not knowing
//    whether a swap landed (not yet mined) is an error, never a rejection, so
//    the caller does not refund a trade that may have happened.
//
// Not yet exercised against the live chain. It has been tested against fakes of
// 0x, the signer and the chain. Whether 0x quotes and simulates B20 tokens (they
// are native precompiles) must be confirmed with a small real trade.
// ============================================

const BASE_CHAIN_ID = 8453;
const USDC_DECIMALS = 6;
const APPROVE_SELECTOR = "095ea7b3";
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

/** Sends a transaction from the treasury. `idempotencyKey` makes a retry return the first result. */
export interface TradeSigner {
  sendTransaction(p: { to: string; data: string; value?: string; idempotencyKey: string }): Promise<{ txHash: string }>;
}

export interface VenueTradeRow {
  reference: string;
  venue: string;
  side: "buy" | "sell";
  tokenAddress: string;
  sellAmount: bigint;
  minBuyAmount: bigint;
  txHash: string | null;
  state: "submitted" | "filled" | "rejected";
  failure: string | null;
}

export interface TradeStore {
  find(reference: string): Promise<VenueTradeRow | null>;
  create(row: Omit<VenueTradeRow, "txHash" | "state" | "failure">): Promise<VenueTradeRow>;
  update(reference: string, data: Partial<Pick<VenueTradeRow, "txHash" | "state" | "failure">>): Promise<void>;
}

export interface ZeroExConfig {
  apiKey: string;
  baseUrl?: string;
  /** The treasury wallet that holds the tokens and is the taker. */
  treasury: string;
  /** USDC on Base. */
  usdc: string;
  /** Contract addresses we are willing to approve to or call. Required. */
  allowedTargets: string[];
  /** The slippage the swap enforces on chain, in basis points. */
  slippageBps: number;
  /** The most USDC a single buy may spend, in USDC units. A defensive cap next to the order limits. */
  maxBuyUsdcUnits: bigint;
  signer: TradeSigner;
  store: TradeStore;
  fetchImpl?: typeof fetch;
  getReceipt?: (txHash: string) => Promise<Receipt | null>;
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for a transaction to be mined before reporting "not confirmed yet". */
  confirmTimeoutMs?: number;
  pollMs?: number;
}

interface ZQuote {
  liquidity: boolean;
  buyAmount: bigint;
  minBuyAmount: bigint;
  to?: string;
  data?: string;
  value?: string;
  spender?: string;
  allowanceActual?: bigint;
  allowanceExpected?: bigint;
  balanceIssue: boolean;
}

export function encodeApprove(spender: string, amount: bigint): string {
  if (!ADDRESS_RE.test(spender)) throw new Error("Invalid spender address");
  if (amount <= 0n) throw new Error("Invalid approval amount");
  return "0x" + APPROVE_SELECTOR + spender.slice(2).toLowerCase().padStart(64, "0") + amount.toString(16).padStart(64, "0");
}

export function createZeroExVenue(cfg: ZeroExConfig): StockVenue {
  if (!cfg.apiKey) throw new Error("0x venue needs an API key");
  const allowed = new Set(cfg.allowedTargets.filter((a) => ADDRESS_RE.test(a)).map((a) => a.toLowerCase()));
  if (allowed.size === 0) throw new Error("0x venue needs an allowlist of contract addresses (STOCKS_0X_ALLOWED_TARGETS)");
  if (!ADDRESS_RE.test(cfg.treasury) || !ADDRESS_RE.test(cfg.usdc)) throw new Error("0x venue needs valid treasury and USDC addresses");

  const base = cfg.baseUrl ?? "https://api.0x.org";
  const doFetch = cfg.fetchImpl ?? fetch;
  const receiptOf = cfg.getReceipt ?? defaultGetReceipt;
  const sleep = cfg.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const confirmTimeoutMs = cfg.confirmTimeoutMs ?? 60_000;
  const pollMs = cfg.pollMs ?? 2_000;
  const usdc = cfg.usdc.toLowerCase();
  const treasury = cfg.treasury.toLowerCase();
  const isAllowed = (a?: string) => !!a && allowed.has(a.toLowerCase());

  /** A firm quote from 0x. Throws if 0x cannot be reached or answers with an error. */
  async function quote(sellToken: string, buyToken: string, sellAmount: bigint): Promise<ZQuote> {
    const params = new URLSearchParams({
      chainId: String(BASE_CHAIN_ID),
      sellToken,
      buyToken,
      sellAmount: sellAmount.toString(),
      taker: cfg.treasury,
      slippageBps: String(cfg.slippageBps),
    });
    const res = await doFetch(`${base}/swap/allowance-holder/quote?${params}`, {
      headers: { "0x-api-key": cfg.apiKey, "0x-version": "v2" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`0x quote failed (${res.status})`);
    const b: any = await res.json();
    if (b.liquidityAvailable === false) return { liquidity: false, buyAmount: 0n, minBuyAmount: 0n, balanceIssue: false };
    const big = (v: unknown) => {
      try {
        return BigInt(String(v));
      } catch {
        throw new Error("0x quote had an amount that is not a number");
      }
    };
    return {
      liquidity: true,
      buyAmount: big(b.buyAmount),
      minBuyAmount: big(b.minBuyAmount),
      to: b.transaction?.to,
      data: b.transaction?.data,
      value: b.transaction?.value,
      spender: b.issues?.allowance?.spender,
      allowanceActual: b.issues?.allowance ? big(b.issues.allowance.actual ?? 0) : undefined,
      allowanceExpected: b.issues?.allowance ? big(b.issues.allowance.expected ?? sellAmount) : undefined,
      balanceIssue: !!b.issues?.balance,
    };
  }

  // Price impact: how much worse the price for this size is than for a small one. Taken
  // from two quotes so it needs nothing 0x does not document.
  const refCache = new Map<string, { at: number; price: number }>();
  async function referencePrice(sellToken: string, buyToken: string, sellAmount: bigint): Promise<number | null> {
    const key = `${sellToken}>${buyToken}`;
    const hit = refCache.get(key);
    if (hit && Date.now() - hit.at < 30_000) return hit.price;
    const q = await quote(sellToken, buyToken, sellAmount);
    if (!q.liquidity || q.buyAmount <= 0n) return null;
    const price = Number(q.buyAmount) / Number(sellAmount);
    refCache.set(key, { at: Date.now(), price });
    return price;
  }
  const impactBps = (refPrice: number | null, sellAmount: bigint, buyAmount: bigint) => {
    if (!refPrice || refPrice <= 0) return 0;
    const price = Number(buyAmount) / Number(sellAmount);
    return Math.max(0, Math.round(((refPrice - price) / refPrice) * 10_000));
  };

  const REF_USDC = BigInt(10 * 10 ** USDC_DECIMALS); // a $10 reference

  async function quoteBuy(token: VenueToken, usdcUnits: bigint): Promise<BuyQuote> {
    const q = await quote(cfg.usdc, token.address, usdcUnits);
    if (!q.liquidity || q.buyAmount <= 0n) throw new OrderRefused("There isn't enough market liquidity for that right now. Try a smaller amount.");
    const ref = await referencePrice(cfg.usdc, token.address, REF_USDC);
    return { tokenUnits: q.buyAmount, priceImpactBps: impactBps(ref, usdcUnits, q.buyAmount) };
  }

  async function quoteSell(token: VenueToken, tokenUnits: bigint): Promise<SellQuote> {
    const q = await quote(token.address, cfg.usdc, tokenUnits);
    if (!q.liquidity || q.buyAmount <= 0n) throw new OrderRefused("There isn't enough market liquidity for that right now. Try a smaller amount.");
    // A $10 worth of the token, from what a $10 buy returns, is the reference size to sell.
    const buyRef = await quote(cfg.usdc, token.address, REF_USDC);
    const ref = buyRef.liquidity && buyRef.buyAmount > 0n ? await referencePrice(token.address, cfg.usdc, buyRef.buyAmount) : null;
    return { usdcUnits: q.buyAmount, priceImpactBps: impactBps(ref, tokenUnits, q.buyAmount) };
  }

  /** Wait for a transaction to be mined. Returns null if it is not yet: that is "unknown", never "failed". */
  async function waitForReceipt(txHash: string): Promise<Receipt | null> {
    const deadline = Date.now() + confirmTimeoutMs;
    for (;;) {
      const r = await receiptOf(txHash);
      if (r) return r;
      if (Date.now() >= deadline) return null;
      await sleep(pollMs);
    }
  }

  /** What a mined swap actually moved, read from its receipt. */
  function outcome(row: VenueTradeRow, receipt: Receipt) {
    if (row.side === "buy") {
      return {
        tokenUnits: transferred(receipt, row.tokenAddress, treasury, "to"),
        usdcUnits: transferred(receipt, usdc, treasury, "from"),
      };
    }
    return {
      tokenUnits: transferred(receipt, row.tokenAddress, treasury, "from"),
      usdcUnits: transferred(receipt, usdc, treasury, "to"),
    };
  }

  async function reject(reference: string, reason: string, persisted: boolean): Promise<VenueResult> {
    if (persisted) await cfg.store.update(reference, { state: "rejected", failure: reason });
    return { status: "rejected", reason };
  }

  /** Turn a row with a transaction into its result, waiting for it to be mined. */
  async function resolve(row: VenueTradeRow): Promise<VenueResult> {
    const receipt = await waitForReceipt(row.txHash!);
    if (!receipt) throw new Error("Swap not confirmed yet"); // unknown: the caller must not refund
    if (!receipt.success) return reject(row.reference, "The swap was reverted on chain.", true);
    const amounts = outcome(row, receipt);
    await cfg.store.update(row.reference, { state: "filled" });
    return { status: "filled", tokenUnits: amounts.tokenUnits, usdcUnits: amounts.usdcUnits, txHash: row.txHash! };
  }

  async function trade(side: "buy" | "sell", p: { reference: string; token: VenueToken; sellAmount: bigint; minBuyAmount: bigint }): Promise<VenueResult> {
    const { reference } = p;
    const sellToken = side === "buy" ? cfg.usdc : p.token.address;
    const buyToken = side === "buy" ? p.token.address : cfg.usdc;

    // Resume, never repeat: a reference already seen is the same trade.
    const existing = await cfg.store.find(reference);
    if (existing) {
      if (existing.state === "rejected") return { status: "rejected", reason: existing.failure ?? "rejected" };
      if (existing.txHash) return resolve(existing);
      // Recorded but never handed to the signer: carry on from the quote, with the same idempotency keys.
    }

    if (side === "buy" && p.sellAmount > cfg.maxBuyUsdcUnits) return reject(reference, "That is above the most one trade may spend.", !!existing);

    const q = await quote(sellToken, buyToken, p.sellAmount);
    if (!q.liquidity) return reject(reference, "No market liquidity for that right now.", !!existing) ;
    if (q.minBuyAmount < p.minBuyAmount) return reject(reference, "The price moved beyond what was allowed.", !!existing);
    if (q.balanceIssue) return reject(reference, "The treasury balance cannot cover that trade.", !!existing);
    // Whatever 0x tells us to call or approve must be on our list, and must not send ether.
    if (!isAllowed(q.to) || !q.data) return reject(reference, "The quote pointed at a contract that is not on the allowlist.", !!existing);
    if (q.spender && !isAllowed(q.spender)) return reject(reference, "The quote asked for an approval to a contract that is not on the allowlist.", !!existing);
    if (q.value && BigInt(q.value) !== 0n) return reject(reference, "The quote tried to send ether.", !!existing);

    // Write down the trade before anything can be broadcast.
    let row = existing;
    if (!row) {
      row = await cfg.store.create({ reference, venue: "0x", side, tokenAddress: p.token.address.toLowerCase(), sellAmount: p.sellAmount, minBuyAmount: q.minBuyAmount });
    }

    // Approve exactly what is being sold, only if the allowance is short.
    if (q.spender && (q.allowanceActual ?? 0n) < (q.allowanceExpected ?? p.sellAmount)) {
      const approval = await cfg.signer.sendTransaction({
        to: sellToken,
        data: encodeApprove(q.spender, p.sellAmount),
        value: "0x0",
        idempotencyKey: `${reference}:approve`.slice(0, 64),
      });
      const ar = await waitForReceipt(approval.txHash);
      if (!ar) throw new Error("Approval not confirmed yet");
      if (!ar.success) return reject(reference, "The approval was reverted on chain.", true);
    }

    const sent = await cfg.signer.sendTransaction({ to: q.to!, data: q.data!, value: "0x0", idempotencyKey: `${reference}:swap`.slice(0, 64) });
    await cfg.store.update(reference, { txHash: sent.txHash });
    logger.info("Swap sent", { reference, side, txHash: sent.txHash });
    return resolve({ ...row, txHash: sent.txHash });
  }

  return {
    id: "0x",
    quoteBuy,
    quoteSell,
    buy: (req) => trade("buy", { reference: req.reference, token: req.token, sellAmount: req.usdcUnits, minBuyAmount: req.minTokenUnits }),
    sell: (req) => trade("sell", { reference: req.reference, token: req.token, sellAmount: req.tokenUnits, minBuyAmount: req.minUsdcUnits }),

    async status(reference): Promise<VenueStatus> {
      const row = await cfg.store.find(reference);
      if (!row) return { state: "not_found" };
      if (row.state === "rejected") return { state: "rejected", reason: row.failure ?? "rejected" };
      // Recorded but never handed to the signer: the venue effectively never received it.
      if (!row.txHash) return { state: "not_found" };
      const receipt = await receiptOf(row.txHash);
      if (!receipt) return { state: "pending" };
      if (!receipt.success) {
        await cfg.store.update(reference, { state: "rejected", failure: "The swap was reverted on chain." });
        return { state: "rejected", reason: "The swap was reverted on chain." };
      }
      const amounts = outcome(row, receipt);
      if (row.state !== "filled") await cfg.store.update(reference, { state: "filled" });
      return { state: "filled", tokenUnits: amounts.tokenUnits, usdcUnits: amounts.usdcUnits, txHash: row.txHash };
    },
  };
}
