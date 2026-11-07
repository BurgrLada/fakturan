import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { setClockForTests } from "@/server/clock";
import { exchangeRate, job, schedulerState, user } from "@/server/db/schema";
import { checkHealth } from "@/server/health";
import {
  measureFiles,
  opsCheck,
  opsCheckTask,
  reportedToday,
  resetOpsForTests,
} from "@/server/scheduler/ops-check";
import { getInstanceStatus } from "@/server/services/instance-status";
import { createTestDb } from "../helpers/db";

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock("@sentry/nextjs", () => ({ captureException: sentry.captureException }));

const dataDir = mkdtempSync(join(tmpdir(), "fakturan-ops-check-"));
vi.stubEnv("DATA_DIR", dataDir);
vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "x".repeat(32));
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));

const db = createTestDb();
const GIB = 1024 ** 3;
const MINUTE = 60_000;
const ADMIN = { userId: "adm", source: "web" } as const;
const OWNER_ID = "owner-7f3a";
const OWNER_EMAIL = "majitel@example.cz";

function volume(freeBytes: number, totalBytes = 500 * GIB) {
  const bsize = 4096;
  return {
    statfs: () => ({
      bsize: BigInt(bsize),
      bavail: BigInt(Math.floor(freeBytes / bsize)),
      blocks: BigInt(Math.floor(totalBytes / bsize)),
    }),
  };
}

const ROOMY = volume(200 * GIB);

function reportedKeys(): string[] {
  return sentry.captureException.mock.calls.map(([, ctx]) => ctx.tags.task);
}

function seedRate(listDate: string) {
  db.insert(exchangeRate)
    .values({ currency: "EUR", listDate, rateMicros: 24_000_000, fetchedAt: new Date() })
    .run();
}

function heavyJob(id: string, status: "running" | "pending", since: Date, userId: string | null) {
  db.insert(job)
    .values({
      id,
      userId,
      kind: "export.run",
      key: `export:${id}`,
      payload: { exportId: id },
      status,
      runAt: since,
      maxAttempts: 1,
      createdAt: since,
      updatedAt: since,
    })
    .run();
}

const created = new Date("2026-01-01T00:00:00Z");
db.insert(user)
  .values([
    {
      id: "adm",
      name: "A",
      email: "a@x.cz",
      role: "admin",
      createdAt: created,
      updatedAt: created,
    },
    { id: OWNER_ID, name: "M", email: OWNER_EMAIL, createdAt: created, updatedAt: created },
  ])
  .run();

beforeEach(() => {
  resetOpsForTests();
  sentry.captureException.mockClear();
  vi.stubEnv("SENTRY_DSN", "https://klic@errors.example.cz/1");
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  db.delete(exchangeRate).run();
  db.delete(job).run();
  db.delete(schedulerState).run();
  db.insert(schedulerState).values({ id: 1 }).run();
});

afterEach(() => {
  vi.restoreAllMocks();
  setClockForTests(null);
});

