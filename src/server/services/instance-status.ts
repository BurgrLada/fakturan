import "server-only";
import { statSync } from "node:fs";
import type { Actor } from "../audit/context";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { schedulerState } from "../db/schema";
import { env } from "../env";
import { isInstanceMailConfigured } from "../mail/instance";
import { schedulerHealth } from "../scheduler/start";
import pkg from "../../../package.json";
import { assertAdmin } from "./access";

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

// Booleans only: the admin sees whether SMTP and monitoring are set up, never their values (ADM-008).
export function getInstanceStatus(actor: Actor) {
  assertAdmin(db, actor);
  const path = env.DATABASE_PATH;
  const state = db.select().from(schedulerState).where(eq(schedulerState.id, 1)).get();
  return {
    version: pkg.version,
    databaseBytes: fileSize(path) + fileSize(`${path}-wal`),
    scheduler: schedulerHealth(db),
    lastBackupAt: state?.lastBackupAt ?? null,
    lastBackupFailedAt:
      state?.lastBackupTryAt && (!state.lastBackupAt || state.lastBackupTryAt > state.lastBackupAt)
        ? state.lastBackupTryAt
        : null,
    smtpConfigured: isInstanceMailConfigured(env),
    monitoringConfigured: Boolean(env.SENTRY_DSN),
  };
}
