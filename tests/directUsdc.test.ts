import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const cfg: any = vi.hoisted(() => ({
  logLevel: "silent",
  treasury: { address: "0x2527D02599Ba641c19FEa793cD0F167589a0f10D", tokenContract: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", tokenDecimals: 6, rpcUrl: "http://rpc.test", maxWithdrawUsd: 2000 },
  nearIntents: {},
  directUsdc: { enabled: true, confirmations: 3, chunkBlocks: 2000, lookbackBlocks: 1800, maxTag: 499 },
  rails: {},
}));
vi.mock("@/config", () => ({ config: cfg }));

const settleInvoicePayment = vi.fn();
vi.mock("@/services/invoice", () => ({ settleInvoicePayment: (...a: any[]) => settleInvoicePayment(...a) }));
vi.mock("@/services/nearIntents", () => ({ EVM_ADDRESS_RE: /^0x[a-fA-F0-9]{40}$/, nearIntents: {} }));

const txRows = new Map<string, any>();
vi.mock("@/db/prisma", async () => {
  const { makeIntentTables } = await import("./helpers/fakeIntents");
  const tables = makeIntentTables();
  return {
    __tables: tables,
    prisma: {
      paymentIntent: tables.paymentIntent,
      railEvent: tables.railEvent,
      railCursor: tables.railCursor,
      transaction: {
        findUnique: async ({ where }: any) => txRows.get(where.reference) ?? null,
        updateMany: async ({ where, data }: any) => {
          const row = txRows.get(where.reference);
          if (row) Object.assign(row, data);
          return { count: row ? 1 : 0 };
        },
        update: async ({ where, data }: any) => Object.assign(txRows.get(where.reference), data),
      },
    },
  };
});
const tables = ((await import("@/db/prisma")) as any).__tables;

import {
  allocateDirectPayment,
  scanDirectUsdc,
  resetDirectScanState,
  releaseStaleDirectPayments,
  isDirectUsdcEnabled,
  openKeyFor,
} from "@/services/directUsdc";
import { directUsdcRail } from "@/rails/directUsdc";
import { checkLimits } from "@/rails/limits";

const TREASURY = cfg.treasury.address;
const hexn = (n: number) => `0x${n.toString(16)}`;
const log = (value: bigint, extra: object = {}) => ({
  data: `0x${value.toString(16).padStart(64, "0")}`,
  transactionHash: "0xabc" + Math.random().toString(16).slice(2, 10),
  logIndex: "0x1",
  blockNumber: hexn(900),
  topics: ["0xddf2", "0x" + "00".repeat(12) + "11".repeat(20), "0x" + "00".repeat(12) + TREASURY.slice(2).toLowerCase()],
  ...extra,
});

/** A fake Base RPC. */
function rpc(opts: { head: number; logs?: any[]; onGetLogs?: (p: any) => any[] }) {
  const calls: any[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: any) => {
    const { method, params } = JSON.parse(init.body);
    calls.push({ method, params });
    const result = method === "eth_blockNumber" ? hexn(opts.head) : method === "eth_getLogs" ? (opts.onGetLogs ? opts.onGetLogs(params[0]) : opts.logs ?? []) : null;
    return { ok: true, status: 200, json: async () => ({ result }) };
  });
  return calls;
}

beforeEach(() => {
  tables.reset();
  txRows.clear();
  settleInvoicePayment.mockReset();
  settleInvoicePayment.mockResolvedValue({ settled: true });
  cfg.directUsdc = { enabled: true, confirmations: 3, chunkBlocks: 2000, lookbackBlocks: 1800, maxTag: 499 };
  cfg.nearIntents = {};
  cfg.rails = {};
  resetDirectScanState();
});
afterEach(() => vi.unstubAllGlobals());

describe("isDirectUsdcEnabled", () => {
  it("needs the flag, an EVM treasury, and a live network", () => {
    expect(isDirectUsdcEnabled()).toBe(true);
    cfg.directUsdc.enabled = false;
    expect(isDirectUsdcEnabled()).toBe(false);
    cfg.directUsdc.enabled = true;
    cfg.treasury.address = "treasury.near"; // a NEAR Intents treasury has no Base address to pay
    expect(isDirectUsdcEnabled()).toBe(false);
    cfg.treasury.address = TREASURY;
    cfg.nearIntents = { network: "tidepool" };
    expect(isDirectUsdcEnabled()).toBe(false);
  });
});

