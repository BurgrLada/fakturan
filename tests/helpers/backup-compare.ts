import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import {
  AUDIT_ENTRY,
  FILES_INDEX_ENTRY,
  MANIFEST_ENTRY,
  type BackupManifest,
} from "@/lib/backup-format";
import v1Columns from "../fixtures/backup/columns-v1.json";
import { BACKUP_TABLES } from "@/server/backup/tables";
import type { Db } from "@/server/db";
import { exportJob } from "@/server/db/schema";
import { blobPath, writeBlob } from "@/server/files/store";
import { drainHeavy } from "@/server/jobs/worker";
import { createBackup } from "@/server/services/account-backup";
import { startRestore } from "@/server/services/account-restore";
import { AUTOMATIONS } from "@/lib/automation";
import { encryptSecret } from "@/server/crypto";
import { emailLog, file, mailSettings, supplier } from "@/server/db/schema";
import { setAutomation, setPeriodSummary } from "@/server/services/automation";
import { createCreditNote } from "@/server/services/credit-notes";
import { ensureDashboards } from "@/server/services/dashboards";
import { archiveSentPdf } from "@/server/services/files";
import { saveTemplate } from "@/server/services/invoice-templates";
import { getInvoice, newDraftDefaults } from "@/server/services/invoices";
import { addPayment } from "@/server/services/payments";
import { savePreferences } from "@/server/services/preferences";
import { saveReminderRule } from "@/server/services/reminders";
import { seedMailbox } from "./fixtures-bank";
import { issuedInvoice, seedCustomer } from "./fixtures-mail";
import { savePlan } from "./fixtures-recurring";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const actor = (userId: string) => ({ userId, source: "web" as const });

export async function backupArchive(db: Db, owner: string): Promise<Uint8Array> {
  const { id } = createBackup(actor(owner));
  await drainHeavy("w");
  const row = db.select().from(exportJob).where(eq(exportJob.id, id)).get()!;
  if (row.status !== "done") throw new Error(`Záloha skončila ${row.status}: ${row.reason}`);
  return new Uint8Array(readFileSync(blobPath(owner, id)));
}

export async function restoreArchive(db: Db, owner: string, bytes: Uint8Array) {
  const uploadId = randomUUID();
  writeBlob(owner, uploadId, Buffer.from(bytes));
  const { id } = startRestore(actor(owner), uploadId);
  await drainHeavy("w");
  return db.select().from(exportJob).where(eq(exportJob.id, id)).get()!;
}

const FILE_ENTRY = /^files\/[A-Za-z0-9_-]{1,128}$/;

// Rewrites an archive the way a hostile editor would, then signs it again so only the check under
// test can stop it: a well-named files/<id> goes into files.jsonl, every other entry into the
// manifest. `manifest` edits the manifest after the hashes are recomputed.
export function editArchive(
  bytes: Uint8Array,
  edit: (entries: Record<string, Uint8Array>) => void,
  manifest: (value: BackupManifest) => void = () => {},
  { rehash = true }: { rehash?: boolean } = {},
): Uint8Array {
  const entries = unzipSync(bytes);
  const parsed = JSON.parse(strFromU8(entries[MANIFEST_ENTRY]!)) as BackupManifest;
  delete entries[MANIFEST_ENTRY];
  edit(entries);
  if (rehash) {
    const names = Object.keys(entries).filter((name) => name !== FILES_INDEX_ENTRY);
    const files = names.filter((name) => FILE_ENTRY.test(name));
    if (FILES_INDEX_ENTRY in entries) {
      entries[FILES_INDEX_ENTRY] = new Uint8Array(
        jsonl(
          files.map((name) => ({
            id: name.slice("files/".length),
            size: entries[name]!.length,
            sha256: sha256(entries[name]!),
          })),
        ),
      );
    }
    parsed.entries = Object.fromEntries(
      Object.keys(entries)
        .filter((name) => !files.includes(name))
        .map((name) => [name, { sha256: sha256(entries[name]!), size: entries[name]!.length }]),
    );
  }
  manifest(parsed);
  return zipSync({ [MANIFEST_ENTRY]: strToU8(JSON.stringify(parsed)), ...entries });
}

// What version 1 wrote: no file index, every blob named in the manifest, files before the audit.
// Columns added after version 1 were never written by it.
function withoutV2Columns(table: string, bytes: Uint8Array): Uint8Array {
  const known = (v1Columns.tables as Record<string, Record<string, string>>)[table];
  if (!known) return bytes;
  const rows = readJsonl(bytes);
  for (const row of rows) {
    for (const column of Object.keys(row)) if (!Object.hasOwn(known, column)) delete row[column];
  }
  return jsonl(rows);
}

