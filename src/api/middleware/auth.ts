import crypto from "crypto";
import type { Request, Response, NextFunction } from "express";
import { config } from "@/config";
import { createLogger } from "@/utils/logger";

const logger = createLogger("auth");

/**
 * Shared `x-api-key` check for anything that is ours to call: the notify
 * webhook and the merchant read API. The key is compared in constant time
 * against `config.webhook.secret`.
 */
export function requireApiKey(req: Request, res: Response, next: NextFunction) {
  const apiKey = req.headers["x-api-key"] as string;

  if (!apiKey) {
    return res.status(401).json({ error: "Missing x-api-key header" });
  }

  const expected = config.webhook.secret;
  if (!expected) {
    logger.warn("No webhook secret configured");
    return res.status(500).json({ error: "Webhook not configured" });
  }

  const received = Buffer.from(apiKey, "utf8");
  const secret = Buffer.from(expected, "utf8");

  // timingSafeEqual throws on length mismatch, which would surface as a 500
  // on a publicly-reachable route - a wrong length is just a wrong key.
  const isValid =
    received.length === secret.length && crypto.timingSafeEqual(received, secret);

  if (!isValid) {
    logger.warn("Invalid API key", { ip: req.ip });
    return res.status(403).json({ error: "Invalid API key" });
  }

  next();
}