describe("allocateDirectPayment", () => {
  it("adds a tag of 1..499 micro-USDC and holds that exact amount", async () => {
    const a = await allocateDirectPayment({ invoiceReference: "INV-1", userId: "m1", baseUnits: "3448276" });
    expect(a.tag).toBeGreaterThanOrEqual(1);
    expect(a.tag).toBeLessThanOrEqual(499);
    expect(a.units).toBe((3448276n + BigInt(a.tag)).toString());
    const [row] = [...tables.intents.values()];
    expect(row).toMatchObject({ reference: "INV-1:direct", rail: "direct-usdc", state: "awaiting_funds", openKey: openKeyFor(a.units) });
  });

  it("gives the same amount back when the page is reloaded, and burns no second tag", async () => {
    const a = await allocateDirectPayment({ invoiceReference: "INV-1", baseUnits: "1000000" });
    const b = await allocateDirectPayment({ invoiceReference: "INV-1", baseUnits: "1000000" });
    expect(b.units).toBe(a.units);
    expect(tables.intents.size).toBe(1);
  });

  it("two invoices for the same amount never share a tagged amount", async () => {
    const units = new Set<string>();
    for (let i = 0; i < 60; i++) units.add((await allocateDirectPayment({ invoiceReference: `INV-${i}`, baseUnits: "1000000" })).units);
    expect(units.size).toBe(60);
  });

  it("two simultaneous requests for one invoice end with one payment", async () => {
    const [a, b] = await Promise.all([
      allocateDirectPayment({ invoiceReference: "INV-1", baseUnits: "1000000" }),
      allocateDirectPayment({ invoiceReference: "INV-1", baseUnits: "1000000" }),
    ]);
    expect(a.units).toBe(b.units);
    expect(tables.intents.size).toBe(1);
  });

  it("says so, rather than reusing an amount, when every tag is taken", async () => {
    cfg.directUsdc.maxTag = 3;
    for (let i = 0; i < 3; i++) await allocateDirectPayment({ invoiceReference: `INV-${i}`, baseUnits: "1000000" });
    await expect(allocateDirectPayment({ invoiceReference: "INV-X", baseUnits: "1000000" })).rejects.toThrow("Too many direct payments");
  });

  it("a finished payment frees its amount for the next invoice", async () => {
    cfg.directUsdc.maxTag = 1;
    const a = await allocateDirectPayment({ invoiceReference: "INV-1", baseUnits: "1000000" });
    await expect(allocateDirectPayment({ invoiceReference: "INV-2", baseUnits: "1000000" })).rejects.toThrow("Too many");
    const row = [...tables.intents.values()][0];
    row.state = "settled";
    row.openKey = null; // what the engine does on a final state
    const b = await allocateDirectPayment({ invoiceReference: "INV-2", baseUnits: "1000000" });
    expect(b.units).toBe(a.units);
  });

  it("refuses to restart a payment that already finished", async () => {
    await allocateDirectPayment({ invoiceReference: "INV-1", baseUnits: "1000000" });
    const row = [...tables.intents.values()][0];
    row.state = "settled";
    row.openKey = null;
    await expect(allocateDirectPayment({ invoiceReference: "INV-1", baseUnits: "1000000" })).rejects.toThrow("already started");
  });

  it("refuses an amount of zero", async () => {
    await expect(allocateDirectPayment({ invoiceReference: "INV-1", baseUnits: "0" })).rejects.toThrow("above zero");
  });
});

