import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";

vi.mock("@/config", () => ({
  config: {
    logLevel: "debug",
    toden: { baseUrl: "https://sandbox-api.toden.co", secretKey: "sk_test_x", workflowId: "wf_1", enabled: true },
  },
}));

const post = vi.fn();
vi.mock("axios", () => ({ default: { post: (...a: any[]) => post(...a) } }));

import { createVerificationSession, verifyTodenWebhook, outcomeFromEvent } from "@/services/toden";

const SECRET = "whsec_test";
const sign = (body: string, t: number, secret = SECRET) =>
  `t=${t},v1=${createHmac("sha256", secret).update(`${t}.`).update(Buffer.from(body)).digest("hex")}`;
const NOW = 1_800_000_000_000;
const t = NOW / 1000;

describe("createVerificationSession", () => {
  beforeEach(() => { post.mockReset(); });

  it("posts the workflow and our user id with the secret key", async () => {
    post.mockResolvedValue({ data: { session: { sessionId: "s1", url: "https://console.toden.co/verify/abc", expiresAt: "2026-11-14T00:00:00Z" } } });
    const s = await createVerificationSession({ externalUserId: "user_1" });
    expect(s).toEqual({ sessionId: "s1", url: "https://console.toden.co/verify/abc", expiresAt: "2026-11-14T00:00:00Z" });
    expect(post).toHaveBeenCalledWith(
      "https://sandbox-api.toden.co/api/v1/sessions",
      { workflowId: "wf_1", externalUserId: "user_1" },
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer sk_test_x" }) })
    );
  });

});

describe("createVerificationSession failure", () => {
  it("gives a friendly error, not the provider's, when the call fails", async () => {
    post.mockImplementation(() => {
      // eslint-disable-next-line no-throw-literal
      throw { response: { status: 500, data: { detail: "provider internals" } }, message: "upstream" };
    });
    let err: any = null;
    try {
      await createVerificationSession({ externalUserId: "u" });
    } catch (e) {
      err = e;
    }
    expect(err?.message).toBe("I couldn't start the identity check. Please try again in a moment.");
  });
});


describe("verifyTodenWebhook", () => {
  const body = JSON.stringify({ id: "evt_1", event: "verification.completed", data: { externalUserId: "u1", status: "approved" } });

  it("accepts a correctly signed, fresh event", () => {
    expect(verifyTodenWebhook(Buffer.from(body), sign(body, t), [SECRET], NOW).id).toBe("evt_1");
  });

  it("accepts the previous secret during a rotation", () => {
    expect(verifyTodenWebhook(Buffer.from(body), sign(body, t, "old"), [SECRET, "old"], NOW).id).toBe("evt_1");
  });

  it("rejects a wrong signature, a tampered body, a stale timestamp and no secret", () => {
    expect(() => verifyTodenWebhook(Buffer.from(body), sign(body, t, "wrong"), [SECRET], NOW)).toThrow(/Invalid webhook signature/);
    expect(() => verifyTodenWebhook(Buffer.from(body + " "), sign(body, t), [SECRET], NOW)).toThrow(/Invalid webhook signature/);
    expect(() => verifyTodenWebhook(Buffer.from(body), sign(body, t - 301), [SECRET], NOW)).toThrow(/Expired/);
    expect(() => verifyTodenWebhook(Buffer.from(body), sign(body, t), [""], NOW)).toThrow(/Invalid webhook input/);
  });

  it("rejects a malformed header", () => {
    expect(() => verifyTodenWebhook(Buffer.from(body), "garbage", [SECRET], NOW)).toThrow(/Invalid timestamp/);
  });
});

describe("outcomeFromEvent", () => {
  it("approves a completed, approved verification", () => {
    expect(outcomeFromEvent({ id: "e1", event: "verification.completed", data: { externalUserId: "u1", status: "approved", verificationId: "v1" } }))
      .toMatchObject({ outcome: "approved", userId: "u1", verificationId: "v1", eventId: "e1" });
  });

  it("declines with the reason", () => {
    expect(outcomeFromEvent({ id: "e2", event: "verification.completed", data: { externalUserId: "u1", status: "declined", reason: "The document expired." } }))
      .toMatchObject({ outcome: "declined", reason: "The document expired." });
  });

  it("asks for a resubmission with the link (top-level payload shape)", () => {
    expect(outcomeFromEvent({
      id: "e3", type: "verification.status_updated", externalUserId: "u1", status: "awaiting_resubmission",
      summary: { reason: "Too blurry." }, resubmission: { url: "https://console.toden.co/verify/hs_1" },
    })).toMatchObject({ outcome: "resubmit", reason: "Too blurry.", resubmissionUrl: "https://console.toden.co/verify/hs_1" });
  });

  it("ignores events that are not an identity result, or have no user", () => {
    expect(outcomeFromEvent({ id: "e4", event: "api_key.created", data: {} })).toBeNull();
    expect(outcomeFromEvent({ id: "e5", event: "verification.completed", data: { status: "approved" } })).toBeNull();
    expect(outcomeFromEvent({ id: "e6", event: "verification.completed", data: { externalUserId: "u1", status: "in_review" } })).toBeNull();
  });
});
