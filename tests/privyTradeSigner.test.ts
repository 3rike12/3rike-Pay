import { describe, it, expect, vi, beforeEach } from "vitest";

const cfg: any = vi.hoisted(() => ({
  logLevel: "silent",
  privy: { appId: "app", appSecret: "secret", authorizationKey: "wallet-auth:KEY123", walletId: "wallet-1", sponsorGas: false },
}));
vi.mock("@/config", () => ({ config: cfg }));

import { createPrivyTradeSigner } from "@/services/privyTradeSigner";
import { encodeApprove } from "@/services/venues/zeroEx";

const HOLDER = "0x" + "a".repeat(40);
const OTHER = "0x" + "e".repeat(40);
const TOKEN = "0x" + "b".repeat(40);
const sendTransaction = vi.fn();
const client: any = { wallets: () => ({ ethereum: () => ({ sendTransaction }) }) };
const signer = () => createPrivyTradeSigner({ allowedTargets: [HOLDER], client });

beforeEach(() => {
  sendTransaction.mockReset();
  sendTransaction.mockResolvedValue({ hash: "0xhash" });
  cfg.privy.sponsorGas = false;
});

describe("what it will send", () => {
  it("a swap to an allowlisted contract, with the idempotency key, on Base, from the treasury wallet", async () => {
    const r = await signer().sendTransaction({ to: HOLDER, data: "0xswap", idempotencyKey: "buy-1:swap" });
    expect(r).toEqual({ txHash: "0xhash" });
    expect(sendTransaction).toHaveBeenCalledWith("wallet-1", {
      caip2: "eip155:8453",
      params: { transaction: { to: HOLDER, data: "0xswap", value: "0x0" } },
      idempotency_key: "buy-1:swap",
      authorization_context: { authorization_private_keys: ["KEY123"] },
    });
  });

  it("an approval ON a token (not on the allowlist) TO an allowlisted spender", async () => {
    await signer().sendTransaction({ to: TOKEN, data: encodeApprove(HOLDER, 5n), idempotencyKey: "buy-1:approve" });
    expect(sendTransaction).toHaveBeenCalledTimes(1);
  });

  it("asks Privy to sponsor gas only when configured", async () => {
    cfg.privy.sponsorGas = true;
    await signer().sendTransaction({ to: HOLDER, data: "0xswap", idempotencyKey: "k" });
    expect(sendTransaction.mock.calls[0][1].sponsor).toBe(true);
  });

  it("trims an idempotency key to what Privy accepts", async () => {
    await signer().sendTransaction({ to: HOLDER, data: "0xswap", idempotencyKey: "x".repeat(100) });
    expect(sendTransaction.mock.calls[0][1].idempotency_key).toHaveLength(64);
  });
});

describe("what it refuses, without ever asking Privy", () => {
  it("a swap to a contract that is not on the allowlist", async () => {
    await expect(signer().sendTransaction({ to: OTHER, data: "0xswap", idempotencyKey: "k" })).rejects.toThrow(/not on the allowlist/);
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("an approval to a spender that is not on the allowlist, even on a legitimate token", async () => {
    await expect(signer().sendTransaction({ to: TOKEN, data: encodeApprove(OTHER, 5n), idempotencyKey: "k" })).rejects.toThrow(/spender/);
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("sending ether", async () => {
    await expect(signer().sendTransaction({ to: HOLDER, data: "0xswap", value: "0xde0b6b3a7640000", idempotencyKey: "k" })).rejects.toThrow(/ether/);
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("a malformed target", async () => {
    await expect(signer().sendTransaction({ to: "nope", data: "0x", idempotencyKey: "k" })).rejects.toThrow(/Invalid/);
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("an allowlisted address cannot be used to approve a DIFFERENT spender by naming it as the target", async () => {
    await expect(signer().sendTransaction({ to: HOLDER, data: encodeApprove(OTHER, 5n), idempotencyKey: "k" })).rejects.toThrow(/spender/);
  });

  it("existing without an allowlist is not possible", () => {
    expect(() => createPrivyTradeSigner({ allowedTargets: [], client })).toThrow(/allowlist/);
    expect(() => createPrivyTradeSigner({ allowedTargets: ["nope"], client })).toThrow(/allowlist/);
  });

  it("a failure from Privy is raised, not hidden", async () => {
    sendTransaction.mockRejectedValue(new Error("policy violation"));
    await expect(signer().sendTransaction({ to: HOLDER, data: "0xswap", idempotencyKey: "k" })).rejects.toThrow("policy violation");
  });
});
