import { createLogger } from "@/utils/logger";

const logger = createLogger("stellar-account");

/** Stellar's public Horizon API. Override with STELLAR_HORIZON_URL (for example a testnet or a paid provider). */
const horizonUrl = () => (process.env.STELLAR_HORIZON_URL || "https://horizon.stellar.org").replace(/\/+$/, "");

export type RefundCheck = { ok: true } | { ok: false; error: string };

/**
 * Can this Stellar account receive a refund of `symbol`?
 *
 * A Stellar account only exists once it has been funded (about 1 XLM), and it can only hold a token such as USDC after it
 * opts in with a "trustline" to that token's issuer. A refund sent to an account that cannot receive it fails, so this is
 * checked BEFORE a payment is prepared, and the payer is told what to fix. XLM needs only an activated account.
 *
 * If Stellar cannot be reached the check passes (and says so in the log): not being able to look must not stop a payment
 * that would very likely have been fine. A real "no such account" or "no trustline" answer always blocks.
 */
export async function checkStellarRefund(address: string, token: { symbol: string; contractAddress?: string | null }): Promise<RefundCheck> {
  let res: Response;
  try {
    res = await fetch(`${horizonUrl()}/accounts/${encodeURIComponent(address)}`, { signal: AbortSignal.timeout(8000) });
  } catch (error: any) {
    logger.warn("Could not reach Stellar to check a refund address; allowing it", { error: error?.message });
    return { ok: true };
  }

  if (res.status === 404) {
    return { ok: false, error: "That Stellar account isn't activated yet. An account becomes active once it holds at least 1 XLM. Fund it, or use another address." };
  }
  if (!res.ok) {
    logger.warn("Stellar answered with an error when checking a refund address; allowing it", { status: res.status });
    return { ok: true };
  }

  const symbol = token.symbol.toUpperCase();
  if (symbol === "XLM") return { ok: true };

  let balances: Array<{ asset_type?: string; asset_code?: string; asset_issuer?: string }> = [];
  try {
    balances = ((await res.json()) as any)?.balances ?? [];
  } catch {
    logger.warn("Stellar sent an unreadable reply when checking a refund address; allowing it");
    return { ok: true };
  }

  const issuer = token.contractAddress || "";
  const hasTrustline = balances.some((b) => b.asset_code?.toUpperCase() === symbol && (!issuer || b.asset_issuer === issuer));
  if (!hasTrustline) {
    return { ok: false, error: `That account can't receive ${symbol} yet: it has no ${symbol} trustline. Add the ${symbol} trustline in your Stellar wallet (it costs 0.5 XLM of reserve), or pay with XLM instead.` };
  }
  return { ok: true };
}
