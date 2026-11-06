import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { unzipSync } from "fflate";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { exportContents, type ExportInput } from "@/lib/export-filter";
import { setClockForTests } from "@/server/clock";
import { exportJob, file, invoice, job, schedulerState } from "@/server/db/schema";
import { buildIsdoc } from "@/server/isdoc/build";
import { parseIsdoc } from "@/server/isdoc/parse";
import { registerJob } from "@/server/jobs/registry";
import { drainHeavy } from "@/server/jobs/worker";
import { createCreditNote } from "@/server/services/credit-notes";
import { runExport } from "@/server/services/export-run";
import {
  createExport,
  ExportNotFoundError,
  openExport,
  recoverExportJob,
} from "@/server/services/exports";
import { invoicePdf } from "@/server/services/invoice-pdf";
import { loadInvoiceDocument } from "@/server/services/invoice-document";
import { cancelInvoice, issueInvoice } from "@/server/services/invoice-lifecycle";
import { getInvoice } from "@/server/services/invoices";
import { createTestDb } from "../helpers/db";
import { draftFor, seedCustomer, seedOwner, webActor } from "../helpers/fixtures-mail";
import { committed, editedIsdoc, importOwner, parsed, registerImportJobs } from "../helpers/import";
import { pdfText } from "../helpers/pdf";

vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-export-isdoc-")));

const db = createTestDb();
const NOW = new Date("2026-03-20T10:00:00Z");

beforeAll(() => {
  registerImportJobs();
  registerJob("export.run", { run: runExport, recover: recoverExportJob });
});
beforeEach(() => {
  db.delete(job).run();
  db.delete(schedulerState).run();
  setClockForTests({ now: () => NOW });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});
afterEach(() => {
  setClockForTests(null);
  vi.restoreAllMocks();
});

async function exported(owner: string, input: ExportInput) {
  const { id } = createExport(webActor(owner), input);
  await drainHeavy("w");
  return db.select().from(exportJob).where(eq(exportJob.id, id)).get()!;
}

function entries(owner: string, id: string): Record<string, Uint8Array> {
  return unzipSync(new Uint8Array(readFileSync(openExport(webActor(owner), id).path)));
}

function issued(owner: string, customerId: string) {
  const { id, revision } = draftFor(owner, customerId, { issueDate: "2026-03-01" });
  issueInvoice(webActor(owner), id, { revision });
  return id;
}

