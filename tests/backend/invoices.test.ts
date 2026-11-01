import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { count, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { diffAudit } from "@/lib/audit-diff";
import { MAX_DOCUMENT_MINOR } from "@/lib/invoice-totals";
import { INVOICE_STATUSES, INVOICE_TYPES, isOverdue } from "@/lib/invoice";
import type { SupplierSnapshot } from "@/lib/invoice-document";
import { DOCUMENT_TYPES } from "@/lib/number-format";
import { DEFAULT_PREFERENCES } from "@/lib/preferences";
import { TEXTS } from "@/lib/texts";
import { setClockForTests } from "@/server/clock";
import {
  auditLog,
  bankAccount,
  customer,
  invoice,
  invoiceLine,
  invoiceTag,
  numberSeries,
  tag,
  user,
} from "@/server/db/schema";
import {
  deleteBankAccount,
  hideBankAccount,
  saveBankAccount,
} from "@/server/services/bank-accounts";
import { saveCatalogItem } from "@/server/services/catalog";
import { deleteCustomer, getCustomer, saveCustomer } from "@/server/services/customers";
import {
  deleteDraft,
  duplicateInvoice,
  getInvoice,
  newDraftDefaults,
  saveDraft,
  type DraftInput,
} from "@/server/services/invoices";
import {
  allocateNumber,
  ensureDefaultSeries,
  isNumberTaken,
  listSeries,
  setNextNumber,
} from "@/server/services/number-series";
import { getPreferences, savePreferences } from "@/server/services/preferences";
import { deleteTag, listTags, setInvoiceTags } from "@/server/services/tags";
import { deleteUser, USER_OWNED_TABLES } from "@/server/services/users";
import { assertConsistent } from "../helpers/consistency";
import { createTestDb } from "../helpers/db";

vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-invoices-")));

const db = createTestDb();
const actor = (userId: string) => ({ userId, source: "web" as const });
const NOW = new Date("2026-03-10T10:00:00Z");

function seed(id: string) {
  const now = new Date();
  db.insert(user)
    .values({ id, name: id, email: `${id}@example.cz`, createdAt: now, updatedAt: now })
    .onConflictDoNothing()
    .run();
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

const draft = (owner: string, over: Partial<DraftInput> = {}): DraftInput => ({
  ...newDraftDefaults(owner, null),
  lines: [line()],
  ...over,
});

const save = (owner: string, over: Partial<DraftInput> = {}) =>
  saveDraft(actor(owner), draft(owner, over));

const newCustomer = (owner: string, over: Record<string, unknown> = {}) =>
  saveCustomer(actor(owner), {
    name: "Alfa s.r.o.",
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
    ...over,
  }).id;

const newAccount = (owner: string, currency: "CZK" | "EUR" = "CZK") =>
  saveBankAccount(actor(owner), {
    name: `Účet ${currency}`,
    currency,
    number: "19-2000145399",
    bankCode: "0800",
    iban: "",
    swift: "",
  });

const invoiceAudits = (id: string) =>
  db.select().from(auditLog).where(eq(auditLog.entityId, id)).all();

const listOwnDrafts = (owner: string) =>
  db.select({ total: count() }).from(invoice).where(eq(invoice.userId, owner)).get()!.total;

const setStatus = (id: string, status: (typeof INVOICE_STATUSES)[number], number?: string) =>
  db
    .update(invoice)
    .set({ status, number: number ?? null })
    .where(eq(invoice.id, id))
    .run();

beforeEach(() => {
  setClockForTests({ now: () => NOW });
  seed("i1");
  seed("i2");
  db.delete(invoice).run();
  db.delete(tag).run();
  db.delete(customer).run();
  db.delete(bankAccount).run();
});

afterEach(() => setClockForTests(null));

describe("koncept", () => {
  test("[INV-001] koncept nemá číslo a nepočítá se jako po splatnosti", () => {
    const { id } = save("i1", { dueDate: "2026-01-01" });

    const row = getInvoice("i1", id)!;

    expect(row).toMatchObject({ status: "draft", number: null, variableSymbol: null });
    expect(isOverdue(row, "2026-03-10")).toBe(false);
  });

  test("[INV-001] po splatnosti je jen nezaplacený doklad a jen po dni splatnosti", () => {
    const row = {
      status: "issued" as const,
      dueDate: "2026-03-10",
      totalMinor: 1000,
      paidMinor: 0,
      creditsMinor: 0,
      advanceMinor: 0,
      supersededAt: null,
    };

    expect(isOverdue(row, "2026-03-10")).toBe(false);
    expect(isOverdue(row, "2026-03-11")).toBe(true);
    expect(isOverdue({ ...row, status: "sent" }, "2026-03-11")).toBe(true);
    expect(isOverdue({ ...row, status: "partially_paid" }, "2026-03-11")).toBe(true);
    for (const status of ["draft", "paid", "cancelled", "credited"] as const)
      expect(isOverdue({ ...row, status }, "2026-03-11")).toBe(false);
    expect(isOverdue({ ...row, dueDate: null }, "2026-03-11")).toBe(false);
    expect(isOverdue({ ...row, paidMinor: 1000 }, "2026-03-11")).toBe(false);
  });

  test("[INV-001] stavy a typy dokladu odpovídají datovému modelu", () => {
    expect(INVOICE_STATUSES).toEqual([
      "draft",
      "issued",
      "sent",
      "partially_paid",
      "paid",
      "cancelled",
      "credited",
    ]);
    expect(INVOICE_TYPES).toBe(DOCUMENT_TYPES);
  });

  test("[INV-001] koncept smí být bez položek, zákazníka i dat", () => {
    const { id, revision, totals } = save("i1", {
      lines: [],
      customerId: null,
      issueDate: null,
      dueDate: null,
      bankAccountId: null,
      seriesId: null,
    });

    expect(revision).toBe(1);
    expect(totals.totalMinor).toBe(0);
    expect(getInvoice("i1", id)).toMatchObject({ lines: [], tags: [], customerName: "" });
  });

  test("[INV-002] koncept jde smazat", () => {
    const { id } = save("i1");
    setInvoiceTags(actor("i1"), id, ["Práce"]);

    deleteDraft(actor("i1"), id);

    expect(getInvoice("i1", id)).toBeNull();
    expect(db.select().from(invoiceLine).where(eq(invoiceLine.invoiceId, id)).all()).toEqual([]);
    expect(db.select().from(invoiceTag).where(eq(invoiceTag.invoiceId, id)).all()).toEqual([]);
    expect(invoiceAudits(id).map((row) => row.action)).toContain("invoice.delete");
  });

  test("[INV-002] vystavený doklad nejde smazat jako koncept", () => {
    const { id } = save("i1");
    setStatus(id, "issued", "2026-001");

    expect(() => deleteDraft(actor("i1"), id)).toThrow("koncept");
    expect(getInvoice("i1", id)).not.toBeNull();
  });

  test("[INV-010] nová faktura převezme splatnost, jazyk, měnu a design z výjimky zákazníka", () => {
    newAccount("i1", "CZK");
    const eur = newAccount("i1", "EUR");
    ensureDefaultSeries(actor("i1"));
    const customerId = newCustomer("i1", {
      dueDays: 30,
      language: "en",
      currency: "EUR",
      designId: "mono",
    });

    const defaults = newDraftDefaults("i1", customerId);

    expect(defaults).toMatchObject({
      customerId,
      language: "en",
      currency: "EUR",
      issueDate: "2026-03-10",
      dueDate: "2026-04-09",
      bankAccountId: eur,
      lines: [],
    });
    expect(defaults.appearance.designId).toBe("mono");
    expect(defaults.seriesId).toBe(
      listSeries("i1").find((s) => s.documentType === "invoice" && s.isDefault)?.id,
    );
  });

  test("[INV-010] bez zákazníka platí výchozí hodnoty a cizí zákazník se odmítne", () => {
    const customerId = newCustomer("i1");
    savePreferences(actor("i1"), {
      dueDays: 7,
      issueDateMode: "last_day_previous_month",
      textBefore: "Dobrý den",
      rounding: "whole",
    });

    expect(newDraftDefaults("i1", null)).toMatchObject({
      customerId: null,
      issueDate: "2026-02-28",
      dueDate: "2026-03-07",
      textBefore: "Dobrý den",
      rounding: "whole",
      bankAccountId: null,
    });
    expect(() => newDraftDefaults("i2", customerId)).toThrow("neexistuje");
  });

  test("[INV-010] vzhled se zkopíruje a změna nastavení starý koncept nezmění", () => {
    savePreferences(actor("i1"), {
      accentColor: "#112233",
      surfaceColor: "#ffffff",
      textColor: "#000000",
      lineColor: "#cccccc",
      logoPosition: "right",
      showQr: false,
    });
    const { id } = save("i1");

    savePreferences(actor("i1"), { accentColor: "#445566", logoPosition: "none", showQr: true });

    expect(getInvoice("i1", id)?.appearance).toEqual({
      designId: "cisty",
      colors: { accent: "#112233", surface: "#ffffff", text: "#000000", line: "#cccccc" },
      logoPosition: "right",
      showLogo: true,
      showQr: false,
      showQrLogo: false,
      showSignature: false,
      showDuzp: false,
    });
  });

  test("[SET-030] nové preference mají výchozí hodnoty a ověří se", () => {
    expect(DEFAULT_PREFERENCES).toMatchObject({
      surfaceColor: "",
      textColor: "",
      lineColor: "",
      logoPosition: "left",
      rounding: "none",
      pdfFileName: "{cislo}.pdf",
      fxBasis: "issue_date",
    });

    savePreferences(actor("i2"), { pdfFileName: "faktura-{cislo}.pdf", fxBasis: "taxable_date" });
    expect(getPreferences("i2")).toMatchObject({
      pdfFileName: "faktura-{cislo}.pdf",
      fxBasis: "taxable_date",
    });

    expect(() => savePreferences(actor("i2"), { pdfFileName: "../x.pdf" })).toThrow("název");
    expect(() => savePreferences(actor("i2"), { pdfFileName: "" })).toThrow("název");
    for (const pdfFileName of ["a\nb.pdf", "a\rb.pdf", "a\u0000b.pdf", "a\u2028b.pdf"])
      expect(() => savePreferences(actor("i2"), { pdfFileName })).toThrow("název");
    expect(() => savePreferences(actor("i2"), { surfaceColor: "red" })).toThrow("#rrggbb");
    expect(() => savePreferences(actor("i2"), { logoPosition: "top" as "left" })).toThrow("loga");
    expect(() => savePreferences(actor("i2"), { rounding: "cent" as "none" })).toThrow(
      "zaokrouhlení",
    );
    expect(() => savePreferences(actor("i2"), { fxBasis: "x" as "issue_date" })).toThrow("kurz");
  });
});

describe("položky a součty", () => {
  test("[INV-012] klientem podstrčený total se ignoruje", () => {
    const forged = {
      ...draft("i1"),
      totalMinor: 1,
      subtotalMinor: 1,
      status: "paid",
      number: "X",
      lines: [{ ...line(), netMinor: 1 }],
    } as unknown as DraftInput;

    const { id, totals } = saveDraft(actor("i1"), forged);

    expect(totals.totalMinor).toBe(300_000);
    expect(getInvoice("i1", id)).toMatchObject({
      subtotalMinor: 300_000,
      totalMinor: 300_000,
      status: "draft",
      number: null,
      lines: [{ netMinor: 300_000, position: 0 }],
    });
  });

  test("[INV-014] sleva řádku i dokladu a [INV-015] zaokrouhlení se uloží", () => {
    const { id, totals } = save("i1", {
      lines: [line({ discountKind: "percent", discountValue: 1000 }), line({ name: "B" })],
      discountKind: "amount",
      discountValue: 50_049,
      rounding: "whole",
    });

    expect(totals).toMatchObject({
      subtotalMinor: 570_000,
      discountMinor: 50_049,
      roundingMinor: 49,
      totalMinor: 520_000,
    });
    expect(getInvoice("i1", id)).toMatchObject({
      subtotalMinor: 570_000,
      discountMinor: 50_049,
      roundingMinor: 49,
      totalMinor: 520_000,
      lines: [{ name: "Konzultace", netMinor: 270_000 }, { name: "B" }],
    });
  });

  test("[INV-012] sleva a cena mimo rozsah se odmítnou", () => {
    const discount = (over: Partial<DraftInput>) => () => save("i1", over);

    expect(discount({ discountKind: "percent", discountValue: 10_001 })).toThrow("Sleva");
    expect(discount({ discountKind: "percent", discountValue: -1 })).toThrow("Sleva");
    expect(discount({ discountKind: "amount", discountValue: MAX_DOCUMENT_MINOR + 1 })).toThrow(
      "Sleva",
    );
    expect(discount({ lines: [line({ discountKind: "percent", discountValue: 10_001 })] })).toThrow(
      "Sleva",
    );
    expect(discount({ lines: [line({ unitPriceMinor: -1 })] })).toThrow("Cena");
    expect(discount({ lines: [line({ unitPriceMinor: 1.5 })] })).toThrow("Cena");
    expect(discount({ lines: [line({ unitPriceMinor: 1e15 })] })).toThrow("Cena");
    expect(discount({ lines: [line({ quantityMilli: -1 })] })).toThrow("Množství");
    expect(discount({ lines: [line({ quantityMilli: 0.5 })] })).toThrow("Množství");
    expect(db.select({ n: count() }).from(invoice).get()?.n).toBe(0);
  });

  test("záporná cena na faktuře a záloze je odmítnutá u konceptu, opravná faktura ji uloží", () => {
    const negative = [line({ quantityMilli: 3000, unitPriceMinor: -125_050 })];
    for (const type of ["invoice", "advance"] as const) {
      expect(() => save("i1", { type, lines: negative })).toThrow(
        TEXTS.invoices.validation.negativePrice,
      );
    }
    expect(db.select({ n: count() }).from(invoice).get()?.n).toBe(0);

    const { totals } = save("i1", { type: "credit_note", rounding: "none", lines: negative });
    expect(totals.totalMinor).toBe(-375_150);
    expect(totals.lines[0]?.netMinor).toBe(-375_150);
  });

  test("částka mimo limit je odmítnutá v obou znaménkách i na opravné faktuře", () => {
    const priced = (unitPriceMinor: number) => () =>
      save("i1", { type: "credit_note", lines: [line({ unitPriceMinor })] });
    expect(priced(-1e15)).toThrow("Cena");
    expect(priced(-(MAX_DOCUMENT_MINOR + 1))).toThrow(TEXTS.invoices.validation.amountRange);
    expect(db.select({ n: count() }).from(invoice).get()?.n).toBe(0);
  });

  test("[INV-012] sleva 100 % a sleva bez druhu projdou, hodnota bez druhu se vynuluje", () => {
    const { id, totals } = save("i1", {
      lines: [line({ discountKind: "none", discountValue: 77 })],
      discountKind: "percent",
      discountValue: 10_000,
    });

    expect(totals.totalMinor).toBe(0);
    expect(getInvoice("i1", id)?.lines[0]).toMatchObject({ discountValue: 0 });
  });

  test("[INV-012] cena z ceníku nad limit dokladu projde, dokud sedí součet", () => {
    const expensive = 200_000_000_000;

    const { totals } = save("i1", {
      lines: [line({ unitPriceMinor: expensive, quantityMilli: 1 })],
    });

    expect(totals.totalMinor).toBe(200_000_000);
    expect(() =>
      save("i1", { lines: [line({ unitPriceMinor: expensive, quantityMilli: 1000 })] }),
    ).toThrow("příliš vysoká");
  });

  test("[INV-012] limity délek a počtu položek platí", () => {
    const tooLong = (over: Partial<DraftInput>) => () => save("i1", over);

    expect(tooLong({ lines: [line({ name: "x".repeat(201) })] })).toThrow("dlouhý");
    expect(tooLong({ lines: [line({ description: "x".repeat(2001) })] })).toThrow("dlouhý");
    expect(tooLong({ note: "x".repeat(2001) })).toThrow("dlouhý");
    expect(tooLong({ textBefore: "x".repeat(2001) })).toThrow("dlouhý");
    expect(tooLong({ textAfter: "x".repeat(2001) })).toThrow("dlouhý");
    expect(tooLong({ lines: Array.from({ length: 501 }, () => line()) })).toThrow("položek");

    expect(save("i1", { lines: Array.from({ length: 500 }, () => line()) }).id).toBeTruthy();
    expect(() => saveDraft({ userId: null, source: "web" }, draft("i1"))).toThrow("oprávnění");
  });

  test("[INV-012] neplatný vzhled, datum a kurz se odmítnou", () => {
    const appearance = draft("i1").appearance;

    expect(() => save("i1", { issueDate: "2026-02-30" })).toThrow("datum");
    expect(() =>
      save("i1", { appearance: { ...appearance, colors: { ...appearance.colors, text: "x" } } }),
    ).toThrow("#rrggbb");
    expect(() => save("i1", { exchangeRateMicros: 0 })).toThrow("Kurz");
    expect(save("i1", { exchangeRateMicros: 25_123_000 }).id).toBeTruthy();
  });

  test("[INV-012] text pro hledání drží zákazníka a položky bez diakritiky", () => {
    const customerId = newCustomer("i1", { name: "Šťastná s.r.o." });

    const { id } = save("i1", { customerId, lines: [line({ name: "Návrh loga" })] });

    const row = getInvoice("i1", id)!;
    expect(row.customerName).toBe("Šťastná s.r.o.");
    expect(row.searchText).toContain("stastna");
    expect(row.searchText).toContain("navrh loga");
  });

  test("[INV-012] položka drží odkaz na ceník a řádek kopii hodnot", () => {
    const item = saveCatalogItem(actor("i1"), {
      name: "Audit",
      description: "",
      unit: "ks",
      priceMinor: 100,
      currency: "CZK",
      category: "",
      tags: [],
    }).id;

    const { id } = save("i1", { lines: [line({ catalogItemId: item })] });

    expect(getInvoice("i1", id)?.lines[0]).toMatchObject({
      catalogItemId: item,
      unitPriceMinor: 150_000,
    });
  });
});

describe("automatické ukládání", () => {
  test("[INV-017] každé uložení zvýší revizi", () => {
    const first = save("i1");

    const second = save("i1", { id: first.id, revision: first.revision, note: "změna" });

    expect(second).toMatchObject({ id: first.id, revision: first.revision + 1 });
    expect(getInvoice("i1", first.id)).toMatchObject({ note: "změna", revision: 2 });
  });

  test("[INV-017] uložení bez změny nepřidá auditní záznam", () => {
    const body = draft("i1", { lines: [line(), line({ name: "Druhá" })] });
    const first = saveDraft(actor("i1"), body);
    const audits = invoiceAudits(first.id).length;

    const again = saveDraft(actor("i1"), { ...body, id: first.id, revision: first.revision });

    expect(again).toEqual(first);
    expect(invoiceAudits(first.id)).toHaveLength(audits);
    expect(getInvoice("i1", first.id)?.revision).toBe(first.revision);
  });

  test("[INV-017] změna pořadí položek je změna", () => {
    const body = draft("i1", { lines: [line({ name: "A" }), line({ name: "B" })] });
    const first = saveDraft(actor("i1"), body);

    const second = saveDraft(actor("i1"), {
      ...body,
      id: first.id,
      revision: first.revision,
      lines: [line({ name: "B" }), line({ name: "A" })],
    });

    expect(second.revision).toBe(2);
    expect(getInvoice("i1", first.id)?.lines.map((l) => l.name)).toEqual(["B", "A"]);
  });

  test("[INV-017] uložení se starší revizí je odmítnuté a data zůstanou", () => {
    const first = save("i1", { note: "první" });
    save("i1", { id: first.id, revision: first.revision, note: "druhá" });

    expect(() => save("i1", { id: first.id, revision: first.revision, note: "stará" })).toThrow(
      "změnil",
    );
    expect(() => save("i1", { id: first.id, note: "bez revize" })).toThrow("změnil");
    expect(getInvoice("i1", first.id)).toMatchObject({ note: "druhá", revision: 2 });
  });

  test("[INV-017] po ztracené odpovědi stejný obsah vrátí aktuální revizi místo odmítnutí", () => {
    const first = save("i1", { note: "první" });
    const body = draft("i1", { note: "druhá" });
    const saved = saveDraft(actor("i1"), { ...body, id: first.id, revision: first.revision });
    const audits = invoiceAudits(first.id).length;

    const retried = saveDraft(actor("i1"), { ...body, id: first.id, revision: first.revision });

    expect(retried).toEqual(saved);
    expect(invoiceAudits(first.id)).toHaveLength(audits);
  });

  test("[INV-017] opakovaný první zápis se stejným clientId nezaloží druhý koncept", () => {
    const clientId = randomUUID();
    const body = draft("i1", { clientId, note: "jednou" });
    const count = listOwnDrafts("i1");

    const first = saveDraft(actor("i1"), body);
    const retried = saveDraft(actor("i1"), body);

    expect(first.id).toBe(clientId);
    expect(retried).toEqual(first);
    expect(listOwnDrafts("i1")).toBe(count + 1);
  });

  test("[INV-017] jiný obsah se starým clientId je odmítnutý a data zůstanou", () => {
    const clientId = randomUUID();
    saveDraft(actor("i1"), draft("i1", { clientId, note: "první" }));

    expect(() => saveDraft(actor("i1"), draft("i1", { clientId, note: "jiná karta" }))).toThrow(
      "změnil",
    );
    expect(getInvoice("i1", clientId)).toMatchObject({ note: "první", revision: 1 });
  });

  test("[SEC-002] clientId cizího konceptu je odmítnuté bez úniku a beze změny", () => {
    const clientId = randomUUID();
    saveDraft(actor("i1"), draft("i1", { clientId, note: "moje" }));

    expect(() => saveDraft(actor("i2"), draft("i2", { clientId, note: "cizí" }))).toThrow(
      "Doklad neexistuje",
    );
    expect(getInvoice("i1", clientId)).toMatchObject({ note: "moje" });
  });

  test("[SEC-006] clientId musí být uuid", () => {
    expect(() => save("i1", { clientId: "x" })).toThrow("Neplatné údaje");
  });

  test("[INV-017] uložení nad vystaveným dokladem je odmítnuté", () => {
    const first = save("i1", { note: "koncept" });
    setStatus(first.id, "issued", "2026-001");

    expect(() => save("i1", { id: first.id, revision: first.revision, note: "pozdě" })).toThrow(
      "změnil",
    );
    expect(getInvoice("i1", first.id)).toMatchObject({ note: "koncept", status: "issued" });
  });

  test("[AUD-009] audit uložení konceptu má před i po stejný tvar", () => {
    const first = save("i1");
    save("i1", { id: first.id, revision: first.revision, note: "nově" });

    const entry = invoiceAudits(first.id).at(-1)!;
    expect(entry.action).toBe("invoice.save");
    const before = entry.before as Record<string, unknown>;
    const after = entry.after as Record<string, unknown>;
    expect(Object.keys(before).sort()).toEqual(Object.keys(after).sort());
    expect(after).toMatchObject({ note: "nově", lineCount: 1, revision: 2 });
  });
});

describe("audit položek", () => {
  const lastAudit = (id: string) => {
    const entry = invoiceAudits(id).at(-1)!;
    return {
      entry,
      before: (entry.before as { lines?: Record<string, unknown[]> } | null)?.lines,
      after: (entry.after as { lines?: Record<string, unknown[]> } | null)?.lines,
    };
  };

  test("[AUD-009] přejmenování položky je v auditu vidět a nezměněné řádky tam nejsou", () => {
    const body = draft("i1", { lines: [line({ name: "Stará" }), line({ name: "Beze změny" })] });
    const first = saveDraft(actor("i1"), body);

    saveDraft(actor("i1"), {
      ...body,
      id: first.id,
      revision: first.revision,
      lines: [line({ name: "Nová" }), line({ name: "Beze změny" })],
    });

    const { entry, before, after } = lastAudit(first.id);
    expect(before).toMatchObject({ changed: [{ name: "Stará", position: 0 }], removed: [] });
    expect(after).toMatchObject({ changed: [{ name: "Nová", position: 0 }], added: [] });
    expect(after?.changed).toHaveLength(1);
    expect(diffAudit(entry.before, entry.after).map((c) => c.field)).toContain("lines");
  });

  test("[AUD-009] přidání, odebrání a prohození položek audit rozliší", () => {
    const body = draft("i1", { lines: [line({ name: "A" }), line({ name: "B" })] });
    const first = saveDraft(actor("i1"), body);

    const second = saveDraft(actor("i1"), {
      ...body,
      id: first.id,
      revision: first.revision,
      lines: [line({ name: "B" }), line({ name: "A" }), line({ name: "C" })],
    });
    const added = lastAudit(first.id);
    expect(added.before).toMatchObject({
      moved: [
        { name: "B", position: 1 },
        { name: "A", position: 0 },
      ],
      changed: [],
      removed: [],
    });
    expect(added.after).toMatchObject({
      moved: [
        { name: "B", position: 0 },
        { name: "A", position: 1 },
      ],
      changed: [],
      added: [{ name: "C", position: 2 }],
    });

    saveDraft(actor("i1"), {
      ...body,
      id: first.id,
      revision: second.revision,
      lines: [line({ name: "B" })],
    });
    const removed = lastAudit(first.id);
    expect(removed.before?.removed).toMatchObject([{ name: "A" }, { name: "C" }]);
    expect(removed.after).toMatchObject({ added: [], changed: [], moved: [] });
  });

  test("[AUD-009] změna jen hlavičky nepřidá do auditu rozdíl řádků", () => {
    const first = save("i1");

    save("i1", { id: first.id, revision: first.revision, note: "x" });

    expect(lastAudit(first.id)).toMatchObject({ before: undefined, after: undefined });
  });

  test("[AUD-009] smazání konceptu v auditu uchová celé řádky", () => {
    const { id } = save("i1", { lines: [line({ name: "A", description: "popis" })] });

    deleteDraft(actor("i1"), id);

    const { entry } = lastAudit(id);
    expect(entry.action).toBe("invoice.delete");
    expect((entry.before as { lines: unknown[] }).lines).toMatchObject([
      { name: "A", description: "popis", quantityMilli: 2000, unitPriceMinor: 150_000 },
    ]);
  });
});

describe("duplikace", () => {
  test("[INV-018] duplikát je koncept s dnešními daty, bez čísla a se stejnými položkami", () => {
    const customerId = newCustomer("i1");
    const source = save("i1", {
      customerId,
      issueDate: "2026-01-01",
      dueDate: "2026-01-15",
      taxableDate: "2026-01-02",
      discountKind: "percent",
      discountValue: 1000,
      note: "Díky",
      lines: [line({ name: "A" }), line({ name: "B", description: "popis" })],
    });
    setInvoiceTags(actor("i1"), source.id, ["Práce"]);
    setStatus(source.id, "paid", "2026-001");
    db.update(invoice)
      .set({
        variableSymbol: "2026001",
        variableSymbolManual: true,
        supplierSnapshot: { name: "x" } as SupplierSnapshot,
        issuedAt: NOW,
        sentAt: NOW,
        paidMinor: 5,
        external: true,
      })
      .where(eq(invoice.id, source.id))
      .run();

    const { id } = duplicateInvoice(actor("i1"), source.id);

    const original = getInvoice("i1", source.id)!;
    const copy = getInvoice("i1", id)!;
    expect(id).not.toBe(source.id);
    expect(copy).toMatchObject({
      status: "draft",
      number: null,
      variableSymbol: null,
      variableSymbolManual: false,
      supplierSnapshot: null,
      issuedAt: null,
      sentAt: null,
      paidMinor: 0,
      external: false,
      revision: 1,
      customerId,
      note: "Díky",
      issueDate: "2026-03-10",
      dueDate: "2026-03-24",
      taxableDate: "2026-03-10",
      totalMinor: original.totalMinor,
    });
    const strip = (rows: typeof copy.lines) =>
      rows.map(({ id: _i, invoiceId: _v, ...rest }) => rest);
    expect(strip(copy.lines)).toEqual(strip(original.lines));
    expect(copy.tags.map((t) => t.name)).toEqual(["Práce"]);
    expect(invoiceAudits(id).map((row) => row.action)).toEqual(["invoice.duplicate"]);
  });

  test("[INV-018] duplikát bez dat a se skrytým účtem vezme výchozí účet", () => {
    const hidden = newAccount("i1");
    const source = save("i1", {
      bankAccountId: hidden,
      issueDate: null,
      dueDate: null,
      taxableDate: null,
    });
    hideBankAccount(actor("i1"), hidden);
    const visible = newAccount("i1");

    const { id } = duplicateInvoice(actor("i1"), source.id);

    expect(getInvoice("i1", id)).toMatchObject({
      issueDate: "2026-03-10",
      dueDate: null,
      taxableDate: null,
      bankAccountId: visible,
    });
  });
});

describe("štítky", () => {
  test("[INV-026] štítek se založí při prvním použití a „Práce“ a „prace“ je tentýž", () => {
    const first = save("i1");
    const second = save("i1");

    setInvoiceTags(actor("i1"), first.id, ["Práce", "prace", " Práce "]);
    setInvoiceTags(actor("i1"), second.id, ["prace", "Osobní"]);

    expect(listTags("i1").map((t) => t.name)).toEqual(["Osobní", "Práce"]);
    expect(getInvoice("i1", first.id)?.tags.map((t) => t.name)).toEqual(["Práce"]);
    expect(getInvoice("i1", second.id)?.tags.map((t) => t.name)).toEqual(["Osobní", "Práce"]);
  });

  test("[INV-026] z duplicit vyhraje první varianta názvu", () => {
    const { id } = save("i1");

    setInvoiceTags(actor("i1"), id, ["Práce", "prace"]);

    expect(listTags("i1").map((t) => t.name)).toEqual(["Práce"]);
  });

  test("[INV-026] založení štítku má vlastní auditní záznam, opakované použití ne", () => {
    const first = save("i1");
    const second = save("i1");

    setInvoiceTags(actor("i1"), first.id, ["Práce"]);
    setInvoiceTags(actor("i1"), second.id, ["práce"]);

    const [work] = listTags("i1");
    expect(invoiceAudits(work!.id)).toMatchObject([
      { action: "tag.create", entity: "tag", ownerId: "i1", after: { name: "Práce" } },
    ]);
  });

  test("[INV-026] štítky jdou měnit i na vystaveném dokladu a nemění revizi", () => {
    const { id, revision } = save("i1");
    setStatus(id, "issued", "2026-001");

    setInvoiceTags(actor("i1"), id, ["Práce"]);

    expect(getInvoice("i1", id)).toMatchObject({ revision, status: "issued" });
    expect(getInvoice("i1", id)?.tags).toHaveLength(1);
  });

  test("[INV-026] štítky nezablokují autosave a odebráním zmizí jen z dokladu", () => {
    const first = save("i1");
    setInvoiceTags(actor("i1"), first.id, ["Práce"]);

    expect(save("i1", { id: first.id, revision: first.revision, note: "x" }).revision).toBe(2);
    setInvoiceTags(actor("i1"), first.id, []);

    expect(getInvoice("i1", first.id)?.tags).toEqual([]);
    expect(listTags("i1").map((t) => t.name)).toEqual(["Práce"]);
  });

  test("[INV-026] stejné štítky nepřidají auditní záznam", () => {
    const { id } = save("i1");
    setInvoiceTags(actor("i1"), id, ["Práce"]);
    const audits = invoiceAudits(id).length;

    setInvoiceTags(actor("i1"), id, ["práce"]);

    expect(invoiceAudits(id)).toHaveLength(audits);
  });

  test("[INV-026] limity štítků platí", () => {
    const { id } = save("i1");
    const many = (n: number) => Array.from({ length: n }, (_, i) => `štítek ${i}`);

    expect(() => setInvoiceTags(actor("i1"), id, many(21))).toThrow("štítků");
    expect(() => setInvoiceTags(actor("i1"), id, ["x".repeat(41)])).toThrow("dlouhý");
    expect(() => setInvoiceTags(actor("i1"), id, [" "])).toThrow("štítku");
    setInvoiceTags(actor("i1"), id, many(20));
    expect(getInvoice("i1", id)?.tags).toHaveLength(20);
  });

  test("[INV-026] smazaný štítek zmizí ze všech dokladů", () => {
    const { id } = save("i1");
    setInvoiceTags(actor("i1"), id, ["Práce"]);
    const [work] = listTags("i1");

    deleteTag(actor("i1"), work!.id);

    expect(listTags("i1")).toEqual([]);
    expect(getInvoice("i1", id)?.tags).toEqual([]);
  });
});

describe("přenosy z evidence", () => {
  test("[SET-022] použitý účet nejde smazat, jen skrýt", () => {
    const accountId = newAccount("i1");
    const { id } = save("i1", { bankAccountId: accountId });

    expect(() => deleteBankAccount(actor("i1"), accountId)).toThrow("skrýt");
    hideBankAccount(actor("i1"), accountId);
    expect(getInvoice("i1", id)?.bankAccountId).toBe(accountId);

    deleteDraft(actor("i1"), id);
    deleteBankAccount(actor("i1"), accountId);
  });

  test("[CUS-007] zákazník s dokladem nejde smazat", () => {
    const customerId = newCustomer("i1");
    const { id } = save("i1", { customerId });

    expect(() => deleteCustomer(actor("i1"), customerId)).toThrow("archivovat");
    expect(getCustomer("i1", customerId)).not.toBeNull();

    deleteDraft(actor("i1"), id);
    deleteCustomer(actor("i1"), customerId);
    expect(getCustomer("i1", customerId)).toBeNull();
  });

  test("[NUM-004] číslo obsazené doklady jde poznat a další číslo na něj nejde nastavit", () => {
    ensureDefaultSeries(actor("i1"));
    const series = listSeries("i1").find((s) => s.documentType === "invoice")!;
    const { id } = save("i1");
    setStatus(id, "issued", "2026-005");

    expect(db.transaction((tx) => isNumberTaken(tx, "i1", "2026-005"))).toBe(true);
    expect(db.transaction((tx) => isNumberTaken(tx, "i1", "2026-006"))).toBe(false);
    expect(db.transaction((tx) => isNumberTaken(tx, "i2", "2026-005"))).toBe(false);
    expect(() => setNextNumber(actor("i1"), series.id, 5, "2026-03-10")).toThrow();
    setNextNumber(actor("i1"), series.id, 6, "2026-03-10");
  });

  test("[NUM-004] číslo je v účtu unikátní, koncepty ho nemají", () => {
    const first = save("i1");
    const second = save("i1");
    const foreign = save("i2");
    setStatus(first.id, "issued", "2026-001");
    setStatus(foreign.id, "issued", "2026-001");

    expect(() => setStatus(second.id, "issued", "2026-001")).toThrow("UNIQUE");
  });

  test("[NUM-003] smazaná řada koncept neblokuje", () => {
    ensureDefaultSeries(actor("i1"));
    const seriesId = listSeries("i1")[0]!.id;
    const { id } = save("i1", { seriesId });

    db.delete(numberSeries).where(eq(numberSeries.id, seriesId)).run();

    expect(getInvoice("i1", id)?.seriesId).toBeNull();
  });

  test("[ADM-006] smazání účtu s fakturami nezanechá řádky", () => {
    seed("root");
    seed("gone");
    db.update(user).set({ role: "admin" }).where(eq(user.id, "root")).run();
    ensureDefaultSeries(actor("gone"));
    const seriesId = listSeries("gone")[0]!.id;
    db.transaction((tx) => allocateNumber(tx, "gone", seriesId, "2026-03-10"));
    const customerId = newCustomer("gone");
    const bankAccountId = newAccount("gone");
    const first = save("gone", { customerId, bankAccountId, seriesId });
    const second = save("gone", { customerId, bankAccountId, seriesId });
    setInvoiceTags(actor("gone"), first.id, ["Práce"]);
    setStatus(first.id, "issued", "2026-001");
    db.update(invoice).set({ relatedInvoiceId: first.id }).where(eq(invoice.id, second.id)).run();
    db.update(invoice).set({ relatedInvoiceId: second.id }).where(eq(invoice.id, first.id)).run();

    deleteUser(actor("root"), "gone", "gone@example.cz");

    for (const table of [invoice, invoiceLine, invoiceTag, tag]) {
      expect(db.select().from(table).where(eq(table.userId, "gone")).all()).toEqual([]);
    }
    assertConsistent(db, "gone");
  });

  test("[ADM-006] faktura je v seznamu dat účtu před tabulkami, na které odkazuje", () => {
    const at = (table: (typeof USER_OWNED_TABLES)[number]) => USER_OWNED_TABLES.indexOf(table);

    for (const table of [invoice, invoiceLine, invoiceTag, tag])
      expect(at(table)).toBeGreaterThanOrEqual(0);
    for (const target of [customer, bankAccount, numberSeries])
      expect(at(invoice)).toBeLessThan(at(target));
  });
});
