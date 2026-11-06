import "server-only";
import { and, asc, count, eq, gte, inArray, lte, ne, sql, type SQL } from "drizzle-orm";
import type { ExportFilter } from "@/lib/export-filter";
import { amountDue } from "@/lib/qr-payload";
import {
  CSV_BOM,
  count as countCell,
  csvHeader,
  csvRow,
  money,
  text,
  type Cell,
} from "@/lib/tabular";
import { TEXTS } from "@/lib/texts";
import { buildSheets, type SheetStream } from "@/lib/xlsx-writer";
import { clock } from "../clock";
import { db } from "../db";
import {
  catalogItem,
  customer,
  invoice,
  invoiceLine,
  invoiceTemplate,
  payment,
  type ExportJob,
  type Job,
} from "../db/schema";
import { scoped } from "../db/scoped";
import { blobPath } from "../files/store";
import {
  assertEntryName,
  atomicFileWriter,
  ExportTooLarge,
  zipFileWriter,
  type AtomicFile,
  type ZipFileWriter,
} from "../files/zip-writer";
import { moveExport } from "../jobs/export-progress";
import { yieldHeavy } from "../jobs/worker";
import { ServiceError } from "./access";
import { failExport, findExport, finishExport, removeResult } from "./exports";
import { assertValidIsdoc, isdocFileFor, IsdocRejected } from "./invoice-isdoc";
import { loadInvoiceDocument } from "./invoice-document";
import { documentPdf, fileNameTaker } from "./invoice-pdf";
import { ownedCustomerId, type Invoice } from "./invoices";

const E = TEXTS.exporting.errors;
const C = TEXTS.exporting.columns;
const PAGE = 200;

type Run = { job: Job; row: ExportJob; ownerId: string; done: number; total: number };

// A failure the person can act on; anything else is a code failure and goes to monitoring.
class ExportStopped extends Error {}

async function progress(run: Run, step = 1): Promise<void> {
  run.done += step;
  moveExport(run.ownerId, run.row.id, ["running"], { progress: run.done });
  await yieldHeavy(run.job);
}

function invoiceWhere(ownerId: string, filter: ExportFilter): SQL {
  const wantsCustomer = filter.customerId !== undefined;
  const customerId = ownedCustomerId(ownerId, filter.customerId);
  return scoped(ownerId).where(invoice, (t, { and: all, eq: is }) =>
    all(
      // A draft has no number and no final content, so no export ever carries one (R-24).
      ne(t.status, "draft"),
      filter.from ? gte(t.issueDate, filter.from) : undefined,
      filter.to ? lte(t.issueDate, filter.to) : undefined,
      filter.types?.length ? inArray(t.type, filter.types) : undefined,
      filter.statuses?.length ? inArray(t.status, filter.statuses) : undefined,
      // A customer of another account narrows to nothing instead of being ignored.
      wantsCustomer ? (customerId ? is(t.customerId, customerId) : sql`0`) : undefined,
      filter.ids ? inArray(t.id, filter.ids) : undefined,
    ),
  );
}

// IDs from a bulk action are the client's word: every one must be a document of this account.
function assertOwnIds(filter: ExportFilter, where: SQL): void {
  if (!filter.ids) return;
  const found = db.select({ n: count() }).from(invoice).where(where).get()?.n ?? 0;
  if (found !== new Set(filter.ids).size) throw new ExportStopped(E.foreignIds);
}

async function* invoicePages(where: SQL): AsyncGenerator<Invoice[]> {
  for (let offset = 0; ; offset += PAGE) {
    const page = db
      .select()
      .from(invoice)
      .where(where)
      .orderBy(asc(invoice.issueDate), asc(invoice.number), asc(invoice.id))
      .limit(PAGE)
      .offset(offset)
      .all();
    if (page.length === 0) return;
    yield page;
    if (page.length < PAGE) return;
  }
}

function lineCounts(ownerId: string, ids: string[]): Map<string, number> {
  const rows = db
    .select({ invoiceId: invoiceLine.invoiceId, n: count() })
    .from(invoiceLine)
    .where(scoped(ownerId).where(invoiceLine, (t) => inArray(t.invoiceId, ids)))
    .groupBy(invoiceLine.invoiceId)
    .all();
  return new Map(rows.map((row) => [row.invoiceId, row.n]));
}

