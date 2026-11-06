import "server-only";
import { fitText } from "@/lib/text-limits";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { MAX_BATCH_DOCUMENTS, type PreviewRow } from "@/lib/import-preview";
import { calendarDateInPrague } from "@/lib/number-format";
import { extractEmbeddedXml } from "@/lib/safe-input/pdf-embedded";
import {
  InputRejected,
  PDF_LIMITS,
  sniffContent,
  XML_LIMITS,
  ZIP_LIMITS,
  type InputRejectedCode,
} from "@/lib/safe-input/limits";
import { parseXml } from "@/lib/safe-input/xml";
import { readZipEntries } from "@/lib/safe-input/zip";
import { TEXTS } from "@/lib/texts";
import { clock } from "../clock";
import { db } from "../db";
import { file, importBatch, type ImportBatch, type Job } from "../db/schema";
import { scoped } from "../db/scoped";
import { readBlob, writeBlob } from "../files/store";
import { isdocFromXml, IsdocInvalid } from "../isdoc/parse";
import { isdocRules } from "../isdoc/rules";
import { validateIsdoc } from "../isdoc/validate";
import { setImportProgress } from "../jobs/import-progress";
import { yieldHeavy } from "../jobs/worker";
import { ServiceError } from "./access";
import { analyzeRows, type RowInput } from "./import-analyze";
import {
  failBatch,
  findBatch,
  importActor,
  removeBlobs,
  uploadsOf,
  writePreview,
} from "./import-batch";
import { parseTabular } from "./import-tabular";
import { mutate } from "./mutation";

const T = TEXTS.importing;
const REJECTED: Record<InputRejectedCode, string> = T.rejected;
const DOCUMENT_NAME = /\.(isdoc|xml)$/i;
const PDF_NAME = /\.pdf$/i;
const VALIDATE_BYTES = 8 * 1024 * 1024;
const VALIDATE_DOCUMENTS = 50;
const PDF_PASS_BYTES = 32 * 1024 * 1024;
const PROGRESS_EVERY = 25;

class BatchRejected extends Error {}

export function rejectionText(error: InputRejected): string {
  const text = REJECTED[error.code];
  return error.entry ? `${error.entry}: ${text}` : text;
}

type Source = RowInput & {
  stem: string;
  upload: string;
  pdfEntry: string | null;
  pdfSize: number;
};
type LoosePdf = { stem: string; upload: string; entry: string | null; size: number };

const stemOf = (name: string) => name.replace(/\.[^./\\]*$/, "").toLowerCase();

// Validation runs in groups: xmllint has a start-up cost per call, and a group bounds the bytes
// held at once.
class Reader {
  private pending: { source: Source; xml: Uint8Array }[] = [];
  private bytes = 0;
  readonly sources: Source[] = [];
  readonly pdfs: LoosePdf[] = [];
  readonly warnings: string[] = [];
  private seen = 0;

  constructor(
    private readonly job: Job,
    private readonly ownerId: string,
    private readonly batchId: string,
  ) {}

  private count(): void {
    this.seen += 1;
    if (this.sources.length + this.pending.length > MAX_BATCH_DOCUMENTS) {
      throw new BatchRejected(T.errors.tooMany(MAX_BATCH_DOCUMENTS));
    }
    if (this.seen % PROGRESS_EVERY === 0) setImportProgress(this.ownerId, this.batchId, this.seen);
  }

  async document(
    label: string,
    upload: string,
    xml: Uint8Array,
    pdfEntry: string | null,
    pdfSize = 0,
  ) {
    const source: Source = {
      key: `r${this.sources.length + this.pending.length + 1}`,
      source: label,
      document: null,
      errors: [],
      pdfFileId: null,
      stem: stemOf(label),
      upload,
      pdfEntry,
      pdfSize,
    };
    this.pending.push({ source, xml });
    this.bytes += xml.length;
    this.count();
    if (this.pending.length >= VALIDATE_DOCUMENTS || this.bytes >= VALIDATE_BYTES)
      await this.flush();
  }

