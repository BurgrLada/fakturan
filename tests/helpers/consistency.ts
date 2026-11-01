import { asc, eq, getTableColumns, getTableName, is, sql } from "drizzle-orm";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import { isActiveDocument, toDiscount } from "@/lib/invoice";
import { computeTotals } from "@/lib/invoice-totals";
import { deriveStatus } from "@/lib/payments";
import type { Db } from "@/server/db";
import * as schema from "@/server/db/schema";

const OWNER_COLUMNS = ["userId", "ownerId"] as const;

function ownedTables(): { table: string; column: string }[] {
  return Object.values(schema as Record<string, unknown>)
    .filter((value): value is SQLiteTable => is(value, SQLiteTable))
    .flatMap((table) => {
      const columns = getTableColumns(table) as Record<string, { name: string } | undefined>;
      const key = OWNER_COLUMNS.find((name) => columns[name]);
      return key && getTableName(table) !== "audit_log"
        ? [{ table: getTableName(table), column: columns[key]!.name }]
        : [];
    });
}

const OWNED = ownedTables();

function count(db: Db, query: ReturnType<typeof sql>): number {
  return db.get<{ n: number }>(query)?.n ?? 0;
}

function creditNoteProblems(
  row: typeof schema.invoice.$inferSelect,
  rows: (typeof schema.invoice.$inferSelect)[],
  label: string,
): string[] {
  const problems: string[] = [];
  if (row.totalMinor >= 0) problems.push(`${label}: oprava není záporná`);
  if (row.variableSymbol !== null) problems.push(`${label}: oprava má variabilní symbol`);
  const original = rows.find((other) => other.id === row.relatedInvoiceId);
  if (!original) return [...problems, `${label}: oprava bez původní faktury`];
  if (!row.relatedSnapshot) problems.push(`${label}: oprava bez zamrzlého odkazu`);
  if (original.currency !== row.currency) problems.push(`${label}: oprava v jiné měně`);
  if (original.totalMinor + original.creditsMinor < 0) {
    problems.push(`${label}: opravy přečerpaly fakturu`);
  }
  return problems;
}

function invoiceProblems(db: Db, ownerId: string): string[] {
  const { invoice, invoiceLine } = schema;
  const problems: string[] = [];
  const rows = db.select().from(invoice).where(eq(invoice.userId, ownerId)).all();

  for (const row of rows) {
    const label = `invoice ${row.id}`;
    const lines = db
      .select()
      .from(invoiceLine)
      .where(eq(invoiceLine.invoiceId, row.id))
      .orderBy(asc(invoiceLine.position))
      .all();
    try {
      const totals = computeTotals(
        lines.map((line) => ({
          quantityMilli: line.quantityMilli,
          unitPriceMinor: line.unitPriceMinor,
          discount: toDiscount(line.discountKind, line.discountValue),
        })),
        toDiscount(row.discountKind, row.discountValue),
        row.rounding,
      );
      const matches =
        row.subtotalMinor === totals.subtotalMinor &&
        row.discountMinor === totals.discountMinor &&
        row.roundingMinor === totals.roundingMinor &&
        row.totalMinor === totals.totalMinor &&
        lines.every((line, i) => line.netMinor === totals.lines[i]!.netMinor);
      if (!matches) problems.push(`${label}: uložené součty neodpovídají položkám`);
    } catch {
      problems.push(`${label}: součty nejde spočítat`);
    }

    if (row.status === "draft") {
      if (row.number !== null) problems.push(`${label}: koncept má číslo`);
      continue;
    }
    if (row.number === null) problems.push(`${label}: vystavený doklad nemá číslo`);
    if (!row.supplierSnapshot || !row.customerSnapshot) {
      problems.push(`${label}: vystavený doklad nemá snapshoty`);
    }
    if (!row.dateFormat) problems.push(`${label}: vystavený doklad nemá formát data`);
    if (row.paymentMethod === "transfer" && !row.accountSnapshot) {
      problems.push(`${label}: převod bez snapshotu účtu`);
    }
    if (row.type === "credit_note") problems.push(...creditNoteProblems(row, rows, label));
  }

  const numbers = rows.flatMap((row) => row.number ?? []);
  const repeated = numbers.filter((number, i) => numbers.indexOf(number) !== i);
  if (repeated.length > 0) problems.push(`invoice: opakovaná čísla ${repeated.join(", ")}`);
  return problems;
}

