import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/config", () => ({ config: { logLevel: "debug", redis: {} } }));
vi.mock("@/db/prisma", () => ({ prisma: {} }));
vi.mock("@/services/cryptoInvoice", () => ({ getCryptoPaymentState: vi.fn() }));

const set = vi.fn();
vi.mock("@/services/redis", () => ({ redis: { set: (...a: any[]) => set(...a) } }));

import { acquireLeader } from "@/services/cryptoSweep";

beforeEach(() => vi.clearAllMocks());

describe("acquireLeader with Redis", () => {
  it("takes the lock with NX and an expiry, so only one instance sweeps", async () => {
    set.mockResolvedValue("OK");
    expect(await acquireLeader(25)).toBe(true);
    expect(set).toHaveBeenCalledWith("3rike:crypto-sweeper:leader", expect.any(String), "EX", 25, "NX");
  });

  it("backs off when another instance holds it", async () => {
    set.mockResolvedValue(null);
    expect(await acquireLeader(25)).toBe(false);
  });

  it("still sweeps if Redis errors (settlement is idempotent)", async () => {
    set.mockRejectedValue(new Error("redis down"));
    expect(await acquireLeader(25)).toBe(true);
  });
});
