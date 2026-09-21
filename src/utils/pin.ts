import bcrypt from "bcryptjs";

const BCRYPT_ROUNDS = 10;

export function hashPin(pin: string): string {
  return bcrypt.hashSync(pin, BCRYPT_ROUNDS);
}

export function verifyPin(pin: string, hash: string): boolean {
  return bcrypt.compareSync(pin, hash);
}