describe("scanDirectUsdc", () => {
  it("settles the invoice whose exact tagged amount arrived, and records the proof", async () => {
    const a = await allocateDirectPayment({ invoiceReference: "INV-1", userId: "m1", baseUnits: "3448276" });
    txRows.set("INV-1", { metadata: { nearIntents: {} }, status: "processing" });
    const hit = log(BigInt(a.units), { transactionHash: "0xfeed" });
    rpc({ head: 1000, logs: [hit] });

    const r = await scanDirectUsdc();
    expect(r).toMatchObject({ transfers: 1, settled: 1, unmatched: 0 });
    expect(settleInvoicePayment).toHaveBeenCalledWith("INV-1", expect.objectContaining({ provider: "direct-usdc", crypto: expect.objectContaining({ txHash: "0xfeed", txUrl: "https://basescan.org/tx/0xfeed", paidWith: `${(Number(a.units) / 1e6).toFixed(6)} USDC on Base` }) }));
    expect(txRows.get("INV-1")).toMatchObject({ status: "completed", metadata: { receipt: { txHash: "0xfeed" } } });
    const row = [...tables.intents.values()][0];
    expect(row).toMatchObject({ state: "settled", openKey: null }); // the tag is free again
    expect(tables.events[0]).toMatchObject({ type: "settled", applied: true });
  });

  it("matches the exact amount only: an underpayment or a different amount settles nothing", async () => {
    const a = await allocateDirectPayment({ invoiceReference: "INV-1", baseUnits: "3448276" });
    rpc({ head: 1000, logs: [log(BigInt(a.units) - 1n), log(BigInt(a.units) + 1n), log(1n)] });
    const r = await scanDirectUsdc();
    expect(r).toMatchObject({ transfers: 3, settled: 0, unmatched: 3 });
    expect(settleInvoicePayment).not.toHaveBeenCalled();
  });

  it("does not settle the same transfer twice, even if the cursor is lost", async () => {
    const a = await allocateDirectPayment({ invoiceReference: "INV-1", baseUnits: "3448276" });
    const hit = log(BigInt(a.units), { transactionHash: "0xsame" });
    rpc({ head: 1000, logs: [hit] });
    await scanDirectUsdc();
    tables.cursors.clear(); // a lost cursor rescans the same blocks
    resetDirectScanState();
    const again = await scanDirectUsdc();
    expect(settleInvoicePayment).toHaveBeenCalledTimes(1);
    expect(again.settled).toBe(0); // the tag was freed, so nothing matches any more
  });

  it("holds the cursor back when settling fails, and settles on the retry", async () => {
    const a = await allocateDirectPayment({ invoiceReference: "INV-1", baseUnits: "3448276" });
    rpc({ head: 1000, logs: [log(BigInt(a.units))] });
    settleInvoicePayment.mockRejectedValueOnce(new Error("ledger down"));

    await expect(scanDirectUsdc()).rejects.toThrow("ledger down");
    expect(tables.cursors.has("direct-usdc:base")).toBe(false); // the range is not skipped
    expect([...tables.intents.values()][0].state).toBe("awaiting_funds"); // and not marked paid with nothing credited

    resetDirectScanState();
    expect((await scanDirectUsdc()).settled).toBe(1);
    expect([...tables.intents.values()][0].state).toBe("settled");
  });

  it("waits for confirmations, and resumes from where it stopped", async () => {
    const calls = rpc({ head: 1000 });
    await scanDirectUsdc();
    expect(tables.cursors.get("direct-usdc:base")).toBe("997"); // 1000 - 3 confirmations
    resetDirectScanState();
    calls.length = 0;
    rpc({ head: 1010 });
    await scanDirectUsdc();
    expect(tables.cursors.get("direct-usdc:base")).toBe("1007");
  });

  it("does nothing, and asks nothing, when there is nothing new", async () => {
    tables.cursors.set("direct-usdc:base", "997");
    const calls = rpc({ head: 1000 });
    const r = await scanDirectUsdc();
    expect(r.blocks).toBe(0);
    expect(calls.map((c) => c.method)).toEqual(["eth_blockNumber"]);
  });

  it("filters the logs to USDC transfers into the treasury, in ranges the RPC accepts", async () => {
    tables.cursors.set("direct-usdc:base", "100");
    const ranges: Array<[string, string]> = [];
    const calls = rpc({ head: 5200, onGetLogs: (p) => (ranges.push([p.fromBlock, p.toBlock]), []) });
    await scanDirectUsdc();
    const q = calls.find((c) => c.method === "eth_getLogs")!.params[0];
    expect(q.address).toBe(cfg.treasury.tokenContract);
    expect(q.topics[0]).toBe("0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef");
    expect(q.topics[1]).toBeNull();
    expect(q.topics[2]).toBe("0x" + "00".repeat(12) + TREASURY.slice(2).toLowerCase());
    expect(ranges).toEqual([[hexn(101), hexn(2100)], [hexn(2101), hexn(4100)], [hexn(4101), hexn(5197)]]);
    expect(tables.cursors.get("direct-usdc:base")).toBe("5197");
  });

  it("starts a first run a little way back, not at the beginning of the chain", async () => {
    const calls = rpc({ head: 100_000 });
    await scanDirectUsdc();
    const first = calls.find((c) => c.method === "eth_getLogs")!.params[0];
    expect(parseInt(first.fromBlock, 16)).toBe(100_000 - 3 - 1800 + 1);
  });

  it("ignores logs the chain has since removed (a reorg)", async () => {
    const a = await allocateDirectPayment({ invoiceReference: "INV-1", baseUnits: "3448276" });
    rpc({ head: 1000, logs: [log(BigInt(a.units), { removed: true })] });
    expect((await scanDirectUsdc()).settled).toBe(0);
  });

  it("is a no-op while disabled", async () => {
    cfg.directUsdc.enabled = false;
    const calls = rpc({ head: 1000 });
    expect((await scanDirectUsdc()).skipped).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("runs one scan at a time and skips calls that come too quickly", async () => {
    const calls = rpc({ head: 1000 });
    const [a, b] = await Promise.all([scanDirectUsdc(), scanDirectUsdc()]);
    expect(a).toBe(b); // the second call shared the first's scan
    expect(calls.filter((c) => c.method === "eth_blockNumber")).toHaveLength(1);
    const third = await scanDirectUsdc(); // immediately after
    expect(third.skipped).toBe(true);
  });

  it("settles a late payment on an invoice that has expired", async () => {
    const a = await allocateDirectPayment({ invoiceReference: "INV-1", baseUnits: "3448276" });
    [...tables.intents.values()][0].state = "expired"; // the window closed; the tag is still held
    rpc({ head: 1000, logs: [log(BigInt(a.units))] });
    expect((await scanDirectUsdc()).settled).toBe(1);
  });
});

describe("releaseStaleDirectPayments", () => {
  it("frees tags that can no longer arrive, and keeps recent ones", async () => {
    await allocateDirectPayment({ invoiceReference: "OLD", baseUnits: "1000000" });
    await allocateDirectPayment({ invoiceReference: "NEW", baseUnits: "1000000" });
    const old = [...tables.intents.values()].find((i: any) => i.reference === "OLD:direct");
    old.createdAt = new Date(Date.now() - 30 * 3600_000);
    expect(await releaseStaleDirectPayments()).toBe(1);
    expect(old).toMatchObject({ state: "expired", openKey: null });
    expect([...tables.intents.values()].find((i: any) => i.reference === "NEW:direct").openKey).not.toBeNull();
  });
});

describe("the rail", () => {
  it("returns the treasury address and the tagged amount, formatted for a person", async () => {
    const out = await directUsdcRail.initiate!({ kind: "direct_transfer", reference: "INV-1", userId: "m1", baseUnits: "3448276" });
    expect(out).toMatchObject({ rail: "direct-usdc", depositAddress: TREASURY, railRef: "INV-1:direct", amountOut: "3448276" });
    expect(BigInt(out.amountIn!) - 3448276n).toBeGreaterThanOrEqual(1n);
    expect(out.amountInFormatted).toBe((Number(out.amountIn) / 1e6).toFixed(6));
  });

  it("refuses when disabled, and refuses the wrong kind of request", async () => {
    cfg.directUsdc.enabled = false;
    await expect(directUsdcRail.initiate!({ kind: "direct_transfer", reference: "INV-1", baseUnits: "1" })).rejects.toThrow("not enabled");
    cfg.directUsdc.enabled = true;
    await expect(directUsdcRail.initiate!({ kind: "swap", swapType: "EXACT_INPUT", amount: "1", deadline: new Date() })).rejects.toThrow("cannot swap");
  });

  it("has no swap floor, but is capped like other inbound money, and is only offered for USDC on Base", () => {
    const caps = directUsdcRail.capabilities();
    expect(caps).toMatchObject({ kinds: ["direct_transfer"], assets: ["USDC"], chains: ["base"], maxUsd: 2000 });
    expect(caps.minUsd).toBeUndefined();
  });

  it("is never offered for a swap, so 1Click's minimum still governs top-ups", () => {
    const r = checkLimits("in", { kind: "swap", usd: 1 });
    expect(r).toEqual({ ok: false, reason: "below_min", minUsd: 5 });
  });

  it("can be limited on its own", () => {
    cfg.rails = { "direct-usdc": { minUsd: 2, maxUsd: 50 } };
    expect(directUsdcRail.capabilities()).toMatchObject({ minUsd: 2, maxUsd: 50 });
  });
});
