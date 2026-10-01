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
 * Currency-agnostic amount formatter. RWF has no subunit in practice, so
 * fraction digits are dropped; the code is spelled out ("RWF 5,000") because
 * the symbol form renders inconsistently across ICU versions.
 */
export function formatCurrency(amount: number, currency = "RWF"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    currencyDisplay: "code",
    minimumFractionDigits: 0,
  })
    .format(amount)
    // Intl uses U+00A0 between code and amount; normalise it so the string
    // is predictable in WhatsApp messages and in tests.
    .replace(/\u00A0/g, " ");
}

/**
 * Rwanda mobile prefixes per RURA's National Numbering Plan:
 * 072/073 (Airtel), 077 (KTRN), 078/079 (MTN). 10 digits national,
 * 12 with the 250 country code.
 */
const RWANDA_MOBILE_PREFIXES = ["072", "073", "077", "078", "079"];

/**
 * Normalise any Rwanda phone input to the 10-digit national form
 * (0781234567) that the RWF mobile-money charge endpoint expects.
 *
 * Accepts +250781234567, 250781234567, 0781234567 and 781234567.
 * Returns null when the number is not a plausible Rwanda mobile number -
 * callers must treat null as a hard validation error rather than sending
 * a malformed number to Flutterwave.
 *
 * NOTE: Flutterwave's own Rwanda docs show a Ghanaian number
 * (054709929220), so the exact representation they route on is only
 * confirmable in sandbox. Flip RWANDA_PHONE_LOCAL below if it rejects.
 */
export function toRwandaPhone(phone: string): string | null {
  const cleaned = (phone || "").replace(/[^0-9]/g, "");
  let national: string | null = null;

  if (cleaned.length === 12 && cleaned.startsWith("250")) {
    national = "0" + cleaned.slice(3);
  } else if (cleaned.length === 10 && cleaned.startsWith("0")) {
    national = cleaned;
  } else if (cleaned.length === 9 && cleaned.startsWith("7")) {
    national = "0" + cleaned;
  }

  if (!national) return null;
  return RWANDA_MOBILE_PREFIXES.some((p) => national!.startsWith(p)) ? national : null;
}

