import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { computeTotals } from "@/lib/invoice-totals";
import { setClockForTests } from "@/server/clock";
import { userDir } from "@/server/files/store";
import {
  auditLog,
  catalogItem,
  file,
  invoice,
  invoiceLine,
  numberSeries,
  numberSeriesCounter,
  user,
} from "@/server/db/schema";
import { saveBankAccount, hideBankAccount } from "@/server/services/bank-accounts";
import { getCatalogItem, saveCatalogItem } from "@/server/services/catalog";
import { saveCustomer } from "@/server/services/customers";
import { readOwnedFile } from "@/server/services/files";
import { loadInvoiceDocument } from "@/server/services/invoice-document";
import {
  cancelInvoice,
  checkIssuable,
  issueInvoice,
  markSent,
  NotIssuableError,
  previewIssue,
  restoreInvoice,
  storeLines,
} from "@/server/services/invoice-lifecycle";
import { updateIssuedInvoice } from "@/server/services/invoice-versions";
import {
  deleteDraft,
  getInvoice,
  newDraftDefaults,
  saveDraft,
  type DraftInput,
} from "@/server/services/invoices";
import {
  allocateNumber,
  ensureDefaultSeries,
  listSeries,
  saveSeries,
} from "@/server/services/number-series";
import { savePreferences } from "@/server/services/preferences";
import {
  clearSupplierImage,
  getSupplier,
  saveSupplier,
  setSupplierImage,
  type SupplierInput,
} from "@/server/services/supplier";
import { deleteUser } from "@/server/services/users";
import { assertConsistent } from "../helpers/consistency";
import { createTestDb } from "../helpers/db";
import { runAllocateWorkers } from "../helpers/run-workers";

vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-issue-")));

const db = createTestDb();
const actor = (userId: string) => ({ userId, source: "web" as const });
const NOW = new Date("2026-03-10T10:00:00Z");
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 1),
]);

let ownerCounter = 0;

function seed(id: string) {
  const now = new Date();
  db.insert(user)
    .values({ id, name: id, email: `${id}@example.cz`, createdAt: now, updatedAt: now })
    .run();
}

const supplierInput: SupplierInput = {
  name: "Jan Novák",
  street: "Dlouhá 1",
  city: "Praha",
  zip: "110 00",
  country: "Česká republika",
  ico: "27082440",
  dic: "",
  email: "",
  phone: "",
  web: "",
  registryNote: "",
  contactPerson: "",
  vatIdentified: false,
  footerText: "",
  notVatPayerCs: "Nejsem plátce DPH.",
  notVatPayerEn: "I am not a VAT payer.",
};

const customerInput = (name: string) => ({
  name,
  street: "Krátká 2",
  city: "Brno",
  zip: "602 00",
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
});

const newCustomer = (owner: string, name = "Alfa s.r.o.") =>
  saveCustomer(actor(owner), customerInput(name)).id;

const newAccount = (owner: string, currency: "CZK" | "EUR" = "CZK") =>
  saveBankAccount(actor(owner), {
    name: `Účet ${currency}`,
    currency,
    number: "19-2000145399",
    bankCode: "0800",
    iban: "",
    swift: "",
  });

function newOwner(): { owner: string; customerId: string; accountId: string } {
  const owner = `u${(ownerCounter += 1)}`;
  seed(owner);
  ensureDefaultSeries(actor(owner));
  saveSupplier(actor(owner), supplierInput);
  return { owner, customerId: newCustomer(owner), accountId: newAccount(owner) };
}

const line = (over: Partial<DraftInput["lines"][number]> = {}): DraftInput["lines"][number] => ({
  catalogItemId: null,
  name: "Konzultace",
  description: "",
  quantityMilli: 2000,
  unit: "hod.",
  unitPriceMinor: 150_000,
  discountKind: "none",
  discountValue: 0,
  ...over,
});

function save(owner: string, customerId: string | null, over: Partial<DraftInput> = {}) {
  return saveDraft(actor(owner), {
    ...newDraftDefaults(owner, customerId),
    lines: [line()],
    ...over,
  });
}

function issueNew(
  owner: string,
  customerId: string | null,
  over: Partial<DraftInput> = {},
  opts: { seriesId?: string; variableSymbol?: string } = {},
) {
  const { id, revision } = save(owner, customerId, over);
  return issueInvoice(actor(owner), id, { revision, ...opts });
}

const fields = (owner: string, id: string) => checkIssuable(owner, id).map((p) => p.field);

const counters = (owner: string) =>
  db.select().from(numberSeriesCounter).where(eq(numberSeriesCounter.userId, owner)).all();

const audit = (id: string, action: string) =>
  db
    .select()
    .from(auditLog)
    .where(eq(auditLog.entityId, id))
    .all()
    .find((row) => row.action === action);

beforeEach(() => setClockForTests({ now: () => NOW }));
afterEach(() => setClockForTests(null));

