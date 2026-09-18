import crypto from "crypto";
import fs from "fs";
import path from "path";

const PRIVATE_KEY_PATH =
  process.env.FLOW_PRIVATE_KEY_PATH || path.resolve(process.cwd(), "secrets/flow_private.pem");

const GCM_TAG_LENGTH = 16;

function getPrivateKey(): crypto.KeyObject {
  return crypto.createPrivateKey({
    key: fs.readFileSync(PRIVATE_KEY_PATH, "utf8"),
    passphrase: process.env.FLOW_PRIVATE_KEY_PASSPHRASE || undefined,
  });
}

export interface DecryptedFlowRequest {
  decrypted: any;
  aesKey: Buffer;
  iv: Buffer;
}

export function decryptFlowRequest(body: any): DecryptedFlowRequest {
  const { encrypted_flow_data, encrypted_aes_key, initial_vector } = body;

  const aesKey = crypto.privateDecrypt(
    { key: getPrivateKey(), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(encrypted_aes_key, "base64")
  );

  const flowData = Buffer.from(encrypted_flow_data, "base64");
  const iv = Buffer.from(initial_vector, "base64");
  const body_ = flowData.subarray(0, -GCM_TAG_LENGTH);
  const tag = flowData.subarray(-GCM_TAG_LENGTH);

  const decipher = crypto.createDecipheriv(`aes-${aesKey.length * 8}-gcm` as any, aesKey, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(body_), decipher.final()]).toString("utf8");

  return { decrypted: JSON.parse(decrypted), aesKey, iv };
}

export function encryptFlowResponse(response: any, aesKey: Buffer, iv: Buffer): string {
  const flippedIv = Buffer.from(iv.map((b) => ~b));
  const cipher = crypto.createCipheriv(`aes-${aesKey.length * 8}-gcm` as any, aesKey, flippedIv);
  return Buffer.concat([
    cipher.update(JSON.stringify(response), "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64");
}

export function screen(name: string, data: Record<string, unknown> = {}) {
  return { screen: name, data };
}
