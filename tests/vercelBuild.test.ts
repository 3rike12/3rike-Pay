import { describe, it, expect } from "vitest";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildConfig } = require("../scripts/vercel-build.js");

describe("vercel-build buildConfig", () => {
  it("writes only the origin of the backend URL", () => {
    expect(buildConfig("https://api.3rike.com/")).toBe('window.PAY_CONFIG = {"apiBase":"https://api.3rike.com"};\n');
    expect(buildConfig("https://api.3rike.com/some/path?x=1")).toContain('"apiBase":"https://api.3rike.com"');
  });
  it("allows http only for localhost", () => {
    expect(buildConfig("http://localhost:3000")).toContain("http://localhost:3000");
    expect(() => buildConfig("http://api.3rike.com")).toThrow(/https/);
  });
  it("fails the build clearly when it is missing or malformed", () => {
    expect(() => buildConfig("")).toThrow(/PAY_API_URL is not set/);
    expect(() => buildConfig(undefined)).toThrow(/PAY_API_URL is not set/);
    expect(() => buildConfig("not a url")).toThrow(/not a valid URL/);
  });
  it("cannot be used to inject script", () => {
    const out = buildConfig('https://a.com/"};alert(1);//');
    expect(out).not.toContain("alert");
  });
});

describe("vercel.json routes", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const config = require("../vercel.json");
  const rewrites: Array<{ source: string; destination: string }> = config.rewrites;

  it("shows the holder page at /pay and the invoice page at /pay/:ref", () => {
    expect(rewrites).toContainEqual({ source: "/pay", destination: "/pay-home.html" });
    expect(rewrites).toContainEqual({ source: "/pay/:ref", destination: "/pay.html" });
  });

  it("does not give the homepage or any other path a page, so they stay 404", () => {
    expect(rewrites.map((r) => r.source)).not.toContain("/");
    expect(rewrites.map((r) => r.source)).not.toContain("/(.*)");
  });
});
