import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { diffInvoices } from "@/lib/invoice-diff";
import { TEXTS } from "@/lib/texts";
import { setClockForTests } from "@/server/clock";
import {
  auditLog,
  bankAccount,
  catalogItem,
  file,
  invoice,
  invoiceLine,
  invoiceVersion,
  numberSeriesCounter,
  user,
} from "@/server/db/schema";
import {
  deleteBankAccount,
  hideBankAccount,
  saveBankAccount,
} from "@/server/services/bank-accounts";
import { saveCatalogItem } from "@/server/services/catalog";
import { saveCustomer } from "@/server/services/customers";
import {
  cancelInvoice,
  issueInvoice,
  markSent,
  NotIssuableError,
} from "@/server/services/invoice-lifecycle";
import {
  getVersion,
  listVersions,
  refreshCustomerSnapshot,
  restoreVersion,
  updateIssuedInvoice,
} from "@/server/services/invoice-versions";
import {
  getInvoice,
  newDraftDefaults,
  saveDraft,
  type DraftInput,
  type IssuedInput,
} from "@/server/services/invoices";
import { ensureDefaultSeries } from "@/server/services/number-series";
import { saveSupplier, setSupplierImage, type SupplierInput } from "@/server/services/supplier";
import { deleteUser, USER_OWNED_TABLES } from "@/server/services/users";
import { assertConsistent } from "../helpers/consistency";
import { createTestDb } from "../helpers/db";
import { assertIsolated } from "../helpers/isolation";

vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-versions-")));

const db = createTestDb();
const actor = (userId: string) => ({ userId, source: "web" as const });
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 1),
]);
const V = TEXTS.invoices.validation;
const NOW = new Date("2026-03-10T10:00:00Z");

let ownerCounter = 0;

