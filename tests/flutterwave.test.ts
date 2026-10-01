import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/config", () => ({
  config: {
    logLevel: "silent",
    redis: {},
    flutterwave: {
      publicKey: "FLWPUBK_TEST-x",
      secretKey: "FLWSECK_TEST-x",
      isProduction: false,
      clientId: "cid_test",
      clientSecret: "csecret_test",
      apiBase: "https://developersandbox-api.flutterwave.com",
      tokenUrl: "https://idp.example/token",
      webhookSecret: "flw-secret",
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

describe("v4 push charge client", () => {
  const fetchMock = vi.fn();

  const json = (body: unknown, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
  const token = (value = "tok-1") => json({ access_token: value, expires_in: 600 });

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    // The token cache lives on the singleton; start every test cold.
    (flutterwave as any).v4Token = null;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is enabled only when the OAuth credentials are set", async () => {
    const { config } = await import("@/config");
    const flutterwaveConfig = config.flutterwave as any;
    const original = flutterwaveConfig.clientId;

    flutterwaveConfig.clientId = "";
    expect(flutterwave.isV4Enabled()).toBe(false);

    flutterwaveConfig.clientId = original;
    expect(flutterwave.isV4Enabled()).toBe(true);
  });

  it("mints one access token and reuses it across calls", async () => {
    fetchMock
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(json({ status: "success", data: { id: "cus_1" } }))
      .mockResolvedValueOnce(json({ status: "success", data: { id: "cus_2" } }));

    await flutterwave.createV4Customer({ email: "one@buyer.app" });
    await flutterwave.createV4Customer({ email: "two@buyer.app" });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][0]).toBe("https://idp.example/token");
    expect(fetchMock.mock.calls[0][1].body.toString()).toContain("client_id=cid_test");
    expect(fetchMock.mock.calls[2][1].headers.Authorization).toBe("Bearer tok-1");
  });

  it("sends the trace and idempotency headers on a charge", async () => {
    fetchMock
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(
        json({
          status: "success",
          data: {
            id: "chg_1",
            status: "pending",
            reference: "3RIKE-20261001-ABC123",
            next_action: {
              type: "payment_instruction",
              payment_instruction: { note: "Approve this payment on your phone." },
            },
          },
        })
      );

    const charge = await flutterwave.createV4Charge({
      reference: "3RIKE-20261001-ABC123",
      amount: 5000,
      currency: "RWF",
      customerId: "cus_1",
      paymentMethodId: "pmd_1",
    });

    const [, init] = fetchMock.mock.calls[1];
    expect(init.method).toBe("POST");
    expect(init.headers["X-Trace-Id"]).toMatch(/.{12,}/);
    expect(init.headers["X-Idempotency-Key"]).toBe("3RIKE-20261001-ABC123");
    expect(JSON.parse(init.body)).toMatchObject({
      reference: "3RIKE-20261001-ABC123",
      amount: 5000,
      currency: "RWF",
      customer_id: "cus_1",
      payment_method_id: "pmd_1",
    });

    // Push flow: instruction, no link.
    expect(charge.id).toBe("chg_1");
    expect(flutterwave.extractV4PaymentUrl(charge)).toBeNull();
    expect(flutterwave.extractV4PaymentInstruction(charge)).toBe(
      "Approve this payment on your phone."
    );
  });

  it("reads the redirect URL when Flutterwave answers with one instead", async () => {
    fetchMock
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(
        json({
          status: "success",
          data: {
            id: "chg_2",
            next_action: { type: "redirect_url", redirect_url: { url: "https://pay.example/x" } },
          },
        })
      );

    const charge = await flutterwave.createV4Charge({
      reference: "3RIKE-20261001-REDIR",
      amount: 100,
      customerId: "cus_1",
      paymentMethodId: "pmd_1",
    });

    expect(flutterwave.extractV4PaymentUrl(charge)).toBe("https://pay.example/x");
    expect(flutterwave.extractV4PaymentInstruction(charge)).toBeNull();
  });

  it("throws Flutterwave's message when the v4 API rejects a request", async () => {
    fetchMock
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(
        json(
          {
            status: "failed",
            error: { type: "REQUEST_NOT_VALID", message: "Currency not supported for RW Mobile Money." },
          },
          400
        )
      );

    await expect(
      flutterwave.createV4Charge({
        reference: "3RIKE-20261001-REJECT",
        amount: 100,
        customerId: "cus_1",
        paymentMethodId: "pmd_1",
      })
    ).rejects.toThrow("Currency not supported for RW Mobile Money.");
  });

  it("retries once with a fresh token when the cached one is rejected", async () => {
    fetchMock
      .mockResolvedValueOnce(token("tok-old"))
      .mockResolvedValueOnce(json({ status: "failed", message: "UNAUTHORIZED" }, 401))
      .mockResolvedValueOnce(token("tok-new"))
      .mockResolvedValueOnce(json({ status: "success", data: { id: "cus_3" } }));

    const customer = await flutterwave.createV4Customer({ email: "retry@buyer.app" });

    expect(customer.id).toBe("cus_3");
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[3][1].headers.Authorization).toBe("Bearer tok-new");
  });

  it("maps Rwanda prefixes to the carrier and strips the trunk zero", async () => {
    fetchMock
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(json({ status: "success", data: { id: "pmd_mtn" } }))
      .mockResolvedValueOnce(json({ status: "success", data: { id: "pmd_airtel" } }));

    await flutterwave.createV4MobileMoneyPaymentMethod({ phoneNumber: "0781234567" });
    await flutterwave.createV4MobileMoneyPaymentMethod({ phoneNumber: "250738123456" });

    const mtnBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(mtnBody.type).toBe("mobile_money");
    expect(mtnBody.mobile_money).toEqual({
      country_code: "250",
      network: "MTN",
      phone_number: "781234567",
    });

    const airtelBody = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(airtelBody.mobile_money.network).toBe("AIRTEL");
    expect(airtelBody.mobile_money.phone_number).toBe("738123456");
  });

  it("surfaces the v4 error when the customer payload is invalid", async () => {
    fetchMock
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(
        json(
          {
            status: "failed",
            error: {
              message: "Request is not valid",
              validation_errors: [{ field_name: "email", message: "must be an email format" }],
            },
          },
          400
        )
      );

    await expect(
      flutterwave.createV4Customer({ email: "not-an-email" })
    ).rejects.toThrow("must be an email format");
  });
});

