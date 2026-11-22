import { describe, it, expect, vi, beforeEach } from "vitest";

const cfg: any = vi.hoisted(() => ({ logLevel: "silent", nearIntents: { fxRates: { USD: 1, KES: 130, NGN: 1500 } } }));
vi.mock("@/config", () => ({ config: cfg }));

import { staticFx, liveFx, isStale, usdAt, getFx, registerFxProvider, unregisterFxProvider, resetFxCache, type FxProvider } from "@/services/fx";

beforeEach(() => {
  cfg.nearIntents = { fxRates: { USD: 1, KES: 130, NGN: 1500 } };
  cfg.fx = { liveSources: ["test"], cacheSeconds: 300, maxAgeSeconds: 900, maxDeviation: 0.25 };
  resetFxCache();
  unregisterFxProvider("test");
});

describe("fx records", () => {
  it("records the static rate and says it is static", () => {
    expect(staticFx("kes")).toEqual({ currency: "KES", perUsd: 130, source: "static", asOf: null });
  });

  it("refuses a currency with no rate rather than guessing", () => {
    expect(() => staticFx("XYZ")).toThrow("No FX rate for XYZ");
    cfg.nearIntents = { fxRates: { KES: 0 } };
    expect(() => staticFx("KES")).toThrow("No FX rate");
    cfg.nearIntents = {};
    expect(() => staticFx("KES")).toThrow("No FX rate");
  });

  it("stamps a live quote with its source and time", () => {
    const at = new Date("2026-11-22T12:00:00Z");
    expect(liveFx("ngn", 1612.5, "autoramp", at)).toEqual({ currency: "NGN", perUsd: 1612.5, source: "autoramp", asOf: at.toISOString() });
    expect(() => liveFx("NGN", 0, "autoramp")).toThrow("Bad FX rate");
    expect(() => liveFx("NGN", NaN, "autoramp")).toThrow("Bad FX rate");
  });

  it("a configured rate is never stale, a live one goes stale", () => {
    expect(isStale(staticFx("KES"), 1000, Date.now() + 1e12)).toBe(false);
    const rate = liveFx("NGN", 1600, "autoramp", new Date("2026-11-22T12:00:00Z"));
    const t = Date.parse("2026-11-22T12:00:00Z");
    expect(isStale(rate, 60_000, t + 59_000)).toBe(false);
    expect(isStale(rate, 60_000, t + 61_000)).toBe(true);
    expect(isStale({ ...rate, asOf: "garbage" }, 60_000, t)).toBe(true);
  });

  it("converts at the recorded rate", () => {
    expect(usdAt(13000, staticFx("KES"))).toBe(100);
  });
});

describe("getFx", () => {
  const T0 = Date.parse("2026-11-22T12:00:00Z");
  const provider = (impl: (c: string) => Promise<number>) => {
    const fetch = vi.fn(impl);
    const p: FxProvider = { id: "test", supports: (c) => c.toUpperCase() === "NGN", fetch };
    registerFxProvider(p);
    return fetch;
  };

  it("uses the live rate and says where and when it came from", async () => {
    provider(async () => 1612.5);
    expect(await getFx("ngn", T0)).toEqual({ currency: "NGN", perUsd: 1612.5, source: "test", asOf: new Date(T0).toISOString() });
  });

  it("reuses a live rate inside the cache window, and refreshes after it", async () => {
    const fetch = provider(async () => 1600);
    await getFx("NGN", T0);
    await getFx("NGN", T0 + 299_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    await getFx("NGN", T0 + 301_000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps serving the last good rate when the source goes down, until it is too old", async () => {
    let up = true;
    provider(async () => {
      if (!up) throw new Error("down");
      return 1600;
    });
    await getFx("NGN", T0);
    up = false;
    const during = await getFx("NGN", T0 + 600_000); // 10 min: cache expired, source down, still within 15 min
    expect(during).toMatchObject({ perUsd: 1600, source: "test", asOf: new Date(T0).toISOString() }); // honest about its age
    const after = await getFx("NGN", T0 + 901_000); // past FX_MAX_AGE_SECONDS: never used
    expect(after).toEqual({ currency: "NGN", perUsd: 1500, source: "static", asOf: null });
  });

  it("falls back to the static table, recorded as static, when there was never a live rate", async () => {
    provider(async () => {
      throw new Error("down");
    });
    expect(await getFx("NGN", T0)).toEqual({ currency: "NGN", perUsd: 1500, source: "static", asOf: null });
  });

  it("rejects a rate far from the table as bad data", async () => {
    provider(async () => 15); // a misplaced decimal point
    expect((await getFx("NGN", T0)).source).toBe("static");
    resetFxCache();
    provider(async () => 4000);
    expect((await getFx("NGN", T0)).source).toBe("static");
  });

  it("accepts a real move inside the band", async () => {
    provider(async () => 1500 * 1.2);
    expect((await getFx("NGN", T0)).perUsd).toBe(1800);
  });

  it("rejects zero, negative and NaN from a source", async () => {
    for (const bad of [0, -5, NaN]) {
      resetFxCache();
      provider(async () => bad);
      expect((await getFx("NGN", T0)).source).toBe("static");
    }
  });

  it("only asks a source about currencies it supports", async () => {
    const fetch = provider(async () => 1600);
    expect(await getFx("KES", T0)).toEqual({ currency: "KES", perUsd: 130, source: "static", asOf: null });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("USD is always 1 and never asks a source", async () => {
    const fetch = provider(async () => 1600);
    expect((await getFx("USD", T0)).perUsd).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("is off when no sources are enabled", async () => {
    const fetch = provider(async () => 1600);
    cfg.fx = { liveSources: [] };
    expect((await getFx("NGN", T0)).source).toBe("static");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses the table when a source is enabled but not registered", async () => {
    cfg.fx = { liveSources: ["nobody"] };
    expect((await getFx("NGN", T0)).source).toBe("static");
  });

  it("throws only when there is no rate of any kind", async () => {
    await expect(getFx("XYZ", T0)).rejects.toThrow("No FX rate");
  });

  it("accepts any live rate when the table has nothing to compare it with", async () => {
    cfg.nearIntents = { fxRates: { USD: 1 } };
    provider(async () => 99999);
    expect((await getFx("NGN", T0)).perUsd).toBe(99999);
  });
});
