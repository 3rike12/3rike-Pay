import { Prisma } from "@prisma/client";
import { config } from "@/config";
import { prisma } from "@/db/prisma";
import { applyRailEvent } from "@/rails/settlement";
import { settleInvoicePayment } from "@/services/invoice";
import { EVM_ADDRESS_RE } from "@/services/nearIntents";
import { createLogger } from "@/utils/logger";

const logger = createLogger("direct-usdc");

// ============================================
// Direct USDC on Base
//
// A customer who already holds USDC sends it straight to the treasury. No swap,
// so no 1Click fee, minimum or same-asset restriction.
//
// One treasury address receives every payment, so a transfer must identify
// itself: each open invoice is given a unique TAG added to its amount (a few
// micro-USDC, 0.000001 to 0.000499). The customer sends the exact tagged
// amount; an incoming transfer of that exact value settles that invoice.
//
//   - `PaymentIntent.openKey` is unique, so two open invoices can never hold the
//     same amount, even under concurrency.
//   - A scanner reads USDC Transfer logs to the treasury and settles matches.
//   - A transfer with no matching open invoice is logged and left alone: it is
//     either another flow's money (1Click deliveries land here too) or an
//     underpayment or overpayment, which needs a person.
// ============================================

export const DIRECT_ASSET = "direct:usdc-base";
export const DIRECT_SYMBOL = "USDC";
export const DIRECT_CHAIN = "base";
const CURSOR_KEY = "direct-usdc:base";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"; // Transfer(address,address,uint256)

/** The reference of the payment attempt that holds a tag, distinct from the invoice's own reference. */
export const directReference = (invoiceReference: string) => `${invoiceReference}:direct`;
export const openKeyFor = (units: bigint | string) => `usdc-base:${units.toString()}`;

/** On, and able to work: the treasury is an EVM address, and this is not the testnet demo network. */
export function isDirectUsdcEnabled(): boolean {
  const c = config as any;
  return Boolean(
    c.directUsdc?.enabled &&
      typeof c.treasury?.address === "string" &&
      EVM_ADDRESS_RE.test(c.treasury.address) &&
      c.nearIntents?.network !== "tidepool"
  );
}

/** What the pay page needs to offer and build a transfer for USDC on Base. */
export function directToken() {
  const t = config.treasury;
  return {
    assetId: DIRECT_ASSET,
    symbol: DIRECT_SYMBOL,
    blockchain: DIRECT_CHAIN,
    decimals: t.tokenDecimals,
    price: 1,
    contractAddress: t.tokenContract,
  };
}

const isUnique = (e: unknown) => (e as { code?: string } | null)?.code === "P2002";
const OPEN: string[] = ["created", "awaiting_funds", "processing", "expired"];

export interface DirectAllocation {
  intentId: string;
  /** What the customer must send, in base units: the invoice amount plus the tag. */
  units: string;
  tag: number;
}

/**
 * Reserve a tagged amount for an invoice. Calling again for the same invoice
 * returns the amount it already holds, so reloading the pay page never burns a
 * second tag. Throws when every tag for this amount is taken.
 */
export async function allocateDirectPayment(params: {
  invoiceReference: string;
  userId?: string;
  baseUnits: string;
}): Promise<DirectAllocation> {
  const base = BigInt(params.baseUnits);
  if (base <= 0n) throw new Error("Direct payments need an amount above zero.");
  const reference = directReference(params.invoiceReference);

  const existing = await prisma.paymentIntent.findUnique({ where: { reference } });
  if (existing) {
    const stillOpen = OPEN.includes(existing.state) && existing.openKey && existing.railRef;
    const sameBase = (existing.payload as any)?.baseUnits === base.toString();
    if (stillOpen && sameBase) {
      return { intentId: existing.id, units: existing.railRef!, tag: Number(BigInt(existing.railRef!) - base) };
    }
    throw new Error("This payment was already started and can't take a new direct amount.");
  }

  const max = Math.max(1, (config as any).directUsdc?.maxTag ?? 499);
  const start = Math.floor(Math.random() * max); // spread out, so concurrent invoices rarely collide
  for (let i = 0; i < max; i++) {
    const tag = ((start + i) % max) + 1;
    const units = (base + BigInt(tag)).toString();
    try {
      const row = await prisma.paymentIntent.create({
        data: {
          reference,
          direction: "in",
          kind: "invoice",
          userId: params.userId ?? null,
          rail: "direct-usdc",
          railRef: units,
          state: "awaiting_funds",
          openKey: openKeyFor(units),
          payload: { invoiceReference: params.invoiceReference, baseUnits: base.toString(), tag } as Prisma.InputJsonValue,
        },
      });
      return { intentId: row.id, units, tag };
    } catch (error) {
      if (!isUnique(error)) throw error;
      // Taken (by another invoice, or by a racing request for this one). Try the next tag.
      const raced = await prisma.paymentIntent.findUnique({ where: { reference } });
      if (raced?.railRef) return { intentId: raced.id, units: raced.railRef, tag: Number(BigInt(raced.railRef) - base) };
    }
  }
  throw new Error("Too many direct payments are open for this amount. Please try again in a few minutes.");
}