  failed(label: string, upload: string, message: string) {
    this.sources.push({
      key: `r${this.sources.length + this.pending.length + 1}`,
      source: label,
      document: null,
      errors: [message],
      pdfFileId: null,
      stem: stemOf(label),
      upload,
      pdfEntry: null,
      pdfSize: 0,
    });
    this.count();
  }

  async flush(): Promise<void> {
    const batch = this.pending;
    this.pending = [];
    this.bytes = 0;
    if (batch.length === 0) return;
    const results = await validateIsdoc(
      batch.map((item) => ({ name: item.source.key, xml: item.xml })),
    );
    batch.forEach((item, i) => {
      const errors = results[i]!.errors;
      if (errors.length === 0) {
        try {
          const root = parseXml(item.xml, XML_LIMITS);
          errors.push(...isdocRules(root));
          if (errors.length === 0) item.source.document = isdocFromXml(root);
        } catch (error) {
          if (error instanceof IsdocInvalid) errors.push(error.message);
          else if (error instanceof InputRejected) errors.push(rejectionText(error));
          else throw error;
        }
      }
      item.source.errors = errors.slice(0, 5);
      this.sources.push(item.source);
    });
    this.sources.sort((a, b) => Number(a.key.slice(1)) - Number(b.key.slice(1)));
    await yieldHeavy(this.job);
  }

  // The PDF itself: a carried ISDOC makes it a document with its own original attached.
  async pdf(label: string, upload: string, bytes: Uint8Array, entry: string | null) {
    let xml: Uint8Array | null;
    try {
      xml = extractEmbeddedXml(bytes, PDF_LIMITS);
    } catch (error) {
      if (!(error instanceof InputRejected)) throw error;
      this.failed(label, upload, rejectionText(error));
      return;
    }
    if (xml) await this.document(label, upload, xml, entry ?? "", bytes.length);
    else this.pdfs.push({ stem: stemOf(label), upload, entry, size: bytes.length });
  }
}

async function readUpload(reader: Reader, upload: { id: string; name: string }, ownerId: string) {
  const bytes = new Uint8Array(readBlob(ownerId, upload.id));
  const kind = sniffContent(bytes);
  if (kind === "xml") return reader.document(upload.name, upload.id, bytes, null);
  if (kind === "pdf") return reader.pdf(upload.name, upload.id, bytes, null);
  if (kind !== "zip") return reader.failed(upload.name, upload.id, T.errors.unsupported);
  // onEntry stays free of side effects and never throws: the archive may still be refused after
  // it, and readZipEntries would report any other error as a corrupt archive.
  let fatal: unknown = null;
  // The second pass finds a PDF by its name, so a repeated name would hand one document the PDF
  // of another: only the first entry of a name is read.
  const seen = new Set<string>();
  const repeated = new Set<string>();
  const summary = await readZipEntries(
    bytes,
    { ...ZIP_LIMITS, select: (name) => DOCUMENT_NAME.test(name) || PDF_NAME.test(name) },
    async (entry) => {
      if (fatal) return;
      if (seen.has(entry.name)) {
        repeated.add(entry.name);
        return;
      }
      seen.add(entry.name);
      try {
        if (entry.kind === "xml") await reader.document(entry.name, upload.id, entry.bytes, null);
        else if (entry.kind === "pdf")
          await reader.pdf(entry.name, upload.id, entry.bytes, entry.name);
      } catch (error) {
        fatal = error;
      }
    },
  );
  if (fatal) throw fatal;
  for (const warning of summary.warnings) reader.warnings.push(T.rows.nestedArchive(warning.entry));
  for (const name of repeated) reader.warnings.push(T.rows.duplicateEntry(name));
}

type Wanted = { upload: string; entry: string | null; size: number; sources: Source[] };

