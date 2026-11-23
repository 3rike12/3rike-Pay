import { describe, it, expect, vi } from "vitest";

vi.mock("@/config", () => ({ config: { logLevel: "silent", stocks: {}, nearIntents: { fxRates: {} } } }));
vi.mock("@/db/prisma", () => ({ prisma: {} }));
vi.mock("@/services/treasury", () => ({ fromUsd: (n: number) => n }));

import { runRebalanceChecks, weekKey, driftMessage } from "@/services/rebalanceAlerts";

const NOW = new Date("2026-11-23T08:00:00Z");

function world(over: Record<string, any> = {}) {
  const claims = new Set<string>();
  const sent: Array<[string, string]> = [];
  const deps = {
    users: async () => ["a", "b"],
    plan: async () => ({ status: "trades", maxDrift: 12.4 }),
    isOptedOut: async () => false,
    claim: async (key: string) => (claims.has(key) ? false : (claims.add(key), true)),
    release: async (key: string) => void claims.delete(key),
    notify: async (u: string, t: string) => void sent.push([u, t]),
    now: () => NOW,
    ...over,
  };
  return { deps, sent, claims };
}

describe("runRebalanceChecks", () => {
  it("nudges each person whose mix has drifted, once", async () => {
    const w = world();
    expect(await runRebalanceChecks(w.deps)).toEqual({ checked: 2, sent: 2 });
    expect(w.sent.map((s) => s[0])).toEqual(["a", "b"]);
    expect(w.sent[0][1]).toContain("about 12 points");
    expect(w.sent[0][1]).toContain("*rebalance*");
  });

  it("does not nudge the same person twice in a week, however often it runs", async () => {
    const w = world();
    await runRebalanceChecks(w.deps);
    await runRebalanceChecks(w.deps);
    await runRebalanceChecks(w.deps);
    expect(w.sent).toHaveLength(2);
  });

  it("nudges again the next week", async () => {
    const w = world();
    await runRebalanceChecks(w.deps);
    await runRebalanceChecks({ ...w.deps, now: () => new Date("2026-12-01T08:00:00Z") });
    expect(w.sent).toHaveLength(4);
  });

  it("says nothing to people who are on target, have no plan, or turned alerts off", async () => {
    expect((await runRebalanceChecks(world({ plan: async () => ({ status: "balanced" }) }).deps)).sent).toBe(0);
    expect((await runRebalanceChecks(world({ plan: async () => null }).deps)).sent).toBe(0);
    expect((await runRebalanceChecks(world({ isOptedOut: async () => true }).deps)).sent).toBe(0);
  });

  it("a failed send releases the claim so the next pass can try again, and the rest still go", async () => {
    let first = true;
    const w = world({ notify: async (u: string, t: string) => { if (u === "a" && first) { first = false; throw new Error("whatsapp down"); } w.sent.push([u, t]); } });
    expect((await runRebalanceChecks(w.deps)).sent).toBe(1); // b went; a failed
    expect((await runRebalanceChecks(w.deps)).sent).toBe(1); // a is retried, b is not repeated
    expect(w.sent.map((s) => s[0])).toEqual(["b", "a"]);
  });

  it("one person's broken plan does not stop the others", async () => {
    const w = world({ plan: async (u: string) => { if (u === "a") throw new Error("boom"); return { status: "trades", maxDrift: 9 }; } });
    expect((await runRebalanceChecks(w.deps)).sent).toBe(1);
    expect(w.sent[0][0]).toBe("b");
  });
});

describe("weekKey", () => {
  it("is the same all week and different the next", () => {
    expect(weekKey(new Date("2026-11-23T01:00:00Z"))).toBe(weekKey(new Date("2026-11-23T23:00:00Z")));
    expect(weekKey(new Date("2026-11-23T08:00:00Z"))).not.toBe(weekKey(new Date("2026-12-01T08:00:00Z")));
  });
  it("driftMessage never promises anything", () => {
    expect(driftMessage(7.6)).toContain("Nothing happens until you say yes");
  });
});
