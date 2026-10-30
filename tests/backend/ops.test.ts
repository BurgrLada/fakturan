import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { user } from "@/server/db/schema";
import { checkHealth } from "@/server/health";
import { logger } from "@/server/logger";
import { getInstanceStatus } from "@/server/services/instance-status";
import { createTestDb } from "../helpers/db";

const db = createTestDb();
const dataDir = mkdtempSync(join(tmpdir(), "fakturan-ops-"));
const validEnv = {
  DATA_DIR: dataDir,
  BETTER_AUTH_URL: "http://localhost:3000",
  BETTER_AUTH_SECRET: "x".repeat(32),
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.doUnmock("@/server/db");
  vi.resetModules();
});

describe("health", () => {
  test("[OPS-004] checkHealth hlásí databázi a plánovač bez citlivých údajů", () => {
    const result = checkHealth(db);
    expect(result).toEqual({ status: "ok", database: "ok", scheduler: "not_started" });
  });

  test("[OPS-004] nedostupná databáze dá status error a nevypíše chybu", () => {
    const broken = {
      $client: {
        prepare: () => {
          throw new Error("SQLITE_CORRUPT /data/fakturan.db");
        },
      },
    } as unknown as Parameters<typeof checkHealth>[0];
    const result = checkHealth(broken);
    expect(result.status).toBe("error");
    expect(JSON.stringify(result)).not.toContain("/data");
  });
});

describe("logger", () => {
  test("[OPS-006] logger zapisuje JSON řádek na stdout", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    logger.info("start", { port: 3000 });
    const line = JSON.parse(String(write.mock.calls[0][0]));
    expect(line).toMatchObject({ level: "info", msg: "start", port: 3000 });
    expect(typeof line.time).toBe("string");
  });

  test("[OPS-006] chyby jdou na stdout se zprávou chyby", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    logger.error("pád", { err: new Error("boom") });
    const line = JSON.parse(String(write.mock.calls[0][0]));
    expect(line).toMatchObject({ level: "error", msg: "pád", err: { message: "boom" } });
  });
});

describe("start", () => {
  async function loadRegister(migrate: () => void) {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    for (const [k, v] of Object.entries(validEnv)) vi.stubEnv(k, v);
    vi.doMock("@/server/db", () => ({ db: {}, runMigrations: migrate }));
    return (await import("../../src/instrumentation")).register;
  }

  test("[OPS-002] selhání migrace zastaví start", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const register = await loadRegister(() => {
      throw new Error("migrace selhala");
    });
    await expect(register()).rejects.toThrow("migrace selhala");
  });

  test("[OPS-002] v produkci selhání migrace ukončí proces", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    vi.stubEnv("NODE_ENV", "production");
    const register = await loadRegister(() => {
      throw new Error("migrace selhala");
    });
    await expect(register()).rejects.toThrow("exit");
    expect(exit).toHaveBeenCalledWith(1);
  });

  test("[SEC-003] bez ENCRYPTION_KEY se aplikace nespustí", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const register = await loadRegister(() => {});
    vi.stubEnv("ENCRYPTION_KEY", "");
    await expect(register()).rejects.toThrow(/ENCRYPTION_KEY/);
  });

  test("[OPS-002] platná konfigurace a migrace startu projdou", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const migrate = vi.fn();
    const register = await loadRegister(migrate);
    await register();
    expect(migrate).toHaveBeenCalledOnce();
  });
});

describe("instance status", () => {
  const now = new Date();
  db.insert(user)
    .values({
      id: "adm",
      name: "A",
      email: "a@x.cz",
      role: "admin",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(user)
    .values({ id: "usr", name: "U", email: "u@x.cz", role: "user", createdAt: now, updatedAt: now })
    .run();

  test("[ADM-008] stav instance ukáže verzi, velikost DB, plánovač a nastavení bez tajemství", () => {
    vi.stubEnv("DATA_DIR", dataDir);
    vi.stubEnv("DATABASE_PATH", join(dataDir, "status.db"));
    writeFileSync(join(dataDir, "status.db"), Buffer.alloc(2048));
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
    vi.stubEnv("BETTER_AUTH_SECRET", "x".repeat(32));
    vi.stubEnv("ENCRYPTION_KEY", validEnv.ENCRYPTION_KEY);
    vi.stubEnv("SMTP_HOST", "smtp.example.cz");
    vi.stubEnv("SMTP_PASSWORD", "tajne-heslo-smtp");
    vi.stubEnv("SENTRY_DSN", "https://klic@errors.example.cz/1");
    const status = getInstanceStatus({ userId: "adm", source: "web" });
    expect(status.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(status.databaseBytes).toBeGreaterThanOrEqual(2048);
    expect(status.scheduler).toBe("not_started");
    expect(status.lastBackupAt).toBeNull();
    expect(status.smtpConfigured).toBe(true);
    expect(status.monitoringConfigured).toBe(true);
    const json = JSON.stringify(status);
    expect(json).not.toContain("tajne-heslo-smtp");
    expect(json).not.toContain("errors.example.cz");
  });

  test("[ADM-008] stav instance je jen pro administrátora", () => {
    expect(() => getInstanceStatus({ userId: "usr", source: "web" })).toThrow(/oprávnění/);
  });
});
