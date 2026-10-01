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
    sendButtonsMessage: vi.fn(),
    listInvoices: vi.fn(),
    renderInvoiceSummary: vi.fn(),
    expireStaleInvoices: vi.fn(),
    getSession: vi.fn(),
    updateSession: vi.fn(),
    resetSession: vi.fn(),
  };
});

vi.mock("@/services/whatsapp", () => ({
  whatsapp: {
    sendTextMessage: (...args: any[]) => h.sendTextMessage(...args),
    sendButtonsMessage: (...args: any[]) => h.sendButtonsMessage(...args),
    sendListMessage: vi.fn().mockResolvedValue(true),
    uploadMedia: vi.fn().mockResolvedValue("media-1"),
    sendImageMessage: vi.fn().mockResolvedValue(true),
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
    invoice: { findFirst: vi.fn() },
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
  listInvoices: (...args: any[]) => h.listInvoices(...args),
  renderInvoiceSummary: (...args: any[]) => h.renderInvoiceSummary(...args),
  expireStaleInvoices: (...args: any[]) => h.expireStaleInvoices(...args),
  createProduct: vi.fn(),
  listProducts: vi.fn().mockResolvedValue([]),
  createDraftInvoice: vi.fn(),
  chargeInvoice: vi.fn(),
  scheduleInvoiceVerification: vi.fn(),
}));

import { handleMessage } from "@/bot";
import { whatsapp } from "@/services/whatsapp";
import { listInvoices } from "@/services/invoice";
import { prisma } from "@/services/database";
import { MESSAGES } from "@/config/constants";

const PHONE = "250788000111";

function invoice(overrides: Record<string, unknown> = {}) {
  return {
    id: "inv_1",
    merchantId: "user_1",
    reference: "3RIKE-TEST-1",
    status: "paid",
    amount: 3000,
    currency: "RWF",
    buyerPhone: "0781234567",
    items: [
      { name: "waters", qty: 2, unitPrice: 1500 },
    ],
    paymentUrl: "https://checkout.flutterwave.com/v3/hosted/pay/abc",
    createdAt: new Date("2026-10-01T00:00:00Z"),
    paidAt: new Date("2026-10-01T00:05:00Z"),
    expiresAt: null,
    ...overrides,
  };
}

async function say(text: string) {
  await handleMessage(PHONE, "Test Merchant", text);
  const calls = h.sendTextMessage.mock.calls;
  return calls.length ? String(calls[calls.length - 1][1]) : "";
}

async function tapListRow(id: string) {
  await handleMessage(PHONE, "Test Merchant", "", undefined, {
    id,
    title: "",
    description: "",
  });
}

function lastListMessage() {
  const calls = vi.mocked(whatsapp.sendListMessage).mock.calls;
  return calls.length ? calls[calls.length - 1] : null;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.session = { state: "idle", flowData: {} };
  h.sendTextMessage.mockResolvedValue(true);
  h.sendButtonsMessage.mockResolvedValue(true);
  h.expireStaleInvoices.mockResolvedValue(0);
  h.getSession.mockImplementation(async () => h.session);
  h.updateSession.mockImplementation(async (_id: string, state: string, flowData: Record<string, unknown>) => {
    h.session = { state, flowData };
    return h.session;
  });
  h.resetSession.mockImplementation(async () => {
    h.session = { state: "idle", flowData: {} };
  });
  vi.mocked(whatsapp.sendListMessage).mockResolvedValue(true);
  h.renderInvoiceSummary.mockImplementation((inv: any) => `summary of ${inv.id}`);
});

describe("invoice list", () => {
  it("shows a page as a list message with the position line", async () => {
    h.listInvoices.mockResolvedValue({
      items: [invoice({ id: "inv_1" }), invoice({ id: "inv_2" })],
      total: 2,
      limit: 10,
      offset: 0,
    });

    await say("/invoices");

    const [, body, button, sections] = lastListMessage()!;
    expect(body).toContain("Showing 1-2 of 2");
    expect(body).toContain("Tap a row");
    expect(button).toBe(MESSAGES.BUSINESS.INVOICES.LIST_BUTTON);
    expect(sections[0].rows).toHaveLength(2);
    expect(sections[0].rows[0]).toMatchObject({ id: "invoice:inv_1" });
    expect(sections[0].rows[0].title).toContain("Paid");
    expect(sections[0].rows[0].description).toContain("0781234567");
    expect(h.sendTextMessage).not.toHaveBeenCalled();
  });

  it("asks for exactly one extra row to decide whether there is a next page", async () => {
    h.listInvoices.mockResolvedValue({
      items: Array.from({ length: 10 }, (_, i) => invoice({ id: `inv_${i}` })),
      total: 40,
      limit: 10,
      offset: 0,
    });

    await say("/invoices");

    expect(h.listInvoices).toHaveBeenCalledWith("user_1", { limit: 10, offset: 0 });
    const rows = lastListMessage()![3][0].rows;
    // 9 invoices + the paging row - never all 40.
    expect(rows).toHaveLength(10);
    expect(rows[9]).toMatchObject({ id: "invoices:9" });
  });

  it("only asks for the next page when there are older invoices", async () => {
    h.listInvoices.mockResolvedValue({
      items: [invoice({ id: "inv_1" })],
      total: 1,
      limit: 10,
      offset: 0,
    });

    await say("/invoices");

    const rows = lastListMessage()![3][0].rows;
    expect(rows.some((r: any) => r.id.startsWith("invoices:"))).toBe(false);
  });

  it("opens page two when the next-page row is tapped", async () => {
    h.listInvoices.mockResolvedValue({ items: [], total: 0, limit: 10, offset: 9 });

    await tapListRow("invoices:9");

    expect(h.listInvoices).toHaveBeenCalledWith("user_1", { limit: 10, offset: 9 });
  });

  it("falls back to a text message when there are no invoices", async () => {
    h.listInvoices.mockResolvedValue({ items: [], total: 0, limit: 10, offset: 0 });

    const reply = await say("/invoices");

    expect(reply).toBe(MESSAGES.BUSINESS.INVOICES.LIST_EMPTY);
    expect(vi.mocked(whatsapp.sendListMessage)).not.toHaveBeenCalled();
  });

  it("reports the error without dumping a stack at the merchant", async () => {
    h.listInvoices.mockRejectedValue(new Error("db down"));

    const reply = await say("/invoices");

    expect(reply).toBe(MESSAGES.BUSINESS.INVOICES.ERROR);
  });
});

describe("invoice detail", () => {
  it("renders one invoice when a row is tapped", async () => {
    const target = invoice({ id: "inv_42" });
    vi.mocked(prisma.invoice.findFirst).mockResolvedValue(target as any);

    await tapListRow("invoice:inv_42");

    expect(prisma.invoice.findFirst).toHaveBeenCalledWith({
      where: { id: "inv_42", merchantId: "user_1" },
    });
    expect(h.renderInvoiceSummary).toHaveBeenCalledWith(target);
    expect(h.sendTextMessage).toHaveBeenCalledWith(PHONE, "summary of inv_42");
  });

  it("never shows another merchant's invoice", async () => {
    vi.mocked(prisma.invoice.findFirst).mockResolvedValue(null as any);

    await tapListRow("invoice:inv_someone_else");

    expect(h.sendTextMessage).toHaveBeenCalledWith(
      PHONE,
      MESSAGES.BUSINESS.INVOICES.NOT_FOUND
    );
  });
});
