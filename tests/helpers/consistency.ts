import { eq, getTableColumns, getTableName, is, sql } from "drizzle-orm";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import { documentCzkMinor, paymentCzkMinor } from "@/lib/fx";
import { addDays, AWAITING_PAYMENT, isOverdue } from "@/lib/invoice";
import { calendarDateInPrague } from "@/lib/number-format";
import { amountDue } from "@/lib/qr-payload";
import { clock } from "@/server/clock";
import type { Db } from "@/server/db";
import * as schema from "@/server/db/schema";
import { reportSummary } from "@/server/reports/queries";
import { invoiceProblems, paymentProblems } from "@/server/services/data-checks";
import { taxOverview, unpaidAsOf } from "@/server/reports/tax";

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

// The parser refuses a list without EUR, so such a date can only be a list written in part.
function rateListProblems(db: Db): string[] {
  const partial = count(
    db,
    sql`SELECT count(*) AS n FROM (
      SELECT 1 FROM exchange_rate GROUP BY list_date HAVING sum(currency = 'EUR') = 0
    )`,
  );
  return partial > 0 ? [`exchange_rate: ${partial} lístků bez EUR`] : [];
}

const czkOrNull = (convert: () => number | null): number | null => {
  try {
    return convert();
  } catch {
    return null;
  }
};

type Missing = Map<string, { count: number; amountMinor: number }>;

function addMissing(missing: Missing, currency: string, amountMinor: number): void {
  const row = missing.get(currency) ?? { count: 0, amountMinor: 0 };
  missing.set(currency, { count: row.count + 1, amountMinor: row.amountMinor + amountMinor });
}

function missingText(missing: Missing): string {
  const byCurrency = [...missing]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([currency, row]) => ({ currency, amountMinor: row.amountMinor }));
  const total = [...missing.values()].reduce((sum, row) => sum + row.count, 0);
  return JSON.stringify({ count: total, byCurrency });
}

const SUMMARY_LABELS = {
  invoiced: "fakturováno",
  income: "příjmy",
  outstanding: "pohledávky",
  overdue: "po splatnosti",
  advanceOpen: "neuhrazené zálohy",
} as const;
type Metric = keyof typeof SUMMARY_LABELS;

// Recomputes each year from the rows in JS, so a mistake in the report SQL cannot hide itself.
// Flows follow the year; balances are the state as of today in every year.
function reportProblems(db: Db, ownerId: string): string[] {
  const { invoice, payment, exchangeRate } = schema;
  const today = calendarDateInPrague(clock.now());
  const documents = db.select().from(invoice).where(eq(invoice.userId, ownerId)).all();
  const byId = new Map(documents.map((row) => [row.id, row]));
  const payments = db.select().from(payment).where(eq(payment.userId, ownerId)).all();
  const lists = db.select().from(exchangeRate).all();
  const listedRate = (currency: string, paidOn: string): number | null =>
    lists
      .filter(
        (row) =>
          row.currency === currency &&
          row.listDate <= paidOn &&
          row.listDate >= addDays(paidOn, -7),
      )
      .sort((a, b) => (a.listDate < b.listDate ? 1 : -1))[0]?.rateMicros ?? null;
  const counted = documents.filter((row) => row.status !== "draft" && row.status !== "cancelled");
  const years = new Set([
    ...counted.flatMap((row) => (row.issueDate ? [row.issueDate.slice(0, 4)] : [])),
    ...payments.map((row) => row.paidOn.slice(0, 4)),
  ]);
  if (years.size === 0 && counted.length > 0) years.add(today.slice(0, 4));

  const problems: string[] = [];
  for (const year of [...years].sort()) {
    const inYear = (date: string | null) => date !== null && date.slice(0, 4) === year;
    const sums: Record<Metric, number> = {
      invoiced: 0,
      income: 0,
      outstanding: 0,
      overdue: 0,
      advanceOpen: 0,
    };
    const missing: Record<Metric, Missing> = {
      invoiced: new Map(),
      income: new Map(),
      outstanding: new Map(),
      overdue: new Map(),
      advanceOpen: new Map(),
    };
    const add = (metric: Metric, currency: string, original: number, czk: number | null) => {
      if (czk === null) addMissing(missing[metric], currency, original);
      else sums[metric] += czk;
    };
    for (const row of counted) {
      const due = amountDue(row);
      const open = (AWAITING_PAYMENT as readonly string[]).includes(row.status) && due > 0;
      const advance = row.type === "advance";
      const rate = { currency: row.currency, exchangeRateMicros: row.exchangeRateMicros };
      const total = czkOrNull(() => documentCzkMinor({ ...rate, totalMinor: row.totalMinor }));
      const dueCzk = czkOrNull(() => documentCzkMinor({ ...rate, totalMinor: due }));
      if (!advance && inYear(row.issueDate)) add("invoiced", row.currency, row.totalMinor, total);
      if (open && advance) add("advanceOpen", row.currency, due, dueCzk);
      if (open && !advance) add("outstanding", row.currency, due, dueCzk);
      if (!advance && isOverdue(row, today)) add("overdue", row.currency, due, dueCzk);
    }
    for (const row of payments.filter((other) => inYear(other.paidOn))) {
      const document = byId.get(row.invoiceId);
      if (row.kind !== "payment" || !document) continue;
      if (document.status === "draft" || document.status === "cancelled") continue;
      const rateMicros = row.rateMicros ?? listedRate(row.currency, row.paidOn);
      const czk = czkOrNull(() => paymentCzkMinor({ ...row, rateMicros }));
      add("income", row.currency, row.amountMinor, czk);
    }

    const range = { from: `${year}-01-01`, to: `${year}-12-31` };
    const actual = reportSummary(db, ownerId, { range, includeExternal: true }, today);
    for (const metric of Object.keys(SUMMARY_LABELS) as Metric[]) {
      const label = `přehled ${year}: ${SUMMARY_LABELS[metric]}`;
      const value = actual[`${metric}Minor`];
      if (value !== sums[metric]) problems.push(`${label} ${value}, z dokladů ${sums[metric]}`);
      const reported = JSON.stringify(actual.unconverted[metric]);
      const expected = missingText(missing[metric]);
      if (reported !== expected) {
        problems.push(`${label} bez kurzu ${reported}, z dokladů ${expected}`);
      }
    }
  }
  return problems;
}

