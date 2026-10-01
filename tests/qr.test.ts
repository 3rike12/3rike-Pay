import { describe, it, expect } from "vitest";
import { paymentQrPng } from "@/utils/qr";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("paymentQrPng", () => {
  it("renders a payment link as a PNG", async () => {
    const png = await paymentQrPng("https://checkout.flutterwave.com/v3/hosted/pay/abc");

    expect(png.subarray(0, 8)).toEqual(PNG_MAGIC);
    expect(png.length).toBeGreaterThan(1000);
  });
});
