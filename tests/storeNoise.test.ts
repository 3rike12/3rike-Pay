import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/config", () => ({ config: { logLevel: "silent", stocks: { navMaxAgeSeconds: 86400 } } }));

// A tiny stand-in for the database that behaves like Postgres on a unique key, and counts what was asked of it.
const db = vi.hoisted(() => {
  const state = { points: new Map<string, any>(), alerts: new Map<string, any>(), creates: 0, failedCreates: 0 };
  const pointKey = (w: any) => `${w.tokenAddress}@${new Date(w.observedAt).getTime()}`;
  return {
    state,
    prisma: {
      stockPricePoint: {
        findUnique: async ({ where }: any) => state.points.get(pointKey(where.tokenAddress_observedAt)) ?? null,
        create: async ({ data }: any) => {
          const k = pointKey(data);
          if (state.points.has(k)) { state.failedCreates++; throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" }); }
          state.creates++;
          state.points.set(k, data);
          return data;
        },
      },
      stockAlert: {
        findUnique: async ({ where }: any) => state.alerts.get(where.key) ?? null,
        create: async ({ data }: any) => {
          if (state.alerts.has(data.key)) { state.failedCreates++; throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" }); }
          state.creates++;
          state.alerts.set(data.key, data);
          return data;
        },
        deleteMany: async () => ({ count: 0 }),
      },
    },
  };
});
vi.mock("@/db/prisma", () => ({ prisma: db.prisma }));

import { prismaPriceStore, forgetSeenPrices } from "@/services/priceHistory";
import { prismaAlertStore } from "@/services/stockAlertStore";

const A = "0x" + "1".repeat(40);
const point = (price = 100, at = "2026-11-24T10:00:00Z") => ({ tokenAddress: A, price, observedAt: new Date(at) });

beforeEach(() => {
  db.state.points.clear();
  db.state.alerts.clear();
  db.state.creates = 0;
  db.state.failedCreates = 0;
  forgetSeenPrices();
});

describe("recording prices without database errors", () => {
  it("saves a new data point once", async () => {
    expect(await prismaPriceStore.record(point())).toBe(true);
    expect(db.state.creates).toBe(1);
  });

  it("seeing the same data point on every pass never attempts a failing insert", async () => {
    await prismaPriceStore.record(point());
    for (let i = 0; i < 10; i++) expect(await prismaPriceStore.record(point())).toBe(false);
    expect(db.state.failedCreates).toBe(0); // no unique-constraint errors for Prisma to log
    expect(db.state.creates).toBe(1);
  });

  it("after a restart it asks the database first, so a saved point is still not an error", async () => {
    await prismaPriceStore.record(point());
    forgetSeenPrices(); // a new process has an empty memory
    expect(await prismaPriceStore.record(point())).toBe(false);
    expect(db.state.failedCreates).toBe(0);
  });

  it("a genuinely new data point is saved", async () => {
    await prismaPriceStore.record(point(100, "2026-11-24T10:00:00Z"));
    expect(await prismaPriceStore.record(point(104, "2026-11-24T10:30:00Z"))).toBe(true);
    expect(db.state.creates).toBe(2);
  });

  it("if another instance saves it between the check and the insert, that is still handled, not thrown", async () => {
    const real = db.prisma.stockPricePoint.findUnique;
    db.prisma.stockPricePoint.findUnique = async () => null; // the check says "not there"...
    await db.prisma.stockPricePoint.create({ data: point() }); // ...but it was saved just now by someone else
    db.state.creates = 0;
    expect(await prismaPriceStore.record(point())).toBe(false);
    db.prisma.stockPricePoint.findUnique = real;
  });

  it("a real database failure is not swallowed", async () => {
    const real = db.prisma.stockPricePoint.create;
    db.prisma.stockPricePoint.create = async () => { throw new Error("connection lost"); };
    await expect(prismaPriceStore.record(point(1, "2026-11-25T10:00:00Z"))).rejects.toThrow("connection lost");
    db.prisma.stockPricePoint.create = real;
  });
});

describe("claiming an alert", () => {
  it("the first claim wins, and repeats (the usual case) cause no failing insert", async () => {
    expect(await prismaAlertStore.claim("rebalance:u1:2026-w47", "u1", "rebalance")).toBe(true);
    for (let i = 0; i < 5; i++) expect(await prismaAlertStore.claim("rebalance:u1:2026-w47", "u1", "rebalance")).toBe(false);
    expect(db.state.failedCreates).toBe(0);
    expect(db.state.creates).toBe(1);
  });

  it("a different key is a different claim", async () => {
    await prismaAlertStore.claim("k1", "u1", "x");
    expect(await prismaAlertStore.claim("k2", "u1", "x")).toBe(true);
  });
});
