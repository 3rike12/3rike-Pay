import { describe, it, expect } from "vitest";
import { currencyForCountry, MERCHANT_CURRENCIES } from "@/utils/helpers";

describe("currencyForCountry", () => {
  it("maps the three supported countries", () => {
    expect(currencyForCountry("KE")).toBe("KES");
    expect(currencyForCountry("tz")).toBe("TZS");
    expect(currencyForCountry("NG")).toBe("NGN");
  });

  it("falls back to KES for anything else", () => {
    expect(currencyForCountry("RW")).toBe("KES");
    expect(currencyForCountry(null)).toBe("KES");
    expect(currencyForCountry(undefined)).toBe("KES");
  });

  it("offers exactly three choices, which fit one WhatsApp button row", () => {
    expect(MERCHANT_CURRENCIES.map((c) => c.code)).toEqual(["KES", "TZS", "NGN"]);
  });
});
