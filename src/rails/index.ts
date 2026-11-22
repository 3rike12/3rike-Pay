import { registerRail } from "@/rails/registry";
import { oneClickPayoutRail, oneClickRail } from "@/rails/oneClick";
import { autoRampOfframpRail } from "@/rails/autoRamp";
import { directUsdcRail } from "@/rails/directUsdc";

export * from "@/rails/types";
export * from "@/rails/state";
export * from "@/rails/registry";
export { mapOneClickStatus, summariseQuoteStatuses, oneClickEvent, oneClickRail, oneClickPayoutRail } from "@/rails/oneClick";
export * from "@/rails/limits";
export * from "@/rails/router";
export { mapOfframpEvent, autoRampOfframpRail } from "@/rails/autoRamp";
export { directUsdcRail } from "@/rails/directUsdc";

/** Register the built-in rails. Safe to call more than once. */
export function registerBuiltInRails(): void {
  registerRail(oneClickRail);
  registerRail(oneClickPayoutRail);
  registerRail(autoRampOfframpRail);
  registerRail(directUsdcRail);
}