// A payment in a foreign currency is valid (PAY-006), so currency is checked through the credit:
// only a payment in the document currency must credit exactly what it says.
function paymentProblems(db: Db, ownerId: string): string[] {
  const { invoice } = schema;
  const problems: string[] = [];
  const paidByInvoice = new Map(
    db
      .all<{ id: string; paid: number }>(
        sql`SELECT invoice_id AS id, sum(credited_minor) AS paid FROM payment GROUP BY invoice_id`,
      )
      .map((row) => [row.id, row.paid]),
  );
  const rows = db.select().from(invoice).where(eq(invoice.userId, ownerId)).all();
  for (const row of rows) {
    const label = `invoice ${row.id}`;
    const paid = paidByInvoice.get(row.id) ?? 0;
    if (row.paidMinor !== paid) problems.push(`${label}: paid_minor neodpovídá součtu plateb`);
    if (row.paidMinor < 0) problems.push(`${label}: paid_minor je záporné`);
    const creditsMinor = rows
      .filter(
        (other) =>
          other.type === "credit_note" &&
          other.relatedInvoiceId === row.id &&
          isActiveDocument(other.status),
      )
      .reduce((sum, other) => sum + other.totalMinor, 0);
    if (row.creditsMinor !== creditsMinor) {
      problems.push(`${label}: credits_minor neodpovídá aktivním opravám`);
    }
    const advance = rows.find(
      (other) => other.id === row.relatedInvoiceId && other.type === "advance",
    );
    const advanceMinor = advance?.paidMinor ?? 0;
    if (row.advanceMinor !== advanceMinor) {
      problems.push(`${label}: advance_minor neodpovídá úhradě zálohy`);
    }
    const expected = deriveStatus({ ...row, paidMinor: paid, creditsMinor, advanceMinor });
    if (row.status !== expected) {
      problems.push(`${label}: stav ${row.status} neodpovídá platbám (${expected})`);
    }
  }

  const foreign = count(
    db,
    sql`SELECT count(*) AS n FROM payment p LEFT JOIN invoice i ON i.id = p.invoice_id
      WHERE (p.user_id = ${ownerId} OR i.user_id = ${ownerId})
        AND (i.id IS NULL OR i.user_id <> p.user_id)`,
  );
  if (foreign > 0) problems.push(`payment: ${foreign} plateb s cizím dokladem`);

  const miscredited = count(
    db,
    sql`SELECT count(*) AS n FROM payment p JOIN invoice i ON i.id = p.invoice_id
      WHERE p.user_id = ${ownerId} AND p.currency = i.currency
        AND p.credited_minor <> p.amount_minor`,
  );
  if (miscredited > 0) problems.push(`payment: ${miscredited} plateb s jinou připsanou částkou`);

  const unpayable = count(
    db,
    sql`SELECT count(*) AS n FROM payment p JOIN invoice i ON i.id = p.invoice_id
      WHERE p.user_id = ${ownerId} AND i.status IN ('draft', 'cancelled')`,
  );
  if (unpayable > 0) problems.push(`payment: ${unpayable} plateb na konceptu nebo stornu`);
  return problems;
}

function mailProblems(db: Db, ownerId: string): string[] {
  const problems: string[] = [];
  const unarchived = count(
    db,
    sql`SELECT count(*) AS n FROM email_log
      WHERE user_id = ${ownerId} AND status = 'sent' AND file_id IS NULL`,
  );
  if (unarchived > 0) problems.push(`email_log: ${unarchived} odeslaných bez archivu`);

  const abandoned = count(
    db,
    sql`SELECT count(*) AS n FROM email_log l
      WHERE l.user_id = ${ownerId} AND l.status = 'sending' AND NOT EXISTS (
        SELECT 1 FROM job j
        WHERE j.status = 'running' AND json_extract(j.payload, '$.logId') = l.id
      )`,
  );
  if (abandoned > 0) problems.push(`email_log: ${abandoned} ve stavu sending bez běžící úlohy`);

  const stillIssued = count(
    db,
    sql`SELECT count(*) AS n FROM email_log l JOIN invoice i ON i.id = l.invoice_id
      WHERE l.user_id = ${ownerId} AND l.status = 'sent' AND l.kind = i.type
        AND i.status = 'issued'`,
  );
  if (stillIssued > 0) problems.push(`invoice: ${stillIssued} odeslaných stále vystavených`);
  return problems;
}