describe("kontrola před vystavením", () => {
  test("[SET-002] bez IČO nejde vystavit a problém pojmenuje pole", () => {
    const { owner, customerId } = newOwner();
    db.run(sql`UPDATE supplier SET ico = '' WHERE user_id = ${owner}`);
    const { id, revision } = save(owner, customerId);

    expect(checkIssuable(owner, id)).toEqual([
      { field: "supplier.ico", message: expect.stringContaining("IČO") },
    ]);
    expect(() => issueInvoice(actor(owner), id, { revision })).toThrow(/IČO/);
    expect(getInvoice(owner, id)?.status).toBe("draft");
  });

  test("[SET-002] bez profilu dodavatele chybí všechna povinná pole", () => {
    const owner = `u${(ownerCounter += 1)}`;
    seed(owner);
    ensureDefaultSeries(actor(owner));
    const customerId = newCustomer(owner);
    newAccount(owner);
    const { id } = save(owner, customerId);

    expect(fields(owner, id)).toEqual([
      "supplier.name",
      "supplier.street",
      "supplier.city",
      "supplier.zip",
      "supplier.country",
      "supplier.ico",
    ]);
  });

  test("[INV-001] kontrola vrací všechny problémy najednou", () => {
    const { owner } = newOwner();
    const { id } = save(owner, null, {
      issueDate: "2026-03-10",
      dueDate: "2026-03-09",
      currency: "EUR",
      bankAccountId: null,
      lines: [line({ name: " ", quantityMilli: 0 })],
    });

    expect(fields(owner, id)).toEqual([
      "customerId",
      "lines.0.name",
      "lines.0.quantityMilli",
      "dueDate",
      "bankAccountId",
      "exchangeRateMicros",
    ]);
  });

  test("[INV-001] koncept bez položek a bez dat neprojde", () => {
    const { owner, customerId } = newOwner();
    const { id } = save(owner, customerId, { lines: [], issueDate: null, dueDate: null });

    expect(fields(owner, id)).toEqual(["lines", "issueDate", "dueDate"]);
  });

  test("[INV-001] kompletní koncept je bez problémů", () => {
    const { owner, customerId } = newOwner();
    const { id } = save(owner, customerId);

    expect(checkIssuable(owner, id)).toEqual([]);
  });

  test("[INV-001] u konceptu rozhodují aktuální data dodavatele", () => {
    const { owner, customerId } = newOwner();
    const { id } = save(owner, customerId);
    expect(checkIssuable(owner, id)).toEqual([]);

    db.run(sql`UPDATE supplier SET city = '' WHERE user_id = ${owner}`);

    expect(fields(owner, id)).toEqual(["supplier.city"]);
  });

  test("[INV-001] vystavený doklad znovu vystavit nejde", () => {
    const { owner, customerId } = newOwner();
    const { id } = issueNew(owner, customerId);

    expect(fields(owner, id)).toEqual(["status"]);
  });

  test("[INV-001] neexistující doklad a cizí doklad", () => {
    const { owner, customerId } = newOwner();
    const other = newOwner();
    const { id, revision } = save(owner, customerId);

    expect(() => checkIssuable(other.owner, id)).toThrow("Doklad neexistuje");
    expect(() => issueInvoice(actor(other.owner), id, { revision })).toThrow("Doklad neexistuje");
    expect(getInvoice(owner, id)?.status).toBe("draft");
  });

  test("[FOR-005] převod bez účtu v EUR je odmítnutý s vysvětlením", () => {
    const { owner, customerId } = newOwner();
    const { id, revision } = save(owner, customerId, {
      currency: "EUR",
      bankAccountId: null,
      exchangeRateMicros: 25_000_000,
    });

    expect(checkIssuable(owner, id)).toEqual([
      { field: "bankAccountId", message: expect.stringContaining("EUR") },
    ]);
    expect(() => issueInvoice(actor(owner), id, { revision })).toThrow(NotIssuableError);
    expect(() => issueInvoice(actor(owner), id, { revision })).toThrow(/EUR/);
  });

  test("[FOR-005] účet v jiné měně než faktura je odmítnutý", () => {
    const { owner, customerId, accountId } = newOwner();
    const { id } = save(owner, customerId, {
      currency: "EUR",
      bankAccountId: accountId,
      exchangeRateMicros: 25_000_000,
    });

    expect(fields(owner, id)).toEqual(["bankAccountId"]);
  });

  test("[FOR-005] skrytý účet je odmítnutý", () => {
    const { owner, customerId, accountId } = newOwner();
    const second = saveBankAccount(actor(owner), {
      name: "Druhý",
      currency: "CZK",
      number: "19-2000145399",
      bankCode: "0100",
      iban: "",
      swift: "",
    });
    const { id } = save(owner, customerId, { bankAccountId: second });
    hideBankAccount(actor(owner), second);

    expect(checkIssuable(owner, id)).toEqual([
      { field: "bankAccountId", message: expect.stringContaining("skrytý") },
    ]);
    expect(accountId).not.toBe(second);
  });

  test("[FOR-005] hotovost účet nepotřebuje", () => {
    const { owner, customerId } = newOwner();
    const { id } = issueNew(owner, customerId, { paymentMethod: "cash", bankAccountId: null });

    expect(getInvoice(owner, id)?.accountSnapshot).toBeNull();
  });

  test("[INV-001] cizí měna vyžaduje kurz", () => {
    const { owner, customerId } = newOwner();
    const eur = newAccount(owner, "EUR");
    const { id } = save(owner, customerId, { currency: "EUR", bankAccountId: eur });
    expect(fields(owner, id)).toEqual(["exchangeRateMicros"]);

    const withRate = save(owner, customerId, {
      currency: "EUR",
      bankAccountId: eur,
      exchangeRateMicros: 25_000_000,
    });
    expect(checkIssuable(owner, withRate.id)).toEqual([]);
  });

  test("[INV-001] částka mimo limit je problém, ne pád", () => {
    const { owner, customerId } = newOwner();
    const { id, revision } = save(owner, customerId);
    db.update(invoiceLine)
      .set({ unitPriceMinor: Number.MAX_SAFE_INTEGER })
      .where(eq(invoiceLine.invoiceId, id))
      .run();

    expect(fields(owner, id)).toEqual(["lines"]);
    expect(() => issueInvoice(actor(owner), id, { revision })).toThrow(/příliš vysoká/);
    expect(counters(owner)).toEqual([]);
  });
});

