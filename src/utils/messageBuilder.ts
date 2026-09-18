import messagesJson from "@/config/messages.json";
import customMessagesJson from "@/config/customMessages.json";
import { whatsapp } from "@/services/whatsapp";
import { createLogger } from "@/utils/logger";

const logger = createLogger("messages");

export type MessageParams = Record<string, string | number>;

/** Registry: src/config/customMessages.json (key -> params + description). */
const REGISTRY = customMessagesJson as Record<string, { params: string[]; description: string }>;

/** Dot-path lookup into messages.json, e.g. "SEND_MONEY.SUCCESS". */
function lookup(key: string): unknown {
  return key.split(".").reduce<unknown>((node, part) => {
    if (node !== null && typeof node === "object" && part in (node as Record<string, unknown>)) {
      return (node as Record<string, unknown>)[part];
    }
    return undefined;
  }, messagesJson as unknown);
}

/** Raw body string for a key. Throws if the key is missing or not a text body. */
export function getMessageBody(key: string): string {
  const node = lookup(key);
  if (typeof node !== "string") {
    throw new Error(`Message key "${key}" not found or is not a text body`);
  }
  return node;
}

/** Placeholder names ({{name}}) a body needs. Prefers the registry, falls back to scanning the body. */
export function getMessageParams(key: string): string[] {
  if (key in REGISTRY) return [...REGISTRY[key].params];
  const params = new Set<string>();
  getMessageBody(key).replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    params.add(name);
    return "";
  });
  return [...params];
}

/** All registered custom-message keys. */
export function listCustomMessages(): string[] {
  return Object.keys(REGISTRY);
}

/**
 * Render a message body from messages.json with the given params.
 * Missing params render as "" (never leak {{placeholders}} to users)
 * and are logged so the caller can fix the call site.
 */
export function buildMessage(key: string, params: MessageParams = {}): string {
  const missing = new Set<string>();
  const text = getMessageBody(key).replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    if (name in params) return String(params[name]);
    missing.add(name);
    return "";
  });
  if (missing.size > 0) {
    logger.warn("buildMessage missing params", { key, missing: [...missing] });
  }
  if (key in REGISTRY) {
    const extra = Object.keys(params).filter((p) => !REGISTRY[key].params.includes(p));
    if (extra.length > 0) {
      logger.warn("buildMessage unexpected params", { key, extra });
    }
  }
  return text;
}

/** Render + send a custom message in one call. Returns false on bad key or send failure. */
export async function sendCustomMessage(
  phone: string,
  key: string,
  params: MessageParams = {}
): Promise<boolean> {
  let text: string;
  try {
    text = buildMessage(key, params);
  } catch (error: any) {
    logger.error("sendCustomMessage bad key", { key, error: error.message });
    return false;
  }
  return whatsapp.sendTextMessage(phone, text);
}
