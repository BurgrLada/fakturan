import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getTableColumns, getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { describe, expect, test } from "vitest";
import { BACKUP_VERSION, isColumnRule } from "@/lib/backup-format";
import * as schema from "@/server/db/schema";
import {
  BACKUP_SKIPPED_TABLES,
  BACKUP_TABLES,
  backupColumnsFingerprint,
  type BackupTable,
} from "@/server/backup/tables";
import { USER_OWNED_TABLES } from "@/server/services/users";
import { findUnregisteredOwnedTables } from "../helpers/audit-guard";

const registered = BACKUP_TABLES.map((entry) => entry.name);
const skipped = Object.keys(BACKUP_SKIPPED_TABLES);
const fixture = (v: number) =>
  JSON.parse(readFileSync(join("tests", "fixtures", "backup", `columns-v${v}.json`), "utf8"));

function columnNames(entry: BackupTable): string[] {
  return Object.values(getTableColumns(entry.table)).map((column) => column.name);
}

describe("registr zálohy", () => {
  test("[EXP-006] každý sloupec každé vlastněné tabulky je zařazený v registru", () => {
    const owned = USER_OWNED_TABLES.map((table) => getTableName(table)).sort();
    expect([...registered, ...skipped].sort()).toEqual(owned);
    expect(registered.filter((name) => skipped.includes(name))).toEqual([]);
    expect(new Set(registered).size).toBe(registered.length);

    for (const entry of BACKUP_TABLES) {
      expect(getTableName(entry.table), entry.name).toBe(entry.name);
      expect(Object.keys(entry.columns).sort(), entry.name).toEqual(columnNames(entry).sort());
      for (const [column, rule] of Object.entries(entry.columns)) {
        expect(isColumnRule(rule), `${entry.name}.${column}`).toBe(true);
        if (rule.startsWith("ref:")) expect(registered).toContain(rule.slice(4));
      }
      // A foreign key says where a value points: to the account, into the archive, or nowhere.
      for (const key of getTableConfig(entry.table).foreignKeys) {
        const reference = key.reference();
        const target = getTableName(reference.foreignTable);
        for (const column of reference.columns) {
          const rule = entry.columns[column.name];
          const expected =
            target === "user" ? "owner" : skipped.includes(target) ? "omit" : `ref:${target}`;
          expect(rule, `${entry.name}.${column.name}`).toBe(expected);
        }
      }
    }
  });

  test("[EXP-006] jen auditní tabulky mají vlastníka mimo registr a audit jde zvlášť", () => {
    const tables = [...BACKUP_TABLES.map((entry) => entry.table), ...USER_OWNED_TABLES];
    expect(
      findUnregisteredOwnedTables(schema, tables, ["audit_log", "audit_purge", "invitation"]),
    ).toEqual([]);
    expect(registered).not.toContain("audit_log");
  });

  test("[EXP-009] tajemství, relace a instance do zálohy nejdou", () => {
    expect(skipped).toEqual(
      expect.arrayContaining(["session", "account", "job", "export_job", "bank_mailbox"]),
    );
    for (const name of ["exchange_rate", "rate_limit", "user", "verification", "invitation"]) {
      expect(registered).not.toContain(name);
    }
    const mail = BACKUP_TABLES.find((entry) => entry.name === "mail_settings")!;
    expect(mail.columns.smtp_password_enc).toBe("omit");
    for (const entry of BACKUP_TABLES) {
      for (const [column, rule] of Object.entries(entry.columns)) {
        if (/_enc$|password|token|secret|totp/.test(column)) {
          expect(rule, `${entry.name}.${column}`).toBe("omit");
        }
      }
    }
  });

  test("[EXP-006] zařazení sloupců, na kterých závisí obnova", () => {
    const rules = backupColumnsFingerprint().tables;
    expect(rules.invoice).toMatchObject({
      foreign: "copy",
      clause: "copy",
      credits_minor: "copy",
      advance_minor: "copy",
      superseded_at: "copy",
      related_snapshot: "copy",
      exchange_rate_micros: "copy",
      exchange_rate_source: "copy",
      exchange_rate_date: "copy",
      external: "copy",
      import_uuid: "copy",
      import_payment_code: "copy",
      import_batch_id: "ref:import_batch",
      import_pdf_file_id: "ref:file",
      related_invoice_id: "ref:invoice",
    });
    expect(rules.payment).toMatchObject({
      rate_micros: "copy",
      source: "copy",
      date_estimated: "copy",
    });
    expect(rules.supplier).toMatchObject({
      advance_note_cs: "copy",
      reverse_charge_cs: "copy",
      logo_file_id: "ref:file",
    });
    expect(rules.preferences).toMatchObject({
      fixed_rates: "copy",
      turnover_vat_limit_minor: "copy",
      turnover_flat_limit_minor: "copy",
      turnover_basis: "copy",
      turnover_vat_watch: "copy",
      turnover_flat_watch: "copy",
    });
    expect(rules.bank_notification).toMatchObject({ dedupe_key: "copy" });
    expect(rules.email_log).toMatchObject({ file_id: "ref:file", isdoc_file_id: "ref:file" });
    expect(rules.invoice_version).toMatchObject({ document: "json-ids" });
    expect(rules.dashboard_widget).toMatchObject({ config: "json-ids" });
    expect(rules.notification).toMatchObject({ params: "json-ids", dedupe_key: "json-ids" });
    expect(Object.keys(rules)).toEqual(
      expect.arrayContaining(["dashboard", "mapping_preset", "import_batch", "file"]),
    );
  });

  test("[EXP-006] změna sloupců bez nové verze spadne na otisku", () => {
    const current = backupColumnsFingerprint();
    expect(current.v).toBe(BACKUP_VERSION);
    expect(current).toEqual(fixture(BACKUP_VERSION));

    const changed = BACKUP_TABLES.map((entry) =>
      entry.name === "invoice"
        ? { ...entry, columns: { ...entry.columns, clause: "omit" as const } }
        : entry,
    );
    expect(backupColumnsFingerprint(changed)).not.toEqual(fixture(BACKUP_VERSION));
    const fewer = BACKUP_TABLES.filter((entry) => entry.name !== "mapping_preset");
    expect(backupColumnsFingerprint(fewer)).not.toEqual(fixture(BACKUP_VERSION));
  });

  test("[EXP-006] pořadí tabulek drží rodiče před dětmi", () => {
    for (const [index, entry] of BACKUP_TABLES.entries()) {
      for (const [column, rule] of Object.entries(entry.columns)) {
        if (!rule.startsWith("ref:")) continue;
        const target = rule.slice(4);
        // A correction points at its original in the same table; the restore orders those rows.
        if (target === entry.name) continue;
        expect(registered.indexOf(target), `${entry.name}.${column}`).toBeLessThan(index);
      }
    }
  });
});
