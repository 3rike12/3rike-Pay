import { PrivyClient } from "@privy-io/node";
import { config } from "@/config";
import { createLogger } from "@/utils/logger";
import type { TreasurySigner } from "@/services/withdrawal";

const logger = createLogger("privy-signer");

// ============================================
// Treasury signer backed by a Privy server wallet
//
// Sends an ERC-20 `transfer` (USDC on Base) from the treasury wallet. Privy
// holds the key; we only hold an authorization key that lets us ask Privy to
// sign. Pair it with a policy in the Privy dashboard that limits the wallet
// to the USDC contract and a per-transaction cap, so a leaked credential
// cannot drain it.
// ============================================

const BASE_CAIP2 = "eip155:8453";
const TRANSFER_SELECTOR = "a9059cbb";
const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

/** ABI-encode `transfer(to, amount)`. */
export function encodeErc20Transfer(to: string, amountUnits: bigint): string {
  if (!EVM_ADDRESS_RE.test(to)) throw new Error("Invalid recipient address");
  if (amountUnits <= 0n) throw new Error("Invalid amount");
  return (
    "0x" +
    TRANSFER_SELECTOR +
    to.slice(2).toLowerCase().padStart(64, "0") +
    amountUnits.toString(16).padStart(64, "0")
  );
}

/** The slice of the Privy client we use, so tests can stub it. */
export interface PrivyEthereumClient {
  wallets(): {
    ethereum(): {
      sendTransaction(walletId: string, input: any): Promise<{ hash: string; transaction_id?: string }>;
    };
  };
}

export function createPrivySigner(client?: PrivyEthereumClient): TreasurySigner {
  const { appId, appSecret, authorizationKey, walletId, sponsorGas } = config.privy;
  const privy: PrivyEthereumClient = client ?? (new PrivyClient({ appId, appSecret }) as unknown as PrivyEthereumClient);
  // The dashboard shows the key as `wallet-auth:<base64>`; the SDK wants the base64 part.
  const key = authorizationKey.replace(/^wallet-auth:/, "");
  const decimals = config.treasury.tokenDecimals;
  // Belt and braces next to the Privy policy: never send more than a payout can be.
  const maxUnits = BigInt(Math.round(config.treasury.maxWithdrawUsd * 1.05 * 10 ** decimals));

  return {
    async send({ to, amountUnits, asset, reference }) {
      const amount = BigInt(amountUnits);
      if (amount > maxUnits) throw new Error("Payout is above the signer's per-transaction limit");
      const token = EVM_ADDRESS_RE.test(asset) ? asset : config.treasury.tokenContract;

      const result = await privy.wallets().ethereum().sendTransaction(walletId, {
        caip2: BASE_CAIP2,
        params: { transaction: { to: token, data: encodeErc20Transfer(to, amount), value: "0x0" } },
        ...(sponsorGas ? { sponsor: true } : {}),
        ...(reference ? { reference_id: reference.slice(0, 64), idempotency_key: reference.slice(0, 64) } : {}),
        authorization_context: { authorization_private_keys: [key] },
      });

      logger.info("Treasury transfer submitted", { reference, txHash: result.hash });
      return { txHash: result.hash };
    },
  };
}