// --------------------------------------------
// Chain access (plain JSON-RPC, no signing library)
// --------------------------------------------

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(config.treasury.rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Base RPC ${method} failed (${res.status})`);
  const body: any = await res.json();
  if (body.error) throw new Error(`Base RPC ${method}: ${body.error.message ?? "error"}`);
  return body.result as T;
}

const hex = (n: number) => `0x${n.toString(16)}`;
const topicFor = (address: string) => `0x${address.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;

interface TransferLog {
  data: string;
  transactionHash: string;
  logIndex: string;
  blockNumber: string;
  topics: string[];
  removed?: boolean;
}

export interface ScanResult {
  /** Blocks covered by this call. */
  blocks: number;
  /** Transfers to the treasury seen. */
  transfers: number;
  /** Transfers that settled an open invoice. */
  settled: number;
  /** Transfers with no open invoice at that exact amount. */
  unmatched: number;
  skipped?: boolean;
}

async function getCursor(): Promise<number | null> {
  const row = await prisma.railCursor.findUnique({ where: { key: CURSOR_KEY } });
  const n = row ? Number(row.value) : NaN;
  return Number.isFinite(n) ? n : null;
}

async function setCursor(block: number) {
  await prisma.railCursor.upsert({
    where: { key: CURSOR_KEY },
    create: { key: CURSOR_KEY, value: String(block) },
    update: { value: String(block) },
  });
}

/** Settle the invoice that holds this exact amount, if any. Throws if settling fails, so the scan retries. */
async function settleIfOpen(log: TransferLog): Promise<"settled" | "unmatched"> {
  const value = BigInt(log.data);
  const intent = await prisma.paymentIntent.findUnique({ where: { openKey: openKeyFor(value) } });
  if (!intent) return "unmatched";

  const invoiceReference = (intent.payload as any)?.invoiceReference as string | undefined;
  if (!invoiceReference) return "unmatched";

  const decimals = config.treasury.tokenDecimals;
  const formatted = (Number(value) / 10 ** decimals).toFixed(decimals);
  const txHash = log.transactionHash;
  const crypto = {
    paidAt: new Date().toISOString(),
    paidWith: `${formatted} USDC on Base`,
    txHash,
    txUrl: `https://basescan.org/tx/${txHash}`,
  };

  await applyRailEvent({
    reference: intent.reference,
    kind: "invoice",
    direction: "in",
    rail: "direct-usdc",
    userId: intent.userId ?? undefined,
    railRef: intent.railRef ?? undefined,
    initialState: intent.state as any,
    event: {
      type: "settled",
      providerStatus: "TRANSFER",
      dedupeKey: `${txHash}:${parseInt(log.logIndex, 16)}`,
      detail: { txHash, from: log.topics?.[1] ? `0x${log.topics[1].slice(26)}` : undefined, block: parseInt(log.blockNumber, 16), value: value.toString() },
    },
    // Posted before the intent moves, so a crash between the two is retried, not lost.
    // Both steps are idempotent.
    post: async () => {
      await settleInvoicePayment(invoiceReference, { source: "direct_usdc", provider: "direct-usdc", crypto });
      const tx = await prisma.transaction.findUnique({ where: { reference: invoiceReference } });
      await prisma.transaction.updateMany({ where: { reference: invoiceReference }, data: { status: "completed" } });
      if (tx) {
        await prisma.transaction.update({
          where: { reference: invoiceReference },
          data: { metadata: { ...((tx.metadata as Record<string, unknown>) || {}), receipt: crypto } as Prisma.InputJsonValue },
        });
      }
    },
  });
  logger.info("Direct USDC payment settled", { invoiceReference, txHash, units: value.toString() });
  return "settled";
}

let inflight: Promise<ScanResult> | null = null;
let lastRunAt = 0;

/**
 * Read new USDC transfers to the treasury and settle matching invoices. Safe to
 * call as often as you like: one scan runs at a time per process, calls closer
 * together than `minIntervalMs` are skipped, and a repeated transfer is a no-op
 * in the rail event engine. The cursor only advances past a block range once
 * every transfer in it was handled, so a failure is retried.
 */
export async function scanDirectUsdc(options: { minIntervalMs?: number; maxChunks?: number } = {}): Promise<ScanResult> {
  const { minIntervalMs = 4_000, maxChunks = 5 } = options;
  if (!isDirectUsdcEnabled()) return { blocks: 0, transfers: 0, settled: 0, unmatched: 0, skipped: true };
  if (inflight) return inflight;
  if (Date.now() - lastRunAt < minIntervalMs) return { blocks: 0, transfers: 0, settled: 0, unmatched: 0, skipped: true };

  inflight = (async () => {
    const result: ScanResult = { blocks: 0, transfers: 0, settled: 0, unmatched: 0 };
    try {
      const { confirmations = 3, chunkBlocks = 2000, lookbackBlocks = 1800 } = (config as any).directUsdc ?? {};
      const head = parseInt(await rpc<string>("eth_blockNumber", []), 16);
      const safeHead = head - confirmations;
      let cursor = (await getCursor()) ?? Math.max(0, safeHead - lookbackBlocks);

      for (let chunk = 0; chunk < maxChunks && cursor < safeHead; chunk++) {
        const from = cursor + 1;
        const to = Math.min(safeHead, from + chunkBlocks - 1);
        const logs = await rpc<TransferLog[]>("eth_getLogs", [
          {
            address: config.treasury.tokenContract,
            fromBlock: hex(from),
            toBlock: hex(to),
            topics: [TRANSFER_TOPIC, null, topicFor(config.treasury.address)],
          },
        ]);

        let failure: Error | null = null;
        for (const log of logs) {
          if (log.removed) continue;
          result.transfers++;
          try {
            if ((await settleIfOpen(log)) === "settled") result.settled++;
            else {
              result.unmatched++;
              logger.info("Transfer to the treasury matches no open direct payment", {
                txHash: log.transactionHash,
                units: BigInt(log.data).toString(),
              });
            }
          } catch (error: any) {
            failure = error;
            logger.error("Could not settle a direct USDC transfer; will retry", { txHash: log.transactionHash, error: error?.message });
          }
        }
        if (failure) throw failure; // leave the cursor where it was
        await setCursor(to);
        result.blocks += to - from + 1;
        cursor = to;
      }
      return result;
    } finally {
      lastRunAt = Date.now();
      inflight = null;
    }
  })();
  return inflight;
}

/** Test hook: forget throttling state. */
export function resetDirectScanState() {
  inflight = null;
  lastRunAt = 0;
}

/**
 * Free the tagged amounts of payments that can no longer arrive: still open
 * long after the invoice window and the late-payment grace period. Without
 * this a tag would be held forever.
 */
export async function releaseStaleDirectPayments(olderThanMs = 26 * 60 * 60 * 1000, now = Date.now()): Promise<number> {
  const cutoff = new Date(now - olderThanMs);
  const stale = await prisma.paymentIntent.findMany({
    where: { rail: "direct-usdc", openKey: { not: null }, createdAt: { lt: cutoff } },
    select: { id: true, state: true },
    take: 200,
  });
  let released = 0;
  for (const row of stale) {
    const { count } = await prisma.paymentIntent.updateMany({
      where: { id: row.id, state: row.state },
      data: { state: "expired", openKey: null },
    });
    released += count;
  }
  return released;
}