// The tax overview against the rows, year by year and in JS (R-26 to R-28), plus today's unpaid
// list against the stored balances: history rebuilt to today must land on amountDue.
function taxProblems(db: Db, ownerId: string): string[] {
  const { invoice, payment, exchangeRate } = schema;
  const today = calendarDateInPrague(clock.now());
  const documents = db.select().from(invoice).where(eq(invoice.userId, ownerId)).all();
  const byId = new Map(documents.map((row) => [row.id, row]));
  const payments = db.select().from(payment).where(eq(payment.userId, ownerId)).all();
  const lists = db.select().from(exchangeRate).all();
  const listedRate = (currency: string, paidOn: string): number | null =>
    lists
      .filter(
        (row) =>
          row.currency === currency &&
          row.listDate <= paidOn &&
          row.listDate >= addDays(paidOn, -7),
      )
      .sort((a, b) => (a.listDate < b.listDate ? 1 : -1))[0]?.rateMicros ?? null;
  const counted = documents.filter((row) => row.status !== "draft" && row.status !== "cancelled");
  const years = new Set([
    ...counted.flatMap((row) => (row.issueDate ? [row.issueDate.slice(0, 4)] : [])),
    ...payments.map((row) => row.paidOn.slice(0, 4)),
  ]);
  const problems: string[] = [];
  for (const year of [...years].sort()) {
    let paidSum = 0;
    let paidMissing = 0;
    for (const row of payments) {
      const document = byId.get(row.invoiceId);
      if (row.kind !== "payment" || row.paidOn.slice(0, 4) !== year || !document) continue;
      if (document.status === "draft" || document.status === "cancelled") continue;
      const rateMicros = row.rateMicros ?? listedRate(row.currency, row.paidOn);
      const czk = czkOrNull(() => paymentCzkMinor({ ...row, rateMicros }));
      if (czk === null) paidMissing += 1;
      else paidSum += czk;
    }
    let issuedSum = 0;
    let issuedMissing = 0;
    for (const row of counted) {
      if (row.type === "advance" || row.issueDate?.slice(0, 4) !== year) continue;
      const czk = czkOrNull(() => documentCzkMinor(row));
      if (czk === null) issuedMissing += 1;
      else issuedSum += czk;
    }
    const expected = {
      paid: { sum: paidSum, missing: paidMissing },
      issued: { sum: issuedSum, missing: issuedMissing },
    };
    for (const basis of ["paid", "issued"] as const) {
      const overview = taxOverview(db, ownerId, { year: Number(year), basis }, today);
      const label = `daňový přehled ${year} (${basis})`;
      const lines = overview.lines.reduce((sum, line) => sum + (line.czkMinor ?? 0), 0);
      if (lines !== overview.totalCzkMinor) {
        problems.push(`${label}: řádky ${lines}, součet ${overview.totalCzkMinor}`);
      }
      if (overview.totalCzkMinor !== expected[basis].sum) {
        problems.push(`${label}: ${overview.totalCzkMinor}, z dokladů ${expected[basis].sum}`);
      }
      if (overview.unconverted.count !== expected[basis].missing) {
        problems.push(
          `${label}: bez kurzu ${overview.unconverted.count}, z dokladů ${expected[basis].missing}`,
        );
      }
    }
  }
  const reported = new Map(unpaidAsOf(db, ownerId, today).map((row) => [row.invoiceId, row]));
  for (const row of counted) {
    if (row.type === "advance" || !row.issueDate || row.issueDate > today) continue;
    const due = amountDue(row);
    const open = (AWAITING_PAYMENT as readonly string[]).includes(row.status) && due > 0;
    const listed = reported.get(row.id);
    if (open && listed?.dueMinor !== due) {
      problems.push(`${row.id}: neuhrazeno k dnešku ${listed?.dueMinor ?? 0}, zůstatek ${due}`);
    }
    if (!open && listed) problems.push(`${row.id}: neuhrazený k dnešku, ale doklad není otevřený`);
  }
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
  problems.push(...rateListProblems(db));
  problems.push(...reportProblems(db, ownerId));
  problems.push(...taxProblems(db, ownerId));

  if (problems.length > 0) {
    throw new Error(`Data účtu ${ownerId} nejsou konzistentní:\n${problems.join("\n")}`);
  }
}