/** Backwards-compatible check built on toRwandaPhone. */
export function isRwandaPhone(phone: string): boolean {
  return toRwandaPhone(phone) !== null;
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

function expandAmountShorthand(text: string): string {
  return text
    .replace(/\b(\d+(?:\.\d{1,2})?)\s?k\b/gi, (_, n) => String(parseFloat(n) * 1000))
    .replace(/\b(\d+(?:\.\d{1,2})?)\s?kay\b/gi, (_, n) => String(parseFloat(n) * 1000))
    .replace(/\b(\d+(?:\.\d{1,2})?)\s?m\b/gi, (_, n) => String(parseFloat(n) * 1000000))
    .replace(/\b(\d+(?:\.\d{1,2})?)\s?milla?\b/gi, (_, n) => String(parseFloat(n) * 1000000));
}

export function parseAmountFromText(text: string): number | null {
  // Expand Nigerian slang like 4k, 5k, 1m
  const expanded = expandAmountShorthand(text);

  // Try numeric first (anywhere in the text)
  const numericMatch = expanded.match(/\b(\d{1,9}(?:,\d{3})*(?:\.\d{1,2})?)\b/);
  if (numericMatch) {
    const value = parseFloat(numericMatch[1].replace(/,/g, ""));
    if (!isNaN(value)) return value;
  }

  // Try words
  const wordsValue = wordsToNumber(expanded);
  if (wordsValue !== null) return wordsValue;

  return null;
}

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

export function extractAccountNumber(text: string): string | null {
  const matches = text.replace(/[^0-9]/g, " ").match(/\b\d{10}\b/);
  return matches ? matches[0] : null;
}

import messagesJson from "@/config/messages.json";

function extractBankName(text: string): string | null {
  const lower = text.toLowerCase();
  const fallbackBanks = messagesJson.BANKS.FALLBACK.map((b) => b.title);
  const knownBanks = [
    ...fallbackBanks,
    "opay",
    "palmpay",
    "kuda",
    "moniepoint",
  ];

  let best: { name: string; score: number } | null = null;

  for (const bank of knownBanks) {
    const bankLower = bank.toLowerCase();
    // Exact token match or substring match
    const tokens = bankLower.split(/\s+/);
    for (const token of tokens) {
      if (!token || token.length < 2) continue;
      if (lower.includes(token)) {
        const score = token.length; // longer match is better
        if (!best || score > best.score) {
          best = { name: bank, score };
        }
      }
    }
  }

  return best?.name || null;
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
export function parseTransferRequest(text: string, requireIntent = true): NaturalTransferRequest | null {
  const lower = text.toLowerCase();

  // Must contain transfer intent unless caller already established it
  if (requireIntent && !/\b(send|transfer|pay)\b/.test(lower)) return null;

  const amount = parseAmountFromText(text);
  const accountNumber = extractAccountNumber(text);

  if (!amount || !accountNumber) return null;

  const bankName = extractBankName(text);
  if (!bankName) return null;

  return { amount, accountNumber, bankName };
}

// ============================================
// Natural-language product / invoice parsing
//
// Mirrors parseTransferRequest: pure functions, null on any missing part.
// The caller (bot) decides what to do with a null - either prompt for the
// missing field or fall into the structured slash-command state.
// ============================================

function toNumber(raw: string): number {
  return parseFloat(raw.replace(/,/g, ""));
}

/**
 * Extract a price from the tail of a phrase and return the remaining text.
 * Handles "1000", "1,500", "1500 rwf", "rwf 1500", "at 1500", "@1500",
 * "each 1500", "price: 1500", "costs 1500".
 */
export function extractTrailingPrice(text: string): { price: number | null; rest: string } {
  let match = text.match(
    /\s*(?:rwanda\s+)?(?:rwf|frw|francs?)\s*[:\-]?\s*(\d[\d,]*(?:\.\d{1,2})?)\s*$/i
  );
  if (match) return { price: toNumber(match[1]), rest: text.slice(0, match.index) };

  match = text.match(
    /(\d[\d,]*(?:\.\d{1,2})?)\s*(?:rwanda\s+)?(?:rwf|frw|francs?)\s*$/i
  );
  if (match) return { price: toNumber(match[1]), rest: text.slice(0, match.index) };

  match = text.match(
    /\s*(?:at|@|price|each|per|costs?|is|=|:)\s*(?:rwf\s*)?(\d[\d,]*(?:\.\d{1,2})?)\s*$/i
  );
  if (match) return { price: toNumber(match[1]), rest: text.slice(0, match.index) };

  match = text.match(/\s+(\d[\d,]*(?:\.\d{1,2})?)\s*$/);
  if (match) return { price: toNumber(match[1]), rest: text.slice(0, match.index) };

  return { price: null, rest: text };
}

/** Collapse whitespace and drop punctuation that should not be in a name. */
function cleanLabel(text: string): string {
  return text
    .replace(/["'`“”‘’]/g, "")
    .replace(/[()[\]{}|/\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const PRODUCT_INTENT_RE =
  /\b(products?|catalogue|catalog|menu\s+items?|add\s+(?:a\s+)?item|new\s+item)\b/i;

const LEADING_PRODUCT_INTENT_RE =
  /^(?:please\s+)?(?:add|new|create|register|list)?\s*(?:a\s+|an\s+)?(?:products?|catalogue|catalog|menu\s+items?|add\s+(?:a\s+)?item|new\s+item)\s*[:\-–]?\s*/i;

/**
 * Remove a leading product intent phrase ("add product", "new item", ...)
 * so the remainder can be used as the raw argument.
 */
export function stripProductIntent(text: string): string {
  return text.replace(LEADING_PRODUCT_INTENT_RE, "").trim();
}

export interface NaturalProductRequest {
  name: string;
  price: number;
}

/**
 * Parse a product creation message like:
 *   "product Batteries 1000"
 *   "add product: Umbrella at 5000"
 *   "new product 1kg rice RWF 2500"
 *
 * Returns null when the intent or price is missing.
 */
export function parseProductCreateRequest(
  text: string,
  requireIntent = true
): NaturalProductRequest | null {
  if (!text) return null;

  const trimmed = text.trim();
  if (requireIntent && !PRODUCT_INTENT_RE.test(trimmed)) return null;

  let rest = stripProductIntent(trimmed);
  rest = rest.replace(
    /(?:\s+(?:for|to|on|please|costs?|at|each|per))+\s*$/i,
    ""
  );

  const { price, rest: nameSource } = extractTrailingPrice(rest);
  if (price === null || price <= 0) return null;

  const name = cleanLabel(nameSource);
  if (!name) return null;

  return { name, price };
}

// --------------------------------------------
// Invoice
// --------------------------------------------

/**
 * A Rwanda mobile number in any of the shapes merchants paste:
 *   0781234567, +250781234567, 250781234567, 781234567
 */
const RWANDA_PHONE_RE = /(?:\+?\s?250\s?|0)?7[23789]\d{7}\b/;

const INVOICE_INTENT_RE =
  /\b(invoice|charge|bill|request\s+(?:a\s+)?payment|payment\s+request|request)\b/i;

// The optional leading keyword is stripped along with one optional filler
// word, but that filler must be a whole word on its own — otherwise
// "payment request: airtime ..." loses the leading "a" of "airtime".
const LEADING_INVOICE_INTENT_RE =
  /^(?:please\s+)?(?:invoice|charge|bill|request\s+(?:a\s+)?payment|payment\s+request|request|payment)\s*[:\-–]?\s*(?:(?:for|of|to|on|a|an|the)(?=\s)|)\s*[:\-–]?\s*/i;

const CHUNK_SPLIT_RE = /\s+(?:and|&)\s+|\s*,\s*|\s*\+\s*/i;

export interface NaturalInvoiceLine {
  name: string;
  qty: number;
  /** null = resolve against the merchant's product catalogue later. */
  unitPrice: number | null;
}

export interface NaturalInvoiceRequest {
  /** Normalised 10-digit national number, or null if the message had none. */
  buyerPhone: string | null;
  items: NaturalInvoiceLine[];
}

/**
 * Parse an invoice request like:
 *   "invoice 3 batteries and 2 water for 0781234567"
 *   "charge 0781234567 2 waters at 1500"
 *   "bill 1000 water bottle to +250781234567"
 *
 * Returns null unless the message has invoice intent AND at least one item.
 * The phone is optional - the bot asks for it when absent.
 *
 * `requireIntent` lets callers already inside the invoice flow parse bare
 * item lines ("3 batteries and 2 water") without repeating the keyword.
 */
export function parseInvoiceRequest(
  text: string,
  requireIntent = true
): NaturalInvoiceRequest | null {
  if (!text) return null;

  const trimmed = text.trim();
  if (requireIntent && !INVOICE_INTENT_RE.test(trimmed)) return null;

  let buyerPhone: string | null = null;
  let remainder = trimmed;

  const phoneMatch = trimmed.match(RWANDA_PHONE_RE);
  if (phoneMatch) {
    buyerPhone = toRwandaPhone(phoneMatch[0]);
    remainder = trimmed.replace(phoneMatch[0], " ");
  }

  remainder = remainder.replace(LEADING_INVOICE_INTENT_RE, "");

  const items: NaturalInvoiceLine[] = [];

  for (const rawChunk of remainder.split(CHUNK_SPLIT_RE)) {
    let chunk = rawChunk.replace(
      /(?:\s+(?:for|to|on|please|the|a|an|of))+\s*$/i,
      ""
    ).trim();
    if (!chunk) continue;

    let qty: number | null = null;
    let price: number | null = null;

    // Leading quantity: "3 batteries", "3x batteries"
    let match = chunk.match(/^(?:qty\s*)?(\d{1,4})\s*[x×]?\s+/i);
    if (match) {
      qty = parseInt(match[1], 10);
      chunk = chunk.slice(match[0].length);
    } else {
      // Trailing quantity: "batteries x3" - only for small numbers so a
      // price written as "batteries x 1500" is not mistaken for a count.
      match = chunk.match(/\s*[x×]\s*(\d{1,4})\s*$/i);
      if (match && parseInt(match[1], 10) <= 999) {
        qty = parseInt(match[1], 10);
        chunk = chunk.slice(0, match.index);
      }
    }

    const extracted = extractTrailingPrice(chunk);
    price = extracted.price;
    chunk = extracted.rest;

    const name = cleanLabel(chunk);
    if (!name) continue;

    if (qty && qty > 99 && price === null) {
      // "invoice 1000 water bottle" - a big leading number with no price
      // anywhere else is a price, not a count. Counts over 99 written in
      // chat are rare; put them behind "x" ("water x 150") to be explicit.
      price = qty;
      qty = 1;
    }

    items.push({ name, qty: qty && qty > 0 ? qty : 1, unitPrice: price });
  }

  if (items.length === 0) return null;

  return { buyerPhone, items };
}
