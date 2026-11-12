import { describe, it, expect, vi } from "vitest";

vi.mock("@/config", () => ({ config: { logLevel: "debug", redis: {} } }));
vi.mock("@/services/cryptoInvoice", () => ({ getCryptoPaymentState: vi.fn(), setVerificationScheduler: vi.fn() }));
vi.mock("@/services/cryptoSweep", () => ({ listTrackableReferences: vi.fn() }));

import { nextDelayMs, isFinished, connectionFromUrl, MAX_TRACK_MS, startCryptoQueue } from "@/services/cryptoQueue";

describe("poll schedule", () => {
  it("polls fast at first and slows right down for the late-payment watch", () => {
    expect(nextDelayMs(0)).toBe(15_000);
    expect(nextDelayMs(20)).toBe(30_000);
    expect(nextDelayMs(50)).toBe(60_000);
    expect(nextDelayMs(500)).toBe(5 * 60_000);
  });
});

describe("isFinished", () => {
  const now = 1_000_000_000_000;
  it("stops for paid, refunded, failed and unknown", () => {
    for (const s of ["paid", "refunded", "failed", "unknown"]) expect(isFinished(s, now, now)).toBe(true);
  });
  it("keeps going while waiting, processing or expired", () => {
    for (const s of ["awaiting_payment", "processing", "expired"]) expect(isFinished(s, now, now + 1000)).toBe(false);
  });
  it("gives up on an unpaid invoice after the late-payment window", () => {
    expect(isFinished("expired", now, now + MAX_TRACK_MS + 1)).toBe(true);
  });
});

describe("connectionFromUrl", () => {
  it("parses host, port, password, db and TLS", () => {
    expect(connectionFromUrl("rediss://:s3cret@redis.example.com:6380/2")).toMatchObject({
      host: "redis.example.com", port: 6380, password: "s3cret", db: 2, tls: {}, maxRetriesPerRequest: null,
    });
  });
  it("defaults the port and db", () => {
    expect(connectionFromUrl("redis://localhost")).toMatchObject({ host: "localhost", port: 6379, db: 0 });
  });
});

describe("startCryptoQueue without Redis", () => {
  it("does nothing, so the in-process sweeper can take over", async () => {
    expect(await startCryptoQueue()).toBe(false);
  });
});
