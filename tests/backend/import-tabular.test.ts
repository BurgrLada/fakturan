import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, asc, eq } from "drizzle-orm";
import { strFromU8, unzipSync } from "fflate";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { Mapping } from "@/lib/import-mapping";
import { BUILTIN_PRESETS } from "@/lib/import-presets";
import { money, text, toCsv } from "@/lib/tabular";
import { TEXTS } from "@/lib/texts";
import { toXlsx } from "@/lib/xlsx-writer";
import { setClockForTests } from "@/server/clock";
import {
  catalogItem,
  customer,
  importBatch,
  invoice,
  invoiceLine,
  invoiceTemplate,
  job,
  payment,
  recurringInvoice,
  schedulerState,
} from "@/server/db/schema";
import { ServiceError } from "@/server/services/access";
import { confirmBatch, editPreview, getPreview, readPreview } from "@/server/services/import-batch";
import { readSheetOnce, remapBatch, submitMapping } from "@/server/services/import-tabular";
import { parseCsv } from "@/lib/safe-input/csv";
import { undoBatch } from "@/server/services/import-undo";
import { deletePreset, listPresets, savePreset } from "@/server/services/mapping-presets";
import { saveCustomer } from "@/server/services/customers";
import { assertConsistent } from "../helpers/consistency";
import { createTestDb } from "../helpers/db";
import { webActor } from "../helpers/fixtures-mail";
import {
  committed,
  importOwner,
  isdoc,
  parsed,
  registerImportJobs,
  tabularMapped,
  tabularUploaded,
} from "../helpers/import";

vi.mock("@/lib/safe-input/csv", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/safe-input/csv")>();
  return { ...actual, parseCsv: vi.fn(actual.parseCsv) };
});

vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-import-tabular-")));

const db = createTestDb();
const NOW = new Date("2026-03-20T10:00:00Z");
const M = TEXTS.importing.mapping;
const R = TEXTS.importing.rows;

const fixture = (name: string) =>
  new Uint8Array(readFileSync(join("tests", "fixtures", "import", name)));

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

const base = { dateFormat: "dmy", decimal: ",", currency: "CZK", source: "" } as const;

const customersMapping: Mapping = {
  ...base,
  target: "customers",
  columns: {
    name: "Název",
    ico: "IČO",
    dic: "DIČ",
    street: "Ulice",
    city: "Město",
    zip: "PSČ",
    country: "Země",
    email: "E-mail",
    dueDays: "Splatnost",
  },
};

const invoicesMapping: Mapping = {
  ...base,
  target: "invoices",
  source: "Stará tabulka",
  columns: {
    number: "Číslo",
    issueDate: "Vystaveno",
    dueDate: "Splatnost",
    taxableDate: "DUZP",
    paidOn: "Uhrazeno",
    variableSymbol: "VS",
    customerName: "Zákazník",
    customerStreet: "Ulice",
    customerCity: "Město",
    customerZip: "PSČ",
    customerCountry: "Země",
    customerDic: "DIČ",
    currency: "Měna",
    exchangeRate: "Kurz",
    lineName: "Položka",
    lineQuantity: "Množství",
    lineUnit: "Jednotka",
    lineUnitPrice: "Cena za jednotku",
    lineTotal: "Cena položky",
  },
};

