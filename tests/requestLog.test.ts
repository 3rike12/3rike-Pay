import { describe, it, expect } from "vitest";
import { skipFromAccessLog, incomingMessageFields } from "@/utils/requestLog";

const skip = (url: string | undefined, statusCode: number) => skipFromAccessLog({ url }, { statusCode });

describe("the access log leaves out the health check, but only when it is healthy", () => {
  it("skips a successful /health", () => {
    expect(skip("/health", 200)).toBe(true);
    expect(skip("/health?x=1", 200)).toBe(true);
  });
  it("still logs a failing /health, which is what you would want to see", () => {
    expect(skip("/health", 500)).toBe(false);
    expect(skip("/health", 503)).toBe(false);
    expect(skip("/health", 404)).toBe(false);
  });
  it("logs everything else, including look-alikes", () => {
    for (const url of ["/", "/api/health", "/healthz", "/health/deep", "/webhook/whatsapp", "/pay/abc", undefined]) expect(skip(url, 200), String(url)).toBe(false);
  });
});

describe("what is logged about an incoming message", () => {
  const base = { phone: "2349167582901", state: "idle", text: "  how much do i owe on my loan of 450000  ", includeText: false, redactText: (_s: string, t: string) => t.trim() };

  it("by default, never what the person typed: only who (masked), where, and how long", () => {
    const f = incomingMessageFields(base);
    expect(f).toEqual({ phone: "****2901", state: "idle", chars: "how much do i owe on my loan of 450000".length }); // trimmed, so the spaces do not count
    expect(JSON.stringify(f)).not.toMatch(/loan|450000|2349167582901/);
  });

  it("a tapped button's id is logged: it is ours, not their words", () => {
    expect(incomingMessageFields({ ...base, action: "top_up", text: "Add money" })).toMatchObject({ action: "top_up", chars: 9 });
  });

  it("with the switch on, the text comes through the redaction for that step", () => {
    const f = incomingMessageFields({ ...base, includeText: true, state: "awaiting_pin", text: "1234", redactText: (s, t) => (s === "awaiting_pin" ? `[redacted ${t.length} chars]` : t) });
    expect(f.text).toBe("[redacted 4 chars]");
    expect(JSON.stringify(f)).not.toContain("1234");
  });

  it("with the switch on and an ordinary step, the text is shown", () => {
    expect(incomingMessageFields({ ...base, includeText: true }).text).toBe("how much do i owe on my loan of 450000");
  });

  it("an empty message is zero characters, not an error", () => {
    expect(incomingMessageFields({ ...base, text: "" })).toMatchObject({ chars: 0 });
  });
});