export function asVersion1(bytes: Uint8Array): Uint8Array {
  const entries = unzipSync(bytes);
  const manifest = JSON.parse(strFromU8(entries[MANIFEST_ENTRY]!)) as BackupManifest;
  const index = readJsonl(entries[FILES_INDEX_ENTRY]!);
  delete entries[FILES_INDEX_ENTRY];
  delete manifest.entries[FILES_INDEX_ENTRY];
  for (const line of index) {
    manifest.entries[`files/${line.id as string}`] = {
      size: line.size as number,
      sha256: line.sha256 as string,
    };
  }
  manifest.v = 1;
  manifest.columns = sha256(strToU8(JSON.stringify(v1Columns)));
  const names = Object.keys(entries);
  const data: Record<string, Uint8Array> = {};
  for (const name of names.filter((key) => key.startsWith("data/"))) {
    data[name] = withoutV2Columns(name.slice("data/".length, -".jsonl".length), entries[name]!);
    manifest.entries[name] = { size: data[name].length, sha256: sha256(data[name]) };
  }
  const ordered: Record<string, Uint8Array> = {
    [MANIFEST_ENTRY]: strToU8(JSON.stringify(manifest)),
    ...data,
  };
  for (const name of names.filter((key) => key.startsWith("files/")))
    ordered[name] = entries[name]!;
  ordered[AUDIT_ENTRY] = entries[AUDIT_ENTRY]!;
  return zipSync(ordered);
}

