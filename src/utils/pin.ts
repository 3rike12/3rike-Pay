import crypto from "crypto";

const PIN_SALT = process.env.PIN_SALT || "3rike-pay-pin-salt";

export function hashPin(pin: string): string {
  return crypto.pbkdf2Sync(pin, PIN_SALT, 100000, 64, "sha512").toString("hex");
}

export function verifyPin(pin: string, hash: string): boolean {
  return hashPin(pin) === hash;
}
