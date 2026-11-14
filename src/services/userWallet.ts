import { PrivyClient } from "@privy-io/node";
import { config } from "@/config";
import { prisma } from "@/db/prisma";
import { toWhatsAppPhone } from "@/utils/helpers";
import { createLogger } from "@/utils/logger";

const logger = createLogger("user-wallet");

type PrivyWalletAccount = {
  id?: string | null;
  address?: string;
  type?: string;
  chain_type?: string;
  connector_type?: string;
  wallet_client?: string;
};
type PrivyUser = { id: string; linked_accounts?: PrivyWalletAccount[] };

let privyClient: PrivyClient | null = null;
function client(): PrivyClient {
  if (!config.privy.appId || !config.privy.appSecret) {
    throw new Error("User wallets are not configured on this server.");
  }
  return (privyClient ??= new PrivyClient({ appId: config.privy.appId, appSecret: config.privy.appSecret }));
}

function isNotFound(error: any): boolean {
  return error?.status === 404 || error?.statusCode === 404 || error?.name === "NotFoundError";
}

function embeddedEvmWallet(user: PrivyUser): PrivyWalletAccount | undefined {
  return user.linked_accounts?.find(
    (account) =>
      account.type === "wallet" &&
      account.chain_type === "ethereum" &&
      account.connector_type === "embedded" &&
      account.wallet_client === "privy" &&
      account.address
  );
}

/** Return or create the user's Privy EVM wallet, linked to their verified WhatsApp number. */
export async function ensureUserEvmWallet(userId: string, phone: string) {
  const stored = await prisma.user.findUnique({ where: { id: userId } });
  if (!stored) throw new Error("User not found.");
  if (stored.privyUserId && stored.privyWalletId && stored.privyWalletAddress) {
    return { privyUserId: stored.privyUserId, walletId: stored.privyWalletId, address: stored.privyWalletAddress };
  }

  const e164 = `+${toWhatsAppPhone(phone)}`;
  if (!/^\+[1-9]\d{7,14}$/.test(e164)) throw new Error("We couldn't verify the phone number for your wallet.");

  const api = client();
  let privyUser: PrivyUser;
  try {
    privyUser = (await api.users().getByPhoneNumber({ number: e164 })) as PrivyUser;
  } catch (error: any) {
    if (!isNotFound(error)) throw error;
    try {
      privyUser = (await api.users().create({
        linked_accounts: [{ type: "phone", number: e164 }],
        wallets: [{ chain_type: "ethereum" }],
      })) as PrivyUser;
    } catch (createError: any) {
      // A concurrent request may have created this Privy user first.
      try {
        privyUser = (await api.users().getByPhoneNumber({ number: e164 })) as PrivyUser;
      } catch {
        throw createError;
      }
    }
  }

  let wallet = embeddedEvmWallet(privyUser);
  if (!wallet?.id || !wallet.address) {
    const created = await api.wallets().create({
      chain_type: "ethereum",
      owner: { user_id: privyUser.id },
      external_id: `3rike_${userId.replace(/-/g, "")}`,
      display_name: "3rike Pay wallet",
    });
    wallet = { id: created.id, address: created.address, type: "wallet", chain_type: "ethereum" };
  }

  const saved = await prisma.user.update({
    where: { id: userId },
    data: {
      privyUserId: privyUser.id,
      privyWalletId: wallet.id,
      privyWalletAddress: wallet.address,
    },
  });
  logger.info("User EVM wallet ready", { userId, address: saved.privyWalletAddress });
  return {
    privyUserId: saved.privyUserId!,
    walletId: saved.privyWalletId!,
    address: saved.privyWalletAddress!,
  };
}
