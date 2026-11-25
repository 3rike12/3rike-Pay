import { describe, it, expect } from "vitest";
import { skipFromAccessLog } from "@/utils/requestLog";

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
