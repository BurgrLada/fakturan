import { closeSync, existsSync, mkdtempSync, readdirSync, readFileSync, readSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { strFromU8, unzipSync } from "fflate";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { EXPORT_LIMITS, type ExportInput } from "@/lib/export-filter";
import { TABULAR_LIMITS } from "@/lib/safe-input/limits";
import { readXlsx } from "@/lib/safe-input/xlsx-reader";
import { TEXTS } from "@/lib/texts";
import { setClockForTests } from "@/server/clock";
import { encryptSecret } from "@/server/crypto";
import {
  auditLog,
  bankMailbox,
  exportJob,
  file,
  invoice,
  invoiceLine,
  job,
  mailSettings,
  notification,
  rateLimit,
  schedulerState,
} from "@/server/db/schema";
import { RATE_RULES } from "@/server/rate-limit";
import { RateLimitError, ServiceError } from "@/server/services/access";
import { blobPath } from "@/server/files/store";
import { registerJob } from "@/server/jobs/registry";
import { drainHeavy } from "@/server/jobs/worker";
import { saveCatalogItem } from "@/server/services/catalog";
import { createCreditNote } from "@/server/services/credit-notes";
import { saveCustomer } from "@/server/services/customers";
import { runExport } from "@/server/services/export-run";
import {
  createExport,
  ExportNotFoundError,
  listExports,
  openExport,
  purgeExpiredExports,
  recoverExportJob,
} from "@/server/services/exports";
import { issueInvoice } from "@/server/services/invoice-lifecycle";
import { saveTemplate } from "@/server/services/invoice-templates";
import { getInvoice, newDraftDefaults } from "@/server/services/invoices";
import { addPayment } from "@/server/services/payments";
import { createTestDb } from "../helpers/db";
import { readOpened } from "../helpers/opened";
import {
  draftFor,
  issuedInvoice,
  seedCustomer,
  seedOwner,
  webActor,
} from "../helpers/fixtures-mail";
import { pdfText } from "../helpers/pdf";

const sessionUser = vi.hoisted(() => ({ id: null as string | null }));
vi.mock("@/server/auth/session", () => ({
  actorFromRequest: async () => ({ userId: sessionUser.id, source: "web" }),
}));
vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-exports-")));

const db = createTestDb();
const NOW = new Date("2026-03-20T10:00:00Z");
let current = NOW;
const E = TEXTS.exporting.errors;
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

beforeAll(() => registerJob("export.run", { run: runExport, recover: recoverExportJob }));
beforeEach(() => {
  db.delete(job).run();
  db.delete(schedulerState).run();
  current = NOW;
  setClockForTests({ now: () => current });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});
afterEach(() => {
  setClockForTests(null);
  vi.restoreAllMocks();
});

const exportRow = (id: string) => db.select().from(exportJob).where(eq(exportJob.id, id)).get()!;

async function exported(owner: string, input: ExportInput) {
  const { id } = createExport(webActor(owner), input);
  await drainHeavy("w");
  return exportRow(id);
}

function bytesOf(owner: string, id: string): Uint8Array {
  return readOpened(openExport(webActor(owner), id));
}

function csvLines(owner: string, id: string): string[] {
  const text = decoder.decode(bytesOf(owner, id));
  expect(text.startsWith("﻿")).toBe(true);
  return text.slice(1).split("\r\n").filter(Boolean);
}

function issuedOn(owner: string, customerId: string, issueDate: string, over = {}) {
  const { id, revision } = draftFor(owner, customerId, { issueDate, dueDate: issueDate, ...over });
  issueInvoice(webActor(owner), id, { revision });
  return id;
}

function customerNamed(owner: string, name: string): string {
  return saveCustomer(webActor(owner), {
    name,
    street: "",
    city: "",
    zip: "",
    country: "Česká republika",
    ico: "",
    dic: "",
    email: "",
    extraEmails: [],
    phone: "",
    note: "",
    dueDays: null,
    language: null,
    currency: null,
    designId: null,
    remindersEnabled: null,
  }).id;
}

const numberOf = (owner: string, id: string) => getInvoice(owner, id)!.number!;

describe("hromadný export", () => {
  test("[EXP-001] ZIP PDF, ZIP ISDOC, CSV i Excel obsahují vybrané doklady", async () => {
    const owner = seedOwner(db, NOW);
    const customerId = seedCustomer(owner);
    const first = issuedOn(owner, customerId, "2026-03-01");
    const second = issuedOn(owner, customerId, "2026-03-02");
    draftFor(owner, customerId);
    const numbers = [numberOf(owner, first), numberOf(owner, second)];

    const pdf = await exported(owner, { kind: "invoices", format: "pdf_zip" });
    expect(pdf.status).toBe("done");
    const pdfs = unzipSync(bytesOf(owner, pdf.id));
    expect(Object.keys(pdfs).sort()).toEqual(numbers.map((n) => `${n}.pdf`).sort());
    for (const entry of Object.values(pdfs)) {
      expect(Buffer.from(entry.subarray(0, 5)).toString("latin1")).toBe("%PDF-");
    }

    const isdoc = await exported(owner, { kind: "invoices", format: "isdoc_zip" });
    const docs = unzipSync(bytesOf(owner, isdoc.id));
    expect(Object.keys(docs).sort()).toEqual(numbers.map((n) => `${n}.isdoc`).sort());

    const csv = await exported(owner, { kind: "invoices", format: "csv" });
    const lines = csvLines(owner, csv.id);
    expect(lines[0]).toContain("Číslo;Typ;Stav");
    expect(lines[0]).toContain("Počet položek");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain(numbers[0]);
    expect(lines[1]).toContain("3000,00");
    expect(lines[1]!.endsWith(";1")).toBe(true);

    const xlsx = await exported(owner, { kind: "invoices", format: "xlsx" });
    const bytes = bytesOf(owner, xlsx.id);
    const sheet = await readXlsx(bytes, TABULAR_LIMITS);
    expect(sheet.rows.map((row) => row[0])).toEqual(["Číslo", ...numbers]);
    const files = unzipSync(bytes);
    expect(strFromU8(files["xl/workbook.xml"]!)).toContain('name="Položky"');
    const lineSheet = strFromU8(files["xl/worksheets/sheet2.xml"]!);
    expect(lineSheet.match(/Konzultace/g)).toHaveLength(2);

    expect(
      db.select().from(auditLog).where(eq(auditLog.action, "export.create")).all().length,
    ).toBeGreaterThanOrEqual(4);
  });

  test("[EXP-002] filtr období, typu, zákazníka a stavu se protínají, cizí zákazník dá prázdno", async () => {
    const owner = seedOwner(db, NOW);
    const alfa = seedCustomer(owner);
    const beta = customerNamed(owner, "Beta a. s.");
    const marchAlfa = issuedOn(owner, alfa, "2026-03-01");
    issuedOn(owner, alfa, "2026-01-15");
    issuedOn(owner, beta, "2026-03-05");
    const credit = createCreditNote(webActor(owner), marchAlfa);
    issueInvoice(webActor(owner), credit.id, { revision: getInvoice(owner, credit.id)!.revision });

    const rows = async (filter: ExportInput["filter"]) => {
      const row = await exported(owner, { kind: "invoices", format: "csv", filter });
      return csvLines(owner, row.id).slice(1);
    };
    expect(await rows({})).toHaveLength(4);
    expect(await rows({ from: "2026-03-01", to: "2026-03-31" })).toHaveLength(3);
    const crossed = await rows({
      from: "2026-03-01",
      to: "2026-03-31",
      customerId: alfa,
      types: ["invoice"],
      statuses: ["issued", "credited"],
    });
    expect(crossed).toHaveLength(1);
    expect(crossed[0]).toContain(numberOf(owner, marchAlfa));
    expect(await rows({ types: ["credit_note"] })).toHaveLength(1);
    expect(await rows({ statuses: ["paid"] })).toHaveLength(0);

    const other = seedOwner(db, NOW);
    const foreignCustomer = seedCustomer(other);
    issuedInvoice(other, foreignCustomer);
    expect(await rows({ customerId: foreignCustomer })).toHaveLength(0);
  });

  test("[EXP-003] export zákazníků, ceníku, plateb a šablon", async () => {
    const owner = seedOwner(db, NOW);
    const customerId = seedCustomer(owner);
    const invoiceId = issuedOn(owner, customerId, "2026-03-01");
    addPayment(webActor(owner), invoiceId, {
      revision: getInvoice(owner, invoiceId)!.revision,
      paidOn: "2026-03-10",
      amountMinor: 100_000,
      currency: "CZK",
      method: "transfer",
      note: "Záloha od klienta",
    });
    saveCatalogItem(webActor(owner), {
      name: "Hodina práce",
      description: "",
      unit: "hod",
      priceMinor: 120_000,
      currency: "CZK",
      category: "",
      tags: ["služby"],
    });
    saveTemplate(webActor(owner), {
      name: "Měsíční paušál",
      customerId,
      document: { ...newDraftDefaults(owner, customerId), type: "invoice", dueDays: 14, lines: [] },
    });

    const customers = await exported(owner, { kind: "customers", format: "csv" });
    expect(csvLines(owner, customers.id)[1]).toContain("Alfa s.r.o.");

    const catalog = await exported(owner, { kind: "catalog", format: "xlsx" });
    const catalogSheet = await readXlsx(bytesOf(owner, catalog.id), TABULAR_LIMITS);
    expect(catalogSheet.rows[1]).toContain("Hodina práce");
    expect(catalogSheet.rows[1]).toContain("1200.00");

    const payments = await exported(owner, {
      kind: "payments",
      format: "csv",
      filter: { from: "2026-03-01" },
    });
    const paymentLines = csvLines(owner, payments.id);
    expect(paymentLines).toHaveLength(2);
    expect(paymentLines[1]).toContain(numberOf(owner, invoiceId));
    expect(paymentLines[1]).toContain("1000,00");
    const none = await exported(owner, {
      kind: "payments",
      format: "csv",
      filter: { from: "2026-04-01" },
    });
    expect(csvLines(owner, none.id)).toHaveLength(1);

    const templates = await exported(owner, { kind: "templates", format: "json" });
    const parsed = JSON.parse(decoder.decode(bytesOf(owner, templates.id))) as {
      format: string;
      templates: { name: string; document: { dueDays: number } }[];
    };
    expect(parsed.format).toBe("fakturan.invoice-templates");
    expect(parsed.templates).toHaveLength(1);
    expect(parsed.templates[0]).toMatchObject({
      name: "Měsíční paušál",
      document: { dueDays: 14 },
    });
    expect(JSON.stringify(parsed)).not.toContain(owner);
  });

  test("[EXP-007] úloha běží na pozadí s průběhem", async () => {
    const owner = seedOwner(db, NOW);
    const customerId = seedCustomer(owner);
    issuedOn(owner, customerId, "2026-03-01");
    issuedOn(owner, customerId, "2026-03-02");
    const { id } = createExport(webActor(owner), { kind: "invoices", format: "csv" });
    expect(exportRow(id)).toMatchObject({ status: "queued", fileId: null });
    const queued = db.select().from(job).where(eq(job.userId, owner)).all();
    expect(queued).toMatchObject([{ kind: "export.run", status: "pending", maxAttempts: 1 }]);
    expect(listExports(owner).map((row) => row.id)).toEqual([id]);

    await drainHeavy("w");
    const done = exportRow(id);
    expect(done).toMatchObject({ status: "done", progress: 2, progressTotal: 2 });
    expect(done.expiresAt!.getTime() - NOW.getTime()).toBe(7 * 86_400_000);
    const notice = db.select().from(notification).where(eq(notification.userId, owner)).all();
    expect(notice).toMatchObject([{ kind: "export_ready", entityType: "export", entityId: id }]);
  });

  test("[EXP-007] výsledek je 7 dní, po vypršení 404 a soubor zmizí", async () => {
    const owner = seedOwner(db, NOW);
    issuedOn(owner, seedCustomer(owner), "2026-03-01");
    const row = await exported(owner, { kind: "invoices", format: "csv" });
    const path = blobPath(owner, row.fileId!);
    expect(readOpened(openExport(webActor(owner), row.id)).length).toBeGreaterThan(0);
    expect(existsSync(path)).toBe(true);
    expect(
      db.select().from(auditLog).where(eq(auditLog.action, "export.download")).all().length,
    ).toBeGreaterThan(0);

    current = new Date(NOW.getTime() + 7 * 86_400_000 - 60_000);
    expect(readOpened(openExport(webActor(owner), row.id)).length).toBeGreaterThan(0);
    current = new Date(NOW.getTime() + 7 * 86_400_000);
    expect(() => openExport(webActor(owner), row.id)).toThrow(ExportNotFoundError);

    purgeExpiredExports(current);
    expect(existsSync(path)).toBe(false);
    expect(exportRow(row.id)).toMatchObject({ status: "expired", fileId: null });
    expect(db.select().from(file).where(eq(file.id, row.fileId!)).get()).toBeUndefined();
  });

  test("[EXP-008] =1+1 je neutralizované, -500,00 zůstává číslo", async () => {
    const owner = seedOwner(db, NOW);
    const customerId = customerNamed(owner, "=1+1");
    const small = issuedOn(owner, customerId, "2026-03-01", {
      lines: [
        {
          catalogItemId: null,
          name: "@SUM(A1)",
          description: "",
          quantityMilli: 1000,
          unit: "ks",
          unitPriceMinor: 50_000,
          discountKind: "none",
          discountValue: 0,
        },
      ],
    });
    const credit = createCreditNote(webActor(owner), small);
    issueInvoice(webActor(owner), credit.id, { revision: getInvoice(owner, credit.id)!.revision });

    const csv = await exported(owner, { kind: "invoices", format: "csv" });
    const lines = csvLines(owner, csv.id);
    const creditLine = lines.find((line) => line.includes(numberOf(owner, credit.id)))!;
    expect(creditLine).toContain(";'=1+1;");
    expect(creditLine).toContain(";-500,00;");
    expect(creditLine).not.toContain("'-500");

    const xlsx = await exported(owner, { kind: "invoices", format: "xlsx" });
    const files = unzipSync(bytesOf(owner, xlsx.id));
    const documents = strFromU8(files["xl/worksheets/sheet1.xml"]!);
    expect(documents).toContain('t="inlineStr"><is><t xml:space="preserve">=1+1</t>');
    expect(documents).toContain("<v>-500.00</v>");
    expect(strFromU8(files["xl/worksheets/sheet2.xml"]!)).toContain(
      't="inlineStr"><is><t xml:space="preserve">@SUM(A1)</t>',
    );
    expect(documents).not.toContain("<f>");

    const customers = await exported(owner, { kind: "customers", format: "csv" });
    expect(csvLines(owner, customers.id)[1]!.startsWith("'=1+1")).toBe(true);
  });

  test("[EXP-009] žádný výstup neobsahuje heslo ani jeho šifrovaný tvar", async () => {
    const owner = seedOwner(db, NOW);
    const customerId = seedCustomer(owner);
    issuedOn(owner, customerId, "2026-03-01");
    const secrets = ["smtp-heslo-7Qx9", "imap-heslo-4Kd2"];
    const smtpEnc = encryptSecret(secrets[0]!);
    const imapEnc = encryptSecret(secrets[1]!);
    db.insert(mailSettings)
      .values({
        userId: owner,
        smtpHost: "smtp.example.cz",
        smtpPasswordEnc: smtpEnc,
        updatedAt: NOW,
      })
      .run();
    db.insert(bankMailbox)
      .values({
        userId: owner,
        host: "imap.example.cz",
        port: 993,
        tls: "implicit",
        username: "avizo",
        passwordEnc: imapEnc,
        updatedAt: NOW,
      })
      .run();
    saveTemplate(webActor(owner), {
      name: "Šablona",
      customerId,
      document: { ...newDraftDefaults(owner, customerId), type: "invoice", dueDays: 14, lines: [] },
    });
    const needles = [...secrets, smtpEnc, imapEnc, smtpEnc.slice(0, 24), imapEnc.slice(0, 24)];

    const inputs: ExportInput[] = [
      { kind: "invoices", format: "pdf_zip" },
      { kind: "invoices", format: "isdoc_zip" },
      { kind: "invoices", format: "csv" },
      { kind: "invoices", format: "xlsx" },
      { kind: "customers", format: "csv" },
      { kind: "customers", format: "xlsx" },
      { kind: "catalog", format: "csv" },
      { kind: "payments", format: "xlsx" },
      { kind: "templates", format: "json" },
    ];
    for (const input of inputs) {
      const row = await exported(owner, input);
      expect([row.status, row.reason], `${input.kind} ${input.format}`).toEqual(["done", null]);
      const bytes = bytesOf(owner, row.id);
      const texts: string[] = [];
      if (input.format === "csv" || input.format === "json") texts.push(decoder.decode(bytes));
      else {
        for (const [name, entry] of Object.entries(unzipSync(bytes))) {
          texts.push(name, decoder.decode(entry));
          if (name.endsWith(".pdf")) texts.push(...(await pdfText(Buffer.from(entry))));
        }
      }
      const all = texts.join("\n");
      for (const needle of needles)
        expect(all, `${input.kind} ${input.format}`).not.toContain(needle);
    }
  });

  test("[SEC-002] cizí export je 404 a neprozradí existenci", async () => {
    const a = seedOwner(db, NOW);
    const b = seedOwner(db, NOW);
    const aInvoice = issuedOn(a, seedCustomer(a), "2026-03-01");
    const row = await exported(a, { kind: "invoices", format: "csv" });
    expect(row.status).toBe("done");

    const foreign = (() => {
      try {
        openExport(webActor(b), row.id);
      } catch (error) {
        return error;
      }
    })();
    const missing = (() => {
      try {
        openExport(webActor(b), "neexistuje");
      } catch (error) {
        return error;
      }
    })();
    expect(foreign).toBeInstanceOf(ExportNotFoundError);
    expect(missing).toBeInstanceOf(ExportNotFoundError);
    expect((foreign as Error).message).toBe((missing as Error).message);
    expect(listExports(b)).toEqual([]);

    const bInvoice = issuedOn(b, seedCustomer(b), "2026-03-01");
    const mixed = await exported(b, {
      kind: "invoices",
      format: "pdf_zip",
      filter: { ids: [bInvoice, aInvoice] },
    });
    expect(mixed).toMatchObject({ status: "failed", reason: E.foreignIds, fileId: null });
    expect(() => openExport(webActor(b), mixed.id)).toThrow(ExportNotFoundError);
    expect(db.select().from(file).where(eq(file.userId, b)).all()).toEqual([]);
  });

  test("[EXP-007] účet má nejvýš 3 rozpracované exporty", async () => {
    const owner = seedOwner(db, NOW);
    issuedOn(owner, seedCustomer(owner), "2026-03-01");
    const start = () => createExport(webActor(owner), { kind: "invoices", format: "csv" });
    start();
    start();
    start();
    expect(start).toThrow(E.tooManyRunning(3));
    expect(db.select().from(exportJob).where(eq(exportJob.userId, owner)).all()).toHaveLength(3);
    const other = seedOwner(db, NOW);
    expect(() => createExport(webActor(other), { kind: "customers", format: "csv" })).not.toThrow();
    await drainHeavy("w");
    expect(() => start()).not.toThrow();
  });

  test("[SEC-001] stažení exportu má vlastní limit", async () => {
    const owner = seedOwner(db, NOW);
    issuedOn(owner, seedCustomer(owner), "2026-03-01");
    const row = await exported(owner, { kind: "invoices", format: "csv" });
    const rule = RATE_RULES.exportDownloadUser;
    expect(rule.limit).toBe(30);
    expect(rule.windowSeconds).toBe(3600);
    db.insert(rateLimit)
      .values({ key: `${rule.name}:${owner}`, windowStart: current, count: rule.limit })
      .run();
    expect(() => openExport(webActor(owner), row.id)).toThrow(RateLimitError);
  });

  test("přerušený export skončí selháním a rozepsaný soubor zmizí", async () => {
    const owner = seedOwner(db, NOW);
    issuedOn(owner, seedCustomer(owner), "2026-03-01");
    const { id } = createExport(webActor(owner), { kind: "invoices", format: "csv" });
    const running = db.select().from(job).where(eq(job.userId, owner)).get()!;
    db.update(job).set({ status: "running", lockedBy: "w" }).where(eq(job.id, running.id)).run();
    recoverExportJob({ ...running, status: "running", lockedBy: "w" });
    expect(exportRow(id)).toMatchObject({ status: "failed", reason: TEXTS.exporting.interrupted });
    expect(db.select().from(job).where(eq(job.id, running.id)).get()!.status).toBe("dead");
    expect(db.select().from(invoice).where(eq(invoice.userId, owner)).all()).toHaveLength(1);
  });
});

describe("stažení a stropy exportu", () => {
  const exportsOf = (owner: string) =>
    db.select().from(exportJob).where(eq(exportJob.userId, owner)).all();
  const used = (rule: { name: string }, owner: string) =>
    db
      .select()
      .from(rateLimit)
      .where(eq(rateLimit.key, `${rule.name}:${owner}`))
      .get()?.count ?? 0;

  test("[EXP-007] export smazaný úklidem po otevření se dočte celý", async () => {
    const owner = seedOwner(db, NOW);
    const customerId = seedCustomer(owner);
    for (const day of ["2026-03-01", "2026-03-02", "2026-03-03"]) issuedOn(owner, customerId, day);
    const row = await exported(owner, { kind: "invoices", format: "csv" });
    const whole = readFileSync(blobPath(owner, row.fileId!));
    const opened = openExport(webActor(owner), row.id);
    expect(opened.size).toBe(whole.length);
    // As if export-cleanup removed the file between opening and streaming it.
    current = new Date(NOW.getTime() + 8 * 86_400_000);
    purgeExpiredExports(current);
    expect(existsSync(blobPath(owner, row.fileId!))).toBe(false);
    const read = Buffer.alloc(opened.size);
    let offset = 0;
    try {
      while (offset < read.length) {
        const n = readSync(opened.fd, read, offset, read.length - offset, null);
        if (n === 0) break;
        offset += n;
      }
    } finally {
      closeSync(opened.fd);
    }
    expect(read.equals(whole)).toBe(true);
  });

  test("[EXP-007] pdf_zip nad 2 000 doklady vrátí 422 a úloha nevznikne", () => {
    expect(EXPORT_LIMITS).toEqual({ pdfZipDocuments: 2_000 });
    const owner = seedOwner(db, NOW);
    const customerId = seedCustomer(owner);
    for (const day of ["2026-03-01", "2026-03-02", "2026-03-03"]) issuedOn(owner, customerId, day);
    const input: ExportInput = { kind: "invoices", format: "pdf_zip" };
    const run = () => createExport(webActor(owner), input, { pdfZipDocuments: 2 });
    expect(run).toThrow(ServiceError);
    expect(run).toThrow(E.pdfZipTooMany(3, 2));
    expect(exportsOf(owner)).toEqual([]);
    expect(used(RATE_RULES.exportUser, owner)).toBe(0);
    // CSV of the same documents has no such cap, nor does a narrower filter.
    expect(() =>
      createExport(webActor(owner), { ...input, format: "csv" }, { pdfZipDocuments: 2 }),
    ).not.toThrow();
    expect(() =>
      createExport(
        webActor(owner),
        { ...input, filter: { from: "2026-03-02", to: "2026-03-03" } },
        { pdfZipDocuments: 2 },
      ),
    ).not.toThrow();
  });

  test("[SEC-001] odmítnutí stropem tří rozpracovaných exportů limit nespotřebuje", () => {
    const owner = seedOwner(db, NOW);
    for (let index = 0; index < 3; index++) {
      createExport(webActor(owner), { kind: "customers", format: "csv" });
    }
    const before = used(RATE_RULES.exportUser, owner);
    expect(before).toBe(3);
    for (let attempt = 0; attempt < 5; attempt++) {
      expect(() => createExport(webActor(owner), { kind: "customers", format: "csv" })).toThrow(
        E.tooManyRunning(3),
      );
    }
    expect(used(RATE_RULES.exportUser, owner)).toBe(before);
    expect(exportsOf(owner)).toHaveLength(3);
  });
});

describe("HEAD exportu", () => {
  test("[EXP-007] HEAD nenechá otevřený popisovač, nespotřebuje limit ani nezapíše audit", async () => {
    const owner = seedOwner(db, NOW);
    issuedOn(owner, seedCustomer(owner), "2026-03-01");
    const row = await exported(owner, { kind: "invoices", format: "csv" });
    sessionUser.id = owner;
    const { HEAD } = await import("@/app/(app)/nastaveni/export/[id]/route");
    const openFds = () => readdirSync("/proc/self/fd").length;
    const downloads = () =>
      db.select().from(auditLog).where(eq(auditLog.action, "export.download")).all().length;
    const before = openFds();
    const audited = downloads();
    for (let round = 0; round < 50; round++) {
      const response = await HEAD(
        new Request(`http://localhost/nastaveni/export/${row.id}`, { method: "HEAD" }),
        { params: Promise.resolve({ id: row.id }) },
      );
      expect(response.status).toBe(200);
      expect(response.body).toBeNull();
    }
    expect(openFds()).toBeLessThanOrEqual(before);
    expect(downloads()).toBe(audited);
    const key = `${RATE_RULES.exportDownloadUser.name}:${owner}`;
    expect(db.select().from(rateLimit).where(eq(rateLimit.key, key)).get()).toBeUndefined();
  });
});

describe("PDF exportu nad rozpočet textu", () => {
  test("[EXP-007] ZIP s PDF dokladu nad rozpočet skončí s důvodem", async () => {
    const owner = seedOwner(db, NOW);
    const id = issuedOn(owner, seedCustomer(owner), "2026-03-01");
    db.update(invoiceLine)
      .set({ description: "y".repeat(310_000) })
      .where(eq(invoiceLine.invoiceId, id))
      .run();
    const row = await exported(owner, { kind: "invoices", format: "pdf_zip" });
    expect(row).toMatchObject({ status: "failed", reason: TEXTS.pdf.tooLong, fileId: null });
  });
});
