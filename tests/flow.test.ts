import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("@/utils/flowCrypto", () => ({
  screen: (name: string, data: Record<string, unknown> = {}) => ({ screen: name, data }),
  decryptFlowRequest: vi.fn(),
  encryptFlowResponse: vi.fn((r: unknown) => r),
}));

vi.mock("@/services/autoramp", () => ({
  autoramp: {
    initiateIdentityVerification: vi.fn(),
    createSubAccount: vi.fn(),
  },
}));

vi.mock("@/services/database", () => ({
  prisma: {
    userSession: { findFirst: vi.fn() },
    user: { findUnique: vi.fn(), update: vi.fn() },
  },
  updateSession: vi.fn().mockResolvedValue(undefined),
  resetSession: vi.fn().mockResolvedValue(undefined),
  createUserProfile: vi.fn().mockResolvedValue(undefined),
  createBankAccount: vi.fn().mockResolvedValue(undefined),
  createUserCredential: vi.fn().mockResolvedValue(undefined),
  getUserWithDetails: vi.fn(),
}));

vi.mock("@/services/dryRunFlow", () => ({
  handleDryRunFlow: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/services/accountNotification", () => ({
  sendAccountCreatedMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/utils/pin", () => ({
  hashPin: vi.fn(() => "hashed-pin"),
}));

import flowRouter from "@/api/flow";
import { decryptFlowRequest, encryptFlowResponse } from "@/utils/flowCrypto";
import { autoramp } from "@/services/autoramp";
import {
  prisma,
  updateSession,
  resetSession,
  getUserWithDetails,
  createUserCredential,
} from "@/services/database";
import { handleDryRunFlow } from "@/services/dryRunFlow";
import { hashPin } from "@/utils/pin";

const mockDecrypt = vi.mocked(decryptFlowRequest);
const mockGetUser = vi.mocked(getUserWithDetails);
const mockDryRun = vi.mocked(handleDryRunFlow);
const mockIdentity = vi.mocked(autoramp.initiateIdentityVerification);
const mockFindSession = vi.mocked(prisma.userSession.findFirst);
const mockUpdateUser = vi.mocked(prisma.user.update);

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/webhook/flow/kyc", flowRouter);
  return app;
}

