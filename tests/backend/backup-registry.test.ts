import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getTableColumns, getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { describe, expect, test } from "vitest";
import { BACKUP_UPGRADES, BACKUP_VERSION, isColumnRule } from "@/lib/backup-format";
import * as schema from "@/server/db/schema";
import {
  BACKUP_SKIPPED_TABLES,
  BACKUP_TABLES,
  backupColumnsFingerprint,
  type BackupTable,
} from "@/server/backup/tables";
import { USER_OWNED_TABLES } from "@/server/services/users";
import { jsonColumnsWithoutShape, textColumnsWithoutLimit } from "@/server/backup/restore-read";
import { ACCOUNT_ROW_LIMITS } from "@/lib/account-limits";
import { GENERATED_TEXT, TEXT_LIMITS } from "@/lib/text-limits";
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

  test("[EXP-006] otisk sloupců v2 sedí s registrem a změna bez nové verze spadne", () => {
    expect(BACKUP_VERSION).toBe(2);
    const current = backupColumnsFingerprint();
    expect(current).toEqual(fixture(2));
    // Version 1 is kept for the upgrade path: it lacks only the columns that step 1 fills and the
    // tables added after it, which an older archive simply does not contain.
    const added = { automation_settings: ["limit_mail", "period_summary", "tax_reminder"] };
    const v1 = structuredClone(current);
    for (const [table, columns] of Object.entries(added)) {
      for (const column of columns) delete v1.tables[table]![column];
    }
    delete v1.tables.limit_mail_sent;
    expect(fixture(1)).toEqual({ ...v1, v: 1 });
    const row = { id: "a", name: "b" };
    expect(BACKUP_UPGRADES[1]!("customer", row)).toEqual(row);
    expect(
      BACKUP_UPGRADES[1]!("automation_settings", { user_id: "u", daily_digest: true }),
    ).toEqual({
      user_id: "u",
      daily_digest: true,
      period_summary: "off",
      tax_reminder: false,
      limit_mail: false,
    });
    const changed = BACKUP_TABLES.map((entry) =>
      entry.name === "customer"
        ? { ...entry, columns: { ...entry.columns, note: "omit" as const } }
        : entry,
    );
    expect(backupColumnsFingerprint(changed)).not.toEqual(fixture(2));
  });

  test("[SEC-005] každý JSON sloupec zálohované tabulky má strict tvar", () => {
    // A JSON column without a shape would let any object of the archive into the account.
    expect(jsonColumnsWithoutShape()).toEqual([]);
  });

  test("[SEC-005] každý textový sloupec zálohované tabulky má strop délky", () => {
    // A text column without a limit would let a restore put any amount of text where pages read it.
    expect(textColumnsWithoutLimit()).toEqual([]);
  });

  test("[SEC-005] sloupce, které skládá aplikace, mají strop a nejsou mezi texty od lidí", () => {
    expect([...GENERATED_TEXT].filter((name) => !Object.hasOwn(TEXT_LIMITS, name))).toEqual([]);
    for (const own of ["customer.name", "invoice.note", "invoice_line.description"]) {
      expect(GENERATED_TEXT.has(own)).toBe(false);
    }
  });

  test("[SEC-005] konfigurační tabulky mají strop řádků na účet", () => {
    expect(ACCOUNT_ROW_LIMITS).toEqual({
      reminder_rule: 20,
      invoice_template: 2_000,
      recurring_invoice: 2_000,
      dashboard: 50,
      dashboard_widget: 2_500,
      mapping_preset: 200,
      unit: 500,
      number_series: 200,
      bank_account: 100,
      tag: 2_000,
      email_template: 100,
    });
    for (const name of Object.keys(ACCOUNT_ROW_LIMITS)) expect(registered).toContain(name);
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
