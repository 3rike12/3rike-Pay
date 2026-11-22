import { registerRail, getRail, listRails, selectRails } from "@/rails/registry";
import { oneClickPayoutRail, oneClickRail } from "@/rails/oneClick";
import { autoRampOfframpRail } from "@/rails/autoRamp";
import { directUsdcRail } from "@/rails/directUsdc";
import type { Rail, RailDirection, RailInstruction, RailNeed, RailRequest } from "@/rails/types";

// ============================================
// Using rails from a flow
//
// Flows import this instead of a provider. The built-in rails register the
// first time anything asks, so there is no startup step to forget.
// ============================================

let registered = false;

/** Register the built-in rails once. Rails registered by hand (tests, new providers) are left alone. */
export function ensureRails(): void {
  if (registered) return;
  registered = true;
  for (const rail of [oneClickRail, oneClickPayoutRail, autoRampOfframpRail, directUsdcRail]) {
    if (!getRail(rail.id)) registerRail(rail);
  }
}

/** Rails in a direction, built-ins included. */
export function railsFor(direction: RailDirection): Rail[] {
  ensureRails();
  return listRails(direction);
}

/** The best rail that can carry `need`. Throws when none can, so a flow never proceeds without one. */
export function pickRail(direction: RailDirection, need: RailNeed = {}): Rail {
  ensureRails();
  const rail = selectRails(direction, need)[0];
  if (!rail) throw new Error("No payment route is available for this right now.");
  return rail;
}

/** Look a rail up by the id stored on a payment ("1click", "autoramp"). */
export function railById(id: string): Rail | undefined {
  ensureRails();
  return getRail(id);
}

/** Create the payment on a rail. Throws if the rail cannot initiate. */
export async function initiateOn(rail: Rail, req: RailRequest): Promise<RailInstruction> {
  if (!rail.initiate) throw new Error(`Rail ${rail.id} cannot initiate payments.`);
  return rail.initiate(req);
}
