import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/config", () => ({
  config: {
    features: { dryRun: false, mobileMoneyEnabled: true },
    logLevel: "debug",
    whatsapp: { verifyToken: "test-verify-token" },
  },
}));

const h = vi.hoisted(() => {
  const session = { state: "idle", flowData: {} as Record<string, unknown> };
  return {
    session: session as { state: string; flowData: Record<string, unknown> },
    user: {
      id: "user_1",
      phone: "250788000111",
      name: "Test Merchant",
      kycStatus: "pending",
      createdAt: new Date("2020-01-01T00:00:00Z"),
      bankAccount: null as any,
      business: {
        id: "biz_1",
        userId: "user_1",
        name: "Test Shop",
        email: "shop@test.example",
        phone: "0788000111",
        country: "KE",
        registrationNumber: null,
      } as any,
    },
    sendTextMessage: vi.fn(),
    sendButtonsMessage: vi.fn(),
    createProduct: vi.fn(),
    listProducts: vi.fn(),
    createDraftInvoice: vi.fn(),
    chargeInvoice: vi.fn(),
    renderInvoiceSummary: vi.fn(),
    scheduleInvoiceVerification: vi.fn(),
    expireStaleInvoices: vi.fn(),
    updateSession: vi.fn(),
    resetSession: vi.fn(),
    getSession: vi.fn(),
    listPaidInvoices: vi.fn(),
    listBalances: vi.fn(),
    businessUpdate: vi.fn(async () => ({})),
    createSession: vi.fn(),
    listBanks: vi.fn(),
    nameEnquiry: vi.fn(),
    quoteCashout: vi.fn(),
    requestCashout: vi.fn(),
  };
});

