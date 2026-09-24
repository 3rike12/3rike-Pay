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
    patchSubAccount: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/services/database", () => ({
  prisma: {
    userSession: { findFirst: vi.fn() },
    user: { update: vi.fn() },
  },
  getSession: vi.fn(),
  updateSession: vi.fn().mockResolvedValue(undefined),
  resetSession: vi.fn().mockResolvedValue(undefined),
  getUserWithDetails: vi.fn(),
}));

import revalidationRouter from "@/api/revalidationFlow";
import { decryptFlowRequest } from "@/utils/flowCrypto";
import { autoramp } from "@/services/autoramp";
import { prisma, getSession, updateSession, resetSession, getUserWithDetails } from "@/services/database";

const mockDecrypt = vi.mocked(decryptFlowRequest);
const mockIdentity = vi.mocked(autoramp.initiateIdentityVerification);
const mockPatch = vi.mocked(autoramp.patchSubAccount);
const mockGetSession = vi.mocked(getSession);
const mockUpdateUser = vi.mocked(prisma.user.update);
const mockGetUser = vi.mocked(getUserWithDetails);

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/webhook/flow/revalidation", revalidationRouter);
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
  return request(app).post("/webhook/flow/revalidation").send({});
}

describe("Revalidation flow webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({ flowData: {} } as any);
    mockGetUser.mockResolvedValue({
      id: "user-1",
      bankAccount: { autorampSubId: "sub-1" },
    } as any);
  });

  it("responds to ping with active status", async () => {
    const res = await post(buildApp(), flowPayload({ action: "ping" }));
    expect(res.body).toEqual({ data: { status: "active" } });
  });

  it("INIT opens on the IDENTITY screen", async () => {
    const res = await post(buildApp(), flowPayload());
    expect(res.body.screen).toBe("IDENTITY");
  });

  it("rejects an unsupported id_type", async () => {
    const res = await post(
      buildApp(),
      flowPayload({ action: "data_exchange", data: { id_type: "PASSPORT", id_number: "12345678901" } })
    );
    expect(res.body.screen).toBe("IDENTITY");
    expect(res.body.data.error_message).toContain("NIN or BVN");
  });

  it("rejects an id_number that is not 11 digits", async () => {
    const res = await post(
      buildApp(),
      flowPayload({ action: "data_exchange", data: { id_type: "NIN", id_number: "123" } })
    );
    expect(res.body.screen).toBe("IDENTITY");
    expect(res.body.data.error_message).toContain("11 digits");
  });

  it("initiates verification and advances to OTP", async () => {
    mockIdentity.mockResolvedValue({ identityId: "identity-1" } as any);
    const res = await post(
      buildApp(),
      flowPayload({ action: "data_exchange", data: { id_type: "NIN", id_number: "12345678901" } })
    );
    expect(mockIdentity).toHaveBeenCalledWith({ type: "NIN", number: "12345678901" });
    expect(updateSession).toHaveBeenCalled();
    expect(res.body.screen).toBe("OTP");
  });

  it("rejects a too-short OTP", async () => {
    const res = await post(
      buildApp(),
      flowPayload({ action: "data_exchange", screen: "OTP", data: { otp: "12" } })
    );
    expect(res.body.screen).toBe("OTP");
    expect(res.body.data.error_message).toContain("too short");
  });

  it("patches the sub-account and ends the flow on a valid OTP", async () => {
    mockGetSession.mockResolvedValue({
      flowData: { identityId: "identity-1", idType: "NIN", idNumber: "12345678901" },
    } as any);

    const res = await post(
      buildApp(),
      flowPayload({ action: "data_exchange", screen: "OTP", data: { otp: "123456" } })
    );

    expect(mockPatch).toHaveBeenCalledWith("sub-1", {
      otp: "123456",
      identityType: "NIN",
      identityNumber: "12345678901",
      identityId: "identity-1",
    });
    expect(mockUpdateUser).toHaveBeenCalledWith(
      expect.objectContaining({ data: { kycStatus: "verified" } })
    );
    expect(resetSession).toHaveBeenCalledWith("user-1");
    expect(res.body.screen).toBe("END");
  });

  it("returns 421 when decryption fails", async () => {
    mockDecrypt.mockImplementation(() => {
      throw new Error("bad key");
    });
    const res = await request(buildApp()).post("/webhook/flow/revalidation").send({});
    expect(res.status).toBe(421);
  });
});