describe("záporná cena", () => {
  test("úprava vystavené faktury zápornou cenu odmítne a doklad zůstane", () => {
    const { owner, customerId, accountId } = newOwner();
    const { id } = issueNew(owner, customerId, { bankAccountId: accountId });
    const row = getInvoice(owner, id)!;

    expect(() =>
      updateIssuedInvoice(actor(owner), id, {
        ...row,
        number: row.number!,
        lines: [line({ unitPriceMinor: -100 })],
      }),
    ).toThrow(NotIssuableError);
    expect(getInvoice(owner, id)).toMatchObject({ revision: row.revision, totalMinor: 300_000 });
  });

  test("kontrola před vystavením zápornou cenu pustí jen u opravné faktury", () => {
    const { owner, customerId, accountId } = newOwner();
    const { id } = save(owner, customerId, { lines: [line()], bankAccountId: accountId });
    db.run(sql`UPDATE invoice SET type = 'credit_note' WHERE id = ${id}`);
    db.run(sql`UPDATE invoice_line SET unit_price_minor = -100 WHERE invoice_id = ${id}`);
    expect(fields(owner, id)).not.toContain("lines.0.unitPriceMinor");

    db.run(sql`UPDATE invoice SET type = 'invoice' WHERE id = ${id}`);
    expect(fields(owner, id)).toContain("lines.0.unitPriceMinor");
  });
});

