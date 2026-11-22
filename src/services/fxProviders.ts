import { registerFxProvider, type FxProvider } from "@/services/fx";

// ============================================
// Live FX providers
//
// AutoRamp quotes USD/NGN, the rate the cash-out is paid at. It is the only
// live source we have; every other currency stays on the static table.
// ============================================

export const autorampFx: FxProvider = {
  id: "autoramp",
  supports: (currency) => currency.toUpperCase() === "NGN",
  async fetch() {
    // Loaded on use: the AutoRamp client is built at import time.
    const { autoramp } = await import("@/services/autoramp");
    const rate = Number((await autoramp.getUsdNgnRate())?.rate);
    if (!Number.isFinite(rate) || rate <= 0) throw new Error("AutoRamp returned no USD/NGN rate");
    return rate;
  },
};

let registered = false;
/** Register the built-in providers once. */
export function registerBuiltInFxProviders() {
  if (registered) return;
  registered = true;
  registerFxProvider(autorampFx);
}