describe("webhook signatures", () => {
  const raw = Buffer.from(
    JSON.stringify({ type: "charge.completed", data: { reference: "3RIKE-INV-1" } })
  );

  it("accepts the matching legacy verif-hash", () => {
    expect(flutterwave.verifyWebhookSignature("flw-secret")).toBe(true);
  });

  it("rejects a mismatched legacy verif-hash", () => {
    expect(flutterwave.verifyWebhookSignature("wrong")).toBe(false);
  });

  it("accepts the base64 HMAC-SHA256 of the raw body (v4)", async () => {
    const crypto = await import("node:crypto");
    const signature = crypto.createHmac("sha256", "flw-secret").update(raw).digest("base64");

    expect(flutterwave.verifyV4WebhookSignature(raw, signature)).toBe(true);
  });

  it("rejects a v4 signature when the body was altered", async () => {
    const crypto = await import("node:crypto");
    const signature = crypto.createHmac("sha256", "flw-secret").update(raw).digest("base64");
    const tampered = Buffer.from(raw.toString("utf8").replace("3RIKE-INV-1", "3RIKE-INV-2"));

    expect(flutterwave.verifyV4WebhookSignature(tampered, signature)).toBe(false);
  });

  it("rejects a v4 signature when none is sent", () => {
    expect(flutterwave.verifyV4WebhookSignature(raw, "")).toBe(false);
  });
});

describe("chargeRwandaMobileMoneyV4", () => {
  const fetchMock = vi.fn();

  const json = (body: unknown, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    (flutterwave as any).v4Token = null;
    fetchMock.mockResolvedValueOnce(json({ access_token: "tok-1", expires_in: 600 }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("chains customer -> payment method -> charge with the ids linked", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ status: "success", data: { id: "cus_9" } }))
      .mockResolvedValueOnce(json({ status: "success", data: { id: "pmd_9" } }))
      .mockResolvedValueOnce(
        json({
          status: "success",
          data: {
            id: "chg_9",
            status: "pending",
            next_action: {
              type: "payment_instruction",
              payment_instruction: { note: "Approve on your phone" },
            },
          },
        })
      );

    const charge = await flutterwave.chargeRwandaMobileMoneyV4({
      reference: "3RIKE-20261001-ABC123",
      amount: 3000,
      currency: "RWF",
      phoneNumber: "0781234567",
      meta: { invoice_id: "inv_1" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);

    const customerBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(customerBody.email).toBe("buyer-0781234567@pay.3rike.app");
    expect(customerBody.phone).toEqual({ country_code: "250", number: "781234567" });

    const pmdBody = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(pmdBody.mobile_money.phone_number).toBe("781234567");

    const chargeBody = JSON.parse(fetchMock.mock.calls[3][1].body);
    expect(chargeBody).toMatchObject({
      reference: "3RIKE-20261001-ABC123",
      amount: 3000,
      currency: "RWF",
      customer_id: "cus_9",
      payment_method_id: "pmd_9",
      meta: { invoice_id: "inv_1" },
    });

    expect(charge.id).toBe("chg_9");
    expect(flutterwave.extractV4PaymentInstruction(charge)).toBe("Approve on your phone");
    expect(flutterwave.extractV4PaymentUrl(charge)).toBeNull();
  });

  it("refuses a number that is not a Rwanda mobile number", async () => {
    await expect(
      flutterwave.chargeRwandaMobileMoneyV4({
        reference: "3RIKE-20261001-BADNUM",
        amount: 100,
        phoneNumber: "12345",
      })
    ).rejects.toThrow(/Not a valid Rwanda mobile number/);

    // No request goes out at all, not even a token.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