describe("vystavení", () => {
  test("[INV-001] vystavení přidělí číslo z řady", () => {
    const { owner, customerId, accountId } = newOwner();
    const { id, revision } = save(owner, customerId);

    expect(issueInvoice(actor(owner), id, { revision })).toEqual({ id, number: "2026-001" });

    const row = getInvoice(owner, id)!;
    expect(row).toMatchObject({
      status: "issued",
      number: "2026-001",
      customerName: "Alfa s.r.o.",
      bankAccountId: accountId,
      issuedAt: NOW,
      revision: revision + 1,
    });
    expect(row.searchText).toContain("2026-001");
    assertConsistent(db, owner);
  });

  test("[AUD-009] audit vystavení nese číslo, řadu a dosazené texty", () => {
    const { owner, customerId } = newOwner();
    const seriesId = listSeries(owner).find((row) => row.documentType === "invoice")!.id;
    const { id, revision } = save(owner, customerId, {
      seriesId,
      note: "Rok {{rok}}",
      lines: [line({ name: "Služby {{rok}}" })],
    });

    issueInvoice(actor(owner), id, { revision });

    expect(audit(id, "invoice.issue")).toMatchObject({
      before: {
        status: "draft",
        number: null,
        note: "Rok {{rok}}",
        lines: { changed: [{ name: "Služby {{rok}}" }] },
      },
      after: {
        status: "issued",
        number: "2026-001",
        seriesId,
        note: "Rok 2026",
        lines: { changed: [{ name: "Služby 2026" }] },
      },
    });
  });

  test("[TST-018] vystavení přepíše částky řádků z téhož výpočtu jako hlavičku", () => {
    const { owner, customerId } = newOwner();
    const { id, revision } = save(owner, customerId);
    db.update(invoiceLine).set({ netMinor: 1 }).where(eq(invoiceLine.invoiceId, id)).run();

    issueInvoice(actor(owner), id, { revision });

    expect(getInvoice(owner, id)?.lines[0]?.netMinor).toBe(300_000);
    expect(getInvoice(owner, id)?.totalMinor).toBe(300_000);
    assertConsistent(db, owner);
  });

  test("[SET-030] vystavený doklad drží formát data z okamžiku vystavení", () => {
    const { owner, customerId } = newOwner();
    savePreferences(actor(owner), { dateFormat: "dd.MM.yyyy" });
    const { id } = issueNew(owner, customerId, { note: "{{obdobi_od}}" });
    const draft = save(owner, customerId);

    savePreferences(actor(owner), { dateFormat: "yyyy-MM-dd" });

    expect(loadInvoiceDocument(owner, id)).toMatchObject({
      dateFormat: "dd.MM.yyyy",
      note: "01.03.2026",
    });
    expect(loadInvoiceDocument(owner, draft.id)?.dateFormat).toBe("yyyy-MM-dd");
    expect(getInvoice(owner, draft.id)?.dateFormat).toBeNull();
  });

  test("[TPL-004] text přerostlý po dosazení je odmítnutý s pojmenovaným polem", () => {
    const { owner } = newOwner();
    const customerId = newCustomer(owner, "Velmi dlouhý název zákazníka s.r.o.");
    const tooLong = "{{zakaznik}}".repeat(100);
    const { id, revision } = save(owner, customerId, {
      textBefore: "{{zakaznik}}".repeat(100),
      textAfter: tooLong,
      note: tooLong,
      lines: [line({ name: "x".repeat(180) + "{{zakaznik}}", description: tooLong })],
    });

    expect(fields(owner, id)).toEqual([
      "textBefore",
      "textAfter",
      "note",
      "lines.0.name",
      "lines.0.description",
    ]);
    expect(() => issueInvoice(actor(owner), id, { revision })).toThrow(NotIssuableError);
    expect(counters(owner)).toEqual([]);
  });

  test("[TPL-004] kontrola délky počítá se skutečným číslem řady", () => {
    const { owner, customerId } = newOwner();
    const longSeries = saveSeries(actor(owner), {
      name: "Dlouhá",
      documentType: "invoice",
      template: "FAKTURA-DLOUHA-SERIE-{RRRR}-{NNN}",
      reset: "yearly",
    });
    const name = "x".repeat(183) + "{{cislo_faktury}}";
    const onLong = save(owner, customerId, { seriesId: longSeries, lines: [line({ name })] });
    const onDefault = save(owner, customerId, { lines: [line({ name })] });

    expect(fields(owner, onLong.id)).toEqual(["lines.0.name"]);
    expect(fields(owner, onDefault.id)).toEqual([]);
    expect(() =>
      issueInvoice(actor(owner), onDefault.id, { ...onDefault, seriesId: longSeries }),
    ).toThrow(NotIssuableError);
    expect(counters(owner)).toEqual([]);
    expect(getInvoice(owner, onDefault.id)?.status).toBe("draft");
  });

  test("[INV-001] zastaralá revize je odmítnutá a číslo se nespotřebuje", () => {
    const { owner, customerId } = newOwner();
    const { id, revision } = save(owner, customerId);

    expect(() => issueInvoice(actor(owner), id, { revision: revision + 1 })).toThrow(/mezitím/);
    expect(counters(owner)).toEqual([]);
  });

  test("[INV-001] druhé vystavení téhož konceptu neprojde", () => {
    const { owner, customerId } = newOwner();
    const { id, revision } = save(owner, customerId);
    issueInvoice(actor(owner), id, { revision });

    expect(() => issueInvoice(actor(owner), id, { revision })).toThrow(/mezitím/);
    expect(() => issueInvoice(actor(owner), id, { revision: revision + 1 })).toThrow(/mezitím/);
    expect(counters(owner)[0]?.next).toBe(2);
  });

  test("[NUM-003] faktura použije zvolenou řadu, cizí řada je odmítnutá", () => {
    const { owner, customerId } = newOwner();
    const other = newOwner();
    const mine = saveSeries(actor(owner), {
      name: "Druhá",
      documentType: "invoice",
      template: "B{RRRR}-{NN}",
      reset: "yearly",
    });
    const foreign = listSeries(other.owner)[0]!.id;
    const advance = listSeries(owner).find((row) => row.documentType === "advance")!.id;

    expect(issueNew(owner, customerId, {}, { seriesId: mine }).number).toBe("B2026-01");
    expect(getInvoice(owner, issueNew(owner, customerId, { seriesId: mine }).id)?.number).toBe(
      "B2026-02",
    );

    const { id, revision } = save(owner, customerId);
    expect(() => issueInvoice(actor(owner), id, { revision, seriesId: foreign })).toThrow(
      "Číselná řada neexistuje",
    );
    expect(() => issueInvoice(actor(owner), id, { revision, seriesId: advance })).toThrow(
      /typu dokladu/,
    );
    expect(getInvoice(owner, id)?.status).toBe("draft");
    expect(counters(other.owner)).toEqual([]);
  });

  test("[NUM-003] řada konceptu smazaná nebo neuvedená spadne na výchozí", () => {
    const { owner, customerId } = newOwner();

    expect(issueNew(owner, customerId, { seriesId: null }).number).toBe("2026-001");
  });

  test("[NUM-003] bez řady nejde vystavit", () => {
    const { owner, customerId } = newOwner();
    const { id } = save(owner, customerId, { seriesId: null, type: "advance" });
    db.delete(numberSeries)
      .where(sql`${numberSeries.userId} = ${owner} AND ${numberSeries.documentType} = 'advance'`)
      .run();

    expect(fields(owner, id)).toEqual(["seriesId"]);
  });

  test("[NUM-005] 20 souběžných vystavení dá 20 různých čísel", async () => {
    const { owner, customerId } = newOwner();
    const drafts = Array.from({ length: 20 }, () => save(owner, customerId));
    const chunks = [0, 1, 2, 3].map((i) => drafts.filter((_, n) => n % 4 === i));

    const perWorker = await runAllocateWorkers<{ id: string; number: string }[]>(
      chunks.map((issues) => ({ ownerId: owner, issues })),
      db.$client.name,
    );

    const numbers = perWorker.flat().map((row) => row.number);
    expect(new Set(numbers).size).toBe(20);
    expect([...numbers].sort()).toEqual(
      Array.from({ length: 20 }, (_, i) => `2026-${String(i + 1).padStart(3, "0")}`),
    );
    assertConsistent(db, owner);
  }, 30_000);

  test("[NUM-005] ručně obsazené 2026-002 se přeskočí", () => {
    const { owner, customerId } = newOwner();
    const manualSeries = saveSeries(actor(owner), {
      name: "Ruční",
      documentType: "invoice",
      template: "R{RRRR}-{NNN}",
      reset: "yearly",
    });
    expect(issueNew(owner, customerId).number).toBe("2026-001");
    const renumbered = issueNew(owner, customerId, {}, { seriesId: manualSeries });
    db.update(invoice).set({ number: "2026-002" }).where(eq(invoice.id, renumbered.id)).run();

    expect(issueNew(owner, customerId).number).toBe("2026-003");
  });

  test("[NUM-005] allocateNumber přeskočí víc obsazených čísel za sebou", () => {
    const { owner, customerId } = newOwner();
    const seriesId = listSeries(owner).find((row) => row.documentType === "invoice")!.id;
    const a = issueNew(owner, customerId);
    const b = issueNew(owner, customerId);
    db.update(invoice).set({ number: "2026-003" }).where(eq(invoice.id, b.id)).run();
    db.update(invoice).set({ number: "2026-002" }).where(eq(invoice.id, a.id)).run();
    db.update(numberSeriesCounter)
      .set({ next: 2, highest: 1 })
      .where(eq(numberSeriesCounter.seriesId, seriesId))
      .run();

    const result = db.transaction((tx) => allocateNumber(tx, owner, seriesId, "2026-03-10"));

    expect(result).toEqual({
      number: "2026-004",
      n: 4,
      skipped: ["2026-002", "2026-003"],
    });
    expect(counters(owner)[0]).toMatchObject({ next: 5, highest: 4 });
  });

  test("[NUM-005] odmítnuté vystavení nespotřebuje číslo", () => {
    const { owner, customerId } = newOwner();
    const { id, revision } = save(owner, null);
    expect(() => issueInvoice(actor(owner), id, { revision })).toThrow(NotIssuableError);
    expect(counters(owner)).toEqual([]);

    const later = save(owner, customerId);
    db.run(sql`CREATE TRIGGER fail_issue BEFORE UPDATE OF status ON invoice
      BEGIN SELECT RAISE(ABORT, 'zápis selhal'); END`);
    try {
      expect(() => issueInvoice(actor(owner), later.id, later)).toThrow("zápis selhal");
    } finally {
      db.run(sql`DROP TRIGGER fail_issue`);
    }

    expect(counters(owner)).toEqual([]);
    expect(getInvoice(owner, later.id)).toMatchObject({ status: "draft", number: null });
    expect(issueInvoice(actor(owner), later.id, later).number).toBe("2026-001");
  });

  test("[NUM-007] VS 2026040 z čísla 2026-040, ruční VS s písmeny je odmítnutý", () => {
    const { owner, customerId } = newOwner();
    const seriesId = listSeries(owner).find((row) => row.documentType === "invoice")!.id;
    db.insert(numberSeriesCounter)
      .values({ seriesId, periodKey: "2026", userId: owner, next: 40, highest: 39 })
      .run();

    const { id } = issueNew(owner, customerId);
    expect(getInvoice(owner, id)).toMatchObject({
      number: "2026-040",
      variableSymbol: "2026040",
      variableSymbolManual: false,
    });

    const draft = save(owner, customerId);
    for (const variableSymbol of ["12a4", "12345678901", "12 34"]) {
      expect(() =>
        issueInvoice(actor(owner), draft.id, { revision: draft.revision, variableSymbol }),
      ).toThrow(/číslice/);
    }
    expect(getInvoice(owner, draft.id)?.status).toBe("draft");

    issueInvoice(actor(owner), draft.id, {
      revision: draft.revision,
      variableSymbol: "0123456789",
    });
    expect(getInvoice(owner, draft.id)).toMatchObject({
      number: "2026-041",
      variableSymbol: "0123456789",
      variableSymbolManual: true,
    });
  });

  test("[NUM-007] prázdný VS z dialogu nechá doklad bez symbolu, ne s automatickým", () => {
    const { owner, customerId } = newOwner();

    const { id } = issueNew(owner, customerId, {}, { variableSymbol: "" });

    expect(getInvoice(owner, id)).toMatchObject({
      number: "2026-001",
      variableSymbol: null,
      variableSymbolManual: true,
    });
  });

  test("[NUM-007] formát Nevyplňovat nechá VS prázdný", () => {
    const { owner, customerId } = newOwner();
    savePreferences(actor(owner), { variableSymbolFormat: "empty" });

    const { id } = issueNew(owner, customerId);

    expect(getInvoice(owner, id)?.variableSymbol).toBeNull();
  });

  test("[CAT-003] změna ceny v ceníku nemění vystavený doklad", () => {
    const { owner, customerId } = newOwner();
    const input = {
      name: "Audit",
      description: "",
      unit: "ks",
      priceMinor: 100_000,
      currency: "CZK" as const,
      category: "",
      tags: [],
    };
    const { id: itemId } = saveCatalogItem(actor(owner), input);
    const { id } = issueNew(owner, customerId, {
      lines: [
        line({ catalogItemId: itemId, unitPriceMinor: 100_000 }),
        line({ catalogItemId: itemId, unitPriceMinor: 100_000 }),
      ],
    });
    expect(getCatalogItem(owner, itemId)?.useCount).toBe(2);

    saveCatalogItem(actor(owner), { ...input, id: itemId, priceMinor: 999_900 });

    expect(getInvoice(owner, id)?.lines[0]?.unitPriceMinor).toBe(100_000);
    expect(getInvoice(owner, id)?.totalMinor).toBe(400_000);
  });

  test("[CAT-003] koncept použití v ceníku nezapočítá", () => {
    const { owner, customerId } = newOwner();
    const { id: itemId } = saveCatalogItem(actor(owner), {
      name: "Audit",
      description: "",
      unit: "ks",
      priceMinor: 100_000,
      currency: "CZK",
      category: "",
      tags: [],
    });

    save(owner, customerId, { lines: [line({ catalogItemId: itemId })] });

    expect(db.select().from(catalogItem).where(eq(catalogItem.id, itemId)).get()?.useCount).toBe(0);
  });

  test("[CUS-008] přejmenování zákazníka nezmění vystavený doklad", () => {
    const { owner, customerId, accountId } = newOwner();
    const { id } = issueNew(owner, customerId);
    saveCustomer(actor(owner), { ...customerInput("Beta a.s."), id: customerId, city: "Ostrava" });
    saveSupplier(actor(owner), { ...supplierInput, name: "Nové jméno" });
    db.run(sql`UPDATE bank_account SET name = 'Přejmenovaný' WHERE id = ${accountId}`);

    const doc = loadInvoiceDocument(owner, id)!;

    expect(doc.snapshot.customer).toMatchObject({ name: "Alfa s.r.o.", city: "Brno" });
    expect(doc.snapshot.supplier).toMatchObject({ name: "Jan Novák", ico: "27082440" });
    expect(doc.snapshot.account).toMatchObject({ name: "Účet CZK", currency: "CZK" });
    expect(doc.customerName).toBe("Alfa s.r.o.");
  });

  test("[CUS-008] vystavení vezme aktuální jméno zákazníka, ne to z konceptu", () => {
    const { owner, customerId } = newOwner();
    const { id, revision } = save(owner, customerId);
    saveCustomer(actor(owner), { ...customerInput("Beta a.s."), id: customerId });

    issueInvoice(actor(owner), id, { revision });

    expect(getInvoice(owner, id)?.customerName).toBe("Beta a.s.");
  });

  test("[CUS-008] koncept čte strany dokladu z aktuálních dat", () => {
    const { owner, customerId } = newOwner();
    const { id } = save(owner, customerId, { note: "{{zakaznik}} {{cislo_faktury}}|" });
    saveCustomer(actor(owner), { ...customerInput("Beta a.s."), id: customerId });

    const doc = loadInvoiceDocument(owner, id)!;

    expect(doc.number).toBeNull();
    expect(doc.snapshot.customer?.name).toBe("Beta a.s.");
    expect(doc.note).toBe("Beta a.s. 2026-001|");
    expect(getInvoice(owner, id)?.note).toBe("{{zakaznik}} {{cislo_faktury}}|");
  });

  test("[TPL-004] {{rok}} a {{cislo_faktury}} se dosadí při vystavení", () => {
    const { owner, customerId } = newOwner();
    const { id, revision } = save(owner, customerId, {
      textBefore: "Rok {{rok}}",
      textAfter: "Doklad {{cislo_faktury}}",
      note: "{{mesic_nazev}} pro {{zakaznik}} {{neznama}}",
      lines: [line({ name: "Služby {{mesic}}/{{rok}}", description: "od {{obdobi_od}}" })],
    });

    expect(getInvoice(owner, id)?.note).toContain("{{mesic_nazev}}");
    issueInvoice(actor(owner), id, { revision });

    const row = getInvoice(owner, id)!;
    expect(row).toMatchObject({
      textBefore: "Rok 2026",
      textAfter: "Doklad 2026-001",
      note: "březen pro Alfa s.r.o. {{neznama}}",
    });
    expect(row.lines[0]).toMatchObject({ name: "Služby 3/2026", description: "od 1. 3. 2026" });
  });

  test("[TPL-004] objednávka a reference se dosadí při vystavení i v náhledu", () => {
    const { owner, customerId } = newOwner();
    const { id, revision } = save(owner, customerId, {
      orderRef: "OBJ-{{rok}}",
      reference: "{{zakaznik}} {{mesic}}/{{rok}}",
    });

    expect(loadInvoiceDocument(owner, id)).toMatchObject({
      orderRef: "OBJ-2026",
      reference: "Alfa s.r.o. 3/2026",
    });

    issueInvoice(actor(owner), id, { revision });

    expect(getInvoice(owner, id)).toMatchObject({
      orderRef: "OBJ-2026",
      reference: "Alfa s.r.o. 3/2026",
    });
    expect(audit(id, "invoice.issue")).toMatchObject({
      before: { orderRef: "OBJ-{{rok}}" },
      after: { orderRef: "OBJ-2026" },
    });
  });

  test("[TPL-004] objednávka a reference přerostlé po dosazení jsou odmítnuté", () => {
    const { owner } = newOwner();
    const customerId = newCustomer(owner, "D".repeat(150));
    const { id, revision } = save(owner, customerId, {
      orderRef: `${"o".repeat(100)}{{zakaznik}}`,
      reference: `${"r".repeat(100)}{{zakaznik}}`,
    });

    expect(fields(owner, id)).toEqual(expect.arrayContaining(["orderRef", "reference"]));
    expect(() => issueInvoice(actor(owner), id, { revision })).toThrow(NotIssuableError);
  });

  test("[TPL-004] náhled dosadí číslo, které by doklad dostal", () => {
    const { owner, customerId } = newOwner();
    issueNew(owner, customerId);
    const { id } = save(owner, customerId, { note: "Doklad {{cislo_faktury}}" });

    expect(loadInvoiceDocument(owner, id)?.note).toBe("Doklad 2026-002");
  });

  test("[NUM-005] audit vystavení nese přeskočená čísla a počet použití ceníku", () => {
    const { owner, customerId } = newOwner();
    const manualSeries = saveSeries(actor(owner), {
      name: "Ruční",
      documentType: "invoice",
      template: "R{RRRR}-{NNN}",
      reset: "yearly",
    });
    issueNew(owner, customerId);
    const renumbered = issueNew(owner, customerId, {}, { seriesId: manualSeries });
    db.update(invoice).set({ number: "2026-002" }).where(eq(invoice.id, renumbered.id)).run();
    const item = saveCatalogItem(actor(owner), {
      name: "Hosting",
      description: "",
      unit: "ks",
      priceMinor: 100,
      currency: "CZK",
      category: "",
      tags: [],
    });
    const { id, revision } = save(owner, customerId, {
      lines: [line({ catalogItemId: item.id }), line({ catalogItemId: item.id })],
    });

    issueInvoice(actor(owner), id, { revision });

    expect(audit(id, "invoice.issue")).toMatchObject({
      after: {
        number: "2026-003",
        skippedNumbers: ["2026-002"],
        catalogUse: [{ id: item.id, useCount: 2 }],
      },
    });
  });

  test("[TST-009] zápis řádků po vystavení cizí řádek nezmění", () => {
    const { owner, customerId } = newOwner();
    const { owner: stranger } = newOwner();
    const { id } = save(owner, customerId);
    const lines = getInvoice(owner, id)!.lines;

    db.transaction((tx) =>
      storeLines(
        tx,
        stranger,
        lines,
        lines.map((row) => ({ ...row, name: "Cizí zásah" })),
      ),
    );

    expect(getInvoice(owner, id)?.lines[0]?.name).toBe("Konzultace");
  });

  test("[INV-014] náhled vystavení ukáže zákazníka, částku a omezenou slevu", () => {
    const { owner, customerId } = newOwner();
    const { id } = save(owner, customerId, {
      discountKind: "amount",
      discountValue: 900_000,
      lines: [
        line(),
        line({ quantityMilli: 1000, discountKind: "amount", discountValue: 200_000 }),
      ],
    });

    expect(previewIssue(owner, id)).toMatchObject({
      customerName: "Alfa s.r.o.",
      totalMinor: 0,
      currency: "CZK",
      discountNotes: [
        "Sleva na doklad je vyšší než základ, uplatní se jen do výše základu.",
        "Položka 2: sleva je vyšší než cena, uplatní se jen do výše ceny.",
      ],
    });
  });

  test("[SEC-011] hodnota zákazníka {{rok}} se nerozvine", () => {
    const { owner } = newOwner();
    const customerId = newCustomer(owner, "{{rok}}");

    const { id } = issueNew(owner, customerId, { note: "Pro {{zakaznik}} v {{rok}}" });

    expect(getInvoice(owner, id)?.note).toBe("Pro {{rok}} v 2026");
  });

  test("[TST-018] uložené součty odpovídají položkám po vystavení", () => {
    const { owner, customerId } = newOwner();
    const { id } = issueNew(owner, customerId, {
      discountKind: "percent",
      discountValue: 1000,
      rounding: "whole",
      lines: [
        line({ quantityMilli: 1500, unitPriceMinor: 33_333 }),
        line({ discountKind: "amount", discountValue: 5000 }),
      ],
    });

    const row = getInvoice(owner, id)!;
    const totals = computeTotals(
      [
        { quantityMilli: 1500, unitPriceMinor: 33_333, discount: { kind: "none" } },
        { quantityMilli: 2000, unitPriceMinor: 150_000, discount: { kind: "amount", minor: 5000 } },
      ],
      { kind: "percent", basisPoints: 1000 },
      "whole",
    );
    expect(row).toMatchObject({
      subtotalMinor: totals.subtotalMinor,
      discountMinor: totals.discountMinor,
      roundingMinor: totals.roundingMinor,
      totalMinor: totals.totalMinor,
    });
    expect(loadInvoiceDocument(owner, id)?.totals.totalMinor).toBe(totals.totalMinor);
    assertConsistent(db, owner);
  });

  test("[TST-018] dokument nese hlavičku, řádky a vzhled bez štítků a vlastníka", () => {
    const { owner, customerId } = newOwner();
    setSupplierImage(actor(owner), "logo", PNG, "logo.png");
    const logo = getSupplier(owner)?.logoFileId;
    const { id } = issueNew(owner, customerId);

    const doc = loadInvoiceDocument(owner, id)!;

    expect(doc).toMatchObject({
      id,
      number: "2026-001",
      variableSymbol: "2026001",
      status: "issued",
      images: { logoFileId: logo, qrLogoFileId: null, signatureFileId: null },
    });
    expect(doc.appearance.designId).toBeTruthy();
    expect(doc.lines).toHaveLength(1);
    expect(doc).not.toHaveProperty("tags");
    expect(doc).not.toHaveProperty("userId");
    expect(loadInvoiceDocument(owner, "neni")).toBeNull();
  });
});

