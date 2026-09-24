import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("@/config", () => ({
  config: {
    features: { dryRun: false },
    logLevel: "debug",
  },
}));

vi.mock("@/utils/flowCrypto", () => ({
  screen: (name: string, data: Record<string, unknown> = {}) => ({ screen: name, data }),
  decryptFlowRequest: vi.fn(),
  encryptFlowResponse: vi.fn((r: unknown) => r),
}));

vi.mock("@/services/autoramp", () => ({
  autoramp: {
    transfer: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/services/whatsapp", () => ({
  whatsapp: {
    sendTextMessage: vi.fn().mockResolvedValue(true),
    sendTemplate: vi.fn().mockResolvedValue(true),
  },
}));

vi.mock("@/services/database", () => ({
  prisma: {
    userCredential: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
  },
  getSession: vi.fn(),
  updateSession: vi.fn().mockResolvedValue(undefined),
  resetSession: vi.fn().mockResolvedValue(undefined),
  updateTransaction: vi.fn().mockResolvedValue(undefined),
  getTransactionByReference: vi.fn(),
}));

vi.mock("@/utils/pin", () => ({
  verifyPin: vi.fn(),
}));

import transferFlowRouter from "@/api/transferFlow";
import { decryptFlowRequest } from "@/utils/flowCrypto";
import { autoramp } from "@/services/autoramp";
import {
  prisma,
  getSession,
  updateTransaction,
  getTransactionByReference,
} from "@/services/database";
import { verifyPin } from "@/utils/pin";

const mockDecrypt = vi.mocked(decryptFlowRequest);
const mockGetSession = vi.mocked(getSession);
const mockVerifyPin = vi.mocked(verifyPin);
const mockFindCred = vi.mocked(prisma.userCredential.findUnique);
const mockTransfer = vi.mocked(autoramp.transfer);
const mockGetTxn = vi.mocked(getTransactionByReference);

const pendingTransfer = {
  reference: "3RIKE-REF-1",
  amount: 5000,
  bankCode: "090286",
  bankName: "Safe Haven MFB",
  accountNumber: "5015575517",
  accountName: "Jane Doe",
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/webhook/flow/transfer", transferFlowRouter);
  return app;
}

function flowPayload(overrides: Record<string, unknown> = {}) {
  return {
    action: "INIT",
    screen: "VERIFY_PIN",
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
  return request(app).post("/webhook/flow/transfer").send({});
}

describe("Transfer PIN flow webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({
      flowData: { pendingTransfer },
      state: "confirm_transfer",
    } as any);
    mockFindCred.mockResolvedValue({ pin: "some-hash" } as any);
    mockVerifyPin.mockReturnValue(true);
    mockGetTxn.mockResolvedValue(null);
  });

  it("responds to ping with active status", async () => {
    const res = await post(buildApp(), flowPayload({ action: "ping" }));
    expect(res.body).toEqual({ data: { status: "active" } });
  });

  it("INIT shows the transfer summary when a transfer is pending", async () => {
    const res = await post(buildApp(), flowPayload());
    expect(res.body.screen).toBe("VERIFY_PIN");
    expect(res.body.data.transfer_summary).toContain("Jane Doe");
  });

  it("INIT shows an error when no transfer is pending", async () => {
    mockGetSession.mockResolvedValue({ flowData: {}, state: "idle" } as any);
    const res = await post(buildApp(), flowPayload());
    expect(res.body.screen).toBe("VERIFY_PIN");
    expect(res.body.data.error_message).toContain("No pending transfer");
  });

  it("rejects a PIN that is not 4 digits", async () => {
    const res = await post(
      buildApp(),
      flowPayload({ action: "data_exchange", data: { pin: "12" } })
    );
    expect(res.body.screen).toBe("VERIFY_PIN");
    expect(res.body.data.error_message).toContain("4-digit PIN");
  });

  it("keeps the user on VERIFY_PIN when the PIN is wrong", async () => {
    mockVerifyPin.mockReturnValue(false);
    const res = await post(
      buildApp(),
      flowPayload({ action: "data_exchange", data: { pin: "9999" } })
    );
    expect(res.body.screen).toBe("VERIFY_PIN");
    expect(res.body.data.error_message).toContain("Incorrect PIN");
  });

  it("submits the transfer and authorizes when the PIN is correct", async () => {
    const res = await post(
      buildApp(),
      flowPayload({ action: "data_exchange", data: { pin: "1234" } })
    );

    expect(res.body.screen).toBe("AUTHORIZED");
    await vi.waitFor(() => {
      expect(updateTransaction).toHaveBeenCalledWith("3RIKE-REF-1", { status: "processing" });
      expect(mockTransfer).toHaveBeenCalledWith(
        expect.objectContaining({
          beneficiaryBankCode: "090286",
          beneficiaryAccountNumber: "5015575517",
          amount: 5000,
        })
      );
    });
  });
});
