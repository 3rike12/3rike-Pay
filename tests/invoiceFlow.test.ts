import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/config", () => ({
  config: {
    features: { dryRun: false },
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
    },
    sendTextMessage: vi.fn(),
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
  };
});

vi.mock("@/services/whatsapp", () => ({
  whatsapp: {
    sendTextMessage: (...args: any[]) => h.sendTextMessage(...args),
    sendButtonsMessage: vi.fn().mockResolvedValue(true),
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
  },
}));

vi.mock("@/services/database", () => ({
  prisma: {
    webhookEvent: { findFirst: vi.fn().mockResolvedValue(null) },
    user: { findUnique: vi.fn() },
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

vi.mock("@/services/invoice", () => ({
  createProduct: (...args: any[]) => h.createProduct(...args),
  listProducts: (...args: any[]) => h.listProducts(...args),
  createDraftInvoice: (...args: any[]) => h.createDraftInvoice(...args),
  chargeInvoice: (...args: any[]) => h.chargeInvoice(...args),
  renderInvoiceSummary: (...args: any[]) => h.renderInvoiceSummary(...args),
  scheduleInvoiceVerification: (...args: any[]) => h.scheduleInvoiceVerification(...args),
  expireStaleInvoices: (...args: any[]) => h.expireStaleInvoices(...args),
}));

import { handleMessage } from "@/bot";
import { SESSION_STATE, MESSAGES } from "@/config/constants";

const PHONE = "250788000111";

/** Drive one inbound message and return the last plain text we sent. */
async function say(text: string, buttonId?: string) {
  await handleMessage(
    PHONE,
    "Test Merchant",
    text,
    buttonId ? { id: buttonId, title: "" } : undefined
  );
  const calls = h.sendTextMessage.mock.calls;
  return calls.length ? String(calls[calls.length - 1][1]) : "";
}

function setSession(state: string, flowData: Record<string, unknown> = {}) {
  h.session = { state, flowData };
}

beforeEach(() => {
  vi.clearAllMocks();

  h.session = { state: "idle", flowData: {} };
  h.sendTextMessage.mockResolvedValue(true);

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
    (inv: any) => `Total: RWF ${inv.amount}\nBuyer: ${inv.buyerPhone}`
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
      currency: "RWF",
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
      currency: "RWF",
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

  it("rejects a non-Rwanda number", async () => {
    setSession(SESSION_STATE.INVOICE_PHONE, {
      items: [{ name: "water", qty: 1, unitPrice: 1500 }],
      buyerPhone: null,
    });

    const reply = await say("054709929220");

    expect(h.session.state).toBe(SESSION_STATE.INVOICE_PHONE);
    expect(reply).toBe(MESSAGES.BUSINESS.INVOICE.INVALID_PHONE);
  });

  it("rejects an empty item message", async () => {
    setSession(SESSION_STATE.INVOICE_ITEMS, {});

    const reply = await say("");

    expect(h.session.state).toBe(SESSION_STATE.INVOICE_ITEMS);
    expect(reply).toBe(MESSAGES.BUSINESS.INVOICE.INVALID_ITEMS);
  });

  it("charges on yes and schedules verification", async () => {
    setSession(SESSION_STATE.INVOICE_CONFIRM, {
      items: [{ name: "batteries", qty: 3, unitPrice: 1000 }],
      buyerPhone: "0781234567",
    });

    const reply = await say("yes");

    expect(h.createDraftInvoice).toHaveBeenCalledWith({
      merchantId: "user_1",
      buyerPhone: "0781234567",
      items: [{ name: "batteries", qty: 3, unitPrice: 1000 }],
    });
    expect(h.chargeInvoice).toHaveBeenCalledWith({
      merchantId: "user_1",
      invoiceId: "inv_new",
    });
    expect(h.scheduleInvoiceVerification).toHaveBeenCalledWith("3RIKE-TEST-1");
    expect(reply).toContain("Payment request issued");
    expect(reply).toContain("https://checkout.flutterwave.com/v3/hosted/pay/abc");
    expect(h.resetSession).toHaveBeenCalled();
    expect(h.session.state).toBe("idle");
  });

  it("does not charge without confirmation", async () => {
    setSession(SESSION_STATE.INVOICE_CONFIRM, {
      items: [{ name: "batteries", qty: 3, unitPrice: 1000 }],
      buyerPhone: "0781234567",
    });

    const reply = await say("hmm not yet");

    expect(h.chargeInvoice).not.toHaveBeenCalled();
    expect(reply).toContain("Reply *yes*");
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
    expect(h.session.state).toBe(SESSION_STATE.INVOICE_CONFIRM);
    // A retry must reuse the draft instead of creating a second invoice.
    expect(h.createDraftInvoice).toHaveBeenCalledTimes(1);
    expect(h.session.flowData.draftId).toBe("inv_new");
  });
});
