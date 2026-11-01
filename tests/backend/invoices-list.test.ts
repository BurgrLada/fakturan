import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { isOverdue, MAX_BULK_DOCUMENTS, type InvoiceStatus } from "@/lib/invoice";
import { setClockForTests } from "@/server/clock";
import { checkRateLimit, RATE_RULES } from "@/server/rate-limit";
import { RateLimitError, ServiceError } from "@/server/services/access";
import { auditLog, invoice, user } from "@/server/db/schema";
import { saveBankAccount } from "@/server/services/bank-accounts";
import { saveCustomer } from "@/server/services/customers";
import {
  cancelInvoice,
  issueInvoice,
  markSent,
  markSentMany,
} from "@/server/services/invoice-lifecycle";
import {
  InvoicePdfNotFoundError,
  invoicesZip,
  uniqueFileNames,
} from "@/server/services/invoice-pdf";
import {
  customerInvoiceStats,
  getInvoice,
  invoiceQuery,
  invoiceSummary,
  listInvoices,
  newDraftDefaults,
  parseInvoiceFilter,
  saveDraft,
  type DraftInput,
  type InvoiceFilter,
} from "@/server/services/invoices";
import { ensureDefaultSeries } from "@/server/services/number-series";
import { savePreferences, getPreferences } from "@/server/services/preferences";
import { saveSupplier, type SupplierInput } from "@/server/services/supplier";
import { setInvoiceTags, listTags } from "@/server/services/tags";
import { createTestDb } from "../helpers/db";

vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-list-")));

const db = createTestDb();
const actor = (userId: string) => ({ userId, source: "web" as const });
const NOW = new Date("2026-03-10T10:00:00Z");

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

let counter = 0;

