import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("@/utils/flowCrypto", () => ({
  screen: (name: string, data: Record<string, unknown> = {}) => ({ screen: name, data }),
  decryptFlowRequest: vi.fn(),
  encryptFlowResponse: vi.fn((r: unknown) => r),
}));

vi.mock("@/services/whatsapp", () => ({
  whatsapp: { sendTextMessage: vi.fn().mockResolvedValue(true) },
}));

vi.mock("@/services/database", () => ({
  prisma: { user: { findUnique: vi.fn() } },
}));

vi.mock("@/services/flutterwave", () => ({
  flutterwave: { ensureBusiness: vi.fn() },
}));

import businessRouter from "@/api/businessFlow";
import { decryptFlowRequest } from "@/utils/flowCrypto";
import { whatsapp } from "@/services/whatsapp";
import { prisma } from "@/services/database";
import { flutterwave } from "@/services/flutterwave";

const mockDecrypt = vi.mocked(decryptFlowRequest);
const mockSendText = vi.mocked(whatsapp.sendTextMessage);
const mockFindUser = vi.mocked(prisma.user.findUnique);
const mockEnsureBusiness = vi.mocked(flutterwave.ensureBusiness);

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/webhook/flow/business", businessRouter);
  return app;
}

function flowPayload(overrides: Record<string, unknown> = {}) {
  return {
    action: "INIT",
    screen: "BUSINESS_DETAILS",
    data: {},
    flow_token: "user-1",
    ...overrides,
  };
}

async function post(app: express.Express, payload: Record<string, unknown>) {
  mockDecrypt.mockReturnValue({
    decrypted: payload,
    aesKey: Buffer.alloc(0),
    iv: Buffer.alloc(0),
  });
  return request(app).post("/webhook/flow/business").send({});
}

const validForm = {
  business_name: "Kigali Electronics",
  business_email: "shop@kigali.example",
  business_phone: "+250781234567",
  registration_number: "1234567890",
};

describe("Business profile flow webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendText.mockResolvedValue(true);
    mockFindUser.mockResolvedValue({ id: "user-1", phone: "250788000111" } as any);
    mockEnsureBusiness.mockResolvedValue({ id: "biz_1" } as any);
  });

  it("returns 421 when the request cannot be decrypted", async () => {
    mockDecrypt.mockImplementation(() => {
      throw new Error("bad payload");
    });

    const res = await request(buildApp()).post("/webhook/flow/business").send({});
    expect(res.status).toBe(421);
  });

  it("answers ping", async () => {
    const res = await post(buildApp(), flowPayload({ action: "ping" }));
    expect(res.body).toEqual({ data: { status: "active" } });
  });

  it("opens the details screen on INIT", async () => {
    const res = await post(buildApp(), flowPayload({ action: "INIT" }));
    expect(res.body).toEqual({ screen: "BUSINESS_DETAILS", data: { error_message: "" } });
    expect(mockEnsureBusiness).not.toHaveBeenCalled();
  });

  it("rejects a missing flow token", async () => {
    const res = await post(buildApp(), flowPayload({ flow_token: "unused" }));
    expect(res.body.screen).toBe("BUSINESS_DETAILS");
    expect(res.body.data.error_message).toMatch(/Session expired/);
  });

  it("acknowledges a client-side validation error", async () => {
    const res = await post(
      buildApp(),
      flowPayload({ action: "data_exchange", data: { error_message: "required" } })
    );
    expect(res.body).toEqual({ data: { acknowledged: true } });
    expect(mockEnsureBusiness).not.toHaveBeenCalled();
  });

  it("saves a valid profile, normalises the phone and notifies the merchant", async () => {
    const res = await post(
      buildApp(),
      flowPayload({ action: "data_exchange", data: validForm })
    );

    expect(res.body).toEqual({ screen: "SAVED", data: {} });
    expect(mockEnsureBusiness).toHaveBeenCalledWith({
      userId: "user-1",
      name: "Kigali Electronics",
      email: "shop@kigali.example",
      phone: "0781234567",
      country: "RW",
      registrationNumber: "1234567890",
    });
    expect(mockSendText).toHaveBeenCalledWith(
      "250788000111",
      expect.stringContaining("Kigali Electronics")
    );
  });

  it("saves without a registration number when it is left blank", async () => {
    const res = await post(
      buildApp(),
      flowPayload({
        action: "data_exchange",
        data: { ...validForm, registration_number: "" },
      })
    );

    expect(res.body.screen).toBe("SAVED");
    expect(mockEnsureBusiness).toHaveBeenCalledWith(
      expect.objectContaining({ registrationNumber: undefined })
    );
  });

  it("rejects an invalid email and does not save", async () => {
    const res = await post(
      buildApp(),
      flowPayload({
        action: "data_exchange",
        data: { ...validForm, business_email: "not-an-email" },
      })
    );

    expect(res.body.screen).toBe("BUSINESS_DETAILS");
    expect(res.body.data.error_message).toMatch(/email/i);
    expect(mockEnsureBusiness).not.toHaveBeenCalled();
    expect(mockSendText).not.toHaveBeenCalled();
  });

  it("rejects a non-Rwanda phone number", async () => {
    const res = await post(
      buildApp(),
      flowPayload({
        action: "data_exchange",
        data: { ...validForm, business_phone: "08012345678" },
      })
    );

    expect(res.body.screen).toBe("BUSINESS_DETAILS");
    expect(res.body.data.error_message).toMatch(/Rwanda/);
    expect(mockEnsureBusiness).not.toHaveBeenCalled();
  });

  it("rejects a business name that is too short", async () => {
    const res = await post(
      buildApp(),
      flowPayload({
        action: "data_exchange",
        data: { ...validForm, business_name: "K" },
      })
    );

    expect(res.body.screen).toBe("BUSINESS_DETAILS");
    expect(res.body.data.error_message).toMatch(/2 characters/);
    expect(mockEnsureBusiness).not.toHaveBeenCalled();
  });

  it("stays on the details screen when the save fails", async () => {
    mockEnsureBusiness.mockRejectedValue(new Error("db down"));

    const res = await post(
      buildApp(),
      flowPayload({ action: "data_exchange", data: validForm })
    );

    expect(res.body.screen).toBe("BUSINESS_DETAILS");
    expect(res.body.data.error_message).toMatch(/Could not save/);
    expect(mockSendText).not.toHaveBeenCalled();
  });

  it("does not notify when the merchant has no phone on file", async () => {
    mockFindUser.mockResolvedValue({ id: "user-1", phone: null } as any);

    const res = await post(
      buildApp(),
      flowPayload({ action: "data_exchange", data: validForm })
    );

    expect(res.body.screen).toBe("SAVED");
    expect(mockSendText).not.toHaveBeenCalled();
  });

  it("acknowledges the complete action", async () => {
    const res = await post(
      buildApp(),
      flowPayload({ action: "complete", screen: "SAVED" })
    );
    expect(res.body).toEqual({ screen: "SAVED", data: {} });
  });
});