function recurringProblems(db: Db, ownerId: string): string[] {
  const problems: string[] = [];
  const foreign = count(
    db,
    sql`SELECT count(*) AS n FROM recurring_run r
      LEFT JOIN invoice i ON i.id = r.invoice_id
      WHERE r.user_id = ${ownerId} AND r.invoice_id IS NOT NULL
        AND (i.id IS NULL OR i.user_id <> r.user_id)`,
  );
  if (foreign > 0) problems.push(`recurring_run: ${foreign} běhů s cizím dokladem`);

  const repeated = count(
    db,
    sql`SELECT count(*) AS n FROM (
      SELECT 1 FROM invoice
      WHERE user_id = ${ownerId} AND recurring_id IS NOT NULL
      GROUP BY recurring_id, period_from, period_to HAVING count(*) > 1
    )`,
  );
  if (repeated > 0) problems.push(`invoice: ${repeated} období plánu s více fakturami`);
  return problems;
}

function noticeProblems(db: Db, ownerId: string): string[] {
  const problems: string[] = [];
  const unpaid = count(
    db,
    sql`SELECT count(*) AS n FROM bank_notification n
      WHERE n.user_id = ${ownerId} AND n.status = 'matched'
        AND NOT EXISTS (SELECT 1 FROM payment p WHERE p.notification_id = n.id)`,
  );
  if (unpaid > 0) problems.push(`bank_notification: ${unpaid} spárovaných bez platby`);

  const mismatched = count(
    db,
    sql`SELECT count(*) AS n FROM bank_notification n
      JOIN (SELECT notification_id, sum(amount_minor) AS total FROM payment
        WHERE notification_id IS NOT NULL GROUP BY notification_id) p ON p.notification_id = n.id
      WHERE n.user_id = ${ownerId} AND p.total <> n.amount_minor`,
  );
  if (mismatched > 0) problems.push(`bank_notification: ${mismatched} s jinou částkou plateb`);

  const repeated = count(
    db,
    sql`SELECT count(*) AS n FROM (
      SELECT 1 FROM bank_notification WHERE user_id = ${ownerId}
      GROUP BY dedupe_key HAVING count(*) > 1
    )`,
  );
  if (repeated > 0) problems.push(`bank_notification: ${repeated}× opakovaný dedupe_key`);

  const paidPending = count(
    db,
    sql`SELECT count(*) AS n FROM bank_notification n
      JOIN payment p ON p.notification_id = n.id
      WHERE n.user_id = ${ownerId} AND n.status = 'pending'`,
  );
  if (paidPending > 0) problems.push(`bank_notification: ${paidPending} nevyřízených s platbou`);
  return problems;
}

// Throws on the first broken invariant. Plans extend it as new entities arrive.
export function assertConsistent(db: Db, ownerId: string): void {
  const problems: string[] = [];

  const accountExists = count(db, sql`SELECT count(*) AS n FROM user WHERE id = ${ownerId}`) > 0;
  for (const { table, column } of OWNED) {
    const rows = count(
      db,
      sql`SELECT count(*) AS n FROM ${sql.identifier(table)} WHERE ${sql.identifier(column)} = ${ownerId}`,
    );
    if (rows > 0 && !accountExists) problems.push(`${table}: ${rows} řádků neexistujícího účtu`);
  }

  const foreignCounters = count(
    db,
    sql`SELECT count(*) AS n FROM number_series_counter c
      LEFT JOIN number_series s ON s.id = c.series_id
      WHERE c.user_id = ${ownerId} AND (s.id IS NULL OR s.user_id <> c.user_id)`,
  );
  if (foreignCounters > 0) {
    problems.push(`number_series_counter: ${foreignCounters} čítačů cizí nebo chybějící řady`);
  }

  const orphanAudit = count(
    db,
    sql`SELECT count(*) AS n FROM audit_log WHERE scope = 'user' AND owner_id IS NULL`,
  );
  if (orphanAudit > 0)
    problems.push(`audit_log: ${orphanAudit} uživatelských záznamů bez vlastníka`);

  problems.push(...invoiceProblems(db, ownerId));
  problems.push(...paymentProblems(db, ownerId));
  problems.push(...mailProblems(db, ownerId));
  problems.push(...recurringProblems(db, ownerId));
  problems.push(...noticeProblems(db, ownerId));

  if (problems.length > 0) {
    throw new Error(`Data účtu ${ownerId} nejsou konzistentní:\n${problems.join("\n")}`);
  }
}