const INVOICE_COLUMNS = [
  C.number,
  C.type,
  C.status,
  C.issueDate,
  C.taxableDate,
  C.dueDate,
  C.customer,
  C.currency,
  C.total,
  C.paid,
  C.due,
  C.variableSymbol,
  C.source,
  C.lineCount,
];

function date(value: string | null): Cell {
  return value ? { kind: "date", value } : null;
}

function invoiceCells(row: Invoice, lines: number): Cell[] {
  return [
    text(row.number ?? ""),
    text(TEXTS.invoices.list.types[row.type]),
    text(TEXTS.invoices.statuses[row.status]),
    date(row.issueDate),
    date(row.taxableDate),
    date(row.dueDate),
    text(row.customerName),
    text(row.currency),
    money(row.totalMinor, row.currency),
    money(row.paidMinor, row.currency),
    money(amountDue(row), row.currency),
    text(row.variableSymbol ?? ""),
    text(row.external ? (row.sourceSystem ?? TEXTS.importing.sourceUnknown) : ""),
    countCell(lines),
  ];
}

async function* invoiceRows(run: Run, where: SQL): AsyncGenerator<Cell[]> {
  for await (const page of invoicePages(where)) {
    const counts = lineCounts(
      run.ownerId,
      page.map((row) => row.id),
    );
    for (const row of page) yield invoiceCells(row, counts.get(row.id) ?? 0);
    await progress(run, page.length);
  }
}

const LINE_COLUMNS = [
  C.document,
  C.name,
  C.description,
  C.quantity,
  C.unit,
  C.unitPrice,
  C.lineTotal,
  C.currency,
];

async function* lineRows(run: Run, where: SQL): AsyncGenerator<Cell[]> {
  for await (const page of invoicePages(where)) {
    const ids = page.map((row) => row.id);
    const byInvoice = new Map(page.map((row) => [row.id, row]));
    const lines = db
      .select()
      .from(invoiceLine)
      .where(scoped(run.ownerId).where(invoiceLine, (t) => inArray(t.invoiceId, ids)))
      .orderBy(asc(invoiceLine.invoiceId), asc(invoiceLine.position))
      .all();
    const grouped = Map.groupBy(lines, (line) => line.invoiceId);
    for (const line of ids.flatMap((id) => grouped.get(id) ?? [])) {
      const owner = byInvoice.get(line.invoiceId)!;
      yield [
        text(owner.number ?? ""),
        text(line.name),
        text(line.description),
        { kind: "number", value: line.quantityMilli / 1000 },
        text(line.unit),
        money(line.unitPriceMinor, owner.currency),
        money(line.netMinor, owner.currency),
        text(owner.currency),
      ];
    }
    await yieldHeavy(run.job);
  }
}

async function writeCsv(file: AtomicFile, columns: string[], rows: AsyncIterable<Cell[]>) {
  file.write(CSV_BOM + csvHeader(columns));
  let chunk = "";
  let pending = 0;
  for await (const row of rows) {
    chunk += csvRow(row);
    pending += 1;
    if (pending >= PAGE) {
      file.write(chunk);
      chunk = "";
      pending = 0;
    }
  }
  file.write(chunk);
}

async function pdfZip(run: Run, zip: ZipFileWriter, where: SQL): Promise<void> {
  const take = fileNameTaker();
  for await (const page of invoicePages(where)) {
    for (const row of page) {
      const doc = loadInvoiceDocument(run.ownerId, row.id);
      if (!doc) throw new ExportStopped(E.foreignIds);
      const pdf = await documentPdf(run.ownerId, doc);
      // PDF streams are already compressed.
      zip.addStored(assertEntryName(take(pdf.fileName)), new Uint8Array(pdf.data));
      await progress(run);
    }
  }
}

// Every file of a page is validated before any is added: an invalid one stops the whole export.
async function isdocZip(run: Run, zip: ZipFileWriter, where: SQL): Promise<void> {
  const take = fileNameTaker();
  for await (const page of invoicePages(where)) {
    const files = page.map((row) => isdocFileFor(run.ownerId, row.id));
    await assertValidIsdoc(files);
    for (const item of files) zip.addDeflated(assertEntryName(take(item.fileName)), item.xml);
    await progress(run, page.length);
  }
}

type Evidence = { columns: string[]; rows: (run: Run) => AsyncGenerator<Cell[]> };

const yesNo = (value: boolean) => text(value ? TEXTS.exporting.yes : TEXTS.exporting.no);