describe("provozní kontrola", () => {
  test("[MON-003] volné místo 1,5 GiB nahlásí disk jednou za den", () => {
    const low = volume(1.5 * GIB);
    const morning = new Date("2026-11-03T08:00:00Z");

    expect(opsCheck(morning, low)).toEqual([
      { key: "disk", detail: { freeBytes: 1.5 * GIB, totalBytes: 500 * GIB } },
    ]);
    opsCheck(new Date(morning.getTime() + 60 * MINUTE), low);
    expect(reportedKeys()).toEqual(["ops.disk"]);

    opsCheck(new Date("2026-11-04T08:00:00Z"), low);
    expect(reportedKeys()).toEqual(["ops.disk", "ops.disk"]);
  });

  test("[MON-003] méně než 10 % volného místa i plný svazek nahlásí disk", () => {
    const at = new Date("2026-11-03T08:00:00Z");
    expect(opsCheck(at, volume(5 * GIB, 100 * GIB)).map((f) => f.key)).toEqual(["disk"]);
    resetOpsForTests();
    expect(opsCheck(at, volume(0, 100 * GIB)).map((f) => f.key)).toEqual(["disk"]);
    resetOpsForTests();
    expect(opsCheck(at, volume(20 * GIB, 100 * GIB))).toEqual([]);
    expect(opsCheck(at, volume(0, 0))).toEqual([]);
  });

  test("[MON-003] lístek ČNB z pondělí je ve čtvrtek starý, v úterý ne", () => {
    seedRate("2026-11-02");

    expect(opsCheck(new Date("2026-11-03T15:00:00Z"), ROOMY)).toEqual([]);
    expect(opsCheck(new Date("2026-11-05T15:00:00Z"), ROOMY)).toEqual([
      { key: "fx", detail: { lastDate: "2026-11-02", missedLists: 3 } },
    ]);
    expect(reportedKeys()).toEqual(["ops.fx"]);
  });

  test("[FOR-004] prázdná tabulka kurzů se jako starý lístek nehlásí", () => {
    expect(opsCheck(new Date("2026-11-05T15:00:00Z"), ROOMY)).toEqual([]);
  });

  test("[MON-003] těžká úloha běžící 31 minut nahlásí heavy", () => {
    const now = new Date("2026-11-03T10:00:00Z");
    heavyJob("j-new", "running", new Date(now.getTime() - 29 * MINUTE), null);
    expect(opsCheck(now, ROOMY)).toEqual([]);

    db.delete(job).run();
    heavyJob("j-old", "running", new Date(now.getTime() - 31 * MINUTE), null);
    expect(opsCheck(now, ROOMY)).toEqual([
      { key: "heavy", detail: { kind: "export.run", minutes: 31 } },
    ]);
  });

  test("[OPS-005] selhaná poslední noční záloha nahlásí backup", () => {
    const tried = new Date("2026-11-03T01:30:00Z");
    db.update(schedulerState)
      .set({ lastBackupAt: new Date("2026-11-02T01:30:00Z"), lastBackupTryAt: tried })
      .run();

    expect(opsCheck(new Date("2026-11-03T10:30:00Z"), ROOMY)).toEqual([
      { key: "backup", detail: { hoursSinceSuccess: 33 } },
    ]);

    db.update(schedulerState).set({ lastBackupAt: tried }).run();
    resetOpsForTests();
    expect(opsCheck(new Date("2026-11-03T10:30:00Z"), ROOMY)).toEqual([]);
  });

  test("[MON-004] hlášení neobsahuje ID účtu, cestu ani e-mail", () => {
    const now = new Date("2026-11-05T15:00:00Z");
    seedRate("2026-11-02");
    heavyJob("job-secret-id", "running", new Date(now.getTime() - 45 * MINUTE), OWNER_ID);
    db.update(schedulerState)
      .set({ lastBackupTryAt: new Date("2026-11-05T01:30:00Z") })
      .run();

    const findings = opsCheck(now, volume(GIB));

    expect(findings.map((f) => f.key).sort()).toEqual(["backup", "disk", "fx", "heavy"]);
    expect(sentry.captureException).toHaveBeenCalledTimes(4);
    const sent = JSON.stringify(
      sentry.captureException.mock.calls.map(([error, ctx]) => [
        (error as Error).name,
        (error as Error).message,
        ctx,
      ]),
    );
    for (const secret of [OWNER_ID, OWNER_EMAIL, "job-secret-id", dataDir, tmpdir()]) {
      expect(sent).not.toContain(secret);
    }
    for (const [, ctx] of sentry.captureException.mock.calls) {
      expect(ctx).not.toHaveProperty("user");
      expect(Object.keys(ctx.tags)).toEqual(["task"]);
    }
  });

  test("[OPS-004] health zůstává ok i při nálezu opsCheck", () => {
    expect(opsCheck(new Date("2026-11-03T08:00:00Z"), volume(0))).toHaveLength(1);
    expect(checkHealth(db).status).toBe("ok");
  });

  test("[MON-003] úloha plánovače kontroluje nejvýš jednou za hodinu", () => {
    const at = new Date("2026-11-03T08:00:00Z");
    db.update(schedulerState)
      .set({ lastBackupTryAt: new Date("2026-11-03T01:30:00Z") })
      .run();
    const backups = () => reportedKeys().filter((key) => key === "ops.backup").length;

    opsCheckTask.run(at);
    expect(backups()).toBe(1);
    reportedToday.clear();
    opsCheckTask.run(new Date(at.getTime() + 30 * MINUTE));
    expect(backups()).toBe(1);
    opsCheckTask.run(new Date(at.getTime() + 61 * MINUTE));
    expect(backups()).toBe(2);
  });
});

describe("stav instance", () => {
  test("[ADM-008] stav instance ukáže velikost souborů, volné místo, poslední lístek a frontu", () => {
    const now = new Date("2026-11-03T10:00:00Z");
    setClockForTests({ now: () => now });
    const files = join(dataDir, "files", "u1", "ab");
    mkdirSync(files, { recursive: true });
    writeFileSync(join(files, "a.pdf"), Buffer.alloc(3000));
    writeFileSync(join(dataDir, "files", "u1", "b.pdf"), Buffer.alloc(1000));
    seedRate("2026-10-30");
    seedRate("2026-11-02");
    const since = new Date(now.getTime() - 5 * MINUTE);
    heavyJob("run-1", "running", since, OWNER_ID);
    heavyJob("wait-1", "pending", now, OWNER_ID);
    heavyJob("wait-2", "pending", now, null);

    expect(getInstanceStatus(ADMIN).filesBytes).toBeNull();
    measureFiles(now);
    const status = getInstanceStatus(ADMIN);

    expect(status.filesBytes).toBe(4000);
    expect(status.freeBytes).toBeGreaterThan(0);
    expect(status.fxLastDate).toBe("2026-11-02");
    expect(status.heavyQueued).toBe(2);
    expect(status.heavyRunningSince).toEqual(since);
  });

  test("[ADM-008] velikost souborů se přepočítá nejvýš jednou za hodinu", () => {
    const now = new Date("2026-11-03T10:00:00Z");
    const dir = join(dataDir, "files", "u2");
    mkdirSync(dir, { recursive: true });
    const before = measureFiles(now);
    writeFileSync(join(dir, "c.pdf"), Buffer.alloc(500));

    expect(measureFiles(new Date(now.getTime() + 59 * MINUTE))).toBe(before);
    expect(measureFiles(new Date(now.getTime() + 61 * MINUTE))).toBe(before + 500);
  });
});
