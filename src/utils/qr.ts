import QRCode from "qrcode";

/**
 * PNG for a payment link. Rendered on our side so the payment URL never
 * leaves the server through a third-party QR service.
 */
export async function paymentQrPng(text: string): Promise<Buffer> {
  return QRCode.toBuffer(text, {
    type: "png",
    width: 640,
    margin: 2,
    errorCorrectionLevel: "M",
  });
}
