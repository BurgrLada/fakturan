import "server-only";
import { statSync } from "node:fs";
import type { Actor } from "../audit/context";
import { db } from "../db";
import { env } from "../env";
import { isInstanceMailConfigured } from "../mail/instance";
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
  return {
    version: pkg.version,
    databaseBytes: fileSize(path) + fileSize(`${path}-wal`),
    scheduler: "not_started" as const,
    lastBackupAt: null as Date | null,
    smtpConfigured: isInstanceMailConfigured(env),
    monitoringConfigured: Boolean(env.SENTRY_DSN),
  };
}
