import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/config", () => ({ config: { logLevel: "debug", redis: {} } }));

const invoiceFindMany = vi.fn();
const txFindMany = vi.fn();
vi.mock("@/db/prisma", () => ({
  prisma: {
    invoice: { findMany: (...a: any[]) => invoiceFindMany(...a) },
    transaction: { findMany: (...a: any[]) => txFindMany(...a) },
  },
}));

const getState = vi.fn();
vi.mock("@/services/cryptoInvoice", () => ({ getCryptoPaymentState: (...a: any[]) => getState(...a) }));

import { sweepCryptoPayments } from "@/services/cryptoSweep";

beforeEach(() => {
  vi.clearAllMocks();
  getState.mockResolvedValue({ state: "awaiting_payment" });
});

describe("sweepCryptoPayments", () => {
  it("checks only invoices that have a crypto payment in flight", async () => {
    invoiceFindMany.mockResolvedValue([{ reference: "A" }, { reference: "B" }, { reference: "C" }]);
    txFindMany.mockResolvedValue([{ reference: "A" }, { reference: "C" }]); // B has no crypto payment
    expect(await sweepCryptoPayments()).toBe(2);
    expect(getState.mock.calls.map((c) => c[0])).toEqual(["A", "C"]);
  });

  it("looks at open invoices only by default, and adds recently expired ones when asked", async () => {
    invoiceFindMany.mockResolvedValue([]);
    await sweepCryptoPayments(false);
    expect(invoiceFindMany.mock.calls[0][0].where).toEqual({ status: { in: ["sent", "pending_payment"] } });

    await sweepCryptoPayments(true);
    const where = invoiceFindMany.mock.calls[1][0].where;
    expect(where.OR[1].status).toBe("expired");
    expect(where.OR[1].updatedAt.gt).toBeInstanceOf(Date);
  });

  it("one failing invoice does not stop the others", async () => {
    invoiceFindMany.mockResolvedValue([{ reference: "A" }, { reference: "B" }]);
    txFindMany.mockResolvedValue([{ reference: "A" }, { reference: "B" }]);
    getState.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce({ state: "paid" });
    expect(await sweepCryptoPayments()).toBe(1);
    expect(getState).toHaveBeenCalledTimes(2);
  });

  it("does nothing when there are no open invoices", async () => {
    invoiceFindMany.mockResolvedValue([]);
    expect(await sweepCryptoPayments()).toBe(0);
    expect(txFindMany).not.toHaveBeenCalled();
  });
});

describe("acquireLeader (Redis lock)", () => {
  it("lets every instance sweep when Redis is not configured", async () => {
    const { acquireLeader } = await import("@/services/cryptoSweep");
    expect(await acquireLeader(25)).toBe(true);
  });
});
