import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parseEnv } from "@/server/env";

const key = Buffer.alloc(32, 7).toString("base64");
const dir = mkdtempSync(join(tmpdir(), "fakturan-env-"));
const base = {
  BETTER_AUTH_URL: "http://localhost:3000",
  BETTER_AUTH_SECRET: "x".repeat(32),
  ENCRYPTION_KEY: key,
  DATA_DIR: dir,
};

describe("env", () => {
  test("[OPS-003] chybějící ENCRYPTION_KEY hlásí název proměnné", () => {
    const { ENCRYPTION_KEY: _, ...rest } = base;
    expect(() => parseEnv(rest)).toThrow(/ENCRYPTION_KEY/);
  });

  test("[OPS-003] krátký ENCRYPTION_KEY je odmítnut", () => {
    expect(() =>
      parseEnv({ ...base, ENCRYPTION_KEY: Buffer.alloc(16).toString("base64") }),
    ).toThrow(/ENCRYPTION_KEY/);
  });

  test("[OPS-003] ENCRYPTION_KEY s neplatnými znaky base64 je odmítnut", () => {
    expect(() => parseEnv({ ...base, ENCRYPTION_KEY: "!".repeat(43) + "=" })).toThrow(
      /ENCRYPTION_KEY/,
    );
  });

  test("[OPS-003] nezapisovatelná složka dat hlásí cestu", () => {
    const file = join(dir, "soubor");
    writeFileSync(file, "");
    const bad = join(file, "data");
    expect(() => parseEnv({ ...base, DATA_DIR: bad })).toThrow(bad);
  });

  test("[OPS-003] výchozí DATABASE_PATH leží ve složce dat a prázdné volitelné hodnoty se ignorují", () => {
    const env = parseEnv({ ...base, SMTP_HOST: "" });
    expect(env.DATABASE_PATH).toBe(join(dir, "fakturan.db"));
    expect(env.SMTP_HOST).toBeUndefined();
    expect(env.ENCRYPTION_KEY).toHaveLength(32);
  });

  test("[OPS-003] ALLOW_PRIVATE_MAIL_HOSTS a TRUST_PROXY jsou booleany", () => {
    const env = parseEnv({ ...base, TRUST_PROXY: "true" });
    expect(env.TRUST_PROXY).toBe(true);
    expect(env.ALLOW_PRIVATE_MAIL_HOSTS).toBe(false);
  });

  test("[OPS-003] ARES_BASE_URL má veřejné API jako výchozí a lomítko na konci se ořízne", () => {
    expect(parseEnv(base).ARES_BASE_URL).toBe(
      "https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty",
    );
    expect(parseEnv({ ...base, ARES_BASE_URL: "http://127.0.0.1:9/ares/" }).ARES_BASE_URL).toBe(
      "http://127.0.0.1:9/ares",
    );
    expect(() => parseEnv({ ...base, ARES_BASE_URL: "ares" })).toThrow(/ARES_BASE_URL/);
  });

  test("[OPS-003] VIES_BASE_URL má veřejné API jako výchozí a lomítko na konci se ořízne", () => {
    expect(parseEnv(base).VIES_BASE_URL).toBe(
      "https://ec.europa.eu/taxation_customs/vies/rest-api",
    );
    expect(parseEnv({ ...base, VIES_BASE_URL: "http://127.0.0.1:9/vies/" }).VIES_BASE_URL).toBe(
      "http://127.0.0.1:9/vies",
    );
    expect(() => parseEnv({ ...base, VIES_BASE_URL: "vies" })).toThrow(/VIES_BASE_URL/);
  });
});

process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
