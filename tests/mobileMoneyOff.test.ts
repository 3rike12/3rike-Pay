import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The REAL config, with dotenv off so a developer's own .env cannot interfere.
vi.mock("dotenv", () => ({ default: { config: () => ({}) }, config: () => ({}) }));

describe("mobile money collection is switched off, and the environment cannot turn it on", () => {
  const saved = process.env.MOBILE_MONEY_ENABLED;
  beforeEach(() => vi.resetModules());
  afterEach(() => (saved === undefined ? delete process.env.MOBILE_MONEY_ENABLED : (process.env.MOBILE_MONEY_ENABLED = saved)));

  for (const value of [undefined, "false", "true", "TRUE", "1", "yes"]) {
    it(`MOBILE_MONEY_ENABLED=${value ?? "(unset)"} -> off`, async () => {
      if (value === undefined) delete process.env.MOBILE_MONEY_ENABLED;
      else process.env.MOBILE_MONEY_ENABLED = value;
      vi.resetModules();
      const { config } = (await import("@/config")) as any;
      expect(config.features.mobileMoneyEnabled).toBe(false);
    });
  }
});

describe("invoicing is paused, and the environment cannot turn it on", () => {
  const saved = process.env.INVOICING_ENABLED;
  beforeEach(() => vi.resetModules());
  afterEach(() => (saved === undefined ? delete process.env.INVOICING_ENABLED : (process.env.INVOICING_ENABLED = saved)));

  for (const value of [undefined, "false", "true", "TRUE", "1"]) {
    it(`INVOICING_ENABLED=${value ?? "(unset)"} -> off`, async () => {
      if (value === undefined) delete process.env.INVOICING_ENABLED;
      else process.env.INVOICING_ENABLED = value;
      vi.resetModules();
      const { config } = (await import("@/config")) as any;
      expect(config.features.invoicingEnabled).toBe(false);
    });
  }
});

