import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Never read the developer's real .env: these tests control the environment.
vi.mock("dotenv", () => ({ default: { config: () => ({}) }, config: () => ({}) }));

const KEYS = ["NEAR_INTENTS_RECIPIENT", "TREASURY_ADDRESS", "NEAR_INTENTS_REFUND_TO", "NEAR_INTENTS_RECIPIENT_TYPE"];
const saved: Record<string, string | undefined> = {};

async function load(env: Record<string, string>) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  vi.resetModules();
  return (await import("@/config")).config;
}

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
  vi.resetModules();
});

describe("crypto payment recipient", () => {
  const ADDR = "0x1111111111111111111111111111111111111111";

  it("falls back to TREASURY_ADDRESS, so setting it alone turns payments on", async () => {
    const c = await load({ TREASURY_ADDRESS: ADDR });
    expect(c.nearIntents.recipient).toBe(ADDR);
    expect(c.nearIntents.recipientType).toBe("DESTINATION_CHAIN");
    expect(c.nearIntents.refundTo).toBe(ADDR);
    expect(c.treasury.address).toBe(ADDR);
  });

  it("lets NEAR_INTENTS_RECIPIENT win when both are set", async () => {
    const c = await load({ TREASURY_ADDRESS: ADDR, NEAR_INTENTS_RECIPIENT: "0x2222222222222222222222222222222222222222" });
    expect(c.nearIntents.recipient).toBe("0x2222222222222222222222222222222222222222");
  });

  it("stays off when neither is set", async () => {
    const c = await load({});
    expect(c.nearIntents.recipient).toBe("");
  });
});
