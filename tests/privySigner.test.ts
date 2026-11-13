import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/config", () => ({
  config: {
    logLevel: "debug",
    treasury: { tokenContract: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", tokenDecimals: 6, maxWithdrawUsd: 2000 },
    privy: { appId: "app", appSecret: "secret", authorizationKey: "wallet-auth:BASE64KEY", walletId: "w_1", sponsorGas: false },
  },
}));
vi.mock("@privy-io/node", () => ({ PrivyClient: vi.fn() }));

import { createPrivySigner, encodeErc20Transfer } from "@/services/privySigner";
import { config } from "@/config";

const sendTransaction = vi.fn();
const client = { wallets: () => ({ ethereum: () => ({ sendTransaction: (...a: any[]) => sendTransaction(...a) }) }) };
const RAMP = "0x1111111111111111111111111111111111111111";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

beforeEach(() => {
  vi.clearAllMocks();
  (config as any).privy.sponsorGas = false;
  sendTransaction.mockResolvedValue({ hash: "0xhash", transaction_id: "tx_1" });
});

describe("encodeErc20Transfer", () => {
  it("encodes transfer(to, amount) as selector + two 32-byte words", () => {
    expect(encodeErc20Transfer(RAMP, 100_000_000n)).toBe(
      "0xa9059cbb" +
        "0000000000000000000000001111111111111111111111111111111111111111" +
        "0000000000000000000000000000000000000000000000000000000005f5e100"
    );
  });

  it("rejects a bad address or a non-positive amount", () => {
    expect(() => encodeErc20Transfer("0x123", 1n)).toThrow(/address/i);
    expect(() => encodeErc20Transfer(RAMP, 0n)).toThrow(/amount/i);
  });
});

describe("createPrivySigner", () => {
  it("sends USDC on Base from the treasury wallet, signed with the authorization key", async () => {
    const out = await createPrivySigner(client as any).send({
      to: RAMP, amountUnits: "100000000", asset: USDC, reference: "OFR-1",
    });

    expect(out).toEqual({ txHash: "0xhash" });
    expect(sendTransaction).toHaveBeenCalledWith("w_1", {
      caip2: "eip155:8453",
      params: { transaction: { to: USDC, data: expect.stringMatching(/^0xa9059cbb/), value: "0x0" } },
      reference_id: "OFR-1",
      idempotency_key: "OFR-1",
      authorization_context: { authorization_private_keys: ["BASE64KEY"] },
    });
  });

  it("falls back to the treasury token when the asset is not a contract address", async () => {
    await createPrivySigner(client as any).send({ to: RAMP, amountUnits: "5000000", asset: "nep141:usdc-base" });
    expect(sendTransaction.mock.calls[0][1].params.transaction.to).toBe(USDC);
  });

  it("asks Privy to pay gas only when sponsorship is switched on", async () => {
    (config as any).privy.sponsorGas = true;
    await createPrivySigner(client as any).send({ to: RAMP, amountUnits: "5000000", asset: USDC });
    expect(sendTransaction.mock.calls[0][1].sponsor).toBe(true);
  });

  it("refuses a payout above its own limit without calling Privy", async () => {
    await expect(
      createPrivySigner(client as any).send({ to: RAMP, amountUnits: String(2200 * 1_000_000), asset: USDC })
    ).rejects.toThrow(/limit/i);
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("surfaces a Privy failure so the payout is reversed", async () => {
    sendTransaction.mockRejectedValue(new Error("policy violation"));
    await expect(createPrivySigner(client as any).send({ to: RAMP, amountUnits: "5000000", asset: USDC })).rejects.toThrow(/policy/);
  });
});