vi.mock("@/services/whatsapp", () => ({
  whatsapp: {
    sendTextMessage: (...args: any[]) => h.sendTextMessage(...args),
    sendButtonsMessage: (...args: any[]) => h.sendButtonsMessage(...args),
    uploadMedia: vi.fn().mockResolvedValue("media-1"),
    sendImageMessage: vi.fn().mockResolvedValue(true),
    sendListMessage: vi.fn().mockResolvedValue(true),
    sendTemplate: vi.fn().mockResolvedValue(true),
    sendFlowMessage: vi.fn().mockResolvedValue(true),
    markAsRead: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/services/autoramp", () => ({
  autoramp: {
    transfer: vi.fn(),
    getSubAccount: vi.fn(),
    verifyIdentity: vi.fn(),
    listBanks: (...args: any[]) => h.listBanks(...args),
    nameEnquiry: (...args: any[]) => h.nameEnquiry(...args),
  },
}));

vi.mock("@/services/toden", () => ({
  createVerificationSession: (...args: any[]) => h.createSession(...args),
}));

vi.mock("@/services/cashout", () => ({
  quoteCashout: (...args: any[]) => h.quoteCashout(...args),
  requestCashout: (...args: any[]) => h.requestCashout(...args),
}));

vi.mock("@/services/database", () => ({
  prisma: {
    webhookEvent: { findFirst: vi.fn().mockResolvedValue(null) },
    user: { findUnique: vi.fn(), update: vi.fn(async () => ({})) },
    business: { update: (...args: any[]) => h.businessUpdate(...args) },
    transaction: { findUnique: vi.fn() },
  },
  findOrCreateUser: vi.fn(async () => h.user),
  getSession: (...args: any[]) => h.getSession(...args),
  updateSession: (...args: any[]) => h.updateSession(...args),
  resetSession: (...args: any[]) => h.resetSession(...args),
  createTransaction: vi.fn(),
  updateTransaction: vi.fn(),
  logWebhookEvent: vi.fn(),
}));

vi.mock("@/services/ledger", () => ({
  ledger: { listBalances: (...args: any[]) => h.listBalances(...args) },
}));

vi.mock("@/services/invoice", () => ({
  createProduct: (...args: any[]) => h.createProduct(...args),
  listProducts: (...args: any[]) => h.listProducts(...args),
  createDraftInvoice: (...args: any[]) => h.createDraftInvoice(...args),
  chargeInvoice: (...args: any[]) => h.chargeInvoice(...args),
  renderInvoiceSummary: (...args: any[]) => h.renderInvoiceSummary(...args),
  scheduleInvoiceVerification: (...args: any[]) => h.scheduleInvoiceVerification(...args),
  expireStaleInvoices: (...args: any[]) => h.expireStaleInvoices(...args),
  listPaidInvoices: (...args: any[]) => h.listPaidInvoices(...args),
  humanizeChargeError: (error: unknown) =>
    error instanceof Error ? error.message : String((error as any)?.message ?? error ?? ""),
}));

import { handleMessage } from "@/bot";
import { whatsapp } from "@/services/whatsapp";
import { SESSION_STATE, MESSAGES } from "@/config/constants";

const PHONE = "250788000111";

/**
 * Drive one inbound message and return the last body we sent, whether it
 * went out as plain text or as an interactive button message.
 */
async function say(text: string, buttonId?: string) {
  const textBefore = h.sendTextMessage.mock.calls.length;
  const buttonsBefore = h.sendButtonsMessage.mock.calls.length;
  const imagesBefore = vi.mocked(whatsapp.sendImageMessage).mock.calls.length;
  await handleMessage(
    PHONE,
    "Test Merchant",
    text,
    buttonId ? { id: buttonId, title: "" } : undefined
  );
  const imageCalls = vi.mocked(whatsapp.sendImageMessage).mock.calls.slice(imagesBefore);
  if (imageCalls.length) return String(imageCalls[imageCalls.length - 1][2] ?? "");
  const buttonCalls = h.sendButtonsMessage.mock.calls.slice(buttonsBefore);
  if (buttonCalls.length) return String(buttonCalls[buttonCalls.length - 1][1]);
  const textCalls = h.sendTextMessage.mock.calls.slice(textBefore);
  return textCalls.length ? String(textCalls[textCalls.length - 1][1]) : "";
}

function setSession(state: string, flowData: Record<string, unknown> = {}) {
  h.session = { state, flowData };
}

beforeEach(() => {
  vi.clearAllMocks();

  h.session = { state: "idle", flowData: {} };
  h.sendTextMessage.mockResolvedValue(true);
  h.sendButtonsMessage.mockResolvedValue(true);

  h.getSession.mockImplementation(async () => h.session);
  h.updateSession.mockImplementation(async (_id: string, state: string, flowData: Record<string, unknown>) => {
    h.session = { state, flowData };
    return h.session;
  });
  h.resetSession.mockImplementation(async () => {
    h.session = { state: "idle", flowData: {} };
  });

  h.expireStaleInvoices.mockResolvedValue(0);
  h.listProducts.mockResolvedValue([]);
  h.createProduct.mockImplementation(async (p: any) => ({ id: "prod_1", ...p }));
  h.createDraftInvoice.mockResolvedValue({ id: "inv_new" });
  h.renderInvoiceSummary.mockImplementation(
    (inv: any) =>
      `Total: RWF ${inv.amount}\nBuyer: ${inv.buyerPhone}` +
      (inv.paymentUrl ? `\nFallback link: ${inv.paymentUrl}` : "")
  );
  h.scheduleInvoiceVerification.mockImplementation(() => {});
  h.chargeInvoice.mockResolvedValue({
    invoice: {
      reference: "3RIKE-TEST-1",
      amount: 3000,
      currency: "RWF",
      status: "pending_payment",
      buyerPhone: "0781234567",
      items: [{ name: "batteries", qty: 3, unitPrice: 1000 }],
      expiresAt: new Date("2026-09-30T15:00:00Z"),
      paymentUrl: "https://checkout.flutterwave.com/v3/hosted/pay/abc",
    },
    txRef: "3RIKE-TEST-1",
    paymentUrl: "https://checkout.flutterwave.com/v3/hosted/pay/abc",
  });
});

describe("product command", () => {
  it("creates a product directly when name and price are given", async () => {
    const reply = await say("/product Batteries 1000");

    expect(h.createProduct).toHaveBeenCalledWith({
      merchantId: "user_1",
      name: "Batteries",
      price: 1000,
      currency: "KES",
    });
    expect(reply).toContain("Added *Batteries*");
    expect(h.resetSession).toHaveBeenCalled();
  });

  it("walks name then price when only the command is given", async () => {
    let reply = await say("/product");
    expect(h.updateSession).toHaveBeenCalledWith("user_1", SESSION_STATE.PRODUCT_CREATE, {
      step: "name",
    });
    expect(reply).toBe(MESSAGES.BUSINESS.PRODUCT.PROMPT_NAME);

    reply = await say("Umbrella");
    expect(h.updateSession).toHaveBeenCalledWith("user_1", SESSION_STATE.PRODUCT_CREATE, {
      step: "price",
      name: "Umbrella",
    });
    expect(reply).toContain("How much is *Umbrella*?");

    reply = await say("5000");
    expect(h.createProduct).toHaveBeenCalledWith({
      merchantId: "user_1",
      name: "Umbrella",
      price: 5000,
      currency: "KES",
    });
    expect(reply).toContain("Added *Umbrella*");
    expect(h.session.state).toBe("idle");
  });

  it("re-prompts on a non-numeric price", async () => {
    setSession(SESSION_STATE.PRODUCT_CREATE, { step: "price", name: "Umbrella" });

    const reply = await say("not a number");

    expect(h.createProduct).not.toHaveBeenCalled();
    expect(reply).toBe(MESSAGES.BUSINESS.PRODUCT.INVALID_PRICE);
    expect(h.session.state).toBe(SESSION_STATE.PRODUCT_CREATE);
  });

  it("lists the catalogue with RWF amounts", async () => {
    h.listProducts.mockResolvedValue([
      { id: "p1", name: "Batteries", price: 1000, currency: "RWF" },
      { id: "p2", name: "Water", price: 500, currency: "RWF" },
    ] as any);

    const reply = await say("/products");

    expect(reply).toContain("1. Batteries - RWF 1,000");
    expect(reply).toContain("2. Water - RWF 500");
  });

  it("says so when the catalogue is empty", async () => {
    const reply = await say("/products");
    expect(reply).toBe(MESSAGES.BUSINESS.PRODUCT.LIST_EMPTY);
  });
});

describe("invoice triggers", () => {
  it("routes 'payment request' to the invoice flow, not send money", async () => {
    const reply = await say("payment request for 0781234567");

    expect(h.session.state).toBe(SESSION_STATE.INVOICE_ITEMS);
    expect(reply).toBe(MESSAGES.BUSINESS.INVOICE.PROMPT_ITEMS);
    expect(h.updateSession).not.toHaveBeenCalledWith(
      "user_1",
      SESSION_STATE.SEND_MONEY,
      expect.anything()
    );
  });

  it("asks for a price when the idle message has invoice intent but no price", async () => {
    const reply = await say("invoice 3 batteries for 0781234567");

    expect(h.session.state).toBe(SESSION_STATE.INVOICE_PRICE);
    expect(h.session.flowData.items).toEqual([{ name: "batteries", qty: 3, unitPrice: null }]);
    expect(h.session.flowData.buyerPhone).toBe("0781234567");
    expect(reply).toContain("How much is *batteries*?");
  });

  it("prices from the catalogue and asks for the buyer number", async () => {
    h.listProducts.mockResolvedValue([
      { id: "p1", name: "batteries", price: 1000, currency: "RWF" },
    ] as any);

    const reply = await say("invoice 3 batteries");

    expect(h.session.state).toBe(SESSION_STATE.INVOICE_PHONE);
    expect(h.session.flowData.items[0].unitPrice).toBe(1000);
    expect(reply).toBe(MESSAGES.BUSINESS.INVOICE.PROMPT_PHONE);
  });

  it("opens the item prompt from the main-menu row", async () => {
    await say("ok", "create_invoice");

    expect(h.session.state).toBe(SESSION_STATE.INVOICE_ITEMS);
  });
});

describe("invoice conversation", () => {
  it("goes straight to confirmation when items, price and phone are all present", async () => {
    setSession(SESSION_STATE.INVOICE_ITEMS, {});

    const reply = await say("2 waters at 1500 for 0781234567");

    expect(h.session.state).toBe(SESSION_STATE.INVOICE_CONFIRM);
    expect(h.session.flowData.items).toEqual([
      { name: "waters", qty: 2, unitPrice: 1500 },
    ]);
    expect(h.session.flowData.buyerPhone).toBe("0781234567");
    expect(reply).toContain("*Confirm invoice*");
    expect(reply).toContain("Total: RWF 3,000");
    expect(reply).toContain("Buyer: 0781234567");
    // Confirmation arrives as buttons, not as "type yes".
    expect(h.sendButtonsMessage.mock.calls.at(-1)?.[2]).toEqual([
      { id: "confirm_invoice", title: "Yes" },
      { id: "cancel_invoice", title: "No" },
    ]);
    expect(reply).toContain("Tap *Yes*");
  });

  it("asks for the buyer number when the item message has none", async () => {
    setSession(SESSION_STATE.INVOICE_ITEMS, {});

    const reply = await say("2 waters at 1500");

    expect(h.session.state).toBe(SESSION_STATE.INVOICE_PHONE);
    expect(reply).toBe(MESSAGES.BUSINESS.INVOICE.PROMPT_PHONE);

    const confirm = await say("0781234567");
    expect(h.session.state).toBe(SESSION_STATE.INVOICE_CONFIRM);
    expect(confirm).toContain("Total: RWF 3,000");
  });

  it("asks for a price when an item has none and nothing matches the catalogue", async () => {
    setSession(SESSION_STATE.INVOICE_ITEMS, {});

    const pricePrompt = await say("2 waters");

    expect(h.session.state).toBe(SESSION_STATE.INVOICE_PRICE);
    expect(h.session.flowData.priceIndex).toBe(0);
    expect(pricePrompt).toContain("How much is *waters*?");

    const phonePrompt = await say("700");
    expect(h.session.state).toBe(SESSION_STATE.INVOICE_PHONE);
    expect(h.session.flowData.items).toEqual([{ name: "waters", qty: 2, unitPrice: 700 }]);
    expect(phonePrompt).toBe(MESSAGES.BUSINESS.INVOICE.PROMPT_PHONE);

    const confirm = await say("0781234567");
    expect(h.session.state).toBe(SESSION_STATE.INVOICE_CONFIRM);
    expect(confirm).toContain("Total: RWF 1,400");
  });

  it("re-asks for a non-Rwanda number instead of scolding", async () => {
    setSession(SESSION_STATE.INVOICE_PHONE, {
      items: [{ name: "water", qty: 1, unitPrice: 1500 }],
      buyerPhone: null,
    });

    const reply = await say("054709929220");

    expect(h.session.state).toBe(SESSION_STATE.INVOICE_PHONE);
    expect(reply).toBe(MESSAGES.BUSINESS.INVOICE.PROMPT_PHONE);
  });

  it("accepts a number pasted inside the whole request", async () => {
    setSession(SESSION_STATE.INVOICE_PHONE, {
      items: [{ name: "waters", qty: 2, unitPrice: 1500 }],
      buyerPhone: null,
    });

    // The merchant re-sends the full command instead of only the number;
    // the qty/price digits must not poison the phone check.
    const reply = await say("Charge 0782348251 2 waters at 1500");

    expect(h.session.state).toBe(SESSION_STATE.INVOICE_CONFIRM);
    expect(h.session.flowData.buyerPhone).toBe("0782348251");
    expect(reply).toContain("Total: RWF 3,000");
    expect(reply).toContain("Buyer: 0782348251");
  });

  it("rejects an empty item message", async () => {
    setSession(SESSION_STATE.INVOICE_ITEMS, {});

    const reply = await say("");

    expect(h.session.state).toBe(SESSION_STATE.INVOICE_ITEMS);
    expect(reply).toBe(MESSAGES.BUSINESS.INVOICE.INVALID_ITEMS);
  });

  it("answers KYC and send-to-bank requests with a notice while legacy banking is off", async () => {
    setSession(SESSION_STATE.IDLE, {});

    await say("kyc");

    expect(h.sendTextMessage).toHaveBeenCalledWith(
      "250788000111",
      expect.stringContaining("isn't available right now")
    );
  });

  it("does not charge mobile money when it is disabled", async () => {
    const { config } = await import("@/config");
    (config.features as any).mobileMoneyEnabled = false;
    try {
      setSession(SESSION_STATE.INVOICE_CONFIRM, {
        items: [{ name: "batteries", qty: 3, unitPrice: 1000 }],
        buyerPhone: "0781234567",
      });

      await say("yes");

      // NEAR is not configured in this test, so the merchant is told to wait
      // rather than a Flutterwave prompt being fired.
      expect(h.chargeInvoice).not.toHaveBeenCalled();
      expect(h.scheduleInvoiceVerification).not.toHaveBeenCalled();
      expect(h.sendTextMessage).toHaveBeenCalledWith(
        "250788000111",
        expect.stringContaining("temporarily unavailable")
      );
    } finally {
      (config.features as any).mobileMoneyEnabled = true;
    }
  });

  it("charges on yes and schedules verification", async () => {
    setSession(SESSION_STATE.INVOICE_CONFIRM, {
      items: [{ name: "batteries", qty: 3, unitPrice: 1000 }],
      buyerPhone: "0781234567",
    });

    await say("yes");

    expect(h.createDraftInvoice).toHaveBeenCalledWith({
      merchantId: "user_1",
      buyerPhone: "0781234567",
      currency: "KES",
      items: [{ name: "batteries", qty: 3, unitPrice: 1000 }],
    });
    expect(h.chargeInvoice).toHaveBeenCalledWith({
      merchantId: "user_1",
      invoiceId: "inv_new",
    });
    expect(h.scheduleInvoiceVerification).toHaveBeenCalledWith("3RIKE-TEST-1");
    expect(h.resetSession).toHaveBeenCalled();
    expect(h.session.state).toBe("idle");

    // The buyer is never messaged - no QR upload, no image, no text.
    expect(whatsapp.uploadMedia).not.toHaveBeenCalled();
    expect(whatsapp.sendImageMessage).not.toHaveBeenCalled();
    expect(h.sendTextMessage).not.toHaveBeenCalledWith(
      "0781234567",
      expect.anything()
    );

    // The merchant alone gets the summary, with the link to forward.
    expect(h.sendTextMessage).toHaveBeenCalledTimes(1);
    expect(h.sendTextMessage).toHaveBeenCalledWith(
      PHONE,
      expect.stringContaining("Payment request issued")
    );
    expect(h.sendTextMessage).toHaveBeenCalledWith(
      PHONE,
      expect.stringContaining("Fallback link")
    );
  });

  it("tells the merchant the prompt is on the buyer's phone when the charge was pushed", async () => {
    setSession(SESSION_STATE.INVOICE_CONFIRM, {
      items: [{ name: "batteries", qty: 3, unitPrice: 1000 }],
      buyerPhone: "0781234567",
    });
    // v4 push: no link anywhere, just the prompt on the buyer's handset.
    h.chargeInvoice.mockResolvedValue({
      invoice: {
        reference: "3RIKE-TEST-1",
        amount: 3000,
        currency: "RWF",
        status: "pending_payment",
        buyerPhone: "0781234567",
        items: [{ name: "batteries", qty: 3, unitPrice: 1000 }],
        expiresAt: new Date("2026-09-30T15:00:00Z"),
        paymentUrl: null,
      },
      txRef: "3RIKE-TEST-1",
      paymentUrl: null,
      paymentNote: "Approve this payment on your phone.",
      chargeId: "chg_1",
    });

    const reply = await say("yes");

    // Nothing to encode, and the buyer is never messaged at all.
    expect(whatsapp.uploadMedia).not.toHaveBeenCalled();
    expect(whatsapp.sendImageMessage).not.toHaveBeenCalled();
    expect(h.sendTextMessage).not.toHaveBeenCalledWith(
      "0781234567",
      expect.anything()
    );
    // The merchant hears about the prompt instead of being handed a link.
    expect(reply).toContain("Payment request issued");
    expect(reply).toContain("payment prompt");
    expect(reply).not.toContain("https://");
    expect(h.scheduleInvoiceVerification).toHaveBeenCalledWith("3RIKE-TEST-1");
    expect(h.resetSession).toHaveBeenCalled();
  });

  it("does not charge without confirmation", async () => {
    setSession(SESSION_STATE.INVOICE_CONFIRM, {
      items: [{ name: "batteries", qty: 3, unitPrice: 1000 }],
      buyerPhone: "0781234567",
    });

    const reply = await say("hmm not yet");

    expect(h.chargeInvoice).not.toHaveBeenCalled();
    expect(reply).toContain("Reply *yes*");
    // The nudge comes with tappable Yes/Cancel, not as plain text.
    expect(h.sendButtonsMessage).toHaveBeenCalledWith(
      PHONE,
      expect.stringContaining("Reply *yes* to send the payment request"),
      [
        { id: "confirm_invoice", title: "Yes" },
        { id: "cancel_invoice", title: "Cancel" },
      ]
    );
    expect(h.session.state).toBe(SESSION_STATE.INVOICE_CONFIRM);
  });

  it("cancels on cancel", async () => {
    setSession(SESSION_STATE.INVOICE_CONFIRM, {
      items: [{ name: "batteries", qty: 3, unitPrice: 1000 }],
      buyerPhone: "0781234567",
    });

    await say("cancel");

    expect(h.chargeInvoice).not.toHaveBeenCalled();
    expect(h.resetSession).toHaveBeenCalled();
    expect(h.session.state).toBe("idle");
  });

  it("keeps the draft and reports the error when the charge fails", async () => {
    setSession(SESSION_STATE.INVOICE_CONFIRM, {
      items: [{ name: "batteries", qty: 3, unitPrice: 1000 }],
      buyerPhone: "0781234567",
    });
    h.chargeInvoice.mockRejectedValue(new Error("provider unavailable"));

    const reply = await say("yes");

    expect(reply).toContain("Could not start the payment");
    expect(reply).toContain("provider unavailable");
    expect(reply).toContain("Reply *yes* to send the payment request");
    // The failure message carries the retry buttons too.
    expect(h.sendButtonsMessage).toHaveBeenCalledWith(
      PHONE,
      expect.stringContaining("Could not start the payment"),
      [
        { id: "confirm_invoice", title: "Yes" },
        { id: "cancel_invoice", title: "Cancel" },
      ]
    );
    expect(h.session.state).toBe(SESSION_STATE.INVOICE_CONFIRM);
    // A retry must reuse the draft instead of creating a second invoice.
    expect(h.createDraftInvoice).toHaveBeenCalledTimes(1);
    expect(h.session.flowData.draftId).toBe("inv_new");
  });

  it("omits the no-link sentence when neither a link nor a prompt came back", async () => {
    setSession(SESSION_STATE.INVOICE_CONFIRM, {
      items: [{ name: "batteries", qty: 3, unitPrice: 1000 }],
      buyerPhone: "0781234567",
    });
    h.chargeInvoice.mockResolvedValue({
      invoice: {
        reference: "3RIKE-TEST-1",
        amount: 3000,
        currency: "RWF",
        status: "pending_payment",
        buyerPhone: "0781234567",
        items: [{ name: "batteries", qty: 3, unitPrice: 1000 }],
        expiresAt: new Date("2026-09-30T15:00:00Z"),
        paymentUrl: null,
      },
      txRef: "3RIKE-TEST-1",
      paymentUrl: null,
      paymentNote: null,
      chargeId: null,
    });

    const reply = await say("yes");

    expect(reply).toContain("Payment request issued");
    expect(reply).not.toContain("has not been sent anything");
    expect(reply).not.toContain("provider returned no payment link");
  });
});


// ============================================
// The merchant's screens while mobile money and the bank features are off
// ============================================

import { config } from "@/config";

/** Run `fn` with mobile money switched off (the product's default), then restore. */
async function withMobileMoneyOff(fn: () => Promise<void>) {
  (config.features as any).mobileMoneyEnabled = false;
  try {
    await fn();
  } finally {
    (config.features as any).mobileMoneyEnabled = true;
  }
}

describe("invoice without mobile money", () => {
  it("never asks for the customer's number", async () => {
    await withMobileMoneyOff(async () => {
      setSession(SESSION_STATE.INVOICE_ITEMS, {});

      const reply = await say("2 waters at 1500");

      expect(h.session.state).toBe(SESSION_STATE.INVOICE_CONFIRM); // not INVOICE_PHONE
      expect(reply).toContain("*Confirm invoice*");
      expect(reply).toContain("Total: RWF 3,000");
      expect(reply).not.toContain("Buyer:");
      expect(reply).toContain("create the payment link");
      expect(reply).not.toMatch(/mobile number/i);
    });
  });

  it("the opening prompt does not mention a customer number", async () => {
    await withMobileMoneyOff(async () => {
      const reply = await say("/invoice");
      expect(reply).toBe(MESSAGES.BUSINESS.INVOICE.PROMPT_ITEMS_LINK);
      expect(reply).not.toMatch(/number/i);
    });
  });

  it("confirming without a number is accepted (it is not an 'invalid items' error)", async () => {
    await withMobileMoneyOff(async () => {
      setSession(SESSION_STATE.INVOICE_CONFIRM, { items: [{ name: "waters", qty: 2, unitPrice: 1500 }] });

      const reply = await say("yes");

      // NEAR is not configured in this test, so the merchant is told to wait -
      // the point is that the missing number did not reject the invoice.
      expect(reply).not.toBe(MESSAGES.BUSINESS.INVOICE.INVALID_ITEMS);
      expect(reply).toContain("temporarily unavailable");
    });
  });

  it("still asks for the number when mobile money is on", async () => {
    setSession(SESSION_STATE.INVOICE_ITEMS, {});
    await say("2 waters at 1500");
    expect(h.session.state).toBe(SESSION_STATE.INVOICE_PHONE);
  });
});

describe("balance without bank features", () => {
  it("shows ONE balance in the merchant's currency, with next-step buttons and no bank block", async () => {
    h.listBalances.mockResolvedValue([{ currency: "KES", balance: 12500 }]);

    const reply = await say("/balance");

    expect(reply).toContain("*Your balance*");
    expect(reply).toContain("KES 12,500");
    expect(reply).not.toMatch(/bank|not linked|account:/i);
    expect(h.sendButtonsMessage.mock.calls.at(-1)?.[2]).toEqual([
      { id: "create_invoice", title: "New invoice" },
      { id: "transactions", title: "Payments" },
      { id: "set_currency", title: "Change currency" },
    ]);
  });

  it("never lists the leftover RWF / NGN wallets", async () => {
    h.listBalances.mockResolvedValue([
      { currency: "NGN", balance: 0 },
      { currency: "RWF", balance: 900 },
      { currency: "KES", balance: 12500 },
    ]);
    const reply = await say("/balance");
    expect(reply).toContain("KES 12,500");
    expect(reply).not.toMatch(/RWF|NGN/);
  });

  it("follows the currency the merchant picked", async () => {
    h.user.business.country = "NG";
    try {
      h.listBalances.mockResolvedValue([{ currency: "NGN", balance: 5000 }, { currency: "KES", balance: 1 }]);
      const reply = await say("/balance");
      expect(reply).toMatch(/NGN\s?5,000/);
      expect(reply).not.toContain("KES");
    } finally {
      h.user.business.country = "KE";
    }
  });

  it("says so, and points to invoicing, when nothing has been received", async () => {
    h.listBalances.mockResolvedValue([]);
    const reply = await say("/balance");
    expect(reply).toContain("KES 0");
    expect(reply).toContain("Nothing received yet");
  });

  it("reports a ledger failure instead of showing a wrong balance", async () => {
    h.listBalances.mockRejectedValue(new Error("db down"));
    const reply = await say("/balance");
    expect(reply).toBe(MESSAGES.CHECK_BALANCE.ERROR);
  });
});

describe("cash out to a bank", () => {
  const quote = { currency: "KES", amount: 13000, usd: 100, ngn: 150000, usdc: 100, rate: 1500 };
  beforeEach(() => {
    h.listBanks.mockResolvedValue([{ code: "000013", name: "GTBank" }, { code: "000014", name: "Access Bank" }]);
    h.nameEnquiry.mockResolvedValue({ accountName: "ADA OBI" });
    h.quoteCashout.mockResolvedValue(quote);
    h.requestCashout.mockResolvedValue({ reference: "OFR-1", status: "awaiting_signature", quote, depositAddress: "0xramp" });
  });

  it("explains the format when the command is incomplete", async () => {
    expect(await say("/cashout")).toContain("/cashout <amount> <bank> <account number>");
    expect(await say("/cashout 5000 gtbank 123")).toContain("/cashout <amount> <bank> <account number>");
    expect(h.requestCashout).not.toHaveBeenCalled();
  });

  it("shows naira, the verified account name and Yes / No before sending anything", async () => {
    const reply = await say("/cashout 13000 gtbank 0123456789");

    expect(h.quoteCashout).toHaveBeenCalledWith("KES", 13000);
    expect(reply).toContain("₦150,000");
    expect(reply).toContain("ADA OBI");
    expect(reply).toContain("GTBank");
    expect(h.sendButtonsMessage.mock.calls.at(-1)?.[2]).toEqual([
      { id: "cashout_yes", title: "Yes" },
      { id: "cashout_no", title: "No" },
    ]);
    expect(h.requestCashout).not.toHaveBeenCalled();
    expect(h.session.state).toBe("cashout_confirm");
  });

  it("sends the cash-out only after Yes", async () => {
    await say("/cashout 13000 gtbank 0123456789");
    const reply = await say("", "cashout_yes");

    expect(h.requestCashout).toHaveBeenCalledWith({
      userId: "user_1", currency: "KES", amount: 13000, bankCode: "000013",
      accountNumber: "0123456789", accountName: "ADA OBI", bankName: "GTBank",
    });
    expect(reply).toContain("*Cash-out started*");
    expect(h.session.state).toBe("idle");
  });

  it("stops on No without sending", async () => {
    await say("/cashout 13000 gtbank 0123456789");
    const reply = await say("", "cashout_no");
    expect(reply).toContain("cancelled");
    expect(h.requestCashout).not.toHaveBeenCalled();
  });

  it("does not continue when the account cannot be verified", async () => {
    h.nameEnquiry.mockResolvedValue({});
    const reply = await say("/cashout 13000 gtbank 0123456789");
    expect(reply).toContain("couldn't verify that account");
    expect(h.session.state).toBe("idle");
  });

  it("reports an unknown bank and a limit error plainly", async () => {
    expect(await say("/cashout 13000 nosuchbank 0123456789")).toContain("couldn't find a bank");
    h.quoteCashout.mockRejectedValue(new Error("The minimum cash-out is about $5."));
    expect(await say("/cashout 10 gtbank 0123456789")).toBe("The minimum cash-out is about $5.");
  });

  it("is reachable from the menu row", async () => {
    expect(await say("", "cash_out")).toContain("/cashout <amount> <bank> <account number>");
  });
});

describe("identity check before payouts", () => {
  const prior = { ...(config as any).toden };
  beforeEach(() => {
    (config as any).toden = { enabled: true };
    h.createSession.mockResolvedValue({ sessionId: "s1", url: "https://console.toden.co/verify/abc", expiresAt: null });
  });
  const restore = () => { (config as any).toden = prior; h.user.kycStatus = "none"; };

  it("blocks /cashout and /withdraw until verified, pointing to /verify", async () => {
    try {
      for (const cmd of ["/cashout 13000 gtbank 0123456789", "/withdraw 10 usdc base 0x1234"]) {
        expect(await say(cmd)).toContain("/verify");
      }
      expect(h.requestCashout).not.toHaveBeenCalled();
      expect(h.quoteCashout).not.toHaveBeenCalled();
    } finally { restore(); }
  });

  it("/verify sends the hosted link and marks the merchant pending", async () => {
    try {
      const reply = await say("/verify");
      expect(h.createSession).toHaveBeenCalledWith({ externalUserId: "user_1" });
      expect(reply).toContain("https://console.toden.co/verify/abc");
    } finally { restore(); }
  });

  it("lets a verified merchant straight through", async () => {
    h.user.kycStatus = "verified";
    h.listBanks.mockResolvedValue([{ code: "000013", name: "GTBank" }]);
    h.nameEnquiry.mockResolvedValue({ accountName: "ADA OBI" });
    h.quoteCashout.mockResolvedValue({ currency: "KES", amount: 13000, usd: 100, ngn: 150000, usdc: 100, rate: 1500 });
    try {
      expect(await say("/cashout 13000 gtbank 0123456789")).toContain("Confirm cash-out");
      expect(await say("/verify")).toContain("already verified");
    } finally { restore(); }
  });

  it("does nothing special when identity checks are not configured", async () => {
    (config as any).toden = { enabled: false };
    h.quoteCashout.mockResolvedValue({ currency: "KES", amount: 1, usd: 1, ngn: 1500, usdc: 1, rate: 1500 });
    try {
      expect(await say("/cashout")).toContain("/cashout <amount>");
    } finally { restore(); }
  });
});

describe("currency menu", () => {
  it("offers Kenya, Tanzania and Nigeria as buttons from /currency and the menu row", async () => {
    for (const send of [() => say("/currency"), () => say("", "set_currency")]) {
      const reply = await send();
      expect(reply).toContain("*KES*");
      expect(h.sendButtonsMessage.mock.calls.at(-1)?.[2]).toEqual([
        { id: "currency_KES", title: "Kenya (KES)" },
        { id: "currency_TZS", title: "Tanzania (TZS)" },
        { id: "currency_NGN", title: "Nigeria (NGN)" },
      ]);
    }
  });

  it("saves the choice on the business and confirms it", async () => {
    const reply = await say("", "currency_TZS");
    expect(h.businessUpdate).toHaveBeenCalledWith({ where: { userId: "user_1" }, data: { country: "TZ" } });
    expect(reply).toContain("*TZS*");
  });

  it("ignores a currency we do not offer", async () => {
    await say("", "currency_RWF");
    expect(h.businessUpdate).not.toHaveBeenCalled();
  });
});

describe("payments screen", () => {
  const paid = (over: Record<string, unknown> = {}) => ({
    id: "i1", amount: 3000, currency: "RWF", paidAt: new Date("2026-11-12T10:00:00Z"),
    items: [{ name: "waters", qty: 2, unitPrice: 1500 }], ...over,
  });

  it("lists recent paid invoices with a total, instead of a bank-account dead end", async () => {
    h.listPaidInvoices.mockResolvedValue([paid(), paid({ id: "i2", amount: 2000, items: [{ name: "soda", qty: 1, unitPrice: 2000 }] })]);

    const reply = await say("/transactions");

    expect(reply).toContain("*Recent payments*");
    expect(reply).toContain("1. RWF 3,000 - 2 x waters");
    expect(reply).toContain("2. RWF 2,000 - 1 x soda");
    expect(reply).toContain("Total received: RWF 5,000");
    expect(reply).not.toMatch(/create wallet|verify/i);
  });

  it("works from the /payments command and the menu row too", async () => {
    h.listPaidInvoices.mockResolvedValue([paid()]);
    expect(await say("/payments")).toContain("*Recent payments*");
    expect(await say("", "transactions")).toContain("*Recent payments*");
  });

  it("has a friendly empty state", async () => {
    h.listPaidInvoices.mockResolvedValue([]);
    expect(await say("/payments")).toBe(MESSAGES.PAYMENTS.EMPTY);
  });

  it("totals each currency separately", async () => {
    h.listPaidInvoices.mockResolvedValue([paid(), paid({ id: "i2", amount: 20000, currency: "NGN" })]);
    const reply = await say("/payments");
    expect(reply).toContain("RWF 3,000");
    expect(reply).toMatch(/NGN\s?20,000/);
  });
});

describe("main menu", () => {
  it("is personalised with the shop name and has no bank rows", async () => {
    await say("/menu");

    const call = vi.mocked(whatsapp.sendListMessage).mock.calls.at(-1)!;
    expect(call[1]).toContain("Test Shop");
    const rows = (call[3] as any[]).flatMap((s) => s.rows.map((r: any) => r.id));
    expect(rows).toEqual(expect.arrayContaining(["create_invoice", "invoices", "create_product", "business_profile", "check_balance", "transactions"]));
    expect(rows).not.toContain("send_money");
  });

  it("sends a brand-new merchant to shop setup instead of a menu that goes nowhere", async () => {
    h.user.business = null;
    try {
      const reply = await say("/menu");
      expect(reply).toContain("Let's set up your shop");
      expect(h.sendButtonsMessage.mock.calls.at(-1)?.[2]).toEqual([{ id: "business_profile", title: "Set up my shop" }]);
      expect(vi.mocked(whatsapp.sendListMessage)).not.toHaveBeenCalled();
    } finally {
      h.user.business = { id: "biz_1", userId: "user_1", name: "Test Shop", email: "shop@test.example", phone: "0788000111", country: "KE", registrationNumber: null };
    }
  });
});
