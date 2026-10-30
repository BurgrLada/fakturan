import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";

beforeAll(() => {
  process.env.BETTER_AUTH_URL = "http://localhost:3000";
  process.env.BETTER_AUTH_SECRET = "x".repeat(32);
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "fakturan-crypto-"));
});

describe("crypto", () => {
  test("[SEC-003] šifrování je AES-256-GCM s náhodným IV", async () => {
    const { encryptSecret, decryptSecret } = await import("@/server/crypto");
    const a = encryptSecret("tajné heslo");
    const b = encryptSecret("tajné heslo");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^v1\.[\w-]{16}\.[\w-]{22}\.[\w-]+$/);
    expect(decryptSecret(a)).toBe("tajné heslo");
    expect(decryptSecret(b)).toBe("tajné heslo");
  });

  test("[SEC-003] pozměněný šifrový text selže", async () => {
    const { encryptSecret, decryptSecret } = await import("@/server/crypto");
    const [v, iv, tag, data] = encryptSecret("abc").split(".");
    const flipped = (data[0] === "A" ? "B" : "A") + data.slice(1);
    expect(() => decryptSecret([v, iv, tag, flipped].join("."))).toThrow();
    expect(() => decryptSecret("v2.a.b.c")).toThrow();
  });
});
