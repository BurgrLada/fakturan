import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { setClockForTests } from "@/server/clock";
import { auditLog, schedulerState, user } from "@/server/db/schema";
import {
  BACKUP_KEEP,
  backupTask,
  createBackup,
  listBackups,
  pruneBackups,
} from "@/server/scheduler/backup";
import { getInstanceStatus } from "@/server/services/instance-status";
import { createTestDb } from "../helpers/db";

const report = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock("@sentry/nextjs", () => ({ captureException: report.captureException }));

const dataDir = mkdtempSync(join(tmpdir(), "fakturan-backup-"));
vi.stubEnv("DATA_DIR", dataDir);
vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "x".repeat(32));
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));

const db = createTestDb();
const backups = join(dataDir, "backups");
const HOUR = 3_600_000;
const MORNING = new Date("2026-11-02T02:00:00Z");

function names() {
  return readdirSync(backups).sort();
}

function failVacuum() {
  const original = db.$client.prepare.bind(db.$client);
  return vi.spyOn(db.$client, "prepare").mockImplementation(((sql: string) => {
    if (sql.startsWith("VACUUM")) throw new Error("disk full /data/secret");
    return original(sql);
  }) as typeof db.$client.prepare);
}

const now = new Date("2026-01-01T00:00:00Z");
db.insert(user)
  .values({ id: "adm", name: "A", email: "a@x.cz", role: "admin", createdAt: now, updatedAt: now })
  .run();

beforeEach(() => {
  db.delete(schedulerState).run();
  db.insert(schedulerState).values({ id: 1 }).run();
  setClockForTests({ now: () => MORNING });
  vi.stubEnv("SENTRY_DSN", "https://klic@errors.example.cz/1");
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  report.captureException.mockClear();
});

afterEach(() => {
  setClockForTests(null);
  vi.restoreAllMocks();
  rmSync(backups, { recursive: true, force: true });
});

describe("denní záloha", () => {
  test("[OPS-005] po 2:30 vznikne jedna záloha a druhý tick stejného dne nic nepřidá", async () => {
    await backupTask.run(new Date("2026-11-02T01:45:00Z"));
    expect(names()).toEqual(["fakturan-2026-11-02.db"]);
    const file = join(backups, "fakturan-2026-11-02.db");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const before = statSync(file).mtimeMs;
    await backupTask.run(new Date("2026-11-02T09:00:00Z"));
    expect(names()).toEqual(["fakturan-2026-11-02.db"]);
    expect(statSync(file).mtimeMs).toBe(before);
  });

  test("[OPS-005] před 2:30 záloha nevznikne, v den přechodu času ano", async () => {
    await backupTask.run(new Date("2026-11-02T01:00:00Z"));
    expect(existsSync(backups) ? names() : []).toEqual([]);
    await backupTask.run(new Date("2026-10-25T02:10:00Z"));
    await backupTask.run(new Date("2027-03-28T01:10:00Z"));
    expect(names()).toEqual(["fakturan-2026-10-25.db", "fakturan-2027-03-28.db"]);
  });

  test("[OPS-005] 15. záloha smaže nejstarší", async () => {
    for (let day = 1; day <= BACKUP_KEEP + 1; day += 1) {
      const date = String(day).padStart(2, "0");
      await backupTask.run(new Date(`2026-12-${date}T10:00:00Z`));
    }
    const kept = listBackups();
    expect(kept).toHaveLength(BACKUP_KEEP);
    expect(kept[0].at).toBe("2026-12-02");
    expect(kept.at(-1)?.at).toBe("2026-12-15");
    expect(kept[0].bytes).toBeGreaterThan(0);
  });

  test("[OPS-005] selhání nechá staré kopie, žádné .tmp a je hlášené, další pokus po hodině", async () => {
    await backupTask.run(new Date("2026-11-01T10:00:00Z"));
    mkdirSync(backups, { recursive: true });
    writeFileSync(join(backups, "fakturan-2026-10-01.db.tmp"), "napůl");
    const vacuum = failVacuum();
    const failedAt = new Date("2026-11-02T10:00:00Z");
    await backupTask.run(failedAt);
    expect(names()).toEqual(["fakturan-2026-11-01.db"]);
    expect(report.captureException).toHaveBeenCalledTimes(1);
    const tries = () => vacuum.mock.calls.filter(([sql]) => sql.startsWith("VACUUM")).length;
    expect(tries()).toBe(1);
    await backupTask.run(new Date(failedAt.getTime() + HOUR - 60_000));
    expect(tries()).toBe(1);
    vacuum.mockRestore();
    await backupTask.run(new Date(failedAt.getTime() + HOUR));
    expect(names()).toEqual(["fakturan-2026-11-01.db", "fakturan-2026-11-02.db"]);
  });

  test("[OPS-005] obnovená kopie má shodná data", async () => {
    const copy = createBackup(new Date("2026-11-03T10:00:00Z"));
    expect(copy.bytes).toBe(statSync(copy.path).size);
    expect(existsSync(`${copy.path}.tmp`)).toBe(false);
    const restored = new Database(copy.path, { readonly: true });
    try {
      expect(restored.prepare("SELECT email FROM user WHERE id = 'adm'").get()).toEqual({
        email: "a@x.cz",
      });
    } finally {
      restored.close();
    }
  });

  test("[OPS-005] pruneBackups ponechá nejnovější a cizí soubory nechá být", () => {
    mkdirSync(backups, { recursive: true });
    for (const day of ["01", "02", "03"])
      writeFileSync(join(backups, `fakturan-2026-09-${day}.db`), "x");
    writeFileSync(join(backups, "poznamka.txt"), "x");
    pruneBackups(2);
    expect(names()).toEqual(["fakturan-2026-09-02.db", "fakturan-2026-09-03.db", "poznamka.txt"]);
  });

  test("[ADM-008] stav instance ukáže čas poslední zálohy", async () => {
    const actor = { userId: "adm", source: "web" } as const;
    expect(getInstanceStatus(actor).lastBackupAt).toBeNull();
    const at = new Date("2026-11-02T10:00:00Z");
    setClockForTests({ now: () => at });
    await backupTask.run(at);
    expect(getInstanceStatus(actor).lastBackupAt).toEqual(at);
  });

  test("[AUD-002] záloha je v auditu instance", async () => {
    await backupTask.run(new Date("2027-02-02T10:00:00Z"));
    const vacuum = failVacuum();
    await backupTask.run(new Date("2027-02-03T10:00:00Z"));
    vacuum.mockRestore();
    const rows = db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entity, "backup"))
      .all()
      .filter((row) => ["2027-02-02", "2027-02-03"].includes(row.entityId ?? ""));
    expect(rows.map((r) => r.action).sort()).toEqual(["backup.create", "backup.failed"]);
    for (const row of rows) {
      expect(row).toMatchObject({ scope: "instance", actorId: null, source: "scheduler" });
      expect(row.ownerId).toBeNull();
    }
    expect(JSON.stringify(rows)).not.toContain("/data/secret");
  });
});
