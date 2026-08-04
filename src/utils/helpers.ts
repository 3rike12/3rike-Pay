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

export function cleanPhone(phone: string): string {
  let cleaned = phone.replace(/[^0-9+]/g, "");
  if (cleaned.startsWith("234")) cleaned = "0" + cleaned.slice(3);
  if (cleaned.startsWith("+234")) cleaned = "0" + cleaned.slice(4);
  return cleaned;
}

export function extractAmount(text: string): number | null {
  const cleaned = text.replace(/[₦NGN,\s]/g, "");
  const match = cleaned.match(/^(\d+(\.\d{1,2})?)$/);
  return match ? parseFloat(match[1]) : null;
}
