import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/config", () => ({ config: { logLevel: "silent" } }));

// A small in-memory stand-in for the two tables, with the same unique rules.
const intents = new Map<string, any>();
const events: any[] = [];
const uniqueError = () => Object.assign(new Error("unique"), { code: "P2002" });
let failNextEventWith: Error | null = null;

vi.mock("@/db/prisma", () => ({
  prisma: {
    paymentIntent: {
      findUnique: vi.fn(async ({ where }: any) =>
        where.reference ? [...intents.values()].find((i) => i.reference === where.reference) ?? null : intents.get(where.id) ?? null
      ),
      create: vi.fn(async ({ data }: any) => {
        if ([...intents.values()].some((i) => i.reference === data.reference)) throw uniqueError();
        const row = { id: `i${intents.size + 1}`, ...data };
        intents.set(row.id, row);
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const row = intents.get(where.id);
        if (!row || row.state !== where.state) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
    railEvent: {
      create: vi.fn(async ({ data }: any) => {
        if (failNextEventWith) throw failNextEventWith;
        if (events.some((e) => e.intentId === data.intentId && e.type === data.type && e.dedupeKey === data.dedupeKey)) throw uniqueError();
        events.push(data);
        return data;
      }),
    },
  },
}));

import { applyRailEvent, recordRailEvent } from "@/rails/settlement";

const base = { reference: "R1", kind: "cashout", direction: "out", rail: "autoramp" } as const;
const ev = (type: any, providerStatus = type, extra: object = {}) => ({ type, providerStatus, ...extra });

beforeEach(() => {
  intents.clear();
  events.length = 0;
  failNextEventWith = null;
});

describe("applyRailEvent", () => {
  it("creates the payment on first sight and moves it forward", async () => {
    const r = await applyRailEvent({ ...base, initialState: "processing", event: ev("settled", "offramp.completed") });
    expect(r.move.kind).toBe("advance");
    expect(r.state).toBe("settled");
    expect(intents.get(r.intentId).state).toBe("settled");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "settled", providerStatus: "offramp.completed", applied: true });
  });

  it("treats a repeat as a no-op and records nothing more", async () => {
    await applyRailEvent({ ...base, event: ev("settled") });
    const again = await applyRailEvent({ ...base, event: ev("settled") });
    expect(again.move.kind).toBe("duplicate");
    expect(events).toHaveLength(1);
  });

  it("refuses a contradiction, keeps the state, and keeps the event for audit", async () => {
    await applyRailEvent({ ...base, event: ev("settled") });
    const r = await applyRailEvent({ ...base, event: ev("failed", "offramp.failed") });
    expect(r.move.kind).toBe("conflict");
    expect(r.state).toBe("settled");
    expect(intents.get(r.intentId).state).toBe("settled");
    expect(events.at(-1)).toMatchObject({ type: "failed", applied: false });
  });

  it("lets a late payment settle an expired one", async () => {
    await applyRailEvent({ ...base, kind: "invoice", direction: "in", rail: "1click", event: ev("expired") });
    const r = await applyRailEvent({ ...base, kind: "invoice", direction: "in", rail: "1click", event: ev("settled", "SUCCESS") });
    expect(r.move.kind).toBe("advance");
    expect(r.state).toBe("settled");
  });

  it("starts from where an older payment already was", async () => {
    const r = await applyRailEvent({ ...base, initialState: "settled", event: ev("failed") });
    expect(r.move.kind).toBe("conflict");
  });

  it("does not let two workers both move the same payment", async () => {
    await applyRailEvent({ ...base, initialState: "processing", event: ev("processing") });
    const row = [...intents.values()][0];
    // Another worker settles it after we read "processing" but before we write.
    const { prisma } = await import("@/db/prisma");
    const real = (prisma as any).paymentIntent.updateMany.getMockImplementation();
    (prisma as any).paymentIntent.updateMany.mockImplementationOnce(async (args: any) => {
      row.state = "failed";
      return real(args);
    });
    const r = await applyRailEvent({ ...base, event: ev("settled") });
    expect(r.move.kind).toBe("duplicate");
    expect(r.state).toBe("failed");
    expect(events.filter((e) => e.type === "settled")).toHaveLength(0);
  });

  it("remembers the provider's id when it first learns it", async () => {
    const r = await applyRailEvent({ ...base, event: ev("processing") });
    await applyRailEvent({ ...base, railRef: "0xdeposit", event: ev("settled") });
    expect(intents.get(r.intentId).railRef).toBe("0xdeposit");
  });

  it("ignores the same event arriving twice at once", async () => {
    await applyRailEvent({ ...base, event: ev("processing", "P", { dedupeKey: "tx1" }) });
    failNextEventWith = uniqueError();
    await expect(applyRailEvent({ ...base, event: ev("settled", "S", { dedupeKey: "tx1" }) })).resolves.toBeTruthy();
  });

  it("surfaces real database errors", async () => {
    failNextEventWith = new Error("db down");
    await expect(applyRailEvent({ ...base, event: ev("processing") })).rejects.toThrow("db down");
  });
});

describe("recordRailEvent", () => {
  it("never throws, so it cannot block a payment", async () => {
    failNextEventWith = new Error("db down");
    expect(await recordRailEvent({ ...base, event: ev("processing") })).toBeNull();
  });

  it("returns the result when it works", async () => {
    expect((await recordRailEvent({ ...base, event: ev("processing") }))?.state).toBe("processing");
  });
});
