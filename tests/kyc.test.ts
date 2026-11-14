import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/config", () => ({ config: { logLevel: "debug" } }));

const userFind = vi.fn();
const userUpdateMany = vi.fn();
const evFind = vi.fn();
const evCreate = vi.fn();
const evUpdateMany = vi.fn();
vi.mock("@/db/prisma", () => ({
  prisma: {
    user: { findUnique: (...a: any[]) => userFind(...a), updateMany: (...a: any[]) => userUpdateMany(...a) },
    webhookEvent: {
      findFirst: (...a: any[]) => evFind(...a),
      create: (...a: any[]) => evCreate(...a),
      updateMany: (...a: any[]) => evUpdateMany(...a),
    },
  },
}));

const acquireLock = vi.fn();
vi.mock("@/utils/idempotency", () => ({ acquireLock: (...a: any[]) => acquireLock(...a) }));

const createVerificationSession = vi.fn();
vi.mock("@/services/toden", async () => {
  const real: any = await vi.importActual("@/services/toden");
  return { ...real, createVerificationSession: (...a: any[]) => createVerificationSession(...a) };
});

import {
  applyKycOutcome,
  processTodenEvent,
  markKycPending,
  getOrCreateVerificationSession,
  VERIFIED_MESSAGE,
} from "@/services/kyc";

const release = vi.fn();
const approved = { eventId: "e1", userId: "u1", verificationId: "v1", outcome: "approved" as const, reason: null, resubmissionUrl: null };
const declined = { ...approved, outcome: "declined" as const, reason: "The document expired." };

beforeEach(() => {
  vi.clearAllMocks();
  acquireLock.mockResolvedValue({ release });
  userFind.mockResolvedValue({ id: "u1", phone: "250788", kycStatus: "pending" });
  userUpdateMany.mockResolvedValue({ count: 1 });
  evFind.mockResolvedValue(null);
  evCreate.mockResolvedValue({});
  evUpdateMany.mockResolvedValue({ count: 1 });
});

describe("applyKycOutcome", () => {
  it("verifies once: the first approval messages, a replay changes nothing and stays silent", async () => {
    const first = await applyKycOutcome(approved);
    expect(first).toEqual({ phone: "250788", notify: VERIFIED_MESSAGE });
    expect(userUpdateMany).toHaveBeenCalledWith({
      where: { id: "u1", NOT: { kycStatus: "verified" } },
      data: { kycStatus: "verified" },
    });

    userUpdateMany.mockResolvedValue({ count: 0 }); // already verified
    expect((await applyKycOutcome(approved)).notify).toBeNull();
  });

  it("a decline only applies to someone who is neither verified nor already rejected", async () => {
    const first = await applyKycOutcome(declined);
    expect(first.notify).toContain("The document expired.");
    expect(userUpdateMany).toHaveBeenCalledWith({
      where: { id: "u1", kycStatus: { notIn: ["verified", "rejected"] } },
      data: { kycStatus: "rejected" },
    });

    userUpdateMany.mockResolvedValue({ count: 0 }); // verified, or declined already
    expect((await applyKycOutcome(declined)).notify).toBeNull();
  });

  it("a late decline can never downgrade a verified person (the guard is in the update itself)", async () => {
    userUpdateMany.mockImplementation(async ({ where }: any) => ({
      count: where.kycStatus?.notIn?.includes("verified") ? 0 : 1,
    }));
    expect((await applyKycOutcome(declined)).notify).toBeNull();
  });

  it("a retake request goes to unverified people only", async () => {
    const out = { ...approved, outcome: "resubmit" as const, reason: "Too blurry.", resubmissionUrl: "https://x/verify/hs_1" };
    expect((await applyKycOutcome(out)).notify).toContain("https://x/verify/hs_1");
    userFind.mockResolvedValue({ id: "u1", phone: "250788", kycStatus: "verified" });
    expect((await applyKycOutcome(out)).notify).toBeNull();
  });

  it("does nothing for an unknown user", async () => {
    userFind.mockResolvedValue(null);
    expect(await applyKycOutcome(approved)).toEqual({ phone: null, notify: null });
    expect(userUpdateMany).not.toHaveBeenCalled();
  });
});

