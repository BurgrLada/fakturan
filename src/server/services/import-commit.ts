import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, notInArray } from "drizzle-orm";
import type { Currency } from "@/lib/currency";
import { isDomesticCountry } from "@/lib/customers";
import { appearanceFrom } from "@/lib/invoice";
import type { ImportDocument } from "@/lib/import-document";
import { importsRow, rowBlocks, type PreviewRow } from "@/lib/import-preview";
import { calendarDateInPrague } from "@/lib/number-format";
import { fitText } from "@/lib/text-limits";
import { TEXTS } from "@/lib/texts";
import { clock } from "../clock";
import { db, type Tx } from "../db";
import { file, importBatch, invoice, invoiceLine, type ImportBatch, type Job } from "../db/schema";
import { scoped } from "../db/scoped";
import { syncSuperseded } from "./advances";
import { catalogInputSchema, saveCatalogItemIn } from "./catalog";
import { customerInputSchema, saveCustomerIn } from "./customers";
import {
  analyzeRows,
  type RowDecisions,
  type RowInput,
  validCustomerInput,
} from "./import-analyze";
import {
  failBatch,
  findBatch,
  importActor,
  previewBlobId,
  readPreview,
  removeBlobs,
  takeFiles,
  writePreview,
} from "./import-batch";
import { analyzeRecords, type RecordInput } from "./import-tabular";
import { refreshBalance } from "./invoice-balance";
import { auditSnapshot, findOwned, searchTextOf } from "./invoices";
import { mutate, type Audit } from "./mutation";
import { insertImportedPayment } from "./payments";
import { getPreferences } from "./preferences";

const T = TEXTS.importing;

// Advances first so a final invoice finds its advance, credit notes last so they find originals.
const ORDER = { advance: 0, invoice: 1, credit_note: 2 } as const;

class CommitStopped extends Error {}

function decisionsOf(rows: PreviewRow[]): Map<string, RowDecisions> {
  return new Map(
    rows.map((row) => [
      row.key,
      {
        status: row.status,
        skippedFrom: row.skippedFrom,
        paidOn: row.paidOn,
        dateEstimated: row.dateEstimated,
        ownConfirmed: row.ownConfirmed,
        customerAction: row.customerAction,
      },
    ]),
  );
}

function inputsOf(rows: PreviewRow[]): RowInput[] {
  return rows.map((row) => ({
    key: row.key,
    source: row.source,
    document: row.document,
    errors: row.document ? [] : row.messages,
    pdfFileId: row.pdfFileId,
  }));
}

function insertCustomer(
  tx: Tx,
  audit: Audit,
  ownerId: string,
  batchId: string,
  doc: ImportDocument,
) {
  const parsed = validCustomerInput(doc.customer!);
  if (!parsed.success)
    throw new CommitStopped(T.rows.customerInvalid(parsed.error.issues[0]?.message ?? ""));
  const { id: _ignored, ...values } = parsed.data;
  return saveCustomerIn(tx, audit, ownerId, values, batchId).id;
}

type Context = {
  tx: Tx;
  audit: Audit;
  ownerId: string;
  batchId: string;
  sourceSystem: string | null;
  ids: Map<string, string>;
  customers: Map<string, string>;
  pdfs: Set<string>;
  prefs: ReturnType<typeof getPreferences>;
};

function linkedId(ctx: Context, link: PreviewRow["original"]): string | null {
  if (!link) return null;
  if (link.kind === "account") return link.id;
  const id = ctx.ids.get(link.key);
  if (!id) throw new CommitStopped(T.rows.originalMissing);
  return id;
}