describe("export ISDOC", () => {
  test("[TST-015] exportované ISDOC se zpětně přečtou se stejnými částkami a vazbou dobropisu", async () => {
    const owner = seedOwner(db, NOW);
    const original = issued(owner, seedCustomer(owner));
    const credit = createCreditNote(webActor(owner), original);
    issueInvoice(webActor(owner), credit.id, { revision: getInvoice(owner, credit.id)!.revision });

    const row = await exported(owner, { kind: "invoices", format: "isdoc_zip" });
    expect(row.status).toBe("done");
    const docs = Object.values(entries(owner, row.id)).map((bytes) => parseIsdoc(bytes));
    const invoiceDoc = docs.find((doc) => doc.type === "invoice")!;
    const creditDoc = docs.find((doc) => doc.type === "credit_note")!;
    expect(invoiceDoc).toMatchObject({
      uuid: original,
      number: getInvoice(owner, original)!.number,
      totalMinor: 300_000,
      currency: "CZK",
    });
    // Positive in ISDOC, negated on reading (R-12).
    expect(creditDoc.totalMinor).toBe(-300_000);
    expect(creditDoc.originalDocuments).toMatchObject([{ uuid: original }]);
  });

  test("[EXP-005] neplatný ISDOC zastaví export a nic se nestáhne", async () => {
    const owner = seedOwner(db, NOW);
    const customerId = seedCustomer(owner);
    issued(owner, customerId);
    const broken = issued(owner, customerId);
    db.update(invoice).set({ taxableDate: "2026-02-30" }).where(eq(invoice.id, broken)).run();

    const row = await exported(owner, { kind: "invoices", format: "isdoc_zip" });
    expect(row.status).toBe("failed");
    expect(row.fileId).toBeNull();
    expect(row.reason).toContain(getInvoice(owner, broken)!.number!);
    expect(row.reason).toContain("nic se nestáhne");
    expect(() => openExport(webActor(owner), row.id)).toThrow(ExportNotFoundError);
    expect(db.select().from(file).where(eq(file.userId, owner)).all()).toEqual([]);

    db.update(invoice)
      .set({ currency: "EUR", exchangeRateMicros: null })
      .where(eq(invoice.id, broken))
      .run();
    const unconvertible = await exported(owner, { kind: "invoices", format: "isdoc_zip" });
    expect(unconvertible.status).toBe("failed");
    expect(unconvertible.reason).toContain("kurz");
  });

  test("jméno ../../x v čísle dokladu nevytvoří cestu v archivu", async () => {
    const owner = seedOwner(db, NOW);
    const customerId = seedCustomer(owner);
    const id = issued(owner, customerId);
    const twin = issued(owner, customerId);
    db.update(invoice).set({ number: "../../x" }).where(eq(invoice.id, id)).run();
    db.update(invoice).set({ number: "..\\..\\x" }).where(eq(invoice.id, twin)).run();

    for (const format of ["pdf_zip", "isdoc_zip"] as const) {
      const row = await exported(owner, { kind: "invoices", format });
      expect(row.status, format).toBe("done");
      const names = Object.keys(entries(owner, row.id));
      expect(names, format).toHaveLength(2);
      for (const name of names) {
        expect(name).not.toMatch(/[\\/]|\.\./);
        expect(name.startsWith(".")).toBe(false);
      }
      expect(new Set(names.map((name) => name.toLowerCase())).size).toBe(2);
    }
  });

  test("[TST-015] kód platby ze zdroje se vrátí do exportu i se splatností a VS", async () => {
    const owner = importOwner(db, NOW);
    const bytes = editedIsdoc(
      "faktura-czk.isdoc",
      /<PaymentMeans>[\s\S]*<\/PaymentMeans>/,
      "<PaymentMeans><Payment><PaidAmount>3350.50</PaidAmount><PaymentMeansCode>10</PaymentMeansCode>" +
        "<Details><PaymentDueDate>2026-02-16</PaymentDueDate><ID></ID><BankCode></BankCode>" +
        "<Name></Name><IBAN></IBAN><BIC></BIC><VariableSymbol>20260001</VariableSymbol>" +
        "</Details></Payment></PaymentMeans>",
    );
    const batch = await parsed(owner, [{ name: "hotove.isdoc", bytes }]);
    await committed(db, owner, batch.id);
    const imported = db.select().from(invoice).where(eq(invoice.userId, owner)).get()!;
    expect(imported).toMatchObject({ accountSnapshot: null, importPaymentCode: "10" });

    const row = await exported(owner, { kind: "invoices", format: "isdoc_zip" });
    expect(row.status).toBe("done");
    const [xml] = Object.values(entries(owner, row.id));
    const text = new TextDecoder().decode(xml);
    expect(text).toContain("<PaymentMeansCode>10</PaymentMeansCode>");
    expect(parseIsdoc(xml!)).toMatchObject({ dueDate: "2026-02-16", variableSymbol: "20260001" });
    const pdf = (await pdfText((await invoicePdf(owner, imported.id)).data)).join(" ");
    expect(pdf).not.toContain("Převodem");
  });

  test("[EXP-005] uložený kód platby mimo výčet ISDOC se do exportu nedostane", async () => {
    const owner = importOwner(db, NOW);
    const bytes = editedIsdoc(
      "faktura-czk.isdoc",
      /<PaymentMeans>[\s\S]*<\/PaymentMeans>/,
      "<PaymentMeans><Payment><PaidAmount>3350.50</PaidAmount><PaymentMeansCode>10</PaymentMeansCode>" +
        "<Details><PaymentDueDate>2026-02-16</PaymentDueDate><ID></ID><BankCode></BankCode>" +
        "<Name></Name><IBAN></IBAN><BIC></BIC></Details></Payment></PaymentMeans>",
    );
    const batch = await parsed(owner, [{ name: "hotove.isdoc", bytes }]);
    await committed(db, owner, batch.id);
    const imported = db.select().from(invoice).where(eq(invoice.userId, owner)).get()!;
    db.update(invoice).set({ importPaymentCode: "99" }).where(eq(invoice.id, imported.id)).run();

    const xml = buildIsdoc(loadInvoiceDocument(owner, imported.id)!, {
      uuid: imported.importUuid!,
    });
    expect(xml).not.toContain("<PaymentMeans>");

    const row = await exported(owner, { kind: "invoices", format: "isdoc_zip" });
    expect(row.status).toBe("done");
  });

  test("[EXP-001] ISDOC ZIP bez výběru stavu vynechá storna", async () => {
    const owner = seedOwner(db, NOW);
    const customerId = seedCustomer(owner);
    const kept = issued(owner, customerId);
    const cancelled = issued(owner, customerId);
    cancelInvoice(webActor(owner), cancelled);
    const names = async (filter: ExportInput["filter"]) => {
      const row = await exported(owner, { kind: "invoices", format: "isdoc_zip", filter });
      return Object.values(entries(owner, row.id)).map((xml) => parseIsdoc(xml).uuid);
    };
    expect(await names({})).toEqual([kept]);
    expect(await names({ statuses: ["cancelled"] })).toEqual([cancelled]);
    expect(exportContents("invoices", "isdoc_zip")).toMatch(/[Ss]tornované/);
  });

  test("importovaný doklad bez účtu netvrdí v ISDOC ani v PDF platbu hotově", async () => {
    const owner = importOwner(db, NOW);
    const bytes = editedIsdoc("faktura-czk.isdoc", /<PaymentMeans>[\s\S]*<\/PaymentMeans>/, "");
    const batch = await parsed(owner, [{ name: "bez-uctu.isdoc", bytes }]);
    expect(batch.rows[0]!.status).not.toBe("error");
    await committed(db, owner, batch.id);
    const imported = db.select().from(invoice).where(eq(invoice.userId, owner)).get()!;
    expect(imported).toMatchObject({ external: true, accountSnapshot: null });

    const doc = loadInvoiceDocument(owner, imported.id)!;
    const xml = buildIsdoc(doc, { uuid: imported.importUuid! });
    expect(xml).not.toContain("<PaymentMeansCode>10</PaymentMeansCode>");

    const row = await exported(owner, { kind: "invoices", format: "isdoc_zip" });
    expect(row.status).toBe("done");
    const [exportedXml] = Object.values(entries(owner, row.id));
    expect(new TextDecoder().decode(exportedXml)).not.toContain("PaymentMeansCode>10<");

    const text = (await pdfText((await invoicePdf(owner, imported.id)).data)).join(" ");
    expect(text).not.toContain("Hotově");
  });
});
