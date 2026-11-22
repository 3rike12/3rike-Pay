import { configuredLimits } from "@/rails/limitConfig";
import type { IntentState, Rail, RailEventInput, RailInstruction, RailRequest } from "@/rails/types";

// ============================================
// AutoRamp (Nigerian bank payouts) as a rail
//
// AutoRamp reports through webhooks only. The treasury sends USDC to the
// deposit address it returns; once AutoRamp has it, it pays the bank and
// emits offramp.completed or offramp.failed.
// ============================================

/** An AutoRamp off-ramp webhook event in canonical terms, or null when it is not about a payout. */
export function mapOfframpEvent(event: string): IntentState | null {
  switch (event) {
    case "offramp.completed":
      return "settled";
    case "offramp.failed":
      return "failed";
    default:
      return null;
  }
}

export const autoRampOfframpRail: Rail = {
  id: "autoramp",
  direction: "out",
  priority: 10,
  capabilities: () => ({
    kinds: ["bank_payout"],
    currencies: ["NGN"],
    countries: ["NG"],
    // AutoRamp also has a floor in naira (1,000); that check lives with the cash-out quote.
    requiresKyc: true,
    ...configuredLimits("autoramp"),
  }),
  async initiate(req: RailRequest): Promise<RailInstruction> {
    if (req.kind !== "bank_payout") throw new Error("AutoRamp pays bank accounts; it cannot swap crypto.");
    // Loaded on use: the AutoRamp client is built at import time, and a flow
    // that never pays a bank should not need it configured.
    const { autoramp } = await import("@/services/autoramp");
    const ramp: any = await autoramp.initializeOffRamp({
      network: req.network,
      amount: req.ngn,
      bankCode: req.bankCode,
      accountNumber: req.accountNumber,
    });
    const reference: string | undefined = ramp?.databaseRecord?.reference || ramp?.reference;
    const depositAddress: string | undefined = ramp?.data?.depositAddress || ramp?.depositAddress;
    if (!reference || !depositAddress) {
      throw new Error("AutoRamp response is missing the reference or deposit address.");
    }
    return { rail: "autoramp", railRef: reference, depositAddress, raw: ramp };
  },
  parseWebhook(event: string): RailEventInput[] {
    const type = mapOfframpEvent(event);
    return type ? [{ type, providerStatus: event }] : [];
  },
};
