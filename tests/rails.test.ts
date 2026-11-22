import { describe, it, expect, beforeEach } from "vitest";
import { isFinal, transition, fromTransactionStatus } from "@/rails/state";
import { mapOneClickStatus, summariseQuoteStatuses, oneClickRail } from "@/rails/oneClick";
import { mapOfframpEvent, autoRampOfframpRail } from "@/rails/autoRamp";
import { registerRail, unregisterRail, selectRails, supports, listRails } from "@/rails/registry";
import { registerBuiltInRails } from "@/rails";
import type { Rail } from "@/rails/types";

const s = (status: string) => ({ status }) as any;

describe("state machine", () => {
  it("treats a repeat as a duplicate", () => {
    expect(transition("processing", "processing")).toEqual({ kind: "duplicate", state: "processing" });
    expect(transition("settled", "settled").kind).toBe("duplicate");
  });

  it("moves forward", () => {
    expect(transition("awaiting_funds", "processing").kind).toBe("advance");
    expect(transition("processing", "settled").kind).toBe("advance");
    expect(transition("created", "failed").kind).toBe("advance");
  });

  it("refuses to leave a final state", () => {
    for (const done of ["settled", "refunded", "failed"] as const) {
      expect(isFinal(done)).toBe(true);
      for (const to of ["awaiting_funds", "processing", "settled", "refunded", "failed", "expired"] as const) {
        if (to !== done) expect(transition(done, to).kind).toBe("conflict");
      }
    }
  });

  it("lets a late payment settle an expired payment", () => {
    expect(isFinal("expired")).toBe(false);
    expect(transition("expired", "settled").kind).toBe("advance");
    expect(transition("expired", "processing").kind).toBe("advance");
  });

  it("does not go backwards from processing", () => {
    expect(transition("processing", "awaiting_funds").kind).toBe("conflict");
    expect(transition("processing", "expired").kind).toBe("conflict");
  });

  it("reads our existing Transaction statuses", () => {
    expect(fromTransactionStatus("completed")).toBe("settled");
    expect(fromTransactionStatus("processing")).toBe("processing");
    expect(fromTransactionStatus("failed")).toBe("failed");
    expect(fromTransactionStatus("awaiting_signature")).toBe("created");
    expect(fromTransactionStatus("something-new")).toBe("created");
  });
});

describe("1Click mapping", () => {
  it("maps every 1Click status", () => {
    expect(mapOneClickStatus("PENDING_DEPOSIT")).toBe("awaiting_funds");
    expect(mapOneClickStatus("INCOMPLETE_DEPOSIT")).toBe("awaiting_funds");
    expect(mapOneClickStatus("KNOWN_DEPOSIT_TX")).toBe("processing");
    expect(mapOneClickStatus("PROCESSING")).toBe("processing");
    expect(mapOneClickStatus("SUCCESS")).toBe("settled");
    expect(mapOneClickStatus("REFUNDED")).toBe("refunded");
    expect(mapOneClickStatus("FAILED")).toBe("failed");
  });

  it("keeps waiting on a status it has not seen before", () => {
    expect(mapOneClickStatus("SOMETHING_NEW")).toBe("awaiting_funds");
  });
});

describe("summariseQuoteStatuses", () => {
  it("settles when any address was paid, and says which", () => {
    expect(summariseQuoteStatuses([s("PENDING_DEPOSIT"), s("SUCCESS"), s("REFUNDED")])).toEqual({
      state: "settled",
      providerStatus: "SUCCESS",
      paidIndex: 1,
    });
  });

  it("prefers success over an in-flight swap on another address", () => {
    expect(summariseQuoteStatuses([s("PROCESSING"), s("SUCCESS")]).state).toBe("settled");
  });

  it("is processing while any address is mid-swap", () => {
    expect(summariseQuoteStatuses([s("REFUNDED"), s("KNOWN_DEPOSIT_TX")])).toMatchObject({
      state: "processing",
      providerStatus: "KNOWN_DEPOSIT_TX",
    });
  });

  it("fails only when every address is dead", () => {
    expect(summariseQuoteStatuses([s("FAILED"), s("FAILED")]).state).toBe("failed");
    expect(summariseQuoteStatuses([s("FAILED"), s("PENDING_DEPOSIT")]).state).toBe("awaiting_funds");
  });

  it("reports a refund when any dead address was refunded", () => {
    expect(summariseQuoteStatuses([s("FAILED"), s("REFUNDED")])).toMatchObject({
      state: "refunded",
      providerStatus: "REFUNDED",
    });
  });

  it("does not call a payment dead on the strength of a failed poll", () => {
    expect(summariseQuoteStatuses([s("REFUNDED"), null]).state).toBe("awaiting_funds");
    expect(summariseQuoteStatuses([null, null]).state).toBe("awaiting_funds");
  });

  it("waits when nothing came back", () => {
    expect(summariseQuoteStatuses([]).state).toBe("awaiting_funds");
  });
});