function newOwner() {
  const owner = `list-${(counter += 1)}`;
  const now = new Date();
  db.insert(user)
    .values({
      id: owner,
      name: owner,
      email: `${owner}@example.cz`,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  ensureDefaultSeries(actor(owner));
  saveSupplier(actor(owner), supplierInput);
  return {
    owner,
    alfa: saveCustomer(actor(owner), customerInput("Alfa s.r.o.")).id,
    zeta: saveCustomer(actor(owner), customerInput("Žluťoučký kůň")).id,
    czk: saveBankAccount(actor(owner), {
      name: "Účet CZK",
      currency: "CZK",
      number: "19-2000145399",
      bankCode: "0800",
      iban: "",
      swift: "",
    }),
    eur: saveBankAccount(actor(owner), {
      name: "Účet EUR",
      currency: "EUR",
      number: "19-2000145399",
      bankCode: "0800",
      iban: "",
      swift: "",
    }),
  };
}

type Owner = ReturnType<typeof newOwner>;

const line = (name: string, unitPriceMinor: number): DraftInput["lines"][number] => ({
  catalogItemId: null,
  name,
  description: "",
  quantityMilli: 1000,
  unit: "hod.",
  unitPriceMinor,
  discountKind: "none",
  discountValue: 0,
});

function draft(o: Owner, over: Partial<DraftInput> & { price?: number; item?: string } = {}) {
  const { price = 100_000, item = "Konzultace", ...rest } = over;
  const defaults = newDraftDefaults(o.owner, null);
  const currency = rest.currency ?? "CZK";
  return saveDraft(actor(o.owner), {
    ...defaults,
    customerId: o.alfa,
    bankAccountId: currency === "EUR" ? o.eur : o.czk,
    currency,
    exchangeRateMicros: currency === "EUR" ? 25_000_000 : null,
    lines: [line(item, price)],
    ...rest,
  });
}

function issued(o: Owner, over: Parameters<typeof draft>[1] = {}) {
  const saved = draft(o, over);
  issueInvoice(actor(o.owner), saved.id, { revision: saved.revision });
  return saved.id;
}

function setStatus(id: string, status: InvoiceStatus, paidMinor = 0) {
  db.update(invoice).set({ status, paidMinor }).where(eq(invoice.id, id)).run();
}

const ids = (owner: string, filter: InvoiceFilter = {}) =>
  listInvoices(owner, { pageSize: 100, ...filter }).rows.map((row) => row.id);

beforeEach(() => setClockForTests({ now: () => NOW }));
afterEach(() => setClockForTests(null));

describe("seznam faktur", () => {
  test("[INV-030] filtr podle stavu, zákazníka, období, měny, typu, štítku", () => {
    const o = newOwner();
    const a = issued(o, { issueDate: "2026-01-15", dueDate: "2026-04-01" });
    const b = issued(o, {
      customerId: o.zeta,
      currency: "EUR",
      issueDate: "2026-03-01",
      dueDate: "2026-04-01",
    });
    const c = draft(o, { issueDate: "2026-03-05", dueDate: "2026-04-01" }).id;
    const d = issued(o, { issueDate: "2026-03-06", dueDate: "2026-04-01" });
    markSent(actor(o.owner), b);
    setInvoiceTags(actor(o.owner), a, ["Web"]);
    const tag = listTags(o.owner)[0]!.id;
    db.update(invoice).set({ external: true, type: "advance" }).where(eq(invoice.id, d)).run();

    expect(ids(o.owner, { status: "draft" })).toEqual([c]);
    expect(ids(o.owner, { status: "sent" })).toEqual([b]);
    expect(ids(o.owner, { customerId: o.zeta })).toEqual([b]);
    expect(ids(o.owner, { from: "2026-02-01", to: "2026-03-01" })).toEqual([b]);
    expect(ids(o.owner, { currency: "EUR" })).toEqual([b]);
    expect(ids(o.owner, { type: "advance" })).toEqual([d]);
    expect(ids(o.owner, { tagId: tag })).toEqual([a]);
    expect(ids(o.owner, { external: true })).toEqual([d]);
    expect(ids(o.owner, { currency: "EUR", status: "issued" })).toEqual([]);
  });

  test("[INV-030] hledání „prilezitost“ najde „Příležitost“", () => {
    const o = newOwner();
    const hit = issued(o, { item: "Příležitost" });
    const other = issued(o, { customerId: o.zeta });
    const number = getInvoice(o.owner, other)!.number!;

    expect(ids(o.owner, { q: "prilezitost" })).toEqual([hit]);
    expect(ids(o.owner, { q: "zlutoucky" })).toEqual([other]);
    expect(ids(o.owner, { q: number })).toEqual([other]);
    expect(ids(o.owner, { q: "%" })).toEqual([]);
  });

  test("[INV-030] po splatnosti v SQL souhlasí s isOverdue", () => {
    const o = newOwner();
    const today = "2026-03-10";
    const made: string[] = [];
    for (const status of ["issued", "sent", "partially_paid", "paid", "cancelled", "credited"]) {
      for (const dueDate of ["2026-03-09", today, "2026-03-11"]) {
        const id = issued(o, { issueDate: "2026-03-01", dueDate });
        setStatus(id, status as InvoiceStatus);
        made.push(id);
      }
    }
    const expected = made.filter((id) => isOverdue(getInvoice(o.owner, id)!, today));
    expect(expected).toHaveLength(3);
    expect(ids(o.owner, { status: "overdue" }).toSorted()).toEqual(expected.toSorted());
  });

  test("[INV-030] řádek pozná po splatnosti a credited i partially_paid drží svůj stav", () => {
    const o = newOwner();
    const credited = issued(o, { issueDate: "2026-03-01", dueDate: "2026-03-02" });
    const partial = issued(o, { issueDate: "2026-03-01", dueDate: "2026-03-02" });
    setStatus(credited, "credited");
    setStatus(partial, "partially_paid", 40_000);

    const { rows } = listInvoices(o.owner, {});
    expect(rows.find((row) => row.id === credited)).toMatchObject({
      status: "credited",
      overdue: false,
    });
    expect(rows.find((row) => row.id === partial)).toMatchObject({
      status: "partially_paid",
      overdue: true,
      paidMinor: 40_000,
    });
  });

  test("[INV-030] neznámé hodnoty v URL se ignorují", () => {
    expect(
      parseInvoiceFilter({
        stav: "nesmysl",
        mena: "XXX",
        typ: "faktura",
        od: "2026-13-45",
        do: "včera",
        razeni: "heslo",
        smer: "bokem",
        strana: "-1",
        jinde: "ano",
      }),
    ).toEqual({});

    const o = newOwner();
    const other = newOwner();
    const a = issued(o);
    expect(ids(o.owner, { customerId: "neexistuje" })).toEqual([a]);
    expect(ids(o.owner, { customerId: other.alfa })).toEqual([a]);
    expect(ids(o.owner, { tagId: "neexistuje" })).toEqual([a]);
  });

  test("[INV-031] filtr přežije obnovení stránky", () => {
    const filter = parseInvoiceFilter({
      q: " web ",
      stav: "po-splatnosti",
      zakaznik: "c1",
      od: "2026-01-01",
      do: "2026-02-01",
      mena: "EUR",
      typ: "advance",
      stitek: "t1",
      jinde: "1",
      razeni: "castka",
      smer: "asc",
      strana: "3",
    });
    expect(filter).toEqual({
      q: "web",
      status: "overdue",
      customerId: "c1",
      from: "2026-01-01",
      to: "2026-02-01",
      currency: "EUR",
      type: "advance",
      tagId: "t1",
      external: true,
      sort: "total",
      dir: "asc",
      page: 3,
    });
    const url = new URLSearchParams(invoiceQuery(filter));
    expect(parseInvoiceFilter(Object.fromEntries(url))).toEqual(filter);
    expect(invoiceQuery({})).toBe("");
  });

  test("[INV-031] řazení podle každého sloupce, stránkování beze ztrát", () => {
    const o = newOwner();
    const a = issued(o, {
      customerId: o.zeta,
      price: 300,
      issueDate: "2026-01-01",
      dueDate: "2026-05-01",
    });
    const b = issued(o, { price: 200, issueDate: "2026-02-01", dueDate: "2026-04-01" });
    const c = issued(o, { price: 100, issueDate: "2026-03-01", dueDate: "2026-06-01" });
    markSent(actor(o.owner), c);

    expect(ids(o.owner, { sort: "number", dir: "asc" })).toEqual([a, b, c]);
    expect(ids(o.owner, { sort: "customer", dir: "asc" }).at(-1)).toBe(a);
    expect(ids(o.owner, { sort: "customer", dir: "desc" }).at(0)).toBe(a);
    expect(ids(o.owner, { sort: "issueDate", dir: "desc" })).toEqual([c, b, a]);
    expect(ids(o.owner, { sort: "dueDate", dir: "asc" })).toEqual([b, a, c]);
    expect(ids(o.owner, { sort: "total", dir: "asc" })).toEqual([c, b, a]);
    expect(ids(o.owner, { sort: "status", dir: "desc" }).at(0)).toBe(c);

    const same = newOwner();
    const made = Array.from({ length: 7 }, () => issued(same, { issueDate: "2026-03-01" }));
    const seen: string[] = [];
    for (let page = 1, more = true; more; page += 1) {
      const result = listInvoices(same.owner, { page, pageSize: 3 });
      seen.push(...result.rows.map((row) => row.id));
      more = result.hasNext;
    }
    expect(seen.toSorted()).toEqual(made.toSorted());
  });

  test("[INV-032] souhrn je pro každou měnu zvlášť a nad celým filtrem", () => {
    const o = newOwner();
    issued(o, { price: 100_000, issueDate: "2026-03-01", dueDate: "2026-03-05" });
    const partial = issued(o, { price: 50_000, issueDate: "2026-03-01", dueDate: "2026-03-05" });
    setStatus(partial, "partially_paid", 20_000);
    const paid = issued(o, { price: 10_000, issueDate: "2026-03-01", dueDate: "2026-03-05" });
    setStatus(paid, "paid", 10_000);
    issued(o, { currency: "EUR", price: 7_000, issueDate: "2026-03-01", dueDate: "2026-04-01" });

    const summary = invoiceSummary(o.owner, { pageSize: 1 });
    expect(summary).toEqual([
      {
        currency: "CZK",
        invoicedMinor: 160_000,
        paidMinor: 30_000,
        overdueMinor: 130_000,
        advanceOpenMinor: 0,
      },
      {
        currency: "EUR",
        invoicedMinor: 7_000,
        paidMinor: 0,
        overdueMinor: 0,
        advanceOpenMinor: 0,
      },
    ]);
    expect(invoiceSummary(o.owner, { currency: "EUR", page: 9 })).toHaveLength(1);
  });

  test("[INV-032] storno a koncept se nezapočítají", () => {
    const o = newOwner();
    issued(o, { price: 1_000 });
    const cancelled = issued(o, { price: 2_000 });
    cancelInvoice(actor(o.owner), cancelled);
    draft(o, { price: 4_000 });

    expect(invoiceSummary(o.owner, {})).toEqual([
      {
        currency: "CZK",
        invoicedMinor: 1_000,
        paidMinor: 0,
        overdueMinor: 0,
        advanceOpenMinor: 0,
      },
    ]);
  });

  test("[INV-001] koncept se do souhrnu nezapočítá ani s filtrem na koncepty", () => {
    const o = newOwner();
    draft(o, { price: 4_000, issueDate: "2026-01-01", dueDate: "2026-01-02" });
    expect(invoiceSummary(o.owner, {})).toEqual([]);
    expect(invoiceSummary(o.owner, { status: "draft" })).toEqual([]);
  });

  test("[TST-009] cizí detail je 404 a list ho nevrátí", () => {
    const o = newOwner();
    const other = newOwner();
    const mine = issued(o);
    issued(other);

    expect(ids(o.owner)).toEqual([mine]);
    expect(getInvoice(other.owner, mine)).toBeNull();
    expect(invoiceSummary(other.owner, {})).toHaveLength(1);
    expect(customerInvoiceStats(other.owner, o.alfa).sums).toEqual([]);
  });

  test("[INV-001] karta zákazníka nezapočítá koncept a má součty po měnách", () => {
    const o = newOwner();
    const first = issued(o, { price: 100_000 });
    const second = issued(o, { price: 50_000 });
    setStatus(second, "partially_paid", 20_000);
    issued(o, { currency: "EUR", price: 7_000 });
    draft(o, { price: 9_000 });
    const cancelled = issued(o, { price: 3_000 });
    cancelInvoice(actor(o.owner), cancelled);
    issued(o, { customerId: o.zeta, price: 5_000 });

    const stats = customerInvoiceStats(o.owner, o.alfa);
    expect(stats.sums).toEqual([
      { currency: "CZK", invoicedMinor: 150_000, paidMinor: 20_000, outstandingMinor: 130_000 },
      { currency: "EUR", invoicedMinor: 7_000, paidMinor: 0, outstandingMinor: 7_000 },
    ]);
    expect(stats.rows.map((row) => row.id)).toEqual(expect.arrayContaining([first, second]));
    expect(stats.rows.every((row) => row.customerId === o.alfa)).toBe(true);
  });
});

const downloads = (owner: string) =>
  db
    .select()
    .from(auditLog)
    .where(eq(auditLog.action, "invoice.pdf_download"))
    .all()
    .filter((row) => row.ownerId === owner)
    .map((row) => row.entityId);

// INV-024 stays pending until sending and payment arrive, so these name the ids they do cover.
describe("hromadné akce", () => {
  test("[PDF-009] hromadné PDF dá ZIP vybraných dokladů s unikátními názvy", async () => {
    const o = newOwner();
    savePreferences(actor(o.owner), { ...getPreferences(o.owner), pdfFileName: "{zakaznik}.pdf" });
    const a = issued(o);
    const b = issued(o);
    issued(o);

    const zip = await invoicesZip(actor(o.owner), [a, b, a]);
    const entries = unzipSync(zip.data);
    expect(Object.keys(entries).toSorted()).toEqual(["Alfa s.r.o (2).pdf", "Alfa s.r.o.pdf"]);
    for (const data of Object.values(entries)) {
      expect(Buffer.from(data.subarray(0, 5)).toString()).toBe("%PDF-");
    }
    expect(zip.fileName).toBe("faktury-2026-03-10.zip");

    expect(downloads(o.owner).toSorted()).toEqual([a, b].toSorted());
  });

  test("[PDF-009] unikátní název přeskočí i jméno, které už existuje", () => {
    expect(uniqueFileNames(["a.pdf", "A.pdf", "a (2).pdf", "a.pdf"])).toEqual([
      "a.pdf",
      "A (2).pdf",
      "a (2) (2).pdf",
      "a (3).pdf",
    ]);
  });

  test("[TST-009] hromadné PDF odmítne cizí doklad, koncept a překročený limit", async () => {
    const o = newOwner();
    const other = newOwner();
    const mine = issued(o);
    const foreign = issued(other);
    const concept = draft(o).id;

    await expect(invoicesZip(actor(o.owner), [mine, foreign])).rejects.toThrow(
      InvoicePdfNotFoundError,
    );
    await expect(invoicesZip(actor(o.owner), [mine, concept])).rejects.toThrow(
      InvoicePdfNotFoundError,
    );
    const many = Array.from({ length: MAX_BULK_DOCUMENTS }, () => issued(o));
    await expect(invoicesZip(actor(o.owner), [...many, mine])).rejects.toThrow(ServiceError);
    expect(downloads(o.owner)).toEqual([]);
  }, 30_000);

  test("[SEC-001] vyčerpaný limit exportu hromadné PDF odmítne a nic nezapíše", async () => {
    const o = newOwner();
    const mine = issued(o);
    for (let i = 0; i < RATE_RULES.exportUser.limit; i += 1) {
      checkRateLimit(o.owner, RATE_RULES.exportUser);
    }

    await expect(invoicesZip(actor(o.owner), [mine])).rejects.toThrow(RateLimitError);
    expect(downloads(o.owner)).toEqual([]);
  });

  test("[INV-005] hromadné označení změní jen vystavené a vlastní doklady", () => {
    const o = newOwner();
    const other = newOwner();
    const a = issued(o);
    const already = issued(o);
    markSent(actor(o.owner), already);
    const foreign = issued(other);

    expect(markSentMany(actor(o.owner), [a, already, foreign])).toEqual({ done: 1, skipped: 2 });
    expect(getInvoice(o.owner, a)?.status).toBe("sent");
    expect(getInvoice(other.owner, foreign)?.status).toBe("issued");
  });
});