function pairPdfs(reader: Reader): Wanted[] {
  const wanted = new Map<string, Wanted>();
  const want = (upload: string, entry: string | null, size: number, source: Source) => {
    const id = `${upload}\u0000${entry ?? ""}`;
    const item = wanted.get(id) ?? { upload, entry, size, sources: [] };
    item.sources.push(source);
    wanted.set(id, item);
  };
  for (const source of reader.sources) {
    if (!source.document) continue;
    if (source.pdfEntry !== null) {
      want(source.upload, source.pdfEntry || null, source.pdfSize, source);
      continue;
    }
    const pdf =
      reader.pdfs.find((item) => item.stem === source.stem && item.upload === source.upload) ??
      reader.pdfs.find((item) => item.stem === source.stem);
    if (pdf) want(pdf.upload, pdf.entry, pdf.size, source);
  }
  for (const pdf of reader.pdfs) {
    if (
      ![...wanted.values()].some((item) => item.upload === pdf.upload && item.entry === pdf.entry)
    ) {
      reader.warnings.push(T.rows.ignoredPdf(pdf.entry ?? pdf.stem));
    }
  }
  return [...wanted.values()];
}

// A second pass over an archive that already passed: entries go out in groups bounded by size,
// never all of a large archive at once.
async function storePdfs(
  job: Job,
  ownerId: string,
  batchId: string,
  wanted: Wanted[],
): Promise<void> {
  const loose = wanted.filter((item) => item.entry === null);
  if (loose.length > 0) {
    mutate(importActor(ownerId), "import.parse", (tx, audit) => {
      tx.update(file)
        .set({ kind: "import_pdf", mimeType: "application/pdf" })
        .where(
          scoped(ownerId).where(file, (t) =>
            and(
              eq(t.importBatchId, batchId),
              inArray(
                t.id,
                loose.map((item) => item.upload),
              ),
            ),
          ),
        )
        .run();
      audit({
        entity: "import_batch",
        entityId: batchId,
        ownerId,
        scope: "user",
        after: { pdfs: loose.length },
      });
    });
    for (const item of loose) for (const source of item.sources) source.pdfFileId = item.upload;
  }
  const inZip = wanted.filter((item) => item.entry !== null);
  const byUpload = new Map<string, Wanted[]>();
  for (const item of inZip) byUpload.set(item.upload, [...(byUpload.get(item.upload) ?? []), item]);
  for (const [uploadId, items] of byUpload) {
    const bytes = new Uint8Array(readBlob(ownerId, uploadId));
    let group: Wanted[] = [];
    let size = 0;
    const groups: Wanted[][] = [];
    for (const item of items) {
      if (group.length > 0 && size + item.size > PDF_PASS_BYTES) {
        groups.push(group);
        group = [];
        size = 0;
      }
      group.push(item);
      size += item.size;
    }
    if (group.length > 0) groups.push(group);
    for (const part of groups) {
      const names = new Set(part.map((item) => item.entry!));
      const summary = await readZipEntries(
        bytes,
        { ...ZIP_LIMITS, select: (name) => names.has(name) },
        (entry) => (entry.kind === "pdf" ? { name: entry.name, bytes: entry.bytes } : null),
      );
      const stored: { item: Wanted; id: string; size: number }[] = [];
      for (const result of summary.results) {
        if (!result) continue;
        const item = part.find((candidate) => candidate.entry === result.name);
        if (!item || stored.some((done) => done.item === item)) continue;
        const id = randomUUID();
        writeBlob(ownerId, id, Buffer.from(result.bytes));
        stored.push({ item, id, size: result.bytes.length });
      }
      try {
        mutate(importActor(ownerId), "import.parse", (tx, audit) => {
          const now = clock.now();
          for (const { item, id, size: length } of stored) {
            tx.insert(file)
              .values({
                id,
                userId: ownerId,
                kind: "import_pdf",
                mimeType: "application/pdf",
                name: (item.entry!.split(/[\\/]/).at(-1) ?? "doklad.pdf").slice(0, 120),
                size: length,
                importBatchId: batchId,
                createdAt: now,
              })
              .run();
          }
          audit({
            entity: "import_batch",
            entityId: batchId,
            ownerId,
            scope: "user",
            after: { pdfs: stored.length },
          });
        });
      } catch (error) {
        removeBlobs(
          ownerId,
          stored.map((done) => done.id),
        );
        throw error;
      }
      for (const { item, id } of stored) for (const source of item.sources) source.pdfFileId = id;
      await yieldHeavy(job);
    }
  }
}