function existingCustomer(owner: string, name: string, ico: string) {
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

const batchOf = (id: string) => db.select().from(importBatch).where(eq(importBatch.id, id)).get()!;
const imported = (owner: string, batchId: string) =>
  db
    .select()
    .from(customer)
    .where(and(eq(customer.userId, owner), eq(customer.importBatchId, batchId)))
    .orderBy(asc(customer.name))
    .all();

describe("import CSV a Excelu", () => {
  test("[IMP-001] CSV zákazníků projde mapováním, náhledem a potvrzením", async () => {
    const owner = importOwner(db, NOW);
    const existing = existingCustomer(owner, "Gama", "09990020");
    const id = await tabularUploaded(owner, "zakaznici.csv", fixture("zakaznici.csv"));
    expect(batchOf(id).status).toBe("mapping");
    const sample = readPreview(owner, id)!.sample!;
    expect(sample.headers).toEqual([
      "Název",
      "IČO",
      "DIČ",
      "Ulice",
      "Město",
      "PSČ",
      "Země",
      "E-mail",
      "Splatnost",
    ]);
    expect(sample.total).toBe(5);
    expect(sample.rows).toHaveLength(5);

    const { rows } = await tabularMapped(owner, id, customersMapping);
    expect(batchOf(id)).toMatchObject({ status: "ready", target: "customers" });
    expect(rows.map((row) => [row.source, row.status])).toEqual([
      ["Řádek 2", "ok"],
      ["Řádek 3", "ok"],
      ["Řádek 4", "duplicate"],
      ["Řádek 5", "error"],
      ["Řádek 6", "ok"],
    ]);
    expect(rows[2]!.messages).toEqual([R.duplicateCustomer]);
    expect(rows[3]!.messages).toEqual([
      M.errors.field(5, "E-mail", TEXTS.customers.validation.email),
    ]);
    expect(rows[0]!.record).toMatchObject({ target: "customers", name: "Alfa Zkušební s. r. o." });

    const blocked = batchOf(id);
    expect(() => confirmBatch(webActor(owner), id, blocked.revision)).toThrow(
      TEXTS.importing.errors.blocked,
    );
    const { revision } = editPreview(webActor(owner), id, blocked.revision, {
      kind: "skip",
      keys: [rows[3]!.key],
      skip: true,
    });
    expect(revision).toBe(blocked.revision + 1);
    const done = await committed(db, owner, id);
    expect(done).toMatchObject({
      status: "done",
      summary: { documents: 3, duplicates: 1, skipped: 1 },
    });
    expect(readPreview(owner, id)).toBeNull();

    const created = imported(owner, id);
    expect(created.map((row) => [row.name, row.ico, row.country, row.dueDays])).toEqual([
      ['=HYPERLINK("http://example.test","klik")', "", "", null],
      ["Alfa Zkušební s. r. o.", "09990011", "Česká republika", 14],
      ["Beta Pokusná", "", "Česká republika", null],
    ]);
    expect(db.select().from(customer).where(eq(customer.id, existing)).get()!.name).toBe("Gama");

    undoBatch(webActor(owner), id);
    expect(imported(owner, id)).toEqual([]);
    expect(batchOf(id).status).toBe("undone");
  });

  test("[IMP-001] CSV se parsuje jednou pro mapování i řádky", async () => {
    const owner = importOwner(db, NOW);
    vi.mocked(parseCsv).mockClear();

    const id = await tabularUploaded(owner, "zakaznici.csv", fixture("zakaznici.csv"));
    const sample = readPreview(owner, id)!.sample!;
    expect(sample.total).toBe(5);
    expect(sample.rows).toHaveLength(5);
    expect(sample.headers).toHaveLength(9);
    const { rows } = await tabularMapped(owner, id, customersMapping);

    expect(rows).toHaveLength(5);
    expect(vi.mocked(parseCsv)).toHaveBeenCalledTimes(1);
  });

  test("[IMP-001] list se přečte do sloupců jen s mapovanými sloupci", async () => {
    const bytes = new TextEncoder().encode(
      "Název;Poznámka;IČO;Navíc\nAlfa;x;123;y\n;;;\nBeta;;;z\n",
    );
    const mapping: Mapping = { ...customersMapping, columns: { name: "Název", ico: "IČO" } };

    const sheet = await readSheetOnce(bytes, mapping);

    expect(sheet).toMatchObject({
      headers: ["Název", "IČO"],
      columns: [
        ["Alfa", "", "Beta"],
        ["123", "", ""],
      ],
      rows: 3,
    });
  });

  test("[IMP-001] XLSX ceníku se načte přes stejný průvodce", async () => {
    const owner = importOwner(db, NOW);
    const xlsx = toXlsx({
      name: "Ceník",
      columns: ["Název", "Cena", "Jednotka", "Měna", "Kategorie"],
      rows: [
        [text("Konzultace"), money(150_000, "CZK"), text("hod."), text("CZK"), text("Služby")],
        [text("Licence"), money(4_999, "EUR"), text("ks"), text("eur"), null],
        [text("Záporná"), money(-100, "CZK"), text("ks"), null, null],
      ],
    });
    const id = await tabularUploaded(owner, "cenik.xlsx", xlsx);
    expect(readPreview(owner, id)!.sample).toMatchObject({ format: "xlsx", total: 3 });
    const { rows } = await tabularMapped(owner, id, {
      ...base,
      target: "catalog",
      columns: {
        name: "Název",
        price: "Cena",
        unit: "Jednotka",
        currency: "Měna",
        category: "Kategorie",
      },
    });
    expect(rows.map((row) => row.status)).toEqual(["ok", "ok", "error"]);
    expect(rows[2]!.messages).toEqual([M.errors.field(4, "Cena", TEXTS.catalog.validation.price)]);
    editPreview(webActor(owner), id, batchOf(id).revision, {
      kind: "skip",
      keys: [rows[2]!.key],
      skip: true,
    });
    expect((await committed(db, owner, id)).status).toBe("done");
    const items = db
      .select()
      .from(catalogItem)
      .where(eq(catalogItem.importBatchId, id))
      .orderBy(asc(catalogItem.name))
      .all();
    expect(
      items.map((row) => [row.name, row.priceMinor, row.currency, row.unit, row.category]),
    ).toEqual([
      ["Konzultace", 150_000, "CZK", "hod.", "Služby"],
      ["Licence", 4_999, "EUR", "ks", ""],
    ]);

    const again = await tabularUploaded(owner, "cenik.xlsx", xlsx);
    const second = await tabularMapped(owner, again, {
      ...base,
      target: "catalog",
      columns: { name: "Název", price: "Cena", currency: "Měna" },
    });
    expect(second.rows.map((row) => row.status)).toEqual(["duplicate", "duplicate", "error"]);
    expect(second.rows[0]!.messages).toEqual([R.duplicateItem]);
  });

  test("[IMP-001] CSV faktur v EUR dá stejné částky jako ISDOC", async () => {
    const fromIsdoc = importOwner(db, NOW);
    const isdocBatch = await parsed(fromIsdoc, [
      { name: "a.isdoc", bytes: isdoc("faktura-eur.isdoc") },
    ]);
    await committed(db, fromIsdoc, isdocBatch.id);

    const fromCsv = importOwner(db, NOW);
    const id = await tabularUploaded(fromCsv, "faktury.csv", fixture("faktury-eur.csv"));
    const { rows } = await tabularMapped(fromCsv, id, invoicesMapping);
    expect(rows[0]!.messages).toEqual([]);
    expect(rows.map((row) => [row.source, row.status, row.document?.number ?? null])).toEqual([
      ["Řádky 2, 3", "ok", "2026-0002"],
      ["Řádek 4", "ok", "2026-0003"],
      ["Řádek 5", "error", null],
    ]);
    expect(rows[2]!.messages).toEqual([M.errors.missingValue(5, "Číslo")]);
    expect(rows[1]).toMatchObject({
      paidOn: "2026-02-20",
      dateEstimated: false,
      paidMinor: 12_000,
    });
    editPreview(webActor(fromCsv), id, batchOf(id).revision, {
      kind: "skip",
      keys: [rows[2]!.key],
      skip: true,
    });
    expect((await committed(db, fromCsv, id)).status).toBe("done");

    const pick = (owner: string, number: string) => {
      const row = db
        .select()
        .from(invoice)
        .where(and(eq(invoice.userId, owner), eq(invoice.number, number)))
        .get()!;
      const lines = db
        .select()
        .from(invoiceLine)
        .where(eq(invoiceLine.invoiceId, row.id))
        .orderBy(asc(invoiceLine.position))
        .all()
        .map((line) => [
          line.name,
          line.quantityMilli,
          line.unit,
          line.unitPriceMinor,
          line.netMinor,
        ]);
      const { name, street, city, zip, country, dic } = row.customerSnapshot!;
      return {
        row: {
          type: row.type,
          status: row.status,
          external: row.external,
          currency: row.currency,
          totalMinor: row.totalMinor,
          subtotalMinor: row.subtotalMinor,
          roundingMinor: row.roundingMinor,
          exchangeRateMicros: row.exchangeRateMicros,
          exchangeRateSource: row.exchangeRateSource,
          exchangeRateDate: row.exchangeRateDate,
          issueDate: row.issueDate,
          dueDate: row.dueDate,
          taxableDate: row.taxableDate,
          variableSymbol: row.variableSymbol,
          customerName: row.customerName,
          customer: { name, street, city, zip, country, dic },
        },
        lines,
        payments: db.select().from(payment).where(eq(payment.invoiceId, row.id)).all().length,
        sourceSystem: row.sourceSystem,
      };
    };
    const a = pick(fromIsdoc, "2026-0002");
    const b = pick(fromCsv, "2026-0002");
    expect(b.row).toEqual(a.row);
    expect(b.lines).toEqual(a.lines);
    expect(b.payments).toBe(a.payments);
    expect(a.row).toMatchObject({ totalMinor: 40_999, exchangeRateMicros: 25_125_000 });
    expect(b.sourceSystem).toBe("Stará tabulka");

    const paid = db
      .select()
      .from(payment)
      .innerJoin(invoice, eq(invoice.id, payment.invoiceId))
      .where(and(eq(invoice.userId, fromCsv), eq(invoice.number, "2026-0003")))
      .get()!.payment;
    expect(paid).toMatchObject({
      paidOn: "2026-02-20",
      amountMinor: 12_000,
      source: "import",
      dateEstimated: false,
      rateMicros: 25_125_000,
    });
    assertConsistent(db, fromIsdoc);
    assertConsistent(db, fromCsv);
  });

  test("[IMP-002] uložená předloha se použije na další soubor a cizí není vidět", async () => {
    const owner = importOwner(db, NOW);
    const stranger = importOwner(db, NOW);
    const builtIns = BUILTIN_PRESETS.map((preset) => preset.id);
    const { id: presetId } = savePreset(webActor(owner), {
      name: "Moje tabulka",
      mapping: customersMapping,
    });
    expect(listPresets(owner).map((preset) => [preset.id, preset.builtIn])).toEqual([
      ...builtIns.map((id) => [id, true]),
      [presetId, false],
    ]);
    expect(listPresets(stranger).map((preset) => preset.id)).toEqual(builtIns);
    expect(() => deletePreset(webActor(stranger), presetId)).toThrow(M.errors.presetNotFound);
    expect(
      savePreset(webActor(owner), { name: "Moje tabulka", mapping: customersMapping }).id,
    ).toBe(presetId);
    expect(() => savePreset(webActor(owner), { name: "", mapping: customersMapping })).toThrow(
      ServiceError,
    );
    expect(() =>
      savePreset(webActor(owner), {
        name: "S daty",
        mapping: { ...customersMapping, rows: [["Alfa"]] } as Mapping,
      }),
    ).toThrow(ServiceError);

    const stored = listPresets(owner).find((preset) => preset.id === presetId)!;
    expect(Object.keys(stored.mapping).sort()).toEqual([
      "columns",
      "currency",
      "dateFormat",
      "decimal",
      "source",
      "target",
    ]);
    const id = await tabularUploaded(owner, "dalsi.csv", fixture("zakaznici.csv"));
    const { rows } = await tabularMapped(owner, id, stored.mapping);
    expect(rows.filter((row) => row.status === "ok")).toHaveLength(4);

    const fakturoid = await tabularUploaded(
      owner,
      "kontakty.csv",
      fixture("fakturoid-kontakty.csv"),
    );
    const fromBuiltIn = await tabularMapped(owner, fakturoid, BUILTIN_PRESETS[0]!.mapping);
    expect(fromBuiltIn.rows.map((row) => row.status)).toEqual(["ok"]);
    await committed(db, owner, fakturoid);
    expect(
      imported(owner, fakturoid).map((row) => [
        row.name,
        row.ico,
        row.dic,
        row.dueDays,
        row.currency,
        row.note,
      ]),
    ).toEqual([["Omega Zkušební s.r.o.", "09990038", "CZ09990038", 30, "CZK", "Smyšlený kontakt"]]);

    deletePreset(webActor(owner), presetId);
    expect(listPresets(owner).map((preset) => preset.id)).toEqual(builtIns);
  });

  test("[IMP-001] mapování jde změnit z náhledu a chybějící sloupec se odmítne", async () => {
    const owner = importOwner(db, NOW);
    const id = await tabularUploaded(owner, "zakaznici.csv", fixture("zakaznici.csv"));
    expect(() =>
      submitMapping(webActor(owner), id, batchOf(id).revision, {
        ...customersMapping,
        columns: { name: "Firma" },
      }),
    ).toThrow(M.errors.missingColumns("Firma"));
    await tabularMapped(owner, id, { ...customersMapping, columns: { name: "Název" } });
    remapBatch(webActor(owner), id, batchOf(id).revision);
    expect(batchOf(id).status).toBe("mapping");
    expect(getPreview(owner, id)!.rows).toEqual([]);
    expect(batchOf(id).mapping).toMatchObject({ columns: { name: "Název" } });
    const { rows } = await tabularMapped(owner, id, customersMapping);
    expect(rows.map((row) => row.status)).toContain("error");
  });

  test("hodnota =HYPERLINK se uloží jako text a v exportu zůstane textem", async () => {
    const owner = importOwner(db, NOW);
    const id = await tabularUploaded(owner, "zakaznici.csv", fixture("zakaznici.csv"));
    await tabularMapped(owner, id, { ...customersMapping, columns: { name: "Název" } });
    await committed(db, owner, id);
    const name = '=HYPERLINK("http://example.test","klik")';
    const stored = imported(owner, id).find((row) => row.name === name);
    expect(stored?.name).toBe(name);

    const sheet = { name: "Zákazníci", columns: ["Název"], rows: [[text(stored!.name)]] };
    expect(toCsv(sheet)).toContain(`"'=HYPERLINK(""http://example.test"",""klik"")"`);
    const xml = strFromU8(unzipSync(toXlsx(sheet))["xl/worksheets/sheet1.xml"]!);
    expect(xml).toContain('t="inlineStr"><is><t xml:space="preserve">=HYPERLINK');
    expect(xml).not.toContain("<f>");
  });
  test("[IMP-008] zákazník založený mezi náhledem a potvrzením se nepřepíše ani nezdvojí", async () => {
    const owner = importOwner(db, NOW);
    const id = await tabularUploaded(owner, "zakaznici.csv", fixture("zakaznici.csv"));
    const { rows } = await tabularMapped(owner, id, {
      ...customersMapping,
      columns: { name: "Název", ico: "IČO" },
    });
    expect(rows.map((row) => row.status)).toEqual(["ok", "ok", "ok", "ok", "ok"]);
    const meanwhile = existingCustomer(owner, "Alfa ručně", "09990011");
    const done = await committed(db, owner, id);
    expect(done).toMatchObject({ status: "done", summary: { documents: 4, duplicates: 1 } });
    expect(imported(owner, id).map((row) => row.ico)).not.toContain("09990011");
    expect(db.select().from(customer).where(eq(customer.id, meanwhile)).get()!.name).toBe(
      "Alfa ručně",
    );
  });
  test("[IMP-009] jiná hlavička v dalším řádku téhož čísla je chyba, ne sloučení", async () => {
    const owner = importOwner(db, NOW);
    const csv = [
      "Číslo;Vystaveno;Zákazník;Měna;Položka;Cena položky",
      "1;1.2.2026;Alfa;CZK;Práce;100,00",
      "1;;;;Další práce;50,00",
      "2;2.2.2026;Beta;CZK;Práce;100,00",
      "2;2.2.2026;Gama;EUR;Licence;10,00",
      "3;3.2.2026;Beta;CZK;Práce;100,00",
      "3;4.2.2026;;;Licence;10,00",
    ].join("\n");
    const id = await tabularUploaded(owner, "f.csv", new TextEncoder().encode(csv));
    const { rows } = await tabularMapped(owner, id, {
      ...base,
      target: "invoices",
      source: "Tabulka",
      columns: {
        number: "Číslo",
        issueDate: "Vystaveno",
        customerName: "Zákazník",
        currency: "Měna",
        lineName: "Položka",
        lineTotal: "Cena položky",
      },
    });
    expect(rows.map((row) => [row.source, row.status])).toEqual([
      ["Řádky 2, 3", "ok"],
      ["Řádky 4, 5", "error"],
      ["Řádky 6, 7", "error"],
    ]);
    expect(rows[0]!.document!.totalMinor).toBe(15_000);
    expect(rows[1]!.messages).toEqual([
      M.errors.headerMismatch(5, "2", "Zákazník", 4),
      M.errors.headerMismatch(5, "2", "Měna", 4),
    ]);
    expect(rows[2]!.messages).toEqual([M.errors.headerMismatch(7, "3", "Vystaveno", 6)]);
  });

  test("dopočet ceny za jednotku je celočíselný a zaokrouhlí od nuly", async () => {
    const owner = importOwner(db, NOW);
    const csv = [
      "Číslo;Vystaveno;Položka;Množství;Cena položky",
      "1;1.2.2026;Velká;3;90071992547409,91",
      "1;;Malá;2;-0,05",
    ].join("\n");
    const id = await tabularUploaded(owner, "f.csv", new TextEncoder().encode(csv));
    const { rows } = await tabularMapped(owner, id, {
      ...base,
      target: "invoices",
      source: "Tabulka",
      columns: {
        number: "Číslo",
        issueDate: "Vystaveno",
        lineName: "Položka",
        lineQuantity: "Množství",
        lineTotal: "Cena položky",
      },
    });
    expect(rows[0]!.document!.lines.map((line) => line.unitPriceMinor)).toEqual([
      3_002_399_751_580_330, -3,
    ]);
  });

  test("vrácení importu ponechá položku ceníku, na kterou odkazuje šablona nebo plán", async () => {
    const owner = importOwner(db, NOW);
    const xlsx = toXlsx({
      name: "Ceník",
      columns: ["Název", "Cena"],
      rows: [
        [text("V šabloně"), money(100, "CZK")],
        [text("V plánu"), money(200, "CZK")],
        [text("Volná"), money(300, "CZK")],
      ],
    });
    const id = await tabularUploaded(owner, "cenik.xlsx", xlsx);
    await tabularMapped(owner, id, {
      ...base,
      target: "catalog",
      columns: { name: "Název", price: "Cena" },
    });
    await committed(db, owner, id);
    const items = db.select().from(catalogItem).where(eq(catalogItem.importBatchId, id)).all();
    const itemId = (name: string) => items.find((item) => item.name === name)!.id;
    const documentWith = (catalogItemId: string) =>
      ({ lines: [{ catalogItemId }] }) as unknown as typeof invoiceTemplate.$inferInsert.document;
    db.insert(invoiceTemplate)
      .values({
        id: "t-1",
        userId: owner,
        name: "Šablona",
        document: documentWith(itemId("V šabloně")),
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();
    db.insert(recurringInvoice)
      .values({
        id: "p-1",
        userId: owner,
        name: "Plán",
        document: documentWith(itemId("V plánu")),
        frequency: "monthly",
        issueRule: "day",
        issueDay: 1,
        startsOn: "2026-04-01",
        cursorDate: "2026-03-31",
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();
    undoBatch(webActor(owner), id);
    const left = db.select().from(catalogItem).where(eq(catalogItem.importBatchId, id)).all();
    expect(left.map((item) => item.name).sort()).toEqual(["V plánu", "V šabloně"]);
  });
});
