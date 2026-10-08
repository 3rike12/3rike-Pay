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
  const business = {
    id: "biz_1",
    userId: "user_1",
    name: "Kigali Electronics",
    email: "shop@kigali.example",
    phone: "0788000111",
    country: "RW",
    registrationNumber: "1234567890",
  };
  return {
    session: session as { state: string; flowData: Record<string, unknown> },
    user: {
      id: "user_1",
      phone: "250788000111",
      name: "Test Merchant",
      kycStatus: "pending",
      createdAt: new Date("2020-01-01T00:00:00Z"),
      bankAccount: null as any,
      business: business as any,
    },
    business,
    sendTextMessage: vi.fn(),
    sendButtonsMessage: vi.fn(),
    sendFlowMessage: vi.fn(),
    updateSession: vi.fn(),
    resetSession: vi.fn(),
    getSession: vi.fn(),
    expireStaleInvoices: vi.fn(),
  };
});

vi.mock("@/services/whatsapp", () => ({
  whatsapp: {
    sendTextMessage: (...args: any[]) => h.sendTextMessage(...args),
    sendButtonsMessage: (...args: any[]) => h.sendButtonsMessage(...args),
    sendFlowMessage: (...args: any[]) => h.sendFlowMessage(...args),
    sendListMessage: vi.fn().mockResolvedValue(true),
    uploadMedia: vi.fn().mockResolvedValue("media-1"),
    sendImageMessage: vi.fn().mockResolvedValue(true),
    sendTemplate: vi.fn().mockResolvedValue(true),
    markAsRead: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/services/autoramp", () => ({
  autoramp: {
    transfer: vi.fn(),
    getSubAccount: vi.fn(),
    verifyIdentity: vi.fn(),
    listBanks: vi.fn().mockResolvedValue([]),
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
  createProduct: vi.fn(),
  listProducts: vi.fn().mockResolvedValue([]),
  createDraftInvoice: vi.fn(),
  chargeInvoice: vi.fn(),
  renderInvoiceSummary: vi.fn(),
  scheduleInvoiceVerification: vi.fn(),
  expireStaleInvoices: (...args: any[]) => h.expireStaleInvoices(...args),
  humanizeChargeError: (error: unknown) =>
    error instanceof Error ? error.message : String((error as any)?.message ?? error ?? ""),
  listInvoices: vi.fn(),
}));

import { handleMessage } from "@/bot";
import { MESSAGES, FLOWS, SESSION_STATE } from "@/config/constants";

const PHONE = "250788000111";

/** Last body we sent, whether it went out as text or as buttons. */
async function say(text: string, buttonId?: string) {
  const textBefore = h.sendTextMessage.mock.calls.length;
  const buttonsBefore = h.sendButtonsMessage.mock.calls.length;
  await handleMessage(
    PHONE,
    "Test Merchant",
    text,
    buttonId ? { id: buttonId, title: "" } : undefined
  );
  const buttonCalls = h.sendButtonsMessage.mock.calls.slice(buttonsBefore);
  if (buttonCalls.length) return String(buttonCalls[buttonCalls.length - 1][1]);
  const textCalls = h.sendTextMessage.mock.calls.slice(textBefore);
  return textCalls.length ? String(textCalls[textCalls.length - 1][1]) : "";
}

/** The flow invite we last sent, or null when no form was opened. */
function lastFlowInvite() {
  const call = h.sendFlowMessage.mock.calls.at(-1);
  if (!call) return null;
  return {
    phone: call[0],
    body: call[1],
    flowId: call[2],
    cta: call[3],
    token: call[4],
    screen: call[5],
  };
}

beforeEach(() => {
  vi.clearAllMocks();

  h.session = { state: "idle", flowData: {} };
  h.user.business = h.business;
  h.sendTextMessage.mockResolvedValue(true);
  h.sendButtonsMessage.mockResolvedValue(true);
  h.sendFlowMessage.mockResolvedValue(true);

  h.getSession.mockImplementation(async () => h.session);
  h.updateSession.mockImplementation(async (_id: string, state: string, flowData: Record<string, unknown>) => {
    h.session = { state, flowData };
    return h.session;
  });
  h.resetSession.mockImplementation(async () => {
    h.session = { state: "idle", flowData: {} };
  });
  h.expireStaleInvoices.mockResolvedValue(0);
});

describe("view business profile", () => {
  it("shows the saved profile instead of the setup form", async () => {
    const reply = await say("/business");

    expect(h.sendFlowMessage).not.toHaveBeenCalled();
    expect(h.sendButtonsMessage).toHaveBeenCalledWith(
      PHONE,
      expect.stringContaining("Kigali Electronics"),
      [
        { id: "business_update", title: MESSAGES.BUSINESS.PROFILE.UPDATE },
        { id: "btn_menu", title: "Main Menu" },
      ]
    );
    expect(reply).toContain("shop@kigali.example");
    expect(reply).toContain("0788000111");
    expect(reply).toContain("RDB: 1234567890");
  });

  it("omits lines the merchant never filled in", async () => {
    h.user.business = { ...h.business, phone: null, registrationNumber: null };

    await say("ok", "business_profile");

    const reply = String(h.sendButtonsMessage.mock.calls.at(-1)?.[1]);
    expect(reply).toContain("Kigali Electronics");
    expect(reply).not.toContain("0788000111");
    expect(reply).not.toContain("RDB:");
  });

  it("opens the setup form when no profile exists yet", async () => {
    h.user.business = null;

    await say("ok", "business_profile");

    const invite = lastFlowInvite();
    expect(invite).toMatchObject({
      phone: PHONE,
      body: MESSAGES.BUSINESS.PROFILE.OPEN,
      flowId: FLOWS.BUSINESS,
      cta: MESSAGES.BUSINESS.PROFILE.CTA,
      token: "user_1",
      screen: "BUSINESS_DETAILS",
    });
  });

  it("opens the setup form from Update", async () => {
    await say("", "business_update");

    expect(lastFlowInvite()?.body).toBe(MESSAGES.BUSINESS.PROFILE.OPEN);
  });
});

describe("invoice requires a business profile", () => {
  beforeEach(() => {
    h.user.business = null;
  });

  it("sends /invoice into setup instead of asking what to charge for", async () => {
    const reply = await say("/invoice");

    expect(lastFlowInvite()).toMatchObject({
      body: MESSAGES.BUSINESS.PROFILE.REQUIRED,
      flowId: FLOWS.BUSINESS,
      screen: "BUSINESS_DETAILS",
    });
    expect(reply).toBe("");
    expect(h.updateSession).not.toHaveBeenCalledWith(
      "user_1",
      SESSION_STATE.INVOICE_ITEMS,
      expect.anything()
    );
    expect(h.session.state).toBe("idle");
  });

  it("does the same from the main-menu row", async () => {
    await say("ok", "create_invoice");

    expect(lastFlowInvite()?.body).toBe(MESSAGES.BUSINESS.PROFILE.REQUIRED);
    expect(h.session.state).toBe("idle");
  });

  it("does the same for a free-text payment request", async () => {
    await say("payment request for 0781234567");

    expect(lastFlowInvite()?.body).toBe(MESSAGES.BUSINESS.PROFILE.REQUIRED);
    expect(h.session.state).toBe("idle");
    expect(h.updateSession).not.toHaveBeenCalledWith(
      "user_1",
      SESSION_STATE.INVOICE_ITEMS,
      expect.anything()
    );
  });

  it("carries on normally once the profile exists", async () => {
    h.user.business = h.business;

    const reply = await say("/invoice");

    expect(h.sendFlowMessage).not.toHaveBeenCalled();
    expect(h.session.state).toBe(SESSION_STATE.INVOICE_ITEMS);
    expect(reply).toBe(MESSAGES.BUSINESS.INVOICE.PROMPT_ITEMS);
  });
});