function insertDocument(ctx: Context, row: PreviewRow): string {
  const { tx, audit, ownerId, batchId } = ctx;
  const doc = row.document!;
  const type = doc.type!;
  const { prefs } = ctx;
  const relatedId =
    type === "credit_note" ? linkedId(ctx, row.original) : linkedId(ctx, row.advance);
  const related = relatedId ? findOwned(tx, ownerId, relatedId) : null;

  let customerId: string | null = null;
  if (related && type === "invoice") customerId = related.customerId;
  else if (row.customerAction.kind === "existing") customerId = row.customerAction.customerId;
  else if (row.customerAction.kind === "create" && doc.customer) {
    customerId =
      ctx.customers.get(row.customerAction.key) ?? insertCustomer(tx, audit, ownerId, batchId, doc);
    ctx.customers.set(row.customerAction.key, customerId);
  }

  const currency = doc.currency as Currency;
  const foreignCurrency = currency !== "CZK";
  const subtotalMinor = doc.lines.reduce((sum, line) => sum + line.netMinor, 0);
  const party = doc.customer;
  const id = randomUUID();
  const now = clock.now();
  tx.insert(invoice)
    .values({
      id,
      userId: ownerId,
      type,
      status: "issued",
      number: doc.number,
      variableSymbol: type === "credit_note" ? null : doc.variableSymbol,
      variableSymbolManual: true,
      customerId,
      customerName: party?.name.trim() ?? "",
      issueDate: doc.issueDate,
      dueDate: doc.dueDate,
      taxableDate: doc.taxableDate,
      language: prefs.language,
      currency,
      exchangeRateMicros: foreignCurrency ? doc.exchangeRateMicros : null,
      exchangeRateSource: foreignCurrency ? "import" : null,
      exchangeRateDate: foreignCurrency && doc.exchangeRateMicros !== null ? doc.issueDate : null,
      foreign: party ? !isDomesticCountry(party.country) : false,
      paymentMethod: doc.account ? "transfer" : "cash",
      importPaymentCode: doc.paymentMeansCode ?? null,
      note: doc.note.slice(0, 2000),
      subtotalMinor,
      roundingMinor: doc.totalMinor - subtotalMinor,
      totalMinor: doc.totalMinor,
      appearance: appearanceFrom(prefs),
      supplierSnapshot: {
        ...doc.supplier,
        web: "",
        registryNote: "",
        contactPerson: "",
        vatIdentified: doc.vatApplicable,
        footerText: "",
        notVatPayerCs: "",
        notVatPayerEn: "",
      },
      customerSnapshot: party ?? {
        name: "",
        street: "",
        city: "",
        zip: "",
        country: "",
        ico: "",
        dic: "",
        email: "",
        phone: "",
      },
      accountSnapshot: doc.account ? { name: "", currency, ...doc.account } : null,
      dateFormat: prefs.dateFormat,
      relatedInvoiceId: related?.id ?? null,
      relatedSnapshot: related
        ? { type: related.type, number: related.number!, issueDate: related.issueDate! }
        : null,
      external: true,
      importBatchId: batchId,
      importUuid: doc.uuid,
      sourceSystem: (doc.issuingSystem ?? ctx.sourceSystem ?? "ISDOC").slice(0, 200),
      importPdfFileId: row.pdfFileId && ctx.pdfs.has(row.pdfFileId) ? row.pdfFileId : null,
      searchText: fitText(
        "invoice",
        "search_text",
        searchTextOf({ number: doc.number, customerName: party?.name ?? "", lines: doc.lines }),
      ),
      revision: 1,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  doc.lines.forEach((line, position) => {
    tx.insert(invoiceLine)
      .values({
        id: randomUUID(),
        invoiceId: id,
        userId: ownerId,
        position,
        name: line.name.slice(0, 200),
        description: line.description.slice(0, 2000),
        quantityMilli: line.quantityMilli,
        unit: line.unit.slice(0, 20),
        unitPriceMinor: line.unitPriceMinor,
        netMinor: line.netMinor,
      })
      .run();
  });
  audit({
    entity: "invoice",
    entityId: id,
    ownerId,
    scope: "user",
    after: { ...auditSnapshot(findOwned(tx, ownerId, id), doc.lines.length), source: row.source },
  });
  if (type === "credit_note" && related) refreshBalance(tx, audit, ownerId, related.id);
  if (type === "invoice" && related) {
    refreshBalance(tx, audit, ownerId, id);
    syncSuperseded(tx, audit, ownerId, id);
  }
  if (row.paidMinor > 0 && row.paidOn) {
    insertImportedPayment(tx, audit, {
      userId: ownerId,
      invoiceId: id,
      paidOn: row.paidOn,
      amountMinor: row.paidMinor,
      rateMicros: foreignCurrency ? doc.exchangeRateMicros : null,
      dateEstimated: row.dateEstimated,
    });
  }
  return id;
}

// Back to the preview with what changed since: nothing of the batch is written.
function stop(ownerId: string, batchId: string, rows: PreviewRow[], message: string): void {
  writePreview(ownerId, batchId, { ...readPreview(ownerId, batchId), rows });
  mutate(importActor(ownerId), "import.commit_stopped", (tx, audit) => {
    const batch = findBatch(tx, ownerId, batchId);
    tx.update(importBatch)
      .set({
        status: "ready",
        revision: batch.revision + 1,
        error: message,
        updatedAt: clock.now(),
      })
      .where(scoped(ownerId).where(importBatch, (t, { eq }) => eq(t.id, batchId)))
      .run();
    audit({
      entity: "import_batch",
      entityId: batchId,
      ownerId,
      scope: "user",
      after: { status: "ready" },
    });
  });
}

export async function runImportCommit(job: Job): Promise<void> {
  const ownerId = job.userId;
  const batchId = job.payload.batchId;
  if (!ownerId || typeof batchId !== "string") throw new Error("Úloha importu nemá dávku");
  const batch = findBatch(db, ownerId, batchId);
  if (batch.status !== "committing") return;
  const stored = readPreview(ownerId, batchId)?.rows ?? [];
  if (batch.target === "customers" || batch.target === "catalog") {
    return commitRecords(ownerId, batch, stored);
  }
  const today = calendarDateInPrague(clock.now());
  // Checked again right before the write: documents and customers may have changed since.
  const rows = analyzeRows(db, ownerId, inputsOf(stored), today, decisionsOf(stored));
  if (rows.some(rowBlocks)) return stop(ownerId, batchId, rows, T.errors.blocked);
  const chosen = rows
    .filter(importsRow)
    .sort((a, b) => ORDER[a.document!.type!] - ORDER[b.document!.type!]);

  let removed: string[];
  try {
    removed = mutate(importActor(ownerId), "import.commit", (tx, audit) => {
      const batchPdfs = tx
        .select({ id: file.id })
        .from(file)
        .where(
          scoped(ownerId).where(file, (t) =>
            and(eq(t.importBatchId, batchId), eq(t.kind, "import_pdf")),
          ),
        )
        .all();
      const ctx: Context = {
        tx,
        audit,
        ownerId,
        batchId,
        sourceSystem: batch.sourceSystem,
        ids: new Map(),
        customers: new Map(),
        pdfs: new Set(batchPdfs.map((row) => row.id)),
        prefs: getPreferences(ownerId),
      };
      for (const row of chosen) ctx.ids.set(row.key, insertDocument(ctx, row));
      const used = [
        ...new Set(
          chosen.flatMap((row) =>
            row.pdfFileId && ctx.pdfs.has(row.pdfFileId) ? [row.pdfFileId] : [],
          ),
        ),
      ];
      // R-9: after the commit only the attached PDFs stay; the uploads and spare PDFs go.
      const spare = tx
        .delete(file)
        .where(
          scoped(ownerId).where(file, (t) =>
            and(
              eq(t.importBatchId, batchId),
              eq(t.kind, "import_pdf"),
              used.length > 0 ? notInArray(t.id, used) : undefined,
            ),
          ),
        )
        .returning({ id: file.id })
        .all()
        .map((row) => row.id);
      const uploads = takeFiles(tx, ownerId, batchId);
      const summary = {
        documents: chosen.length,
        customers: ctx.customers.size,
        duplicates: rows.filter((row) => row.status === "duplicate").length,
        skipped: rows.filter((row) => row.status === "skipped").length,
        paid: chosen.filter((row) => row.paidMinor > 0).length,
      };
      const now = clock.now();
      const moved = tx
        .update(importBatch)
        .set({ status: "done", summary, error: null, committedAt: now, updatedAt: now })
        .where(
          scoped(ownerId).where(importBatch, (t) =>
            and(eq(t.id, batchId), eq(t.status, "committing")),
          ),
        )
        .run();
      if (moved.changes === 0) throw new CommitStopped(T.errors.status);
      audit({ entity: "import_batch", entityId: batchId, ownerId, scope: "user", after: summary });
      return [...spare, ...uploads];
    });
  } catch (error) {
    if (error instanceof CommitStopped) return stop(ownerId, batchId, rows, error.message);
    failBatch(ownerId, batchId, T.errors.unexpected);
    throw error;
  }
  removeBlobs(ownerId, [...removed, previewBlobId(batchId)]);
}

function recordInputsOf(rows: PreviewRow[]): RecordInput[] {
  return rows.map((row) => ({
    key: row.key,
    source: row.source,
    record: row.record ?? null,
    errors: row.record ? [] : row.messages,
  }));
}

// Customers and catalog items from a table: checked again against the account, then one write.
function commitRecords(ownerId: string, batch: ImportBatch, stored: PreviewRow[]): void {
  const batchId = batch.id;
  const rows = analyzeRecords(db, ownerId, recordInputsOf(stored), decisionsOf(stored));
  if (rows.some(rowBlocks)) return stop(ownerId, batchId, rows, T.errors.blocked);
  const chosen = rows.filter(importsRow);
  let removed: string[];
  try {
    removed = mutate(importActor(ownerId), "import.commit", (tx, audit) => {
      for (const row of chosen) {
        const record = row.record!;
        if (record.target === "customers") {
          const parsed = customerInputSchema.safeParse(record.input);
          if (!parsed.success) throw new CommitStopped(parsed.error.issues[0]?.message ?? "");
          const { id: _ignored, ...values } = parsed.data;
          saveCustomerIn(tx, audit, ownerId, values, batchId);
        } else {
          const parsed = catalogInputSchema.safeParse(record.input);
          if (!parsed.success) throw new CommitStopped(parsed.error.issues[0]?.message ?? "");
          const { id: _ignored, ...values } = parsed.data;
          saveCatalogItemIn(tx, audit, ownerId, values, batchId);
        }
      }
      const uploads = takeFiles(tx, ownerId, batchId);
      const summary = {
        documents: chosen.length,
        duplicates: rows.filter((row) => row.status === "duplicate").length,
        skipped: rows.filter((row) => row.status === "skipped").length,
      };
      const now = clock.now();
      const moved = tx
        .update(importBatch)
        .set({ status: "done", summary, error: null, committedAt: now, updatedAt: now })
        .where(
          scoped(ownerId).where(importBatch, (t) =>
            and(eq(t.id, batchId), eq(t.status, "committing")),
          ),
        )
        .run();
      if (moved.changes === 0) throw new CommitStopped(T.errors.status);
      audit({ entity: "import_batch", entityId: batchId, ownerId, scope: "user", after: summary });
      return uploads;
    });
  } catch (error) {
    if (error instanceof CommitStopped) return stop(ownerId, batchId, rows, error.message);
    failBatch(ownerId, batchId, T.errors.unexpected);
    throw error;
  }
  removeBlobs(ownerId, [...removed, previewBlobId(batchId)]);
}