async function* customerRows(run: Run): AsyncGenerator<Cell[]> {
  for (let offset = 0; ; offset += PAGE) {
    const page = db
      .select()
      .from(customer)
      .where(scoped(run.ownerId).where(customer))
      .orderBy(asc(customer.name), asc(customer.id))
      .limit(PAGE)
      .offset(offset)
      .all();
    for (const row of page) {
      yield [
        text(row.name),
        text(row.street),
        text(row.city),
        text(row.zip),
        text(row.country),
        text(row.ico),
        text(row.dic),
        text(row.email),
        text(row.extraEmails.join(", ")),
        text(row.phone),
        text(row.note),
        row.dueDays === null ? null : countCell(row.dueDays),
        text(row.language ?? ""),
        text(row.currency ?? ""),
        yesNo(row.archivedAt !== null),
      ];
    }
    await progress(run, page.length);
    if (page.length < PAGE) return;
  }
}

async function* catalogRows(run: Run): AsyncGenerator<Cell[]> {
  for (let offset = 0; ; offset += PAGE) {
    const page = db
      .select()
      .from(catalogItem)
      .where(scoped(run.ownerId).where(catalogItem))
      .orderBy(asc(catalogItem.name), asc(catalogItem.id))
      .limit(PAGE)
      .offset(offset)
      .all();
    for (const row of page) {
      yield [
        text(row.name),
        text(row.description),
        text(row.unit),
        money(row.priceMinor, row.currency),
        text(row.currency),
        text(row.category),
        text(row.tags.join(", ")),
        yesNo(row.archivedAt !== null),
      ];
    }
    await progress(run, page.length);
    if (page.length < PAGE) return;
  }
}

function paymentWhere(ownerId: string, filter: ExportFilter): SQL {
  return scoped(ownerId).where(payment, (t, { and: all }) =>
    all(
      filter.from ? gte(t.paidOn, filter.from) : undefined,
      filter.to ? lte(t.paidOn, filter.to) : undefined,
    ),
  );
}

async function* paymentRows(run: Run): AsyncGenerator<Cell[]> {
  const where = paymentWhere(run.ownerId, run.row.filter);
  for (let offset = 0; ; offset += PAGE) {
    const page = db
      .select({ payment, number: invoice.number })
      .from(payment)
      .innerJoin(
        invoice,
        and(eq(invoice.id, payment.invoiceId), scoped(run.ownerId).where(invoice)),
      )
      .where(where)
      .orderBy(asc(payment.paidOn), asc(payment.id))
      .limit(PAGE)
      .offset(offset)
      .all();
    for (const { payment: row, number } of page) {
      yield [
        date(row.paidOn),
        text(number ?? ""),
        text(TEXTS.exporting.paymentKinds[row.kind]),
        money(row.amountMinor, row.currency),
        text(row.currency),
        { kind: "money", minor: row.creditedMinor, currency: row.currency },
        text(TEXTS.payments.methods[row.method]),
        text(TEXTS.payments.sources[row.source]),
        yesNo(row.dateEstimated),
        text(row.note),
      ];
    }
    await progress(run, page.length);
    if (page.length < PAGE) return;
  }
}

const EVIDENCE: Record<"customers" | "catalog" | "payments", Evidence> = {
  customers: {
    columns: [
      C.name,
      C.street,
      C.city,
      C.zip,
      C.country,
      C.ico,
      C.dic,
      C.email,
      C.extraEmails,
      C.phone,
      C.note,
      C.dueDays,
      C.language,
      C.currency,
      C.archived,
    ],
    rows: customerRows,
  },
  catalog: {
    columns: [C.name, C.description, C.unit, C.price, C.currency, C.category, C.tags, C.archived],
    rows: catalogRows,
  },
  payments: {
    columns: [
      C.paidOn,
      C.document,
      C.kind,
      C.amount,
      C.currency,
      C.credited,
      C.method,
      C.source,
      C.estimated,
      C.note,
    ],
    rows: paymentRows,
  },
};

