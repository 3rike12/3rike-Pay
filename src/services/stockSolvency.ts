import { config } from "@/config";
import { positions } from "@/services/positions";
import { createLogger } from "@/utils/logger";

const logger = createLogger("stock-solvency");

// ============================================
// Are the stock positions covered?
//
// Users own units in a ledger; the treasury holds the real tokens in one wallet.
// The one fact that makes that safe: for every token, what the treasury actually
// holds must be at least what users together are recorded as owning. This reads
// the chain and compares. It fails CLOSED: a token whose balance cannot be read
// is reported as not covered, never assumed fine.
//
// Dividends and splits change a token's multiplier, not raw balances, so this
// comparison stays valid through corporate actions.
// ============================================

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const BALANCE_OF = "0x70a08231"; // balanceOf(address)

/** ERC-20 balanceOf(treasury) in raw units, over plain JSON-RPC. Throws if it cannot be read. */
export async function onChainTokenBalance(tokenAddress: string, holder: string = config.treasury.address): Promise<bigint> {
  if (!ADDRESS_RE.test(tokenAddress) || !ADDRESS_RE.test(holder)) throw new Error("Not a valid address");
  const data = BALANCE_OF + holder.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const res = await fetch(config.treasury.rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: tokenAddress, data }, "latest"] }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Token balance RPC failed (${res.status})`);
  const body: any = await res.json();
  if (body.error || typeof body.result !== "string") throw new Error(`Token balance RPC error: ${body.error?.message ?? "no result"}`);
  return BigInt(body.result);
}

export interface TokenCover {
  tokenAddress: string;
  /** What users together own, in raw units. */
  owed: bigint;
  /** What the treasury holds; null if it could not be read. */
  held: bigint | null;
  covered: boolean;
  /** held - owed; null if held is unknown. Negative means a shortfall. */
  surplus: bigint | null;
}

/** For every token anyone owns: does the treasury hold enough? Each token is judged on its own. */
export async function stockSolvency(): Promise<TokenCover[]> {
  const owedByToken = (await positions.totals()).filter((t) => t.units > 0n);
  return Promise.all(
    owedByToken.map(async ({ tokenAddress, units }): Promise<TokenCover> => {
      try {
        const held = await onChainTokenBalance(tokenAddress);
        return { tokenAddress, owed: units, held, covered: held >= units, surplus: held - units };
      } catch (error: any) {
        logger.error("Could not read a token balance; treating it as not covered", { tokenAddress, error: error?.message });
        return { tokenAddress, owed: units, held: null, covered: false, surplus: null };
      }
    })
  );
}

/** The gate before selling or paying out: true only if every token is covered. */
export async function coversOwed(): Promise<boolean> {
  const all = await stockSolvency();
  const short = all.filter((c) => !c.covered);
  if (short.length) {
    logger.error("Stock positions are not fully covered", {
      tokens: short.map((c) => ({ tokenAddress: c.tokenAddress, owed: c.owed.toString(), held: c.held === null ? "unknown" : c.held.toString() })),
    });
  }
  return short.length === 0;
}
