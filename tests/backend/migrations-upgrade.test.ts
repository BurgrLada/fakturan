import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { registerSqlFunctions } from "@/lib/sql-functions";
import { textLimit } from "@/lib/text-limits";
import { setClockForTests } from "@/server/clock";
import { createDb, runMigrations, setDbForTests, type Db } from "@/server/db";
import { invoice, job, schedulerState, user } from "@/server/db/schema";
import { registerJob } from "@/server/jobs/registry";
import { recoverBackupJob, runBackup } from "@/server/services/account-backup";
import { recoverRestore, runRestore } from "@/server/services/account-restore";
import { addPayment } from "@/server/services/payments";
import { createCreditNote } from "@/server/services/credit-notes";
import { ensureDashboards } from "@/server/services/dashboards";
import { saveTemplate } from "@/server/services/invoice-templates";
import { getInvoice, newDraftDefaults } from "@/server/services/invoices";
import { saveReminderRule } from "@/server/services/reminders";
import pkg from "../../package.json";
import {
  asRestored,
  backupArchive,
  canonicalAccount,
  restoreArchive,
} from "../helpers/backup-compare";
import { assertConsistent } from "../helpers/consistency";
import { dumpDatabase } from "../helpers/db-dump";
import { issuedInvoice, seedCustomer, seedOwner, webActor } from "../helpers/fixtures-mail";
import { savePlan } from "../helpers/fixtures-recurring";

vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-upgrade-")));

const DRIZZLE = join(process.cwd(), "drizzle");
const FIXTURES = join("tests", "fixtures", "db");
const NOW = new Date("2026-03-20T10:00:00Z");
type Journal = { entries: { tag: string }[] } & Record<string, unknown>;
const journal = JSON.parse(readFileSync(join(DRIZZLE, "meta", "_journal.json"), "utf8")) as Journal;
const opened: Db[] = [];

beforeAll(() => {
  registerJob("backup.run", { run: runBackup, recover: recoverBackupJob });
  registerJob("restore.run", { run: runRestore, recover: recoverRestore });
});
afterEach(() => {
  setDbForTests(null);
  setClockForTests(null);
  for (const db of opened.splice(0)) db.$client.close();
  vi.restoreAllMocks();
});

function freshDb(): Db {
  const db = createDb(join(mkdtempSync(join(tmpdir(), "fakturan-upgrade-db-")), "app.db"));
  opened.push(db);
  return db;
}

// The first `count` migrations as a folder of their own, so a database can stop at that release.
function prefixFolder(count: number): string {
  const dir = mkdtempSync(join(tmpdir(), "fakturan-prefix-"));
  mkdirSync(join(dir, "meta"));
  const entries = journal.entries.slice(0, count);
  for (const entry of entries)
    cpSync(join(DRIZZLE, `${entry.tag}.sql`), join(dir, `${entry.tag}.sql`));
  writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify({ ...journal, entries }));
  return dir;
}

