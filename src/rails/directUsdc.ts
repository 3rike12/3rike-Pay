import { configuredLimits } from "@/rails/limitConfig";
import type { Rail, RailInstruction, RailRequest } from "@/rails/types";

// ============================================
// Direct USDC on Base as a rail
//
// The customer already holds the treasury's asset, so there is nothing to swap:
// they send USDC to the treasury address. The rail's job is to hand back a
// unique tagged amount that identifies the payment (see services/directUsdc).
// ============================================

export const directUsdcRail: Rail = {
  id: "direct-usdc",
  direction: "in",
  // Ahead of 1Click when both could serve: no swap fee, no minimum.
  priority: 5,
  capabilities: () => ({
    kinds: ["direct_transfer"],
    assets: ["USDC"],
    chains: ["base"],
    ...configuredLimits("direct-usdc"),
  }),
  async initiate(req: RailRequest): Promise<RailInstruction> {
    if (req.kind !== "direct_transfer") throw new Error("Direct USDC takes a transfer; it cannot swap or pay a bank.");
    // Loaded on use: it needs the database and the invoice service.
    const { allocateDirectPayment, isDirectUsdcEnabled } = await import("@/services/directUsdc");
    const { config } = await import("@/config");
    if (!isDirectUsdcEnabled()) throw new Error("Direct USDC payments are not enabled.");

    const allocation = await allocateDirectPayment({
      invoiceReference: req.reference,
      userId: req.userId,
      baseUnits: req.baseUnits,
    });
    const decimals = config.treasury.tokenDecimals;
    return {
      rail: "direct-usdc",
      railRef: `${req.reference}:direct`,
      depositAddress: config.treasury.address,
      amountIn: allocation.units,
      amountInFormatted: (Number(allocation.units) / 10 ** decimals).toFixed(decimals),
      amountOut: req.baseUnits,
      raw: allocation,
    };
  },
};
