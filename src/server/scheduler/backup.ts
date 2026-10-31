import "server-only";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { calendarDateInPrague, isDailyDue, type CalendarDate } from "@/lib/number-format";
import { db } from "../db";
import { schedulerState } from "../db/schema";
import { env } from "../env";
import { mutate } from "../services/mutation";
import { reportFailure } from "./report";
import type { TickTask } from "./tick";

export const BACKUP_KEEP = 14;

const SPACE_FACTOR = 2;
const STALE_TMP_MS = 60 * 60_000;
const BACKUP_AT = "02:30";
const RETRY_AFTER_MS = 60 * 60_000;
const NAME = /^fakturan-(\d{4}-\d{2}-\d{2})\.db$/;
const SCHEDULER = { userId: null, source: "scheduler" } as const;

function backupDir(): string {
  return join(env.DATA_DIR, "backups");
}

function fileFor(date: CalendarDate): string {
  return join(backupDir(), `fakturan-${date}.db`);
}

export function listBackups(): { name: string; at: CalendarDate; bytes: number }[] {
  const dir = backupDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .flatMap((name) => {
      const match = NAME.exec(name);
      return match
        ? [{ name, at: match[1] as CalendarDate, bytes: statSync(join(dir, name)).size }]
        : [];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function pruneBackups(keep: number): void {
  const all = listBackups();
  for (const old of all.slice(0, Math.max(0, all.length - keep))) {
    rmSync(join(backupDir(), old.name), { force: true });
  }
}

function assertIntact(path: string): void {
  const copy = new Database(path, { readonly: true });
  try {
    const result = copy.pragma("integrity_check", { simple: true });
    if (result !== "ok") throw new Error("Kontrola integrity zálohy selhala");
  } finally {
    copy.close();
  }
}

function assertFreeSpace(dir: string): void {
  const pages = db.$client.pragma("page_count", { simple: true }) as number;
  const pageSize = db.$client.pragma("page_size", { simple: true }) as number;
  const { bsize, bavail } = statfsSync(dir);
  if (bsize * bavail < pages * pageSize * SPACE_FACTOR) {
    throw new Error("Na svazku není dost místa pro zálohu");
  }
}

function removeStaleTemps(dir: string, now: Date): void {
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".tmp")) continue;
    const file = join(dir, name);
    // Another process may finish with its .tmp between the listing and this stat.
    const stat = statSync(file, { throwIfNoEntry: false });
    // A fresh .tmp may belong to another process still writing it.
    if (stat && now.getTime() - stat.mtimeMs > STALE_TMP_MS) rmSync(file, { force: true });
  }
}

export function createBackup(now: Date): { path: string; bytes: number } {
  const dir = backupDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  removeStaleTemps(dir, now);
  assertFreeSpace(dir);
  const path = fileFor(calendarDateInPrague(now));
  const tmp = `${path}.${process.pid}-${randomUUID()}.tmp`;
  try {
    // VACUUM INTO refuses to run in a transaction and to overwrite a file, hence the fresh .tmp.
    db.$client.prepare("VACUUM INTO ?").run(tmp);
    chmodSync(tmp, 0o600);
    assertIntact(tmp);
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  return { path, bytes: statSync(path).size };
}

function backupState() {
  return db.select().from(schedulerState).where(eq(schedulerState.id, 1)).get();
}

function wasTriedRecently(now: Date): boolean {
  const tried = backupState()?.lastBackupTryAt;
  return Boolean(tried && now.getTime() - tried.getTime() < RETRY_AFTER_MS);
}

function recordAttempt(now: Date): void {
  db.update(schedulerState).set({ lastBackupTryAt: now }).where(eq(schedulerState.id, 1)).run();
}

function recordSuccess(now: Date, today: CalendarDate): void {
  mutate(SCHEDULER, "backup.create", (tx, audit) => {
    tx.update(schedulerState).set({ lastBackupAt: now }).where(eq(schedulerState.id, 1)).run();
    audit({ entity: "backup", entityId: today, ownerId: null, scope: "instance" });
  });
}

function recordedToday(today: CalendarDate): boolean {
  const last = backupState()?.lastBackupAt;
  return Boolean(last && calendarDateInPrague(last) === today);
}

export const backupTask: TickTask = {
  name: "backup",
  run(now) {
    const today = calendarDateInPrague(now);
    if (!isDailyDue(now, BACKUP_AT)) return;
    if (existsSync(fileFor(today))) {
      // The file is the day key, but a state write that failed after it must still be made up.
      pruneBackups(BACKUP_KEEP);
      if (!recordedToday(today)) recordSuccess(now, today);
      return;
    }
    if (wasTriedRecently(now)) return;
    recordAttempt(now);
    try {
      createBackup(now);
    } catch (error) {
      reportFailure(error, { task: "backup" });
      mutate(SCHEDULER, "backup.failed", (_tx, audit) => {
        audit({ entity: "backup", entityId: today, ownerId: null, scope: "instance" });
      });
      return;
    }
    pruneBackups(BACKUP_KEEP);
    recordSuccess(now, today);
  },
};
