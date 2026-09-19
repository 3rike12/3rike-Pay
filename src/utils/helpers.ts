export function generateReference(prefix: string = "3rik"): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 8);
  return `${prefix}_${ts}_${rand}`;
}

export function generateTransactionReference(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");
  const rand = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `3RIKE-${date}-${rand}`;
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

/**
 * Strip identifiers that must never be persisted or logged in the clear.
 *
 * Currently BVNs (11 consecutive digits). Logs and the webhook event table are
 * both read by humans and shipped off-box, so anything sensitive has to be
 * scrubbed at the point it is written, not later.
 */
export function redactSensitiveText(text: string): string {
  return text.replace(/\b\d{11}\b/g, "[redacted]");
}

export function redactPhone(phone: string): string {
  if (!phone) return "";
  const last4 = phone.replace(/[^0-9]/g, "").slice(-4);
  return `****${last4 || ""}`;
}

export function extractAmount(text: string): number | null {
  const cleaned = text.replace(/[₦NGN,\s]/g, "");
  const match = cleaned.match(/^(\d+(\.\d{1,2})?)$/);
  return match ? parseFloat(match[1]) : null;
}

// ============================================
// Natural-language transfer parser
// ============================================

const UNITS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
  hundred: 100,
  thousand: 1000,
  million: 1_000_000,
};

export function wordsToNumber(text: string): number | null {
  const lower = text.toLowerCase().replace(/[^a-z\s]/g, " ").trim();
  const words = lower.split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;

  // Simple phrase parser for "five thousand", "two million", "one thousand five hundred", etc.
  let total = 0;
  let current = 0;
  let lastScale = 1;

  for (const word of words) {
    const value = UNITS[word];
    if (value === undefined) continue;

    if (value === 100) {
      current = current === 0 ? 100 : current * 100;
    } else if (value >= 1000) {
      current = (current === 0 ? 1 : current) * value;
      total += current;
      current = 0;
    } else {
      current += value;
    }
  }

  const result = total + current;
  return result > 0 ? result : null;
}

export function parseAmountFromText(text: string): number | null {
  // Try numeric first
  const numeric = extractAmount(text);
  if (numeric !== null) return numeric;

  // Try words
  return wordsToNumber(text);
}

export function extractAccountNumber(text: string): string | null {
  const matches = text.replace(/[^0-9]/g, " ").match(/\b\d{10}\b/);
  return matches ? matches[0] : null;
}

export interface NaturalTransferRequest {
  amount: number;
  accountNumber: string;
  bankName: string;
}

/**
 * Try to parse a natural transfer request like:
 *   "send 5000 naira to 1234567890 gtbank"
 *   "transfer five thousand naira to 1234567890 access"
 *
 * Returns null if any part is missing.
 */
export function parseTransferRequest(text: string): NaturalTransferRequest | null {
  const lower = text.toLowerCase();

  // Must contain transfer intent
  if (!/\b(send|transfer|pay)\b/.test(lower)) return null;

  const amount = parseAmountFromText(text);
  const accountNumber = extractAccountNumber(text);

  if (!amount || !accountNumber) return null;

  // Remove account number and amount digits/words from text, leaving bank candidates
  let remainder = lower
    .replace(/\b\d{10}\b/, " ")
    .replace(/[₦NGN,]/g, " ")
    .replace(/\d+/g, " ");

  // Strip common words
  remainder = remainder
    .replace(/\b(send|transfer|pay|to|naira|ngn|into|for|the|of)\b/g, " ")
    .trim();

  // The longest remaining word/phrase is likely the bank name candidate
  const bankCandidate = remainder.split(/\s+/).filter(Boolean).join(" ") || "";
  if (!bankCandidate) return null;

  return { amount, accountNumber, bankName: bankCandidate };
}