describe("AutoRamp mapping", () => {
  it("maps payout webhooks", () => {
    expect(mapOfframpEvent("offramp.completed")).toBe("settled");
    expect(mapOfframpEvent("offramp.failed")).toBe("failed");
    expect(mapOfframpEvent("bank_transfer.completed")).toBeNull();
  });

  it("parses a webhook into canonical events", () => {
    expect(autoRampOfframpRail.parseWebhook!("offramp.failed")).toEqual([
      { type: "failed", providerStatus: "offramp.failed" },
    ]);
    expect(autoRampOfframpRail.parseWebhook!("something.else")).toEqual([]);
  });
});

describe("registry and routing", () => {
  const rail = (id: string, direction: "in" | "out", caps: Rail["capabilities"], priority?: number): Rail => ({
    id,
    direction,
    priority,
    capabilities: caps,
  });
  const added: string[] = [];
  const add = (r: Rail) => {
    registerRail(r);
    added.push(r.id);
  };

  beforeEach(() => {
    for (const id of added.splice(0)) unregisterRail(id);
  });

  it("registers the built-in rails once, however often it is called", () => {
    registerBuiltInRails();
    registerBuiltInRails();
    expect(listRails("in").filter((r) => r.id === oneClickRail.id)).toHaveLength(1);
    expect(listRails("out").some((r) => r.id === "autoramp")).toBe(true);
  });

  it("filters by direction", () => {
    add(rail("t-in", "in", () => ({})));
    add(rail("t-out", "out", () => ({})));
    expect(selectRails("in").map((r) => r.id)).toContain("t-in");
    expect(selectRails("in").map((r) => r.id)).not.toContain("t-out");
  });

  it("filters by what a rail supports, ignoring case", () => {
    add(rail("ngn", "out", () => ({ currencies: ["NGN"] })));
    add(rail("kes", "out", () => ({ currencies: ["KES"] })));
    const mine = (need: Parameters<typeof selectRails>[1]) =>
      selectRails("out", need).map((r) => r.id).filter((id) => added.includes(id));
    expect(mine({ currency: "ngn" })).toEqual(["ngn"]);
    expect(mine({ currency: "KES" })).toEqual(["kes"]);
    expect(mine({ currency: "TZS" })).toEqual([]);
  });

  it("treats a missing restriction as open", () => {
    expect(supports({}, { currency: "NGN", chain: "base", usd: 5 })).toBe(true);
    expect(supports({ currencies: ["NGN"] }, {})).toBe(true);
  });

  it("applies amount limits", () => {
    const caps = { minUsd: 5, maxUsd: 100 };
    expect(supports(caps, { usd: 4.99 })).toBe(false);
    expect(supports(caps, { usd: 5 })).toBe(true);
    expect(supports(caps, { usd: 100 })).toBe(true);
    expect(supports(caps, { usd: 100.01 })).toBe(false);
  });

  it("orders by priority, then registration order", () => {
    add(rail("slow", "in", () => ({}), 50));
    add(rail("fast", "in", () => ({}), 1));
    add(rail("also-default-a", "in", () => ({})));
    add(rail("also-default-b", "in", () => ({})));
    const ids = selectRails("in").map((r) => r.id).filter((id) => added.includes(id));
    expect(ids).toEqual(["fast", "slow", "also-default-a", "also-default-b"]);
  });
});