describe("životní cyklus", () => {
  test("[INV-002] vystavenou fakturu nejde smazat", () => {
    const { owner, customerId } = newOwner();
    const { id } = issueNew(owner, customerId);

    expect(() => deleteDraft(actor(owner), id)).toThrow(/jde stornovat/);
    expect(getInvoice(owner, id)?.status).toBe("issued");
  });

  test("[INV-003] storno a jeho vrácení obnoví předchozí stav a číslo", () => {
    const { owner, customerId } = newOwner();
    const { id, number } = issueNew(owner, customerId);
    markSent(actor(owner), id);

    cancelInvoice(actor(owner), id);
    expect(getInvoice(owner, id)).toMatchObject({
      status: "cancelled",
      cancelledFrom: "sent",
      number,
    });
    expect(issueNew(owner, customerId).number).toBe("2026-002");

    restoreInvoice(actor(owner), id);
    expect(getInvoice(owner, id)).toMatchObject({ status: "sent", cancelledFrom: null, number });
    expect(audit(id, "invoice.mark_sent")).toMatchObject({
      before: { status: "issued" },
      after: { status: "sent" },
    });
    expect(audit(id, "invoice.cancel")).toMatchObject({
      before: { status: "sent" },
      after: { status: "cancelled", cancelledFrom: "sent" },
    });
    expect(audit(id, "invoice.restore")).toMatchObject({
      before: { status: "cancelled", cancelledFrom: "sent" },
      after: { status: "sent", cancelledFrom: null },
    });
    assertConsistent(db, owner);
  });

  test("[INV-003] vrácení storna neodeslané faktury obnoví stav vystavená", () => {
    const { owner, customerId } = newOwner();
    const { id, number } = issueNew(owner, customerId);

    cancelInvoice(actor(owner), id);
    expect(getInvoice(owner, id)).toMatchObject({ status: "cancelled", cancelledFrom: "issued" });

    restoreInvoice(actor(owner), id);
    expect(getInvoice(owner, id)).toMatchObject({ status: "issued", cancelledFrom: null, number });
  });

  test("[INV-003] storno jde jen z vystavené a odeslané, vrátit jen stornovanou", () => {
    const { owner, customerId } = newOwner();
    const draft = save(owner, customerId);
    expect(() => cancelInvoice(actor(owner), draft.id)).toThrow(/stornovat/i);
    expect(() => restoreInvoice(actor(owner), draft.id)).toThrow(/stornovan/);

    const { id } = issueNew(owner, customerId);
    expect(() => restoreInvoice(actor(owner), id)).toThrow(/stornovan/);
    cancelInvoice(actor(owner), id);
    expect(() => cancelInvoice(actor(owner), id)).toThrow(/stornovat/i);

    db.update(invoice).set({ status: "paid", cancelledFrom: null }).where(eq(invoice.id, id)).run();
    expect(() => cancelInvoice(actor(owner), id)).toThrow(/stornovat/i);
  });

  test("[INV-005] označení jako odeslaná nastaví stav bez e-mailu", () => {
    const { owner, customerId } = newOwner();
    const { id, revision } = save(owner, customerId);
    expect(() => markSent(actor(owner), id)).toThrow(/odeslanou/);
    issueInvoice(actor(owner), id, { revision });

    markSent(actor(owner), id);

    expect(getInvoice(owner, id)).toMatchObject({ status: "sent", sentAt: NOW });
    expect(() => markSent(actor(owner), id)).toThrow(/odeslanou/);
  });

  test("[INV-003] cizí uživatel doklad nestornuje, nevrátí ani neoznačí", () => {
    const { owner, customerId } = newOwner();
    const other = newOwner();
    const { id } = issueNew(owner, customerId);

    for (const action of [cancelInvoice, restoreInvoice, markSent]) {
      expect(() => action(actor(other.owner), id)).toThrow("Doklad neexistuje");
    }
    expect(getInvoice(owner, id)?.status).toBe("issued");
  });
});

