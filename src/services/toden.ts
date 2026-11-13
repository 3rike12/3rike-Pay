import { createHmac, timingSafeEqual } from "node:crypto";
import axios from "axios";
import { config } from "@/config";
import { createLogger } from "@/utils/logger";

const logger = createLogger("toden");

// ============================================
// Toden identity verification (basic KYC)
//
// 1. createVerificationSession() -> a hosted link (document + selfie +
//    liveness, whatever the workflow holds). The merchant opens it on their phone.
// 2. Toden calls POST /webhook/toden with a signed result; we verify the
//    signature over the raw bytes, then map it with outcomeFromEvent().
// ============================================

export interface VerificationSession {
  sessionId: string;
  url: string;
  expiresAt: string | null;
}

export async function createVerificationSession(params: {
  /** Our user id, echoed back on the webhook so we know whose result it is. */
  externalUserId: string;
  metadata?: Record<string, unknown>;
}): Promise<VerificationSession> {
  const { baseUrl, secretKey, workflowId } = config.toden;
  if (!secretKey || !workflowId) throw new Error("Identity verification isn't set up.");

  try {
    const { data } = await axios.post(
      `${baseUrl}/api/v1/sessions`,
      { workflowId, externalUserId: params.externalUserId, ...(params.metadata ? { metadata: params.metadata } : {}) },
      { headers: { Authorization: `Bearer ${secretKey}`, "Content-Type": "application/json" }, timeout: 15000 }
    );
    const session = data?.session;
    if (!session?.url || !session?.sessionId) throw new Error("No verification link returned");
    return { sessionId: session.sessionId, url: session.url, expiresAt: session.expiresAt ?? null };
  } catch (error: any) {
    logger.error("Could not create a verification session", {
      status: error?.response?.status,
      error: error?.response?.data || error?.message,
    });
    throw new Error("I couldn't start the identity check. Please try again in a moment.");
  }
}

/**
 * Verify Toden's webhook signature over the EXACT raw bytes
 * (`X-Myaza-Signature-V2: t=<unix>,v1=<hex>` = HMAC-SHA256 of `<t>.<body>`),
 * reject anything older than five minutes, and return the parsed event.
 * Throws on any problem. Accepts several secrets so a rotation never drops events.
 */
export function verifyTodenWebhook(
  rawBody: Buffer,
  signatureHeader: string,
  secrets: string[],
  now = Date.now()
): any {
  const usable = secrets.filter((s) => typeof s === "string" && s.length > 0);
  if (!Buffer.isBuffer(rawBody) || typeof signatureHeader !== "string" || usable.length === 0) {
    throw new Error("Invalid webhook input");
  }
  const parts = signatureHeader.split(",").map((part) => part.trim());
  const stamps = parts.filter((part) => part.startsWith("t="));
  if (stamps.length !== 1 || !/^t=[0-9]+$/.test(stamps[0])) throw new Error("Invalid timestamp");
  const timestamp = Number(stamps[0].slice(2));
  if (!Number.isSafeInteger(timestamp) || Math.abs(now / 1000 - timestamp) > 300) {
    throw new Error("Expired webhook signature");
  }

  const signatures = parts
    .filter((part) => /^v1=[a-f0-9]{64}$/i.test(part))
    .map((part) => Buffer.from(part.slice(3), "hex"));
  const valid = usable.some((secret) => {
    const expected = createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest();
    return signatures.some((sig) => sig.length === expected.length && timingSafeEqual(expected, sig));
  });
  if (!valid) throw new Error("Invalid webhook signature");

  const event = JSON.parse(rawBody.toString("utf8"));
  if (!event || typeof event.id !== "string" || !event.id) throw new Error("Invalid webhook envelope");
  return event;
}

export interface KycOutcome {
  eventId: string;
  userId: string;
  verificationId: string | null;
  outcome: "approved" | "declined" | "resubmit";
  reason: string | null;
  resubmissionUrl: string | null;
}

/**
 * Map a Toden event to what we do about it. Returns null for events that
 * aren't an identity result (API-key events, in-progress states, ...).
 * Handles both payload shapes in the docs: `data.*` and top-level fields.
 */
export function outcomeFromEvent(event: any): KycOutcome | null {
  const type = String(event?.type ?? event?.event ?? "");
  if (!type.startsWith("verification.")) return null;

  const data = event.data && typeof event.data === "object" ? event.data : event;
  const userId = data.externalUserId ?? event.externalUserId;
  if (!userId || typeof userId !== "string") return null;

  const status = String(data.status ?? event.status ?? "").toLowerCase();
  const reason = data.reason ?? data.summary?.reason ?? event.summary?.reason ?? null;
  const resubmissionUrl = event.resubmission?.url ?? data.resubmission?.url ?? null;
  const base = {
    eventId: event.id as string,
    userId,
    verificationId: (data.verificationId ?? event.verificationId ?? null) as string | null,
    reason: typeof reason === "string" ? reason : null,
    resubmissionUrl: typeof resubmissionUrl === "string" ? resubmissionUrl : null,
  };

  if (status === "awaiting_resubmission") return { ...base, outcome: "resubmit" };
  if (type === "verification.completed" || type === "verification.status_updated") {
    if (status === "approved") return { ...base, outcome: "approved" };
    if (status === "declined" || status === "rejected") return { ...base, outcome: "declined" };
  }
  return null;
}
