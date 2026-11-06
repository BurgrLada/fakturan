import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { TEXTS } from "@/lib/texts";
import { setClockForTests } from "@/server/clock";
import {
  customer,
  file,
  importBatch,
  invoice,
  job,
  payment,
  schedulerState,
} from "@/server/db/schema";
import { readBlob } from "@/server/files/store";
import { drainHeavy } from "@/server/jobs/worker";
import { confirmBatch, editPreview, getPreview, startParse } from "@/server/services/import-batch";
import { listPayments } from "@/server/services/payments";
import { reportSummary } from "@/server/reports/queries";
import { saveCustomer } from "@/server/services/customers";
import { assertConsistent } from "../helpers/consistency";
import { createTestDb } from "../helpers/db";
import { webActor } from "../helpers/fixtures-mail";
import { pdfWithEmbedded } from "../helpers/hostile-files";
import {
  committed,
  editedIsdoc,
  importOwner,
  isdoc,
  parsed,
  registerImportJobs,
  uploadBatch,
  zipOf,
} from "../helpers/import";

vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-import-isdoc-")));

const db = createTestDb();
const NOW = new Date("2026-03-20T10:00:00Z");
const R = TEXTS.importing.rows;

beforeAll(() => registerImportJobs());
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

const docs = (owner: string) => db.select().from(invoice).where(eq(invoice.userId, owner)).all();
const byNumber = (owner: string, number: string) =>
  db
    .select()
    .from(invoice)
    .where(and(eq(invoice.userId, owner), eq(invoice.number, number)))
    .get()!;

