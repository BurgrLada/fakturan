import "server-only";
import { statfsSync } from "node:fs";
import { and, asc, count, eq, inArray, sql, sum } from "drizzle-orm";
import { isWorkingDay } from "@/lib/czech-holidays";
import { expectedListDate } from "@/lib/fx";
import { addDays } from "@/lib/invoice";
import { calendarDateInPrague, type CalendarDate } from "@/lib/number-format";
import { db } from "../db";
import { exchangeRate, file, HEAVY_JOB_KINDS, job, schedulerState } from "../db/schema";
import { env } from "../env";
import { reportFailure } from "./report";
import type { TickTask } from "./tick";

export type OpsFinding = {
  key: "disk" | "fx" | "heavy" | "backup";
  detail: Record<string, number | string>;
};

type StatfsProbe = { statfs(path: string): { bavail: bigint; blocks: bigint; bsize: bigint } };

const HOUR_MS = 3_600_000;
const MIN_FREE_BYTES = 2 * 1024 ** 3;
const MIN_FREE_SHARE = 0.1;
const STALE_LISTS = 3;
const HEAVY_LIMIT_MS = 30 * 60_000;

const systemProbe: StatfsProbe = { statfs: (path) => statfsSync(path, { bigint: true }) };

// Process memory only: after a restart one report per condition may come again the same day.
export const reportedToday = new Map<OpsFinding["key"], CalendarDate>();

class OpsAlert extends Error {
  override name = "OpsAlert";
}

type FilesSize = { bytes: number; at: number };
// Instrumentation and the pages are separate module graphs in one process.
const shared = globalThis as typeof globalThis & { __fakturanFilesSize?: FilesSize };

export function volumeSpace(
  probe: StatfsProbe = systemProbe,
): { freeBytes: number; totalBytes: number } | null {
  const stat = probe.statfs(env.DATA_DIR);
  const bsize = BigInt(stat.bsize);
  const totalBytes = Number(BigInt(stat.blocks) * bsize);
  if (totalBytes <= 0) return null;
  return { freeBytes: Number(BigInt(stat.bavail) * bsize), totalBytes };
}

export function newestListDate(): CalendarDate | null {
  return (
    db
      .select({ listDate: sql<CalendarDate | null>`max(${exchangeRate.listDate})` })
      .from(exchangeRate)
      .where(eq(exchangeRate.currency, "EUR"))
      .get()?.listDate ?? null
  );
}

function oldestRunningHeavy(): { kind: string; since: Date } | undefined {
  return db
    .select({ kind: job.kind, since: job.updatedAt })
    .from(job)
    .where(and(inArray(job.kind, [...HEAVY_JOB_KINDS]), eq(job.status, "running")))
    .orderBy(asc(job.updatedAt))
    .limit(1)
    .get();
}

export function heavyQueue(): { queued: number; runningSince: Date | null } {
  const queued =
    db
      .select({ n: count() })
      .from(job)
      .where(and(inArray(job.kind, [...HEAVY_JOB_KINDS]), eq(job.status, "pending")))
      .get()?.n ?? 0;
  return { queued, runningSince: oldestRunningHeavy()?.since ?? null };
}

// Summed from the file rows, not by walking files/: a walk of a large volume would block the shared
// process for every request. Blobs without a row (temp folders, orphans) are not counted.
export function measureFiles(now: Date): number {
  const cached = shared.__fakturanFilesSize;
  if (cached && now.getTime() - cached.at < HOUR_MS) return cached.bytes;
  const bytes = Number(
    db
      .select({ bytes: sum(file.size) })
      .from(file)
      .get()?.bytes ?? 0,
  );
  shared.__fakturanFilesSize = { bytes, at: now.getTime() };
  return bytes;
}

export function cachedFilesBytes(): number | null {
  return shared.__fakturanFilesSize?.bytes ?? null;
}

function diskFinding(probe: StatfsProbe): OpsFinding | null {
  let space;
  try {
    space = volumeSpace(probe);
  } catch {
    return null;
  }
  if (!space) return null;
  const low =
    space.freeBytes < MIN_FREE_BYTES || space.freeBytes < space.totalBytes * MIN_FREE_SHARE;
  return low ? { key: "disk", detail: { ...space } } : null;
}

function fxFinding(now: Date): OpsFinding | null {
  const lastDate = newestListDate();
  if (!lastDate) return null;
  const expected = expectedListDate(calendarDateInPrague(now), now);
  let missedLists = 0;
  for (let day = addDays(lastDate, 1); day <= expected && missedLists < 99; day = addDays(day, 1)) {
    if (isWorkingDay(day)) missedLists += 1;
  }
  return missedLists >= STALE_LISTS ? { key: "fx", detail: { lastDate, missedLists } } : null;
}

function heavyFinding(now: Date): OpsFinding | null {
  const running = oldestRunningHeavy();
  if (!running) return null;
  const elapsed = now.getTime() - running.since.getTime();
  if (elapsed <= HEAVY_LIMIT_MS) return null;
  return { key: "heavy", detail: { kind: running.kind, minutes: Math.floor(elapsed / 60_000) } };
}

function backupFinding(now: Date): OpsFinding | null {
  const state = db.select().from(schedulerState).where(eq(schedulerState.id, 1)).get();
  const tried = state?.lastBackupTryAt;
  const done = state?.lastBackupAt;
  if (!tried || (done && done >= tried)) return null;
  const hoursSinceSuccess = done ? Math.floor((now.getTime() - done.getTime()) / HOUR_MS) : "never";
  return { key: "backup", detail: { hoursSinceSuccess } };
}

function describe(finding: OpsFinding): string {
  const parts = Object.entries(finding.detail).map(([name, value]) => `${name}=${value}`);
  return `Provozní kontrola: ${finding.key} ${parts.join(" ")}`;
}

// Findings carry only a key and non-personal values, never paths, account IDs or content (MON-004).
export function opsCheck(now: Date, probe: StatfsProbe = systemProbe): OpsFinding[] {
  const today = calendarDateInPrague(now);
  const findings = [
    diskFinding(probe),
    fxFinding(now),
    heavyFinding(now),
    backupFinding(now),
  ].filter((finding) => finding !== null);
  for (const finding of findings) {
    if (reportedToday.get(finding.key) === today) continue;
    reportedToday.set(finding.key, today);
    reportFailure(new OpsAlert(describe(finding)), { task: `ops.${finding.key}` });
  }
  return findings;
}

let checkedAt = Number.NEGATIVE_INFINITY;

export const opsCheckTask: TickTask = {
  name: "ops-check",
  run(now) {
    if (now.getTime() - checkedAt < HOUR_MS) return;
    checkedAt = now.getTime();
    try {
      opsCheck(now);
    } finally {
      measureFiles(now);
    }
  },
};

export function resetOpsForTests(): void {
  reportedToday.clear();
  shared.__fakturanFilesSize = undefined;
  checkedAt = Number.NEGATIVE_INFINITY;
}