function evidenceTotal(run: Run): number {
  const { kind } = run.row;
  const q = (table: typeof customer | typeof catalogItem) =>
    db.select({ n: count() }).from(table).where(scoped(run.ownerId).where(table)).get()?.n ?? 0;
  if (kind === "customers") return q(customer);
  if (kind === "catalog") return q(catalogItem);
  if (kind === "payments") {
    return (
      db.select({ n: count() }).from(payment).where(paymentWhere(run.ownerId, run.row.filter)).get()
        ?.n ?? 0
    );
  }
  return (
    db
      .select({ n: count() })
      .from(invoiceTemplate)
      .where(scoped(run.ownerId).where(invoiceTemplate))
      .get()?.n ?? 0
  );
}

// Name and content only: the owner and the row ids stay out, so the file names no account.
function templatesJson(run: Run): string {
  const rows = db
    .select({ name: invoiceTemplate.name, document: invoiceTemplate.document })
    .from(invoiceTemplate)
    .where(scoped(run.ownerId).where(invoiceTemplate))
    .orderBy(asc(invoiceTemplate.name), asc(invoiceTemplate.id))
    .all();
  return JSON.stringify(
    {
      format: "fakturan.invoice-templates",
      v: 1,
      exportedAt: clock.now().toISOString(),
      templates: rows,
    },
    null,
    2,
  );
}

async function produce(run: Run, path: string): Promise<number> {
  const { kind, format, filter } = run.row;
  const mtime = clock.now();
  const zipped = format !== "csv" && format !== "json";
  const zip = zipped ? zipFileWriter(path, { mtime }) : null;
  const plain = zipped ? null : atomicFileWriter(path);
  try {
    if (kind === "invoices") {
      const where = invoiceWhere(run.ownerId, filter);
      assertOwnIds(filter, where);
      run.total = db.select({ n: count() }).from(invoice).where(where).get()?.n ?? 0;
      moveExport(run.ownerId, run.row.id, ["running"], { progressTotal: run.total });
      if (format === "pdf_zip") await pdfZip(run, zip!, where);
      else if (format === "isdoc_zip") await isdocZip(run, zip!, where);
      else if (format === "csv") await writeCsv(plain!, INVOICE_COLUMNS, invoiceRows(run, where));
      else {
        const sheets: SheetStream[] = [
          {
            name: TEXTS.exporting.sheets.documents,
            columns: INVOICE_COLUMNS,
            rows: invoiceRows(run, where),
          },
          { name: TEXTS.exporting.sheets.lines, columns: LINE_COLUMNS, rows: lineRows(run, where) },
        ];
        await buildSheets(zip!, sheets);
      }
    } else {
      run.total = evidenceTotal(run);
      moveExport(run.ownerId, run.row.id, ["running"], { progressTotal: run.total });
      if (kind === "templates") {
        plain!.write(templatesJson(run));
        run.done = run.total;
      } else {
        const { columns, rows } = EVIDENCE[kind];
        if (format === "csv") await writeCsv(plain!, columns, rows(run));
        else {
          const name = TEXTS.exporting.kinds[kind];
          await buildSheets(zip!, [{ name, columns, rows: rows(run) }]);
        }
      }
    }
    return zip ? zip.close() : plain!.close();
  } catch (error) {
    if (zip) zip.abort();
    else plain!.abort();
    throw error;
  }
}

function reasonOf(error: unknown): string | null {
  if (error instanceof ExportStopped || error instanceof ServiceError) return error.message;
  if (error instanceof ExportTooLarge) return E.tooLarge;
  if (error instanceof IsdocRejected) {
    return error.built
      ? E.isdocInvalid(error.number, error.problem)
      : E.isdocBuild(error.number, error.problem);
  }
  return null;
}

export async function runExport(job: Job): Promise<void> {
  const ownerId = job.userId;
  const exportId = job.payload.exportId;
  if (!ownerId || typeof exportId !== "string") throw new Error("Úloha exportu nemá vlastníka");
  const row = findExport(db, ownerId, exportId);
  if (!row || !moveExport(ownerId, exportId, ["queued"], { status: "running", progress: 0 })) {
    return;
  }
  const run: Run = { job, row, ownerId, done: 0, total: 0 };
  // Written under the export's own id; only finishExport makes it a file of the account.
  const path = blobPath(ownerId, row.id);
  let size: number;
  try {
    size = await produce(run, path);
  } catch (error) {
    const reason = reasonOf(error);
    failExport(ownerId, row.id, reason ?? E.unexpected);
    // A code failure leaves a dead job and a report; a refusal is an answer, not an incident.
    if (reason === null) throw error;
    return;
  }
  if (!finishExport(row, size, run.total)) removeResult(ownerId, row.id);
}