describe("processTodenEvent", () => {
  const event = { id: "evt_1", event: "verification.completed", data: { externalUserId: "u1", status: "approved" } };

  it("records the event, applies it, marks it processed and releases the lock", async () => {
    const r = await processTodenEvent(event);
    expect(r).toEqual({ status: "processed", phone: "250788", notify: VERIFIED_MESSAGE });
    expect(evCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ source: "toden", reference: "evt_1", processed: false, payload: { id: "evt_1" } }),
    });
    expect(evUpdateMany).toHaveBeenCalledWith({ where: { source: "toden", reference: "evt_1" }, data: { processed: true } });
    expect(release).toHaveBeenCalled();
  });

  it("acknowledges and skips an event that was already processed", async () => {
    evFind.mockResolvedValue({ processed: true });
    expect(await processTodenEvent(event)).toEqual({ status: "duplicate" });
    expect(userUpdateMany).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalled();
  });

  it("retries an event that was recorded but not finished, without recording it twice", async () => {
    evFind.mockResolvedValue({ processed: false });
    expect((await processTodenEvent(event)).status).toBe("processed");
    expect(evCreate).not.toHaveBeenCalled();
  });

  it("says 'busy' when another delivery of the same event is running", async () => {
    acquireLock.mockResolvedValue(null);
    expect(await processTodenEvent(event)).toEqual({ status: "busy" });
    expect(userUpdateMany).not.toHaveBeenCalled();
  });

  it("leaves the event unprocessed and throws if applying it fails, so Toden retries", async () => {
    userUpdateMany.mockRejectedValue(new Error("db down"));
    await expect(processTodenEvent(event)).rejects.toThrow("db down");
    expect(evUpdateMany).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalled();
  });

  it("marks an unrelated event processed without touching any user", async () => {
    const r = await processTodenEvent({ id: "evt_2", event: "api_key.created", data: {} });
    expect(r).toEqual({ status: "processed", phone: null, notify: null });
    expect(userUpdateMany).not.toHaveBeenCalled();
  });
});

describe("markKycPending", () => {
  it("never overwrites a verification", async () => {
    await markKycPending("u1");
    expect(userUpdateMany).toHaveBeenCalledWith({
      where: { id: "u1", NOT: { kycStatus: "verified" } },
      data: { kycStatus: "pending" },
    });
  });
});

describe("getOrCreateVerificationSession", () => {
  const live = (mins: number) => ({
    createdAt: new Date(),
    payload: { sessionId: "s1", url: "https://t/verify/a", expiresAt: new Date(Date.now() + mins * 60000).toISOString() },
  });

  it("reuses a live link instead of opening a second session", async () => {
    evFind.mockResolvedValue(live(20));
    const s = await getOrCreateVerificationSession("u1");
    expect(s.url).toBe("https://t/verify/a");
    expect(createVerificationSession).not.toHaveBeenCalled();
  });

  it("creates and remembers a session when there is none, or the last one is about to expire", async () => {
    createVerificationSession.mockResolvedValue({ sessionId: "s2", url: "https://t/verify/b", expiresAt: null });
    for (const last of [null, live(0.5)]) {
      evFind.mockResolvedValue(last);
      expect((await getOrCreateVerificationSession("u1")).url).toBe("https://t/verify/b");
    }
    expect(createVerificationSession).toHaveBeenCalledWith({ externalUserId: "u1" });
    expect(evCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ source: "toden-session", reference: "u1" }),
    });
  });

  it("when two taps race, the second reuses the first link or asks to retry", async () => {
    acquireLock.mockResolvedValue(null);
    evFind.mockResolvedValue(live(20));
    expect((await getOrCreateVerificationSession("u1")).url).toBe("https://t/verify/a");
    evFind.mockResolvedValue(null);
    await expect(getOrCreateVerificationSession("u1")).rejects.toThrow(/try again/i);
    expect(createVerificationSession).not.toHaveBeenCalled();
  });
});
