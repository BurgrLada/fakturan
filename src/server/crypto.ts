import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "./env";

const VERSION = "v1";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const b64 = (b: Buffer) => b.toString("base64url");

export function encryptSecret(plain: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", env.ENCRYPTION_KEY, iv, {
    authTagLength: TAG_LENGTH,
  });
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [VERSION, b64(iv), b64(cipher.getAuthTag()), b64(data)].join(".");
}

export function decryptSecret(blob: string): string {
  const [version, iv, tag, data, ...rest] = blob.split(".");
  if (version !== VERSION || !iv || !tag || data === undefined || rest.length > 0) {
    throw new Error("Neplatný formát šifrovaného tajemství");
  }
  const ivBytes = Buffer.from(iv, "base64url");
  const tagBytes = Buffer.from(tag, "base64url");
  if (ivBytes.length !== IV_LENGTH || tagBytes.length !== TAG_LENGTH) {
    throw new Error("Neplatný formát šifrovaného tajemství");
  }
  const decipher = createDecipheriv("aes-256-gcm", env.ENCRYPTION_KEY, ivBytes, {
    authTagLength: TAG_LENGTH,
  });
  decipher.setAuthTag(tagBytes);
  return Buffer.concat([
    decipher.update(Buffer.from(data, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
