import { describe, it, expect, vi } from "vitest";

vi.mock("@/config", () => ({ config: { logLevel: "silent" } }));
vi.mock("@/services/redis", () => ({ redis: null }));

import { createDailyLimiter } from "@/services/dailyLimit";

const at = (iso: string) => () => new Date(iso);

describe("in memory", () => {
  it("lets a person use their allowance and then stops them", async () => {
    const l = createDailyLimiter(3, { now: at("2026-11-23T10:00:00Z") });
    expect([await l.allow("a"), await l.allow("a"), await l.allow("a"), await l.allow("a"), await l.allow("a")]).toEqual([true, true, true, false, false]);
  });

  it("counts each person separately", async () => {
    const l = createDailyLimiter(1, { now: at("2026-11-23T10:00:00Z") });
    expect(await l.allow("a")).toBe(true);
    expect(await l.allow("a")).toBe(false);
    expect(await l.allow("b")).toBe(true);
  });

  it("starts again the next UTC day", async () => {
    let now = new Date("2026-11-23T23:59:00Z");
    const l = createDailyLimiter(1, { now: () => now });
    expect(await l.allow("a")).toBe(true);
    expect(await l.allow("a")).toBe(false);
    now = new Date("2026-11-24T00:01:00Z");
    expect(await l.allow("a")).toBe(true);
  });

  it("separate limiters do not share counts", async () => {
    const a = createDailyLimiter(1, { name: "x", now: at("2026-11-23T10:00:00Z") });
    const b = createDailyLimiter(1, { name: "y", now: at("2026-11-23T10:00:00Z") });
    await a.allow("u");
    expect(await b.allow("u")).toBe(true);
  });

  it("a zero, negative or invalid limit lets nobody through", async () => {
    for (const limit of [0, -1, NaN]) expect(await createDailyLimiter(limit, { now: at("2026-11-23T10:00:00Z") }).allow("a")).toBe(false);
  });

  it("two simultaneous calls cannot both slip through the last place", async () => {
    const l = createDailyLimiter(1, { now: at("2026-11-23T10:00:00Z") });
    const r = await Promise.all([l.allow("a"), l.allow("a"), l.allow("a")]);
    expect(r.filter(Boolean)).toHaveLength(1);
  });
});

describe("with Redis", () => {
  const fakeRedis = () => {
    const counts = new Map<string, number>();
    const expiries: Array<[string, number]> = [];
    return {
      counts, expiries,
      incr: async (k: string) => (counts.set(k, (counts.get(k) ?? 0) + 1), counts.get(k)!),
      expire: async (k: string, s: number) => void expiries.push([k, s]),
    };
  };

  it("counts there, shared between instances, and sets an expiry only on the first use of the day", async () => {
    const r = fakeRedis();
    const one = createDailyLimiter(2, { redis: r, now: at("2026-11-23T10:00:00Z") });
    const two = createDailyLimiter(2, { redis: r, now: at("2026-11-23T10:00:00Z") }); // another instance
    expect(await one.allow("a")).toBe(true);
    expect(await two.allow("a")).toBe(true);
    expect(await one.allow("a")).toBe(false); // the allowance is shared
    expect(r.expiries).toHaveLength(1);
    expect(r.expiries[0][1]).toBe(25 * 3600);
  });

  it("falls back to counting in memory if Redis fails, rather than letting everyone through", async () => {
    const broken = { incr: async () => { throw new Error("down"); }, expire: async () => {} };
    const l = createDailyLimiter(1, { redis: broken, now: at("2026-11-23T10:00:00Z") });
    expect(await l.allow("a")).toBe(true);
    expect(await l.allow("a")).toBe(false);
  });
});
