import type { Rail, RailCapabilities, RailDirection, RailNeed } from "@/rails/types";

// ============================================
// Rail registry and routing
//
// Rails register themselves once at startup. `selectRails` answers "which
// rails can carry this payment, best first", so adding a provider is
// registering it, not editing the flows that use it.
// ============================================

const rails = new Map<string, Rail>();

export function registerRail(rail: Rail): void {
  rails.set(rail.id, rail);
}

export function unregisterRail(id: string): void {
  rails.delete(id);
}

export function getRail(id: string): Rail | undefined {
  return rails.get(id);
}

export function listRails(direction?: RailDirection): Rail[] {
  const all = [...rails.values()];
  return direction ? all.filter((r) => r.direction === direction) : all;
}

/** A list means "one of these"; an absent list means "no restriction". Case-insensitive. */
function allows(list: string[] | undefined, wanted: string | undefined): boolean {
  if (!list || !wanted) return true;
  const w = wanted.toLowerCase();
  return list.some((item) => item.toLowerCase() === w);
}

export function supports(caps: RailCapabilities, need: RailNeed): boolean {
  if (!allows(caps.kinds, need.kind)) return false;
  if (!allows(caps.assets, need.asset)) return false;
  if (!allows(caps.chains, need.chain)) return false;
  if (!allows(caps.currencies, need.currency)) return false;
  if (!allows(caps.countries, need.country)) return false;
  if (need.usd !== undefined) {
    if (caps.minUsd !== undefined && need.usd < caps.minUsd) return false;
    if (caps.maxUsd !== undefined && need.usd > caps.maxUsd) return false;
  }
  return true;
}

/** Rails in `direction` that can carry `need`, lowest priority number first (ties keep registration order). */
export function selectRails(direction: RailDirection, need: RailNeed = {}): Rail[] {
  return listRails(direction)
    .filter((r) => supports(r.capabilities(), need))
    .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
}