function summaryOf(rows: PreviewRow[]): Record<string, number> {
  const count = (status: PreviewRow["status"]) =>
    rows.filter((row) => row.status === status).length;
  return {
    documents: rows.length,
    ok: count("ok"),
    warnings: count("warning"),
    errors: count("error"),
    duplicates: count("duplicate"),
    paid: rows.filter((row) => row.paidMinor > 0).length,
  };
}

function finishParse(
  ownerId: string,
  batch: ImportBatch,
  status: "mapping" | "ready",
  rows: PreviewRow[],
  warnings: string[],
): void {
  const summary = status === "ready" ? summaryOf(rows) : null;
  mutate(importActor(ownerId), "import.parsed", (tx, audit) => {
    const moved = tx
      .update(importBatch)
      .set({
        status,
        progress: rows.length,
        progressTotal: rows.length,
        revision: batch.revision + 1,
        summary,
        error:
          warnings.length > 0
            ? fitText("import_batch", "error", warnings.slice(0, 20).join("\n"))
            : null,
        updatedAt: clock.now(),
      })
      .where(
        scoped(ownerId).where(importBatch, (t) => and(eq(t.id, batch.id), eq(t.status, "parsing"))),
      )
      .run();
    if (moved.changes === 0) throw new BatchRejected(T.errors.status);
    audit({
      entity: "import_batch",
      entityId: batch.id,
      ownerId,
      scope: "user",
      after: summary ?? { status },
    });
  });
}

async function parseIsdoc(job: Job, ownerId: string, batch: ImportBatch): Promise<void> {
  const batchId = batch.id;
  const uploads = uploadsOf(db, ownerId, batchId);
  const reader = new Reader(job, ownerId, batchId);
  for (const upload of uploads) await readUpload(reader, upload, ownerId);
  await reader.flush();
  if (reader.sources.length === 0) throw new BatchRejected(T.errors.noDocuments);
  const wanted = pairPdfs(reader);
  await storePdfs(job, ownerId, batchId, wanted);
  const today = calendarDateInPrague(clock.now());
  const rows = analyzeRows(db, ownerId, reader.sources, today);
  writePreview(ownerId, batchId, { rows });
  finishParse(ownerId, batch, "ready", rows, reader.warnings);
}

export async function runImportParse(job: Job): Promise<void> {
  const ownerId = job.userId;
  const batchId = job.payload.batchId;
  if (!ownerId || typeof batchId !== "string") throw new Error("Úloha importu nemá dávku");
  const batch = findBatch(db, ownerId, batchId);
  if (batch.status !== "parsing") return;
  try {
    if (batch.kind === "tabular") {
      const result = await parseTabular(job, ownerId, batch);
      writePreview(ownerId, batchId, { rows: result.rows, sample: result.sample });
      finishParse(ownerId, batch, result.status, result.rows, []);
    } else {
      await parseIsdoc(job, ownerId, batch);
    }
  } catch (error) {
    if (error instanceof BatchRejected) return failBatch(ownerId, batchId, error.message);
    if (error instanceof InputRejected) return failBatch(ownerId, batchId, rejectionText(error));
    // Refusals of a table (no header, a mapping that no longer fits) carry their own text.
    if (error instanceof ServiceError && batch.kind === "tabular") {
      return failBatch(ownerId, batchId, error.message);
    }
    failBatch(ownerId, batchId, T.errors.unexpected);
    throw error;
  }
}