export function jsonl(rows: Record<string, unknown>[]): Uint8Array {
  return strToU8(rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
}

export function readJsonl(bytes: Uint8Array): Record<string, unknown>[] {
  return strFromU8(bytes)
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

type Canonical = Record<string, unknown[]>;

// Rows the restore adds on purpose; everything else must come back as it was.
const ADDED_BY_RESTORE = new Set(["audit_archive", "backup_restored"]);

// The account with ids replaced by stable labels, owners left out and each blob by its SHA-256,
// so a source and its restored copy compare equal although no id is the same (R-36).
export function canonicalAccount(db: Db, ownerId: string): Canonical {
  const raw: Record<string, Record<string, unknown>[]> = {};
  for (const entry of BACKUP_TABLES) {
    const rows = db.all<Record<string, unknown>>(
      sql`SELECT * FROM ${sql.identifier(entry.name)} WHERE user_id = ${ownerId}`,
    );
    raw[entry.name] = rows.filter((row) => {
      if (entry.name === "file") {
        return !["export", "import_upload", "audit_archive"].includes(row.kind as string);
      }
      return !(entry.name === "notification" && ADDED_BY_RESTORE.has(row.kind as string));
    });
  }
  // Labels follow content, so they do not depend on the ids themselves.
  const labels = new Map<string, string>();
  const content = (table: string, row: Record<string, unknown>) => {
    const rules = BACKUP_TABLES.find((entry) => entry.name === table)!.columns;
    return JSON.stringify(
      Object.entries(row).filter(([column]) => {
        const rule = rules[column];
        return rule === "copy";
      }),
    );
  };
  for (const entry of BACKUP_TABLES) {
    const rows = raw[entry.name]!;
    if (!("id" in entry.columns)) continue;
    const sorted = [...rows].sort((a, b) =>
      content(entry.name, a) < content(entry.name, b) ? -1 : 1,
    );
    sorted.forEach((row, index) => labels.set(row.id as string, `${entry.name}#${index}`));
  }
  const relabel = (value: unknown): unknown =>
    typeof value === "string" ? value.replace(UUID, (id) => labels.get(id) ?? id) : value;
  const result: Canonical = {};
  for (const entry of BACKUP_TABLES) {
    const rows = raw[entry.name]!.map((row) => {
      const out: Record<string, unknown> = {};
      for (const [column, value] of Object.entries(row)) {
        const rule = entry.columns[column];
        if (rule === "owner" || rule === "omit" || rule === "id") continue;
        out[column] = relabel(value);
      }
      if (entry.name === "file") {
        out.sha256 = sha256(new Uint8Array(readFileSync(blobPath(ownerId, row.id as string))));
      }
      return out;
    });
    result[entry.name] = rows
      .map((row) => JSON.stringify(row))
      .sort()
      .map((row) => JSON.parse(row));
  }
  return result;
}

// An account using most of what a backup carries, built through the services so its sums hold.
export function seedRichAccount(db: Db, owner: string, now: Date) {
  const web = actor(owner);
  ensureDashboards(web);
  const customerId = seedCustomer(owner);
  const paid = issuedInvoice(owner, customerId);
  const paidRow = getInvoice(owner, paid)!;
  addPayment(web, paid, {
    revision: paidRow.revision,
    paidOn: paidRow.issueDate!,
    amountMinor: 100_000,
    currency: "CZK",
    method: "transfer",
    note: "",
  });
  const credited = issuedInvoice(owner, customerId);
  const creditNote = createCreditNote(web, credited);
  saveTemplate(web, {
    name: "Paušál",
    customerId,
    document: { ...newDraftDefaults(owner, customerId), type: "invoice", dueDays: 14, lines: [] },
  });
  for (const key of AUTOMATIONS.filter((item) => item.available).map((item) => item.key)) {
    setAutomation(web, key, true, { confirmed: true });
  }
  setPeriodSummary(web, "monthly");
  const planId = savePlan(owner, customerId, { mode: "send", confirmSend: true });
  saveReminderRule(web, { offsetDays: 7, texts: null });
  savePreferences(web, { advanceFinalMode: "issue" });
  const logoId = randomUUID();
  db.insert(file)
    .values({
      id: logoId,
      userId: owner,
      kind: "logo",
      mimeType: "image/png",
      name: "logo.png",
      size: 4,
      createdAt: now,
    })
    .run();
  writeBlob(owner, logoId, Buffer.from("LOGO"));
  db.update(supplier).set({ logoFileId: logoId }).where(eq(supplier.userId, owner)).run();
  const logId = randomUUID();
  db.insert(emailLog)
    .values({
      id: logId,
      userId: owner,
      invoiceId: paid,
      kind: "reminder",
      trigger: "manual",
      to: ["alfa@example.cz"],
      cc: [],
      bcc: [],
      subject: "Upomínka",
      body: "Dobrý den",
      status: "sent",
      invoiceRevision: 1,
      // Not an id: email_log.message_id is copied as it is (R-33).
      messageId: "<upominka-1@example.cz>",
      createdAt: now,
      updatedAt: now,
      sentAt: now,
    })
    .run();
  const sentPdfId = archiveSentPdf(web, logId, Buffer.from("%PDF-1.4 odeslano"), "U.pdf").id;
  db.insert(mailSettings)
    .values({
      userId: owner,
      smtpHost: "smtp.example.cz",
      smtpPort: 587,
      smtpUser: "jan",
      smtpPasswordEnc: encryptSecret("heslo-smtp-obnova"),
      fromEmail: "jan@example.cz",
      verifiedAt: now,
      updatedAt: now,
    })
    .run();
  seedMailbox(db, owner, 993, now);
  return {
    customerId,
    paid,
    credited,
    creditNote: creditNote.id,
    planId,
    logoId,
    logId,
    sentPdfId,
  };
}

// What a restore changes on purpose (R-34), applied to the source so the rest compares equal.
export function asRestored(account: Canonical): Canonical {
  const edit = (table: string, change: (row: Record<string, unknown>) => void) => {
    const rows = (account[table] ?? []) as Record<string, unknown>[];
    for (const row of rows) change(row);
    account[table] = rows
      .map((row) => JSON.stringify(row))
      .sort()
      .map((row) => JSON.parse(row));
  };
  edit("automation_settings", (row) => {
    for (const key of [
      "recurring_send",
      "reminders",
      "payment_receipt",
      "advance_invoice",
      "daily_digest",
      "paused",
    ]) {
      row[key] = 0;
    }
    row.reminders_open_since = null;
    row.period_summary = "off";
    row.tax_reminder = 0;
    row.limit_mail = 0;
  });
  edit("preferences", (row) => (row.advance_final_mode = "draft"));
  edit("recurring_invoice", (row) => {
    row.send_confirmed_at = null;
    if (row.status === "active") row.status = "paused";
  });
  edit("mail_settings", (row) => (row.verified_at = null));
  edit("email_log", (row) => {
    if (row.status === "queued" || row.status === "sending") row.status = "cancelled";
  });
  edit("import_batch", (row) => {
    if (!["done", "undone", "failed"].includes(row.status as string)) row.status = "failed";
  });
  return account;
}
