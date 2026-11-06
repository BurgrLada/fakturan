import { z } from "zod";
import type { CalendarDate } from "./number-format";

export const BACKUP_FORMAT = "fakturan.account-backup";
// Raised together with a new tests/fixtures/backup/columns-v<n>.json and a BACKUP_UPGRADES step.
export const BACKUP_VERSION = 1;

export const MANIFEST_ENTRY = "manifest.json";
export const AUDIT_ENTRY = "audit.jsonl";

export function dataEntry(table: string): string {
  return `data/${table}.jsonl`;
}

export function fileEntry(id: string): string {
  return `files/${id}`;
}

export function backupFileName(day: CalendarDate): string {
  return `fakturan-zaloha-${day}.zip`;
}

// id gets a new UUID on restore, owner is taken from the session, ref:<table> points at an id of
// that table in the same archive, json-ids is text or JSON in which known ids are replaced, and
// omit never leaves the database (R-31, R-33).
export type ColumnRule = "id" | "owner" | "copy" | "json-ids" | "omit" | `ref:${string}`;

const PLAIN_RULES = new Set(["id", "owner", "copy", "json-ids", "omit"]);
const TABLE_NAME = /^[a-z][a-z_]{0,63}$/;

export function isColumnRule(value: string): value is ColumnRule {
  if (PLAIN_RULES.has(value)) return true;
  return value.startsWith("ref:") && TABLE_NAME.test(value.slice(4));
}

const ENTRY_NAME = /^(?:data\/[a-z][a-z_]{0,63}\.jsonl|files\/[A-Za-z0-9_-]{1,128}|audit\.jsonl)$/;
const MAX_ENTRIES = 1_000_000;
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

// The archive is foreign input even when Fakturan wrote it: the manifest is not a signature (R-30).
export const backupManifestSchema = z
  .strictObject({
    format: z.literal(BACKUP_FORMAT),
    v: z.number().int().min(1),
    app: z.string().min(1).max(64),
    migration: z.string().min(1).max(128),
    createdAt: z.iso.datetime(),
    counts: z.strictObject({
      tables: z.record(z.string().regex(TABLE_NAME), count),
      files: count,
      audit: count,
    }),
    entries: z.record(
      z.string().regex(ENTRY_NAME),
      z.strictObject({ sha256: z.string().regex(/^[0-9a-f]{64}$/), size: count }),
    ),
  })
  .refine((manifest) => Object.keys(manifest.entries).length <= MAX_ENTRIES);

export type BackupManifest = z.output<typeof backupManifestSchema>;
