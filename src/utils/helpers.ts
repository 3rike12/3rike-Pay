export function generateReference(prefix: string = "3rik"): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 8);
  return `${prefix}_${ts}_${rand}`;
}

export function formatAmount(amount: number): string {
  return new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: "NGN",
    minimumFractionDigits: 0,
  }).format(amount);
}

/**
 * Normalise to local Nigerian format (0803...), which is what the AutoRamp /
 * Nigerian bank APIs expect.
 *
 * Do NOT use this for anything sent back to the WhatsApp Cloud API - it
 * requires the international form. Use toWhatsAppPhone() there.
 */
export function cleanPhone(phone: string): string {
  let cleaned = phone.replace(/[^0-9+]/g, "");
  if (cleaned.startsWith("+234")) cleaned = "0" + cleaned.slice(4);
  else if (cleaned.startsWith("234")) cleaned = "0" + cleaned.slice(3);
  return cleaned;
}

/**
 * Normalise to the international format the WhatsApp Cloud API requires
 * (2348031234567, no leading + or zero).
 *
 * Sending a local-format number is silently fatal: the API still answers 200
 * with a message id, but the message is never delivered.
 */
export function toWhatsAppPhone(phone: string): string {
  let cleaned = phone.replace(/[^0-9+]/g, "").replace(/^\+/, "");
  if (cleaned.startsWith("0")) cleaned = "234" + cleaned.slice(1);
  return cleaned;
}

export function extractAmount(text: string): number | null {
  const cleaned = text.replace(/[₦NGN,\s]/g, "");
  const match = cleaned.match(/^(\d+(\.\d{1,2})?)$/);
  return match ? parseFloat(match[1]) : null;
}
