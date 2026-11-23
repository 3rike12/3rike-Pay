import { PrivyClient } from "@privy-io/node";
import { config } from "@/config";
import { createLogger } from "@/utils/logger";
import type { TradeSigner } from "@/services/venues/zeroEx";
import type { PrivyEthereumClient } from "@/services/privySigner";

const logger = createLogger("privy-trade-signer");

// ============================================
// Trade signer backed by the Privy treasury wallet
//
// Unlike the payout signer (which can only send USDC transfers), this one sends
// the swap and approval transactions a venue needs. That is more power, so it is
// fenced in twice: here, by an allowlist of contract addresses, and again in the
// Privy dashboard policy, which must limit the wallet to the same addresses and
// the `approve` function. A swap goes only to an allowlisted contract; an approval
// is only allowed if the SPENDER is allowlisted.
// ============================================

const BASE_CAIP2 = "eip155:8453";
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const APPROVE_SELECTOR = "0x095ea7b3";

export function createPrivyTradeSigner(opts: { allowedTargets: string[]; client?: PrivyEthereumClient }): TradeSigner {
  const allowed = new Set(opts.allowedTargets.filter((a) => ADDRESS_RE.test(a)).map((a) => a.toLowerCase()));
  if (allowed.size === 0) throw new Error("Trade signer needs an allowlist of contract addresses");

  const { appId, appSecret, authorizationKey, walletId, sponsorGas } = config.privy;
  const privy: PrivyEthereumClient = opts.client ?? (new PrivyClient({ appId, appSecret }) as unknown as PrivyEthereumClient);
  const key = authorizationKey.replace(/^wallet-auth:/, "");

  return {
    async sendTransaction({ to, data, value, idempotencyKey }) {
      if (!ADDRESS_RE.test(to)) throw new Error("Invalid transaction target");
      const isApprove = data.toLowerCase().startsWith(APPROVE_SELECTOR);
      if (isApprove) {
        // An approval is made ON a token, TO a spender. The spender is what must be trusted.
        const spender = `0x${data.slice(10 + 24, 10 + 64)}`.toLowerCase();
        if (!allowed.has(spender)) throw new Error("Refusing to approve a spender that is not on the allowlist");
      } else if (!allowed.has(to.toLowerCase())) {
        throw new Error("Refusing to send a transaction to a contract that is not on the allowlist");
      }
      if (value && BigInt(value) !== 0n) throw new Error("Refusing to send ether");

      const result = await privy.wallets().ethereum().sendTransaction(walletId, {
        caip2: BASE_CAIP2,
        params: { transaction: { to, data, value: "0x0" } },
        ...(sponsorGas ? { sponsor: true } : {}),
        idempotency_key: idempotencyKey.slice(0, 64),
        authorization_context: { authorization_private_keys: [key] },
      });
      logger.info("Trade transaction submitted", { idempotencyKey, txHash: result.hash });
      return { txHash: result.hash };
    },
  };
}