function seed(id: string) {
  const now = new Date();
  db.insert(user)
    .values({
      id,
      name: id,
      email: `${id}@example.cz`,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
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

const catalogInput = (name: string) => ({
  name,
  description: "",
  unit: "ks",
  priceMinor: 100,
  currency: "CZK" as const,
  category: "",
  tags: [],
});

const newAccount = (owner: string, currency: "CZK" | "EUR" = "CZK") =>
  saveBankAccount(actor(owner), {
    name: `Účet ${currency}`,
    currency,
    number: "19-2000145399",
    bankCode: "0800",
    iban: "",
    swift: "",
  });

function newOwner(prefix = "u") {
  const owner = `${prefix}${(ownerCounter += 1)}`;
  seed(owner);
  ensureDefaultSeries(actor(owner));
  saveSupplier(actor(owner), supplierInput);
  return {
    owner,
    customerId: saveCustomer(actor(owner), customerInput("Alfa s.r.o.")).id,
    accountId: newAccount(owner),
  };
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

function issued(owner: string, customerId: string, over: Partial<DraftInput> = {}) {
  const { id, revision } = saveDraft(actor(owner), {
    ...newDraftDefaults(owner, customerId),
    lines: [line()],
    ...over,
  });
  return issueInvoice(actor(owner), id, { revision });
}

const detail = (owner: string, id: string) => getInvoice(owner, id)!;

const edit = (owner: string, id: string, over: Partial<IssuedInput> = {}): IssuedInput => {
  const row = detail(owner, id);
  return { ...row, number: row.number!, ...over };
};

const update = (owner: string, id: string, over: Partial<IssuedInput> = {}) =>
  updateIssuedInvoice(actor(owner), id, edit(owner, id, over));

const audits = (id: string, action: string) =>
  db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityId, id), eq(auditLog.action, action)))
    .orderBy(desc(auditLog.id))
    .all();

const counters = (owner: string) =>
  db.select().from(numberSeriesCounter).where(eq(numberSeriesCounter.userId, owner)).all();

const expectRefused = (run: () => unknown, message: string) => {
  expect(run).toThrow(message);
};

beforeEach(() => {
  setClockForTests({ now: () => NOW });
});

afterEach(() => setClockForTests(null));

describe("úprava vystaveného dokladu", () => {
  test("[INV-020] úprava odeslané faktury nabídne opětovné odeslání a nic neodešle", () => {
    const { owner, customerId } = newOwner();
    const { id } = issued(owner, customerId);
    markSent(actor(owner), id);
    const sentAt = detail(owner, id).sentAt;

    const result = update(owner, id, { note: "Nová poznámka" });

    expect(result).toMatchObject({
      resendSuggested: true,
      balanceWarning: "none",
    });
    expect(detail(owner, id)).toMatchObject({
      status: "sent",
      note: "Nová poznámka",
      sentAt,
    });
  });

  test("[INV-020] vystavená faktura opětovné odeslání nenabízí a revize roste", () => {
    const { owner, customerId } = newOwner();
    const { id } = issued(owner, customerId);
    const revision = detail(owner, id).revision;

    const result = update(owner, id, { note: "Nová poznámka" });

    expect(result).toEqual({
      revision: revision + 1,
      resendSuggested: false,
      balanceWarning: "none",
    });
    expect(detail(owner, id).revision).toBe(revision + 1);
  });

  test("[INV-020] stornovaný, dobropisovaný doklad ani koncept upravit nejde", () => {
    const { owner, customerId } = newOwner();
    const cancelled = issued(owner, customerId).id;
    cancelInvoice(actor(owner), cancelled);
    expectRefused(() => update(owner, cancelled, { note: "x" }), V.notEditable);

    const credited = issued(owner, customerId).id;
    db.update(invoice).set({ status: "credited" }).where(eq(invoice.id, credited)).run();
    expectRefused(() => update(owner, credited, { note: "x" }), V.notEditable);

    const draft = saveDraft(actor(owner), newDraftDefaults(owner, customerId));
    expectRefused(
      () =>
        updateIssuedInvoice(actor(owner), draft.id, {
          ...edit(owner, cancelled),
          revision: draft.revision,
        }),
      V.notEditable,
    );
    expect(listVersions(owner, cancelled)).toEqual([]);
  });

  test("[INV-020] chybějící nebo stará revize je zastaralá úprava", () => {
    const { owner, customerId } = newOwner();
    const { id } = issued(owner, customerId);
    const stale = edit(owner, id, { note: "x" });
    const { revision: _, ...withoutRevision } = stale;
    update(owner, id, { note: "y" });

    expectRefused(() => updateIssuedInvoice(actor(owner), id, stale), TEXTS.invoices.stale);
    expectRefused(
      () =>
        updateIssuedInvoice(actor(owner), id, {
          ...withoutRevision,
          revision: undefined,
        }),
      TEXTS.invoices.stale,
    );
    expect(detail(owner, id).note).toBe("y");
  });

  test("[INV-020] přechod stavu mezi načtením a uložením úpravu odmítne", () => {
    const { owner, customerId } = newOwner();
    const { id } = issued(owner, customerId);
    const input = edit(owner, id, { note: "x" });
    markSent(actor(owner), id);

    expectRefused(() => updateIssuedInvoice(actor(owner), id, input), TEXTS.invoices.stale);
  });

  test("[INV-020] součty a čisté částky počítá server z jednoho výpočtu", () => {
    const { owner, customerId } = newOwner();
    const { id } = issued(owner, customerId);

    update(owner, id, {
      lines: [
        {
          ...line({ quantityMilli: 1000, unitPriceMinor: 10_000 }),
          netMinor: 1,
        } as never,
        line({ quantityMilli: 2000, unitPriceMinor: 5_000 }),
      ],
      discountKind: "percent",
      discountValue: 1000,
      subtotalMinor: 7,
      totalMinor: 7,
    } as Partial<IssuedInput>);

    const row = detail(owner, id);
    expect(row.lines.map((l) => l.netMinor)).toEqual([10_000, 10_000]);
    expect(row).toMatchObject({
      subtotalMinor: 20_000,
      discountMinor: 2_000,
      totalMinor: 18_000,
    });
    assertConsistent(db, owner);
  });

  test("[INV-020] úprava platí stejná pravidla jako vystavení", () => {
    const { owner, customerId } = newOwner();
    const { id } = issued(owner, customerId);
    const fieldsOf = (over: Partial<IssuedInput>) => {
      try {
        update(owner, id, over);
      } catch (error) {
        if (error instanceof NotIssuableError) return error.problems.map((p) => p.field);
        throw error;
      }
      return [];
    };

    expect(fieldsOf({ lines: [] })).toEqual(["lines"]);
    expect(fieldsOf({ lines: [line({ name: "" })] })).toEqual(["lines.0.name"]);
    expect(fieldsOf({ lines: [line({ quantityMilli: 0 })] })).toEqual(["lines.0.quantityMilli"]);
    expect(fieldsOf({ issueDate: null })).toEqual(["issueDate"]);
    expect(fieldsOf({ dueDate: null })).toEqual(["dueDate"]);
    expect(fieldsOf({ dueDate: "2020-01-01" })).toEqual(["dueDate"]);
    expect(fieldsOf({ bankAccountId: null })).toEqual(["bankAccountId"]);
    expect(fieldsOf({ currency: "EUR" })).toEqual(["bankAccountId", "exchangeRateMicros"]);
    expect(listVersions(owner, id)).toEqual([]);
  });

  test("[INV-020] úprava drží limity vstupu i částky", () => {
    const { owner, customerId } = newOwner();
    const { id } = issued(owner, customerId);

    expectRefused(() => update(owner, id, { note: "x".repeat(2001) }), V.tooLong);
    expectRefused(
      () => update(owner, id, { lines: Array.from({ length: 501 }, () => line()) }),
      V.tooManyLines,
    );
    expectRefused(
      () =>
        update(owner, id, {
          lines: [
            line({
              quantityMilli: 1_000_000_000,
              unitPriceMinor: 100_000_000_000,
            }),
          ],
        }),
      V.amountRange,
    );
    expectRefused(() => update(owner, id, { number: "   " }), V.number);
    expectRefused(() => update(owner, id, { number: "1".repeat(101) }), V.number);
  });

  test("[INV-020] cizí účet ani položka ceníku na doklad nesmí", () => {
    const { owner, customerId } = newOwner();
    const other = newOwner();
    const { id } = issued(owner, customerId);
    const { id: item } = saveCatalogItem(actor(other.owner), catalogInput("Cizí"));

    expectRefused(() => update(owner, id, { bankAccountId: other.accountId }), V.accountNotFound);
    expectRefused(
      () => update(owner, id, { lines: [line({ catalogItemId: item })] }),
      V.catalogItemNotFound,
    );
  });

  test("[INV-020] skrytý účet lze na dokladu ponechat, ale nově vybrat ne", () => {
    const { owner, customerId, accountId } = newOwner();
    const { id } = issued(owner, customerId);
    const second = newAccount(owner);
    hideBankAccount(actor(owner), second);
    expectRefused(
      () => update(owner, id, { bankAccountId: second }),
      TEXTS.invoices.issue.accountHidden,
    );

    hideBankAccount(actor(owner), accountId);
    expect(update(owner, id, { note: "x" }).revision).toBeGreaterThan(0);
  });

  test("[INV-020] změna účtu přepíše jeho snapshot, jinak zůstává původní", () => {
    const { owner, customerId, accountId } = newOwner();
    const { id } = issued(owner, customerId);
    db.update(bankAccount).set({ name: "Přejmenovaný" }).where(eq(bankAccount.id, accountId)).run();

    update(owner, id, { note: "x" });
    expect(detail(owner, id).accountSnapshot?.name).toBe("Účet CZK");

    const second = saveBankAccount(actor(owner), {
      name: "Druhý",
      currency: "CZK",
      number: "19-2000145399",
      bankCode: "0800",
      iban: "",
      swift: "",
    });
    update(owner, id, { bankAccountId: second });
    expect(detail(owner, id)).toMatchObject({
      bankAccountId: second,
      accountSnapshot: { name: "Druhý" },
    });

    update(owner, id, { bankAccountId: null, paymentMethod: "cash" });
    expect(detail(owner, id)).toMatchObject({
      bankAccountId: null,
      accountSnapshot: null,
    });
    assertConsistent(db, owner);
  });

  test("[INV-020] typ, zákazník ani řada se úpravou nezmění", () => {
    const { owner, customerId } = newOwner();
    const { id } = issued(owner, customerId);
    const before = detail(owner, id);
    const stranger = saveCustomer(actor(owner), customerInput("Beta a.s.")).id;

    update(owner, id, {
      note: "x",
      type: "advance",
      customerId: stranger,
      customerName: "Beta a.s.",
      seriesId: null,
    } as Partial<IssuedInput>);

    expect(detail(owner, id)).toMatchObject({
      type: before.type,
      customerId,
      customerName: "Alfa s.r.o.",
      seriesId: before.seriesId,
      customerSnapshot: before.customerSnapshot,
    });
  });

  test("[INV-020] změna data nepřidělí nové číslo a proměnné se nedosazují", () => {
    const { owner, customerId } = newOwner();
    const { id, number } = issued(owner, customerId);
    const before = counters(owner);

    update(owner, id, {
      issueDate: "2025-12-01",
      dueDate: "2025-12-15",
      note: "Období {{rok}}",
      lines: [line({ name: "Práce {{mesic}}" })],
    });

    expect(detail(owner, id)).toMatchObject({
      number,
      issueDate: "2025-12-01",
      note: "Období {{rok}}",
    });
    expect(detail(owner, id).lines[0]?.name).toBe("Práce {{mesic}}");
    expect(counters(owner)).toEqual(before);
  });

  test("[INV-020] hledání zná změněné číslo a položky", () => {
    const { owner, customerId } = newOwner();
    const { id } = issued(owner, customerId);

    update(owner, id, { number: "ZX-1", lines: [line({ name: "Školení" })] });

    const row = db.select().from(invoice).where(eq(invoice.id, id)).get()!;
    expect(row.searchText).toContain("zx-1");
    expect(row.searchText).toContain("skoleni");
  });

  test("[INV-020] upozornění na platby vychází z paid_minor", () => {
    const { owner, customerId } = newOwner();
    const { id } = issued(owner, customerId);
    const total = detail(owner, id).totalMinor;
    db.update(invoice).set({ status: "paid", paidMinor: total }).where(eq(invoice.id, id)).run();

    expect(update(owner, id, { lines: [line({ unitPriceMinor: 100_000 })] })).toMatchObject({
      balanceWarning: "overpaid",
      resendSuggested: false,
    });
    expect(update(owner, id, { lines: [line({ unitPriceMinor: 200_000 })] })).toMatchObject({
      balanceWarning: "underpaid",
    });
    expect(update(owner, id, { lines: [line()] }).balanceWarning).toBe("none");
    expect(detail(owner, id).status).toBe("paid");
  });

  test("[INV-020] částečná úhrada menší než částka není nesoulad", () => {
    const { owner, customerId } = newOwner();
    const { id } = issued(owner, customerId);
    db.update(invoice)
      .set({ status: "partially_paid", paidMinor: 100 })
      .where(eq(invoice.id, id))
      .run();

    expect(update(owner, id, { note: "x" }).balanceWarning).toBe("none");
  });
});

describe("verze", () => {
  test("[INV-021] každá změna vytvoří verzi a stará jde obnovit", () => {
    const { owner, customerId } = newOwner();
    const { id, number } = issued(owner, customerId, { note: "Původní" });
    const original = detail(owner, id);

    update(owner, id, { note: "Druhá", lines: [line({ name: "Jiná" })] });
    update(owner, id, { note: "Třetí" });

    const versions = listVersions(owner, id);
    expect(versions.map((v) => v.versionNo)).toEqual([2, 1]);
    const first = getVersion(owner, versions[1]!.id)!;
    expect(first.document).toMatchObject({
      number,
      note: "Původní",
      status: "issued",
    });
    expect(first.document.lines[0]?.name).toBe("Konzultace");

    const result = restoreVersion(actor(owner), first.id);

    expect(result.revision).toBe(original.revision + 3);
    const row = detail(owner, id);
    expect(row).toMatchObject({
      note: "Původní",
      totalMinor: original.totalMinor,
      number,
    });
    expect(row.lines.map((l) => l.name)).toEqual(["Konzultace"]);
    expect(listVersions(owner, id).map((v) => v.versionNo)).toEqual([3, 2, 1]);
    expect(getVersion(owner, listVersions(owner, id)[0]!.id)?.document.note).toBe("Třetí");
    expect(getVersion(owner, first.id)?.document.note).toBe("Původní");
    assertConsistent(db, owner);
  });

  test("[INV-021] úprava bez změny verzi ani audit nevytvoří", () => {
    const { owner, customerId } = newOwner();
    const { id } = issued(owner, customerId);
    const revision = detail(owner, id).revision;

    expect(update(owner, id).revision).toBe(revision);

    expect(listVersions(owner, id)).toEqual([]);
    expect(audits(id, "invoice.update")).toEqual([]);
    expect(detail(owner, id).revision).toBe(revision);
  });

  test("[INV-021] úprava zapíše audit s rozdílem položek", () => {
    const { owner, customerId } = newOwner();
    const { id, number } = issued(owner, customerId);

    update(owner, id, { number: "NOVE-1", lines: [line({ name: "Jiná" })] });

    expect(audits(id, "invoice.update")[0]).toMatchObject({
      ownerId: owner,
      scope: "user",
      entity: "invoice",
      before: { number, lines: { changed: [{ name: "Konzultace" }] } },
      after: {
        number: "NOVE-1",
        versionNo: 1,
        lines: { changed: [{ name: "Jiná" }] },
      },
    });
  });

  test("[INV-021] nepovedená úprava verzi nezanechá", () => {
    const { owner, customerId } = newOwner();
    const first = issued(owner, customerId);
    const second = issued(owner, customerId);

    expect(() => update(owner, second.id, { number: first.number })).toThrow();

    expect(listVersions(owner, second.id)).toEqual([]);
  });

  test("[INV-021] obnovení vrátí vše včetně formátu data, obrázků a variabilního symbolu", () => {
    const { owner, customerId } = newOwner();
    setSupplierImage(actor(owner), "logo", PNG, "logo.png");
    const { id, number } = issued(owner, customerId);
    const original = detail(owner, id);
    expect(original.logoFileId).toBeTruthy();

    update(owner, id, { number: "NOVE-1", textBefore: "Změna" });
    const version = listVersions(owner, id)[0]!;
    db.update(invoice)
      .set({
        dateFormat: "yyyy-MM-dd",
        logoFileId: null,
        customerSnapshot: { ...original.customerSnapshot!, name: "Jiný" },
      })
      .where(eq(invoice.id, id))
      .run();

    restoreVersion(actor(owner), version.id);

    expect(detail(owner, id)).toMatchObject({
      number,
      variableSymbol: original.variableSymbol,
      textBefore: original.textBefore,
      dateFormat: original.dateFormat,
      logoFileId: original.logoFileId,
      supplierSnapshot: original.supplierSnapshot,
      customerSnapshot: original.customerSnapshot,
      accountSnapshot: original.accountSnapshot,
      appearance: original.appearance,
    });
  });

  test("[INV-021] obnovení nemění stav, platby ani dobu odeslání", () => {
    const { owner, customerId } = newOwner();
    const { id } = issued(owner, customerId);
    update(owner, id, { note: "Změna" });
    markSent(actor(owner), id);
    db.update(invoice).set({ paidMinor: 500 }).where(eq(invoice.id, id)).run();
    const { sentAt } = detail(owner, id);

    const result = restoreVersion(actor(owner), listVersions(owner, id)[0]!.id);

    expect(detail(owner, id)).toMatchObject({
      status: "sent",
      paidMinor: 500,
      sentAt,
      note: "",
    });
    expect(result).toMatchObject({
      resendSuggested: true,
      balanceWarning: "none",
    });
  });

  test("[INV-021] obnovení stejného obsahu nic nevytvoří", () => {
    const { owner, customerId } = newOwner();
    const { id } = issued(owner, customerId);
    update(owner, id, { note: "Změna" });
    update(owner, id, { note: "" });
    const before = detail(owner, id).revision;

    const result = restoreVersion(actor(owner), listVersions(owner, id).at(-1)!.id);

    expect(result.revision).toBe(before);
    expect(listVersions(owner, id)).toHaveLength(2);
    expect(audits(id, "invoice.restore_version")).toEqual([]);
  });

  test("[INV-021] obnovení zapíše audit", () => {
    const { owner, customerId } = newOwner();
    const { id } = issued(owner, customerId);
    update(owner, id, { lines: [line({ name: "Jiná" })] });

    const version = listVersions(owner, id)[0]!;
    restoreVersion(actor(owner), version.id);

    expect(audits(id, "invoice.restore_version")[0]).toMatchObject({
      ownerId: owner,
      scope: "user",
      before: { lines: { changed: [{ name: "Jiná" }] } },
      after: {
        restoredFrom: version.versionNo,
        versionNo: 2,
        lines: { changed: [{ name: "Konzultace" }] },
      },
    });
  });

  test("[INV-021] stornovaný doklad obnovit nejde", () => {
    const { owner, customerId } = newOwner();
    const { id } = issued(owner, customerId);
    update(owner, id, { note: "Změna" });
    cancelInvoice(actor(owner), id);

    expectRefused(
      () => restoreVersion(actor(owner), listVersions(owner, id)[0]!.id),
      V.notEditable,
    );
  });

  test("[INV-021] neexistující verze je odmítnutá", () => {
    const { owner } = newOwner();
    expectRefused(() => restoreVersion(actor(owner), "nic"), V.versionNotFound);
    expect(getVersion(owner, "nic")).toBeNull();
  });

  test("[INV-021] obnovení přežije smazaný účet a položku ceníku", () => {
    const { owner, customerId, accountId } = newOwner();
    const { id: item } = saveCatalogItem(actor(owner), catalogInput("Konzultace"));
    const { id } = issued(owner, customerId, {
      lines: [line({ catalogItemId: item })],
    });
    const snapshot = detail(owner, id).accountSnapshot;
    const second = newAccount(owner);
    update(owner, id, { bankAccountId: second, lines: [line()] });
    deleteBankAccount(actor(owner), accountId);
    db.delete(catalogItem).where(eq(catalogItem.id, item)).run();

    restoreVersion(actor(owner), listVersions(owner, id)[0]!.id);

    expect(detail(owner, id)).toMatchObject({
      bankAccountId: null,
      accountSnapshot: snapshot,
    });
    expect(detail(owner, id).lines[0]?.catalogItemId).toBeNull();
    assertConsistent(db, owner);
  });

  test("[INV-021] rozdíl verzí ukáže změněnou položku a částku", () => {
    const { owner, customerId } = newOwner();
    const { id } = issued(owner, customerId);
    update(owner, id, {
      lines: [line({ name: "Jiná", unitPriceMinor: 100_000 })],
      note: "Nová",
    });
    const old = getVersion(owner, listVersions(owner, id)[0]!.id)!.document;
    update(owner, id, { note: "Nová2" });
    const current = getVersion(owner, listVersions(owner, id)[0]!.id)!.document;

    const changes = diffInvoices(old, current);

    expect(changes).toContainEqual({
      kind: "field",
      field: "totals.totalMinor",
      before: 300_000,
      after: 200_000,
    });
    expect(changes).toContainEqual({
      kind: "field",
      field: "note",
      before: "",
      after: "Nová",
    });
    expect(changes).toContainEqual(
      expect.objectContaining({
        kind: "line",
        change: "changed",
        position: 0,
        before: expect.objectContaining({
          name: "Konzultace",
          unitPriceMinor: 150_000,
        }),
        after: expect.objectContaining({
          name: "Jiná",
          unitPriceMinor: 100_000,
        }),
      }),
    );
  });

  test("[INV-021] rozdíl pozná přidanou, odebranou a přesunutou položku", () => {
    const { owner, customerId } = newOwner();
    const { id } = issued(owner, customerId);
    update(owner, id, {
      lines: [line({ name: "A" }), line({ name: "B" }), line({ name: "C" })],
    });
    update(owner, id, {
      lines: [line({ name: "B" }), line({ name: "A" })],
    });
    update(owner, id, { note: "konec" });
    const [third, second] = listVersions(owner, id);
    const before = getVersion(owner, second!.id)!.document;
    const after = getVersion(owner, third!.id)!.document;

    const lines = diffInvoices(before, after).filter((c) => c.kind === "line");

    expect(lines.map((c) => [c.change, c.before?.name ?? null, c.after?.name ?? null])).toEqual(
      expect.arrayContaining([
        ["moved", "A", "A"],
        ["moved", "B", "B"],
        ["removed", "C", null],
      ]),
    );
  });

  test("[INV-021] rozdíl neukazuje stav ani platby a shodné doklady nemají změny", () => {
    const { owner, customerId } = newOwner();
    const { id } = issued(owner, customerId);
    update(owner, id, { note: "x" });
    const document = getVersion(owner, listVersions(owner, id)[0]!.id)!.document;

    expect(diffInvoices(document, document)).toEqual([]);
    expect(
      diffInvoices(document, {
        ...document,
        status: "paid",
        totals: { ...document.totals, paidMinor: 5 },
      }),
    ).toEqual([]);
  });

  test("[INV-021] rozdíl pořadí klíčů v JSON ignoruje a přidání účtu ukáže po polích", () => {
    const { owner, customerId } = newOwner();
    const { id } = issued(owner, customerId);
    update(owner, id, { note: "x" });
    const document = getVersion(owner, listVersions(owner, id)[0]!.id)!.document;
    const { accent, ...colors } = document.appearance.colors;

    expect(
      diffInvoices(document, {
        ...document,
        appearance: { ...document.appearance, colors: { ...colors, accent } },
      }),
    ).toEqual([]);
    expect(
      diffInvoices({ ...document, snapshot: { ...document.snapshot, account: null } }, document),
    ).toContainEqual({
      kind: "field",
      field: "snapshot.account.name",
      before: null,
      after: "Účet CZK",
    });
  });
});

describe("číslo dokladu", () => {
  test("[INV-022] obsazené číslo je odmítnuté, stejné číslo téhož dokladu projde", () => {
    const { owner, customerId } = newOwner();
    const first = issued(owner, customerId);
    const second = issued(owner, customerId);

    expectRefused(() => update(owner, second.id, { number: first.number }), V.numberTaken);

    expect(update(owner, second.id, { number: second.number, note: "x" }).revision).toBeGreaterThan(
      0,
    );
    expect(detail(owner, second.id).number).toBe(second.number);
  });

  test("[INV-022] číslo jiného účtu obsazené není", () => {
    const a = newOwner();
    const b = newOwner();
    const first = issued(a.owner, a.customerId);
    const second = issued(b.owner, b.customerId);

    update(a.owner, first.id, { number: "SPOLECNE-1" });

    update(b.owner, second.id, { number: "SPOLECNE-1" });

    expect(detail(b.owner, second.id).number).toBe("SPOLECNE-1");
  });

  test("[INV-022] variabilní symbol následuje číslo, ruční zůstává", () => {
    const { owner, customerId } = newOwner();
    const automatic = issued(owner, customerId);
    update(owner, automatic.id, { number: "2030-777" });
    expect(detail(owner, automatic.id)).toMatchObject({
      variableSymbol: "2030777",
    });

    const { id, revision } = saveDraft(actor(owner), {
      ...newDraftDefaults(owner, customerId),
      lines: [line()],
    });
    issueInvoice(actor(owner), id, { revision, variableSymbol: "4242" });
    update(owner, id, { number: "2030-778" });
    expect(detail(owner, id)).toMatchObject({
      variableSymbol: "4242",
      variableSymbolManual: true,
    });
  });

  test("[INV-022] obnovení verze s mezitím obsazeným číslem je odmítnuté", () => {
    const { owner, customerId } = newOwner();
    const first = issued(owner, customerId);
    update(owner, first.id, { number: "NOVE-1" });
    const second = issued(owner, customerId);
    update(owner, second.id, { number: first.number });

    expectRefused(
      () => restoreVersion(actor(owner), listVersions(owner, first.id)[0]!.id),
      V.numberTaken,
    );
    expect(detail(owner, first.id).number).toBe("NOVE-1");
  });
});

describe("údaje zákazníka", () => {
  test("[CUS-008] obnovení údajů zákazníka je jediná cesta a vytvoří verzi", () => {
    const { owner, customerId } = newOwner();
    const { id, number } = issued(owner, customerId);
    saveCustomer(actor(owner), {
      id: customerId,
      ...customerInput("Nové jméno s.r.o."),
    });

    update(owner, id, { note: "x" });
    expect(detail(owner, id)).toMatchObject({
      customerName: "Alfa s.r.o.",
      customerSnapshot: { name: "Alfa s.r.o." },
    });

    const revision = detail(owner, id).revision;
    expect(refreshCustomerSnapshot(actor(owner), id).revision).toBe(revision + 1);

    expect(detail(owner, id)).toMatchObject({
      number,
      customerName: "Nové jméno s.r.o.",
      customerSnapshot: { name: "Nové jméno s.r.o." },
    });
    const row = db.select().from(invoice).where(eq(invoice.id, id)).get()!;
    expect(row.searchText).toContain("nove jmeno");
    const [latest] = listVersions(owner, id);
    expect(getVersion(owner, latest!.id)?.document.snapshot.customer?.name).toBe("Alfa s.r.o.");
    expect(audits(id, "invoice.refresh_customer")[0]).toMatchObject({
      before: { customerName: "Alfa s.r.o." },
      after: {
        customerName: "Nové jméno s.r.o.",
        versionNo: latest!.versionNo,
      },
    });
    assertConsistent(db, owner);
  });

  test("[CUS-008] obnovení bez změny zákazníka nic nevytvoří", () => {
    const { owner, customerId } = newOwner();
    const { id } = issued(owner, customerId);
    const revision = detail(owner, id).revision;

    expect(refreshCustomerSnapshot(actor(owner), id).revision).toBe(revision);

    expect(listVersions(owner, id)).toEqual([]);
    expect(audits(id, "invoice.refresh_customer")).toEqual([]);
  });

  test("[CUS-008] stornovanému dokladu údaje obnovit nejde", () => {
    const { owner, customerId } = newOwner();
    const { id } = issued(owner, customerId);
    cancelInvoice(actor(owner), id);

    expectRefused(() => refreshCustomerSnapshot(actor(owner), id), V.notEditable);
  });
});

describe("izolace a data účtu", () => {
  test("[TST-009] izolace verzí", async () => {
    await assertIsolated<{ invoiceId: string; versionId: string }>({
      create: (owner) => {
        seed(owner);
        ensureDefaultSeries(actor(owner));
        saveSupplier(actor(owner), supplierInput);
        newAccount(owner);
        const customerId = saveCustomer(actor(owner), customerInput("Alfa s.r.o.")).id;
        const invoiceId = issued(owner, customerId).id;
        update(owner, invoiceId, { note: "Změna" });
        return { invoiceId, versionId: listVersions(owner, invoiceId)[0]!.id };
      },
      find: (owner, { versionId }) => getVersion(owner, versionId),
      update: (owner, { versionId }) => {
        const { revision } = restoreVersion(actor(owner), versionId);
        return revision > 0 ? 1 : 0;
      },
    });
  });

  test("[TST-009] cizí doklad nejde upravit, obnovit ani vypsat", () => {
    const a = newOwner();
    const b = newOwner();
    const { id } = issued(a.owner, a.customerId);
    update(a.owner, id, { note: "Změna" });
    const input = edit(a.owner, id, { note: "cizí" });

    expectRefused(() => updateIssuedInvoice(actor(b.owner), id, input), V.notFound);
    expectRefused(() => refreshCustomerSnapshot(actor(b.owner), id), V.notFound);
    expect(listVersions(b.owner, id)).toEqual([]);
    expect(detail(a.owner, id).note).toBe("Změna");
  });

  test("[ADM-006] smazání účtu odstraní i verze", () => {
    const { owner, customerId } = newOwner();
    seed("root");
    db.update(user).set({ role: "admin" }).where(eq(user.id, "root")).run();
    const { id } = issued(owner, customerId);
    update(owner, id, { note: "Změna" });

    deleteUser(actor("root"), owner, `${owner}@example.cz`);

    expect(USER_OWNED_TABLES).toContain(invoiceVersion);
    expect(USER_OWNED_TABLES.indexOf(invoiceVersion)).toBeLessThan(
      USER_OWNED_TABLES.indexOf(invoice),
    );
    expect(db.select().from(invoiceVersion).where(eq(invoiceVersion.userId, owner)).all()).toEqual(
      [],
    );
    expect(db.select().from(invoiceLine).where(eq(invoiceLine.userId, owner)).all()).toEqual([]);
    assertConsistent(db, owner);
  });
});

describe("soubory ve verzích", () => {
  test("[SET-014] obrázek odkazovaný jen z verze výměna v profilu nesmaže", () => {
    const { owner, customerId } = newOwner();
    setSupplierImage(actor(owner), "logo", PNG, "logo.png");
    const { id } = issued(owner, customerId);
    const logoFileId = detail(owner, id).logoFileId!;
    update(owner, id, { note: "Změna" });
    db.update(invoice).set({ logoFileId: null }).where(eq(invoice.id, id)).run();

    setSupplierImage(actor(owner), "logo", PNG, "nove.png");

    expect(db.select().from(file).where(eq(file.id, logoFileId)).get()).toBeDefined();
    restoreVersion(actor(owner), listVersions(owner, id)[0]!.id);
    expect(detail(owner, id).logoFileId).toBe(logoFileId);
  });
});