function flowPayload(overrides: Record<string, unknown> = {}) {
  return {
    action: "INIT",
    screen: "IDENTITY",
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
  return request(app).post("/webhook/flow/kyc").send({});
}

describe("KYC flow webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDryRun.mockResolvedValue(null);
    mockGetUser.mockResolvedValue({ id: "user-1", kycStatus: "none" } as any);
    mockFindSession.mockResolvedValue(null);
  });

  it("responds to ping with active status", async () => {
    const res = await post(buildApp(), flowPayload({ action: "ping" }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { status: "active" } });
  });

  it("returns IDENTITY with an error when flow_token is missing", async () => {
    const res = await post(buildApp(), flowPayload({ flow_token: "" }));
    expect(res.body.screen).toBe("IDENTITY");
    expect(res.body.data.error_message).toContain("Session expired");
  });

  it("INIT returns IDENTITY for an unverified user", async () => {
    const res = await post(buildApp(), flowPayload());
    expect(res.body.screen).toBe("IDENTITY");
  });

  it("INIT returns COMPLETED for an already-verified user", async () => {
    mockGetUser.mockResolvedValue({ id: "user-1", kycStatus: "verified" } as any);
    const res = await post(buildApp(), flowPayload());
    expect(res.body.screen).toBe("COMPLETED");
    expect(resetSession).toHaveBeenCalledWith("user-1");
  });

  describe("IDENTITY screen", () => {
    it("rejects an unsupported id_type", async () => {
      const res = await post(
        buildApp(),
        flowPayload({ action: "data_exchange", data: { id_type: "PASSPORT", id_number: "12345678901", email: "a@b.co" } })
      );
      expect(res.body.screen).toBe("IDENTITY");
      expect(res.body.data.error_message).toContain("NIN or BVN");
    });

    it("rejects an id_number that is not 11 digits", async () => {
      const res = await post(
        buildApp(),
        flowPayload({ action: "data_exchange", data: { id_type: "NIN", id_number: "123", email: "a@b.co" } })
      );
      expect(res.body.screen).toBe("IDENTITY");
      expect(res.body.data.error_message).toContain("11 digits");
    });

    it("rejects an invalid email", async () => {
      const res = await post(
        buildApp(),
        flowPayload({ action: "data_exchange", data: { id_type: "NIN", id_number: "12345678901", email: "not-an-email" } })
      );
      expect(res.body.screen).toBe("IDENTITY");
      expect(res.body.data.error_message).toContain("valid email");
    });

    it("advances to NAME after a successful identity verification", async () => {
      mockIdentity.mockResolvedValue({ identityId: "identity-1", status: "OK" } as any);
      const res = await post(
        buildApp(),
        flowPayload({ action: "data_exchange", data: { id_type: "NIN", id_number: "12345678901", email: "a@b.co" } })
      );
      expect(mockIdentity).toHaveBeenCalledWith({ type: "NIN", number: "12345678901" });
      expect(updateSession).toHaveBeenCalled();
      expect(res.body.screen).toBe("NAME");
    });

    it("stays on IDENTITY when verification returns no identityId", async () => {
      mockIdentity.mockResolvedValue({ status: "OK" } as any);
      const res = await post(
        buildApp(),
        flowPayload({ action: "data_exchange", data: { id_type: "NIN", id_number: "12345678901", email: "a@b.co" } })
      );
      expect(res.body.screen).toBe("IDENTITY");
    });
  });

  describe("NAME screen", () => {
    it("requires both first and last name", async () => {
      const res = await post(
        buildApp(),
        flowPayload({ action: "data_exchange", screen: "NAME", data: { first_name: "Ada" } })
      );
      expect(res.body.screen).toBe("NAME");
      expect(res.body.data.error_message).toContain("first and last name");
    });

    it("advances to OTP after a valid name", async () => {
      const res = await post(
        buildApp(),
        flowPayload({ action: "data_exchange", screen: "NAME", data: { first_name: "Ada", last_name: "Lovelace" } })
      );
      expect(res.body.screen).toBe("OTP");
      expect(res.body.data.message).toContain("code");
    });
  });

  describe("PIN screen", () => {
    it("rejects non-4-digit PINs", async () => {
      const res = await post(
        buildApp(),
        flowPayload({ action: "data_exchange", screen: "PIN", data: { pin: "12", confirm_pin: "12" } })
      );
      expect(res.body.screen).toBe("PIN");
      expect(res.body.data.error_message).toContain("4 digits");
    });

    it("rejects mismatched PIN and confirm PIN", async () => {
      const res = await post(
        buildApp(),
        flowPayload({ action: "data_exchange", screen: "PIN", data: { pin: "1234", confirm_pin: "9999" } })
      );
      expect(res.body.screen).toBe("PIN");
      expect(res.body.data.error_message).toContain("do not match");
    });

    it("sets the PIN, marks the user verified, and ends the flow", async () => {
      const res = await post(
        buildApp(),
        flowPayload({ action: "data_exchange", screen: "PIN", data: { pin: "1234", confirm_pin: "1234" } })
      );
      expect(hashPin).toHaveBeenCalledWith("1234");
      expect(createUserCredential).toHaveBeenCalled();
      expect(mockUpdateUser).toHaveBeenCalledWith(
        expect.objectContaining({ data: { kycStatus: "verified" } })
      );
      expect(res.body.screen).toBe("END");
    });
  });

  it("acks a client error payload", async () => {
    const res = await post(
      buildApp(),
      flowPayload({ action: "data_exchange", data: { error_message: "something broke" } })
    );
    expect(res.body).toEqual({ data: { acknowledged: true } });
  });

  it("returns 421 when decryption fails", async () => {
    mockDecrypt.mockImplementation(() => {
      throw new Error("bad key");
    });
    const res = await request(buildApp()).post("/webhook/flow/kyc").send({});
    expect(res.status).toBe(421);
  });
});
