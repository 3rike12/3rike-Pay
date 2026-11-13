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
