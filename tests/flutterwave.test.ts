import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/config", () => ({
  config: {
    logLevel: "silent",
    redis: {},
    flutterwave: {
      publicKey: "FLWPUBK_TEST-x",
      secretKey: "FLWSECK_TEST-x",
      isProduction: false,
    },
  },
}));

vi.mock("@/db/prisma", () => ({ prisma: {} }));

const rwanda = vi.fn();
const verifyByTx = vi.fn();

vi.mock("flutterwave-node-v3", () => ({
  default: class FakeFlutterwave {
    constructor() {
      return {
        MobileMoney: { rwanda: (...args: unknown[]) => rwanda(...args) },
        Transaction: { verify_by_tx: (...args: unknown[]) => verifyByTx(...args) },
      };
    }
  },
}));

const { flutterwave } = await import("@/services/flutterwave");

describe("chargeRwandaMobileMoney", () => {
  beforeEach(() => {
    rwanda.mockReset();
    verifyByTx.mockReset();
  });

  it("throws Flutterwave's message when the charge is rejected", async () => {
    // The SDK resolves error bodies instead of rejecting - without our own
    // check this looks like a success and no transaction is ever created.
    // The SDK service returns the body (rave.rwanda destructures { body }).
    rwanda.mockResolvedValue({ status: "error", message: "Phone number is invalid" });

    await expect(
      flutterwave.chargeRwandaMobileMoney({
        txRef: "3RIKE-TEST-1",
        orderId: "3RIKE-TEST-1",
        amount: 1500,
        currency: "RWF",
        phoneNumber: "0781234567",
      })
    ).rejects.toThrow("Phone number is invalid");
  });

  it("throws a generic message when Flutterwave sends none", async () => {
    rwanda.mockResolvedValue({ status: "error" });

    await expect(
      flutterwave.chargeRwandaMobileMoney({
        txRef: "3RIKE-TEST-2",
        orderId: "3RIKE-TEST-2",
        amount: 1500,
        currency: "RWF",
        phoneNumber: "0781234567",
      })
    ).rejects.toThrow(/rejected the mobile money charge/);
  });

  it("returns the response when the charge is accepted", async () => {
    const body = {
      status: "success",
      meta: { authorization: { redirect: "https://checkout.flutterwave.com/pay/abc" } },
    };
    rwanda.mockResolvedValue(body);

    const result = await flutterwave.chargeRwandaMobileMoney({
      txRef: "3RIKE-TEST-3",
      orderId: "3RIKE-TEST-3",
      amount: 1500,
      currency: "RWF",
      phoneNumber: "0781234567",
    });

    expect(result).toEqual(body);
    expect(flutterwave.extractPaymentUrl(result)).toBe(
      "https://checkout.flutterwave.com/pay/abc"
    );
  });

  it("rejects a non-Rwanda phone number before calling Flutterwave", async () => {
    await expect(
      flutterwave.chargeRwandaMobileMoney({
        txRef: "3RIKE-TEST-4",
        amount: 1500,
        currency: "RWF",
        phoneNumber: "not-a-number",
      })
    ).rejects.toThrow(/Not a valid Rwanda mobile number/);

    expect(rwanda).not.toHaveBeenCalled();
  });
});

describe("verifyTransactionByTxRef", () => {
  beforeEach(() => {
    rwanda.mockReset();
    verifyByTx.mockReset();
  });

  it("returns Flutterwave's envelope so callers can see the no-transaction error", async () => {
    const body = {
      status: "error",
      message: "No transaction was found for this id",
      data: null,
    };
    verifyByTx.mockResolvedValue(body);

    const response = await flutterwave.verifyTransactionByTxRef(
      "3RIKE-20261001-FTIVJ8"
    );

    expect(response.status).toBe("error");
    expect(response.message).toBe("No transaction was found for this id");
    expect(response.data).toBeNull();
  });
});
