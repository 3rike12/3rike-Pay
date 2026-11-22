import { describe, it, expect } from "vitest";
import { toMinor, fromMinor, minorExponent } from "@/utils/money";

describe("minor units", () => {
  it("uses 2 decimals, and none for currencies without a minor unit", () => {
    expect(minorExponent("KES")).toBe(2);
    expect(minorExponent("ngn")).toBe(2);
    expect(minorExponent("RWF")).toBe(0);
    expect(minorExponent("rwf")).toBe(0);
  });

  it("converts whole amounts exactly", () => {
    expect(toMinor(13000, "KES")).toBe(1300000n);
    expect(toMinor(14500, "RWF")).toBe(14500n);
    expect(toMinor(0, "KES")).toBe(0n);
  });

  it("absorbs float error that would otherwise lose a cent", () => {
    expect(0.1 + 0.2).not.toBe(0.3); // the reason this exists
    expect(toMinor(0.1 + 0.2, "USD")).toBe(30n);
    expect(toMinor(1234.57, "NGN")).toBe(123457n);
    expect(toMinor(19.99, "USD")).toBe(1999n);
  });

  it("keeps negative balances symmetric", () => {
    expect(toMinor(-12.5, "USD")).toBe(-1250n);
    expect(toMinor(-0.004, "USD")).toBe(0n);
    expect(toMinor(-2.345, "USD")).toBe(-toMinor(2.345, "USD"));
  });

  it("holds balances far past a 32-bit integer", () => {
    expect(toMinor(50_000_000, "NGN")).toBe(5_000_000_000n); // > 2^31
  });

  it("refuses values that are not numbers", () => {
    expect(() => toMinor(NaN, "KES")).toThrow();
    expect(() => toMinor(Infinity, "KES")).toThrow();
  });

  it("round-trips", () => {
    expect(fromMinor(toMinor(1234.56, "KES"), "KES")).toBe(1234.56);
    expect(fromMinor(1500n, "RWF")).toBe(1500);
  });
});
