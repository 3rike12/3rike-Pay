import { config } from "@/config";

// ============================================
// Minimal Base JSON-RPC for reading transaction results. No signing, no state
// changes: only "what happened to this transaction?".
// ============================================

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"; // Transfer(address,address,uint256)

export interface Receipt {
  /** true = mined and succeeded, false = mined and reverted. */
  success: boolean;
  blockNumber: number;
  logs: Array<{ address: string; topics: string[]; data: string }>;
}

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

/** The receipt of a transaction, or null if it is not mined yet. Throws if the chain cannot be read. */
export async function getReceipt(txHash: string): Promise<Receipt | null> {
  const r: any = await rpc("eth_getTransactionReceipt", [txHash]);
  if (!r) return null;
  return {
    success: r.status === "0x1",
    blockNumber: parseInt(r.blockNumber, 16),
    logs: (r.logs ?? []).map((l: any) => ({ address: String(l.address).toLowerCase(), topics: l.topics ?? [], data: l.data })),
  };
}

const topicAddress = (t: string | undefined) => (t ? `0x${t.slice(26)}`.toLowerCase() : "");

/**
 * Total amount of `token` that moved TO `holder` (or FROM `holder`) in a
 * receipt, summed over its Transfer events. This is what actually happened, as
 * opposed to what a quote promised.
 */
export function transferred(receipt: Receipt, token: string, holder: string, direction: "to" | "from"): bigint {
  const t = token.toLowerCase();
  const h = holder.toLowerCase();
  let total = 0n;
  for (const log of receipt.logs) {
    if (log.address !== t || log.topics[0] !== TRANSFER_TOPIC || log.topics.length < 3) continue;
    const party = direction === "to" ? topicAddress(log.topics[2]) : topicAddress(log.topics[1]);
    if (party === h) total += BigInt(log.data);
  }
  return total;
}
