import "server-only";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { calendarDateInPrague, isDailyDue, type CalendarDate } from "@/lib/number-format";
import { clock } from "../clock";
import { db } from "../db";
import { schedulerState } from "../db/schema";
import { env } from "../env";
import { mutate } from "../services/mutation";
import { reportFailure } from "./report";
import type { TickTask } from "./tick";

export const BACKUP_KEEP = 14;

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

export function createBackup(now: Date): { path: string; bytes: number } {
  const dir = backupDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(dir)) {
    if (name.endsWith(".tmp")) rmSync(join(dir, name), { force: true });
  }
  const path = fileFor(calendarDateInPrague(now));
  const tmp = `${path}.tmp`;
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

function wasTriedRecently(now: Date): boolean {
  const state = db.select().from(schedulerState).where(eq(schedulerState.id, 1)).get();
  const tried = state?.lastBackupTryAt;
  return Boolean(tried && now.getTime() - tried.getTime() < RETRY_AFTER_MS);
}

function recordAttempt(now: Date): void {
  db.update(schedulerState).set({ lastBackupTryAt: now }).where(eq(schedulerState.id, 1)).run();
}

export const backupTask: TickTask = {
  name: "backup",
  run(now) {
    const today = calendarDateInPrague(now);
    if (!isDailyDue(now, BACKUP_AT) || existsSync(fileFor(today)) || wasTriedRecently(now)) return;
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
    mutate(SCHEDULER, "backup.create", (tx, audit) => {
      tx.update(schedulerState)
        .set({ lastBackupAt: clock.now() })
        .where(eq(schedulerState.id, 1))
        .run();
      audit({ entity: "backup", entityId: today, ownerId: null, scope: "instance" });
    });
    pruneBackups(BACKUP_KEEP);
  },
};