function tableColumns(db: Db, table: string): string[] {
  return (db.$client.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map(
    (row) => row.name,
  );
}

function assertSound(db: Db): void {
  expect(db.$client.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(db.$client.prepare("PRAGMA integrity_check").pluck().all()).toEqual(["ok"]);
}

const prefixes = Array.from({ length: journal.entries.length - 1 }, (_, index) => index + 1);
const chunks = [0, 1, 2, 3].map((part) => prefixes.filter((_, index) => index % 4 === part));

describe("upgrade databáze", () => {
  test.each(chunks.map((chunk, part) => [part + 1, chunk] as const))(
    "[TST-019] každý prefix migrací dojede na konec bez porušení klíčů (část %i)",
    (_part, chunk) => {
      for (const count of chunk) {
        const db = freshDb();
        migrate(db, { migrationsFolder: prefixFolder(count) });
        // Data of that release: an account, as every later migration has to carry it along.
        const userId = `u-${count}`;
        if (tableColumns(db, "user").length > 0) {
          db.$client
            .prepare(
              "INSERT INTO user (id, name, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            )
            .run(userId, "Uživatel", `${userId}@example.cz`, NOW.getTime(), NOW.getTime());
        }
        runMigrations(db);
        assertSound(db);
        expect(db.select().from(user).where(eq(user.id, userId)).all().length).toBeLessThanOrEqual(
          1,
        );
        assertConsistent(db, userId);
      }
    },
  );

  const releases = readdirSync(FIXTURES).filter((name) => name.endsWith(".sql"));

  function loadRelease(name: string): Db {
    const path = join(mkdtempSync(join(tmpdir(), "fakturan-release-")), "app.db");
    const raw = new Database(path);
    registerSqlFunctions(raw);
    raw.exec(readFileSync(join(FIXTURES, name), "utf8"));
    raw.close();
    const db = createDb(path);
    opened.push(db);
    runMigrations(db);
    return db;
  }

  test("[SEC-005] upgrade zkrátí vyhledávací text dokladu nad strop, aby šla záloha obnovit", () => {
    setClockForTests({ now: () => NOW });
    const at = journal.entries.findIndex((entry) => entry.tag === "0046_search_text_limit");
    expect(at).toBeGreaterThan(0);
    const db = freshDb();
    migrate(db, { migrationsFolder: prefixFolder(at) });
    setDbForTests(db);
    const owner = seedOwner(db, NOW);
    const id = issuedInvoice(owner, seedCustomer(owner));
    const limit = textLimit("invoice", "search_text")!;
    db.update(invoice)
      .set({ searchText: "x".repeat(limit + 5_000) })
      .where(eq(invoice.id, id))
      .run();
    runMigrations(db);
    const row = db
      .select({ searchText: invoice.searchText })
      .from(invoice)
      .where(eq(invoice.id, id))
      .get()!;
    expect(row.searchText).toBe("x".repeat(limit));
    assertConsistent(db, owner);
  });

  test("[TST-019] uložený stav verze 0.1.0 projde upgradem a soulad dat drží", () => {
    expect(releases).toContain("0.1.0.sql");
    for (const name of releases) {
      const db = loadRelease(name);
      assertSound(db);
      const users = db.select({ id: user.id }).from(user).all();
      expect(users.length, name).toBeGreaterThan(0);
      for (const { id } of users) assertConsistent(db, id);
    }
  });

  test("[TST-019] záloha a obnova dají shodná data", async () => {
    setClockForTests({ now: () => NOW });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const db = loadRelease("0.1.0.sql");
    setDbForTests(db);
    db.delete(job).run();
    db.delete(schedulerState).run();
    const [{ id: source }] = db.select({ id: user.id }).from(user).all() as [{ id: string }];
    const expected = asRestored(canonicalAccount(db, source));
    const target = `t-${randomUUID()}`;
    db.insert(user)
      .values({
        id: target,
        name: target,
        email: `${target}@example.cz`,
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();
    expect((await restoreArchive(db, target, await backupArchive(db, source))).status).toBe("done");
    expect(canonicalAccount(db, target)).toEqual(expected);
    assertConsistent(db, target);
  });

  // Writes the release point of the current version: WRITE_DB_FIXTURE=1 with -t "bod vydání".
  test.runIf(process.env.WRITE_DB_FIXTURE)("zapíše bod vydání aktuální verze", () => {
    setClockForTests({ now: () => NOW });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const db = freshDb();
    runMigrations(db);
    setDbForTests(db);
    const owner = seedOwner(db, NOW);
    const web = webActor(owner);
    ensureDashboards(web);
    const customerId = seedCustomer(owner);
    const paid = issuedInvoice(owner, customerId);
    const row = getInvoice(owner, paid)!;
    addPayment(web, paid, {
      revision: row.revision,
      paidOn: row.issueDate!,
      amountMinor: 100_000,
      currency: "CZK",
      method: "transfer",
      note: "",
    });
    createCreditNote(web, issuedInvoice(owner, customerId));
    saveTemplate(web, {
      name: "Paušál",
      customerId,
      document: { ...newDraftDefaults(owner, customerId), type: "invoice", dueDays: 14, lines: [] },
    });
    savePlan(owner, customerId);
    saveReminderRule(web, { offsetDays: 7, texts: null });
    db.delete(job).run();
    writeFileSync(join(FIXTURES, `${pkg.version}.sql`), dumpDatabase(db.$client));
  });
});