describe("obrázky vystavených dokladů", () => {
  test("[CUS-008] výměna loga nesmaže soubor vystaveného dokladu", () => {
    const { owner, customerId } = newOwner();
    setSupplierImage(actor(owner), "logo", PNG, "logo.png");
    const logo = getSupplier(owner)!.logoFileId!;
    const { id } = issueNew(owner, customerId);

    setSupplierImage(actor(owner), "logo", PNG, "nove.png");

    expect(getSupplier(owner)?.logoFileId).not.toBe(logo);
    expect(getInvoice(owner, id)?.logoFileId).toBe(logo);
    expect(readOwnedFile(actor(owner), logo).mimeType).toBe("image/png");
  });

  test("[CUS-008] odebrání podpisu zruší jen vazbu v profilu", () => {
    const { owner, customerId } = newOwner();
    setSupplierImage(actor(owner), "signature", PNG, "podpis.png");
    setSupplierImage(actor(owner), "qr_logo", PNG, "qr.png");
    const profile = getSupplier(owner)!;
    const { id } = issueNew(owner, customerId);

    clearSupplierImage(actor(owner), "signature");
    clearSupplierImage(actor(owner), "qr_logo");

    expect(getSupplier(owner)).toMatchObject({ signatureFileId: null, qrLogoFileId: null });
    expect(getInvoice(owner, id)).toMatchObject({
      signatureFileId: profile.signatureFileId,
      qrLogoFileId: profile.qrLogoFileId,
    });
    expect(readOwnedFile(actor(owner), profile.signatureFileId!).mimeType).toBe("image/png");
  });

  test("[ADM-006] smazání účtu s vystaveným dokladem a logem nic nezanechá", () => {
    const { owner, customerId } = newOwner();
    const adminId = `admin-${owner}`;
    const now = new Date();
    db.insert(user)
      .values({
        id: adminId,
        name: adminId,
        email: `${adminId}@example.cz`,
        role: "admin",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    setSupplierImage(actor(owner), "logo", PNG, "logo.png");
    const { id } = issueNew(owner, customerId);
    setSupplierImage(actor(owner), "logo", PNG, "nove.png");
    expect(existsSync(userDir(owner))).toBe(true);

    deleteUser(actor(adminId), owner, `${owner}@example.cz`);

    expect(db.select().from(invoice).where(eq(invoice.userId, owner)).all()).toEqual([]);
    expect(db.select().from(invoiceLine).where(eq(invoiceLine.invoiceId, id)).all()).toEqual([]);
    expect(db.select().from(file).where(eq(file.userId, owner)).all()).toEqual([]);
    expect(existsSync(userDir(owner))).toBe(false);
    assertConsistent(db, owner);
  });

  test("[CUS-008] bez odkazu z dokladu se starý soubor smaže jako dřív", () => {
    const { owner } = newOwner();
    setSupplierImage(actor(owner), "logo", PNG, "logo.png");
    const logo = getSupplier(owner)!.logoFileId!;

    clearSupplierImage(actor(owner), "logo");

    expect(() => readOwnedFile(actor(owner), logo)).toThrow();
  });
});