function newCustomer(owner: string, name: string, ico = "") {
  return saveCustomer(webActor(owner), {
    name,
    street: "",
    city: "",
    zip: "",
    country: "Česká republika",
    ico,
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

describe("import ISDOC", () => {
  test("[IMP-000] jeden .isdoc, ZIP i PDF s ISDOC dají stejný náhled", async () => {
    const xml = isdoc("faktura-czk.isdoc");
    const pdf = pdfWithEmbedded(xml);
    const variants = [
      [{ name: "faktura.isdoc", bytes: xml }],
      [{ name: "faktury.zip", bytes: zipOf({ "2026/faktura.isdoc": xml }) }],
      [{ name: "faktura.isdocx", bytes: zipOf({ "faktura.isdoc": xml }) }],
      [{ name: "faktura.pdf", bytes: pdf }],
    ];
    const previews = [];
    for (const files of variants) {
      const owner = importOwner(db, NOW);
      const { rows, batch } = await parsed(owner, files);
      expect(batch.status).toBe("ready");
      expect(rows).toHaveLength(1);
      previews.push({ owner, row: rows[0]! });
    }
    for (const { row } of previews) {
      expect(row.status).toBe("ok");
      expect(row.document).toEqual(previews[0]!.row.document);
    }
    const fromPdf = previews[3]!;
    expect(fromPdf.row.pdfFileId).not.toBeNull();
    const pdfBatch = db
      .select()
      .from(importBatch)
      .where(eq(importBatch.userId, fromPdf.owner))
      .get()!;
    await committed(db, fromPdf.owner, pdfBatch.id);
    const stored = byNumber(fromPdf.owner, "2026-0001");
    expect(stored.importPdfFileId).toBe(fromPdf.row.pdfFileId);
    expect(new Uint8Array(readBlob(fromPdf.owner, stored.importPdfFileId!))).toEqual(pdf);
    assertConsistent(db, fromPdf.owner);
  });

  test("[IMP-000] PDF se stejným kmenem jako ISDOC v ZIPu se přiloží", async () => {
    const owner = importOwner(db, NOW);
    const pdf = pdfWithEmbedded(new TextEncoder().encode('<?xml version="1.0"?><Jine/>'));
    const zip = zipOf({
      "faktura-czk.isdoc": isdoc("faktura-czk.isdoc"),
      "faktura-czk.pdf": pdf,
      "jine.pdf": pdf,
    });
    const { id, rows, batch } = await parsed(owner, [{ name: "a.zip", bytes: zip }]);
    expect(rows[0]!.pdfFileId).not.toBeNull();
    expect(batch.error).toContain("jine.pdf");
    const done = await committed(db, owner, id);
    expect(done.status).toBe("done");
    const files = db.select().from(file).where(eq(file.userId, owner)).all();
    expect(files.map((row) => row.kind)).toEqual(["import_pdf"]);
    expect(byNumber(owner, "2026-0001").importPdfFileId).toBe(files[0]!.id);
    assertConsistent(db, owner);
  });

  test("[IMP-003] převezme číslo, UUID, typ, data, zákazníka, položky, měnu, částky, VS a účet", async () => {
    const owner = importOwner(db, NOW);
    const { id } = await parsed(owner, [
      { name: "a.isdoc", bytes: isdoc("faktura-czk.isdoc") },
      { name: "b.isdoc", bytes: isdoc("faktura-eur.isdoc") },
    ]);
    expect((await committed(db, owner, id)).status).toBe("done");

    expect(byNumber(owner, "2026-0001")).toMatchObject({
      type: "invoice",
      status: "issued",
      external: true,
      importBatchId: id,
      importUuid: "00000000-0000-4000-8000-000000000001",
      sourceSystem: "Zkušební systém 1.0",
      issueDate: "2026-02-02",
      taxableDate: "2026-02-02",
      dueDate: "2026-02-16",
      customerName: "Vzorová a. s.",
      currency: "CZK",
      totalMinor: 335_050,
      subtotalMinor: 335_050,
      roundingMinor: 0,
      variableSymbol: "20260001",
      paymentMethod: "transfer",
      sentAt: null,
      seriesId: null,
    });
    expect(byNumber(owner, "2026-0001").accountSnapshot).toMatchObject({
      number: "123456789",
      bankCode: "0100",
    });
    expect(byNumber(owner, "2026-0002")).toMatchObject({
      currency: "EUR",
      exchangeRateMicros: 25_125_000,
      exchangeRateSource: "import",
      exchangeRateDate: "2026-02-02",
      totalMinor: 40_999,
    });
    assertConsistent(db, owner);
  });

  test("[IMP-006] páruje podle IČO, pak jména a chybějící založí", async () => {
    const owner = importOwner(db, NOW);
    const byIco = newCustomer(owner, "Vzorová, jiný název", "99900025");
    const byName = newCustomer(owner, "BEISPIEL GMBH");
    const { id, rows } = await parsed(owner, [
      { name: "a.isdoc", bytes: isdoc("faktura-czk.isdoc") },
      { name: "b.isdoc", bytes: isdoc("faktura-eur.isdoc") },
      { name: "c.isdoc", bytes: isdoc("verze-601.isdoc") },
    ]);
    expect(rows.map((row) => row.customerAction.kind)).toEqual(["existing", "existing", "create"]);
    await committed(db, owner, id);

    expect(byNumber(owner, "2026-0001").customerId).toBe(byIco);
    expect(byNumber(owner, "2026-0002").customerId).toBe(byName);
    const created = db.select().from(customer).where(eq(customer.importBatchId, id)).all();
    expect(created.map((row) => [row.name, row.ico])).toEqual([["Pokusná družstva", "99900041"]]);
    expect(byNumber(owner, "2026-0006").customerId).toBe(created[0]!.id);
    expect(db.select().from(customer).where(eq(customer.id, byIco)).get()!.name).toBe(
      "Vzorová, jiný název",
    );
    assertConsistent(db, owner);
  });

  test("[IMP-007] stejné UUID nebo číslo se přeskočí a vypíše, i uvnitř dávky", async () => {
    const owner = importOwner(db, NOW);
    const first = await parsed(owner, [{ name: "a.isdoc", bytes: isdoc("faktura-czk.isdoc") }]);
    await committed(db, owner, first.id);
    const sameNumber = editedIsdoc("faktura-eur.isdoc", "<ID>2026-0002</ID>", "<ID>2026-0001</ID>");
    const sameUuid = editedIsdoc("verze-601.isdoc", "000000000008", "000000000001");
    const { id, rows } = await parsed(owner, [
      { name: "znovu.isdoc", bytes: isdoc("faktura-czk.isdoc") },
      { name: "cislo.isdoc", bytes: sameNumber },
      { name: "uuid.isdoc", bytes: sameUuid },
      { name: "nova.isdoc", bytes: isdoc("castecne-uhrazena.isdoc") },
      { name: "nova-znovu.isdoc", bytes: isdoc("castecne-uhrazena.isdoc") },
    ]);
    expect(rows.map((row) => [row.status, row.messages.at(-1)])).toEqual([
      ["duplicate", R.duplicateUuid],
      ["duplicate", R.duplicateNumber],
      ["duplicate", R.duplicateUuid],
      ["ok", undefined],
      ["duplicate", R.duplicateInBatch],
    ]);
    const done = await committed(db, owner, id);
    expect(done.summary).toMatchObject({ documents: 1, duplicates: 4 });
    expect(docs(owner)).toHaveLength(2);
    assertConsistent(db, owner);
  });

  test("[IMP-006] neplatné IČO zákazníka doklad nezastaví, zákazník vznikne bez něj", async () => {
    const owner = importOwner(db, NOW);
    const badIco = editedIsdoc(
      "faktura-czk.isdoc",
      "<AccountingCustomerParty><Party><PartyIdentification><ID>99900025</ID>",
      "<AccountingCustomerParty><Party><PartyIdentification><ID>12345678</ID>",
    );
    const { id, rows } = await parsed(owner, [{ name: "a.isdoc", bytes: badIco }]);
    expect(rows[0]).toMatchObject({ status: "warning", messages: [R.customerTrimmed] });
    await committed(db, owner, id);
    const created = db.select().from(customer).where(eq(customer.importBatchId, id)).get()!;
    expect(created).toMatchObject({ name: "Vzorová a. s.", ico: "" });
    expect(byNumber(owner, "2026-0001").customerSnapshot).toMatchObject({ ico: "12345678" });
    assertConsistent(db, owner);
  });

  test("doklad jiného dodavatele je chyba řádku", async () => {
    const owner = importOwner(db, NOW);
    const { rows } = await parsed(owner, [
      { name: "x.isdoc", bytes: isdoc("cizi-dodavatel.isdoc") },
    ]);
    expect(rows[0]).toMatchObject({ status: "error", messages: [R.otherSupplier] });
  });

  test("dodavatel bez IČO vyžaduje potvrzení, že jde o vlastní doklad", async () => {
    const owner = importOwner(db, NOW);
    const noIco = editedIsdoc(
      "faktura-czk.isdoc",
      "<AccountingSupplierParty><Party><PartyIdentification><ID>99900017</ID>",
      "<AccountingSupplierParty><Party><PartyIdentification><ID></ID>",
    );
    const { id, rows, batch } = await parsed(owner, [{ name: "x.isdoc", bytes: noIco }]);
    expect(rows[0]).toMatchObject({ status: "warning", ownConfirmed: false });
    expect(() => committedSync(owner, id, batch.revision)).toThrow(TEXTS.importing.errors.blocked);
    editPreview(webActor(owner), id, batch.revision, { kind: "confirmOwn", keys: [rows[0]!.key] });
    expect((await committed(db, owner, id)).status).toBe("done");
    assertConsistent(db, owner);
  });

  test("[IMP-012] PayableAmount 0 založí platbu s odhadem a hromadná úprava ho změní", async () => {
    const owner = importOwner(db, NOW);
    const { id, rows, batch } = await parsed(owner, [
      { name: "a.isdoc", bytes: isdoc("uhrazena.isdoc") },
      { name: "b.isdoc", bytes: isdoc("castecne-uhrazena.isdoc") },
      { name: "c.isdoc", bytes: isdoc("faktura-czk.isdoc") },
    ]);
    expect(rows.map((row) => [row.paidMinor, row.paidOn, row.dateEstimated])).toEqual([
      [480_000, "2026-02-16", true],
      [200_000, "2026-02-16", true],
      [0, null, false],
    ]);
    expect(() =>
      editPreview(webActor(owner), id, batch.revision, {
        kind: "paidOn",
        keys: [rows[0]!.key],
        mode: "date",
        date: "2026-04-01",
      }),
    ).toThrow(TEXTS.importing.errors.futureDate);
    editPreview(webActor(owner), id, batch.revision, {
      kind: "paidOn",
      keys: [rows[0]!.key],
      mode: "issue",
    });
    await committed(db, owner, id);

    const paid = byNumber(owner, "2026-0004");
    expect(paid.status).toBe("paid");
    expect(listPayments(owner, paid.id)).toMatchObject([
      { paidOn: "2026-02-02", amountMinor: 480_000, source: "import", dateEstimated: false },
    ]);
    const partial = byNumber(owner, "2026-0005");
    expect(partial.status).toBe("partially_paid");
    expect(listPayments(owner, partial.id)).toMatchObject([
      { paidOn: "2026-02-16", amountMinor: 200_000, dateEstimated: true },
    ]);
    expect(byNumber(owner, "2026-0001").status).toBe("issued");
    assertConsistent(db, owner);
  });

  test("[ADV-005] úhrazená záloha a její konečná faktura dají příjem jednou", async () => {
    const owner = importOwner(db, NOW);
    const paidAdvance = editedIsdoc(
      "zalohova.isdoc",
      "<PayableAmount>10000.00</PayableAmount>",
      "<PayableAmount>0.00</PayableAmount>",
    );
    const paidFinal = editedIsdoc(
      "konecna-se-zalohou.isdoc",
      "<PayableAmount>15000.00</PayableAmount>",
      "<PayableAmount>0.00</PayableAmount>",
    );
    const { id, rows } = await parsed(owner, [
      { name: "konecna.isdoc", bytes: paidFinal },
      { name: "zaloha.isdoc", bytes: paidAdvance },
    ]);
    expect(rows[0]).toMatchObject({
      advance: { kind: "batch", key: rows[1]!.key },
      paidMinor: 1_500_000,
    });
    await committed(db, owner, id);

    const advance = byNumber(owner, "2026-Z001");
    const final = byNumber(owner, "2026-0003");
    expect(final).toMatchObject({
      relatedInvoiceId: advance.id,
      advanceMinor: 1_000_000,
      status: "paid",
    });
    expect(advance.supersededAt).not.toBeNull();
    const income = db.select().from(payment).where(eq(payment.userId, owner)).all();
    expect(income.reduce((sum, row) => sum + row.amountMinor, 0)).toBe(2_500_000);
    const year = { from: "2026-01-01", to: "2026-12-31" };
    expect(
      reportSummary(db, owner, { range: year, includeExternal: true }, "2026-03-20"),
    ).toMatchObject({
      incomeMinor: 2_500_000,
      invoicedMinor: 2_500_000,
    });
    assertConsistent(db, owner);
  });

  test("[ADV-005] neuhrazená záloha spárovaná s konečnou fakturou dá varování", async () => {
    const owner = importOwner(db, NOW);
    const { rows } = await parsed(owner, [
      { name: "konecna.isdoc", bytes: isdoc("konecna-se-zalohou.isdoc") },
      { name: "zaloha.isdoc", bytes: isdoc("zalohova.isdoc") },
    ]);
    expect(rows[0]).toMatchObject({ status: "warning", advance: { kind: "batch" } });
    expect(rows[0]!.messages).toContain(TEXTS.importing.rows.advanceUnpaid);
    const paidAdvance = editedIsdoc(
      "zalohova.isdoc",
      "<PayableAmount>10000.00</PayableAmount>",
      "<PayableAmount>0.00</PayableAmount>",
    );
    const paired = await parsed(importOwner(db, NOW), [
      { name: "konecna.isdoc", bytes: isdoc("konecna-se-zalohou.isdoc") },
      { name: "zaloha.isdoc", bytes: paidAdvance },
    ]);
    expect(paired.rows[0]!.messages).not.toContain(TEXTS.importing.rows.advanceUnpaid);
  });

  test("[IMP-009] chybný řádek zablokuje potvrzení, po přeskočení projde", async () => {
    const owner = importOwner(db, NOW);
    const { id, rows, batch } = await parsed(owner, [
      { name: "a.isdoc", bytes: isdoc("faktura-czk.isdoc") },
      { name: "vrubopis.isdoc", bytes: isdoc("vrubopis.isdoc") },
      { name: "rozbity.isdoc", bytes: new TextEncoder().encode("<Invoice") },
    ]);
    expect(rows.map((row) => row.status)).toEqual(["ok", "error", "error"]);
    expect(() => committedSync(owner, id, batch.revision)).toThrow(TEXTS.importing.errors.blocked);

    const { revision } = editPreview(webActor(owner), id, batch.revision, {
      kind: "skip",
      keys: [rows[1]!.key, rows[2]!.key],
      skip: true,
    });
    expect(() =>
      editPreview(webActor(owner), id, batch.revision, {
        kind: "skip",
        keys: [rows[0]!.key],
        skip: true,
      }),
    ).toThrow(TEXTS.importing.errors.stale);
    expect(revision).toBe(batch.revision + 1);
    const done = await committed(db, owner, id);
    expect(done.summary).toMatchObject({ documents: 1, skipped: 2 });
    assertConsistent(db, owner);
  });

  test("[IMP-008] chyba posledního dokladu nezapíše nic", async () => {
    const owner = importOwner(db, NOW);
    const original = await parsed(owner, [{ name: "a.isdoc", bytes: isdoc("faktura-czk.isdoc") }]);
    await committed(db, owner, original.id);
    const { id, rows } = await parsed(owner, [
      { name: "b.isdoc", bytes: isdoc("faktura-eur.isdoc") },
      { name: "dobropis.isdoc", bytes: isdoc("dobropis.isdoc") },
    ]);
    expect(rows.map((row) => row.status)).toEqual(["ok", "ok"]);
    const before = docs(owner).length;
    // The original disappears between the preview and the commit.
    const gone = byNumber(owner, "2026-0001");
    db.update(invoice)
      .set({ number: "2026-0001-x", importUuid: null })
      .where(eq(invoice.id, gone.id))
      .run();

    const batch = await committed(db, owner, id);

    expect(batch.status).toBe("ready");
    expect(batch.error).toBe(TEXTS.importing.errors.blocked);
    expect(docs(owner)).toHaveLength(before);
    expect(getPreview(owner, id)!.rows[1]).toMatchObject({
      status: "error",
      messages: [R.originalMissing],
    });
  });

  test("dobropis se uloží záporně a sníží původní doklad", async () => {
    const owner = importOwner(db, NOW);
    const { id } = await parsed(owner, [
      { name: "dobropis.isdoc", bytes: isdoc("dobropis.isdoc") },
      { name: "a.isdoc", bytes: isdoc("faktura-czk.isdoc") },
    ]);
    await committed(db, owner, id);
    const original = byNumber(owner, "2026-0001");
    const note = byNumber(owner, "2026-D001");
    expect(note).toMatchObject({
      type: "credit_note",
      totalMinor: -150_000,
      relatedInvoiceId: original.id,
    });
    expect(original.creditsMinor).toBe(-150_000);
    assertConsistent(db, owner);
  });

  test("[IMP-011] průběh se mění a zpracování běží na pozadí", async () => {
    const owner = importOwner(db, NOW);
    const entries = Object.fromEntries(
      Array.from({ length: 60 }, (_, i) => [
        `f${i}.isdoc`,
        editedIsdoc("faktura-czk.isdoc", /2026-0001|000000000001/g, `${i}`.padStart(12, "0")),
      ]),
    );
    const batchId = await uploadBatch(owner, [{ name: "velky.zip", bytes: zipOf(entries) }]);
    startParse(webActor(owner), batchId);
    const status = () => db.select().from(importBatch).where(eq(importBatch.id, batchId)).get()!;
    expect(status()).toMatchObject({ status: "parsing", progress: 0 });
    const seen: number[] = [];
    const timer = setInterval(() => seen.push(status().progress), 1);
    await drainHeavy("w");
    clearInterval(timer);
    expect(status()).toMatchObject({ status: "ready", progress: 60 });
    expect(seen.some((value) => value > 0 && value < 60)).toBe(true);
  });
});

function committedSync(owner: string, batchId: string, revision: number) {
  return confirmBatch(webActor(owner), batchId, revision);
}
