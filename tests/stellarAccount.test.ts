import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/config", () => ({ config: { logLevel: "debug", redis: {} } }));

import { checkStellarRefund } from "@/services/stellarAccount";

const ADDR = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
const ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const USDC = { symbol: "USDC", contractAddress: ISSUER };
const XLM = { symbol: "XLM", contractAddress: null };

const horizon = (status: number, balances?: any[]) =>
  vi.fn().mockResolvedValue({ ok: status >= 200 && status < 300, status, json: async () => ({ balances }) });

describe("can this Stellar account receive a refund", () => {
  beforeEach(() => vi.stubGlobal("fetch", horizon(200, [{ asset_type: "native" }])));
  afterEach(() => vi.unstubAllGlobals());

  it("asks Stellar about exactly that account", async () => {
    const f = horizon(200, [{ asset_type: "native" }]);
    vi.stubGlobal("fetch", f);
    await checkStellarRefund(ADDR, XLM);
    expect(f.mock.calls[0][0]).toBe(`https://horizon.stellar.org/accounts/${ADDR}`);
  });

  it("refuses an account that does not exist yet, and says how to fix it", async () => {
    vi.stubGlobal("fetch", horizon(404));
    const r = await checkStellarRefund(ADDR, XLM);
    expect(r).toMatchObject({ ok: false });
    expect((r as any).error).toMatch(/isn't activated.*1 XLM/);
  });

  it("an activated account can receive XLM", async () => {
    expect(await checkStellarRefund(ADDR, XLM)).toEqual({ ok: true });
  });

  it("USDC needs the trustline: an account with only XLM is refused, and told to add it or pay with XLM", async () => {
    vi.stubGlobal("fetch", horizon(200, [{ asset_type: "native" }]));
    const r: any = await checkStellarRefund(ADDR, USDC);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no USDC trustline/);
    expect(r.error).toMatch(/pay with XLM instead/);
  });

  it("an account that has opted in to Circle's USDC is accepted", async () => {
    vi.stubGlobal("fetch", horizon(200, [{ asset_type: "native" }, { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: ISSUER }]));
    expect(await checkStellarRefund(ADDR, USDC)).toEqual({ ok: true });
  });

  it("a trustline to a look-alike USDC from another issuer does not count", async () => {
    vi.stubGlobal("fetch", horizon(200, [{ asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" }]));
    expect((await checkStellarRefund(ADDR, USDC)).ok).toBe(false);
  });

  it("when Stellar cannot be reached it lets the payment through rather than blocking on a lookup", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));
    expect(await checkStellarRefund(ADDR, USDC)).toEqual({ ok: true });
    vi.stubGlobal("fetch", horizon(503));
    expect(await checkStellarRefund(ADDR, USDC)).toEqual({ ok: true });
  });
});
