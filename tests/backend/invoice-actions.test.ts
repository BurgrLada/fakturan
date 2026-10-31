import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  customerDefaultsAction,
  deleteDraftAction,
  issueAction,
  issuePreviewAction,
  saveDraftAction,
  saveLineToCatalogAction,
  searchCatalogAction,
  searchCustomersAction,
  updateIssuedAction,
} from "@/app/(app)/faktury/actions";
import { TEXTS } from "@/lib/texts";
import { catalogItem, invoice, user } from "@/server/db/schema";
import { saveBankAccount } from "@/server/services/bank-accounts";
import { getCatalogItem, saveCatalogItem } from "@/server/services/catalog";
import { saveCustomer } from "@/server/services/customers";
import { getInvoice, newDraftDefaults, type DraftInput } from "@/server/services/invoices";
import { markSent } from "@/server/services/invoice-lifecycle";
import { listSeries } from "@/server/services/number-series";
import { saveSupplier } from "@/server/services/supplier";
import { createTestDb } from "../helpers/db";

const session = vi.hoisted(() => ({ userId: "x1" }));

vi.mock("@/server/auth/session", () => ({
  getCurrentSession: async () => (session.userId ? { user: { id: session.userId } } : null),
  actorFromRequest: async () => ({ userId: session.userId, source: "web" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-invoice-actions-")));

const db = createTestDb();
const actor = (userId: string) => ({ userId, source: "web" as const });

let counter = 0;

function seed() {
  counter += 1;
  const id = `x${counter}`;
  const now = new Date();
  db.insert(user)
    .values({ id, name: id, email: `${id}@example.cz`, createdAt: now, updatedAt: now })
    .run();
  session.userId = id;
  return id;
}

function issuable(owner: string) {
  saveSupplier(actor(owner), {
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
  });
  saveBankAccount(actor(owner), {
    name: "Účet",
    currency: "CZK",
    number: "19-2000145399",
    bankCode: "0800",
    iban: "",
    swift: "",
  });
  const { id: customerId } = saveCustomer(actor(owner), {
    name: "Alfa s.r.o.",
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
    dueDays: 30,
    language: null,
    currency: "EUR",
    designId: null,
    remindersEnabled: null,
  });
  return { customerId };
}

const line = {
  catalogItemId: null,
  name: "Konzultace",
  description: "",
  quantityMilli: 2000,
  unit: "hod.",
  unitPriceMinor: 150_000,
  discountKind: "none",
  discountValue: 0,
} as const;

const draft = (owner: string, over: Partial<DraftInput> = {}): DraftInput => ({
  ...newDraftDefaults(owner, null),
  clientId: randomUUID(),
  lines: [line],
  ...over,
});

async function savedDraft(owner: string, over: Partial<DraftInput> = {}) {
  const result = await saveDraftAction({ draft: draft(owner, over), tags: [] });
  if (!result.ok) throw new Error(result.error);
  return result;
}

async function issued(owner: string, customerId: string) {
  const saved = await savedDraft(owner, { customerId });
  const result = await issueAction({ id: saved.id, revision: saved.revision });
  if (!result.ok) throw new Error(result.error);
  return { ...result, revision: saved.revision + 1 };
}

const editInput = (
  owner: string,
  id: string,
  over: Record<string, unknown> = {},
  tags: string[] = [],
) => {
  const row = getInvoice(owner, id)!;
  const { number, revision, bankAccountId, issueDate, dueDate, taxableDate, language, currency } =
    row;
  const document = {
    revision,
    number,
    bankAccountId,
    issueDate,
    dueDate,
    taxableDate,
    language,
    currency,
    exchangeRateMicros: row.exchangeRateMicros,
    paymentMethod: row.paymentMethod,
    orderRef: row.orderRef,
    reference: row.reference,
    textBefore: row.textBefore,
    textAfter: row.textAfter,
    note: row.note,
    discountKind: row.discountKind,
    discountValue: row.discountValue,
    rounding: row.rounding,
    appearance: row.appearance,
    lines: [line],
    ...over,
  };
  return { id, tags, document };
};

beforeEach(() => {
  seed();
});

describe("akce formuláře faktury", () => {
  test("[INV-002] koncept jde smazat, cizí ani vystavený ne", async () => {
    const owner = session.userId;
    const { customerId } = issuable(owner);
    const own = await savedDraft(owner, { customerId });
    const kept = await issued(owner, customerId);

    expect(await deleteDraftAction({ id: kept.id })).toMatchObject({ ok: false });
    expect(await deleteDraftAction({})).toMatchObject({ ok: false });
    const stranger = seed();
    expect(await deleteDraftAction({ id: own.id })).toMatchObject({ ok: false });
    expect(getInvoice(owner, own.id)).not.toBeNull();
    expect(getInvoice(owner, kept.id)).not.toBeNull();

    session.userId = owner;
    expect(await deleteDraftAction({ id: own.id })).toMatchObject({ ok: true });
    expect(getInvoice(owner, own.id)).toBeNull();
    expect(stranger).not.toBe(owner);
  });

  test("[SEC-006] akce odmítnou neplatný vstup a cizí ID", async () => {
    const owner = session.userId;
    const { customerId } = issuable(owner);
    const own = await savedDraft(owner, { customerId });
    const stranger = seed();

    const invalid = [
      await saveDraftAction({ draft: { ...draft(stranger), currency: "XXX" }, tags: [] }),
      await saveDraftAction({ draft: draft(stranger), tags: "x" }),
      await saveDraftAction({ tags: [] }),
      await issueAction({ id: own.id }),
      await issueAction({ id: own.id, revision: 1, variableSymbol: "12ab" }),
      await updateIssuedAction({ id: own.id }),
      await saveLineToCatalogAction({ name: "", unit: "ks", priceMinor: 0, currency: "CZK" }),
      await searchCatalogAction({ q: 5 }),
      await searchCustomersAction({}),
    ];
    for (const result of invalid) expect(result).toMatchObject({ ok: false });

    const foreign = [
      await saveDraftAction({
        draft: draft(stranger, { id: own.id, revision: own.revision }),
        tags: [],
      }),
      await saveDraftAction({
        draft: draft(stranger, { clientId: own.id }),
        tags: [],
      }),
      await saveDraftAction({ draft: draft(stranger, { customerId }), tags: [] }),
      await issueAction({ id: own.id, revision: own.revision }),
      await issuePreviewAction({ id: own.id }),
      await updateIssuedAction(editInput(owner, own.id)),
      await customerDefaultsAction({ customerId }),
    ];
    for (const result of foreign) expect(result).toMatchObject({ ok: false });
    expect(getInvoice(owner, own.id)).toMatchObject({ status: "draft", revision: own.revision });
  });

  test("[INV-017] vypršená relace je hlášená, ne přesměrovaná", async () => {
    session.userId = "";

    expect(await saveDraftAction({})).toMatchObject({ ok: false, expired: true });
  });

  test("[SEC-006] podstrčené součty, stav a číslo se ignorují", async () => {
    const owner = session.userId;

    const saved = await saveDraftAction({
      draft: { ...draft(owner), totalMinor: 1, status: "paid", number: "666", userId: "x" },
      tags: [],
    });

    expect(saved).toMatchObject({ ok: true });
    const row = getInvoice(owner, (saved as { id: string }).id)!;
    expect(row).toMatchObject({
      totalMinor: 300_000,
      status: "draft",
      number: null,
      userId: owner,
    });
  });

  test("[INV-017] uložení vrátí revizi a souhrn problémů, chybějící řady založí", async () => {
    const owner = session.userId;
    expect(listSeries(owner)).toEqual([]);

    const saved = await savedDraft(owner);

    expect(saved.revision).toBe(1);
    expect(saved.problems.map((problem) => problem.field)).toContain("customerId");
    expect(saved.problems.map((problem) => problem.field)).toContain("supplier.name");
    expect(listSeries(owner).length).toBeGreaterThan(0);
  });

  test("[INV-017] stale je rozlišený od ostatních chyb", async () => {
    const owner = session.userId;
    const body = draft(owner, { note: "první" });
    const first = await saveDraftAction({ draft: body, tags: [] });
    if (!first.ok) throw new Error(first.error);

    const stale = await saveDraftAction({ draft: { ...body, note: "jiná" }, tags: [] });

    expect(stale).toEqual({ ok: false, stale: true, error: TEXTS.invoices.stale });
  });

  test("[INV-026] štítky se uloží s konceptem a revizi nezvednou", async () => {
    const owner = session.userId;
    const body = draft(owner);
    const first = await saveDraftAction({ draft: body, tags: [] });
    if (!first.ok) throw new Error(first.error);

    const tagged = await saveDraftAction({
      draft: { ...body, clientId: undefined, id: first.id, revision: first.revision },
      tags: ["Práce", "prace", "Účetní"],
    });

    expect(tagged).toMatchObject({ ok: true, revision: first.revision });
    expect(getInvoice(owner, first.id)?.tags.map((tag) => tag.name)).toEqual(["Práce", "Účetní"]);
  });

  test("[INV-026] neplatný štítek neuloží ani koncept", async () => {
    const owner = session.userId;
    const body = draft(owner);

    const result = await saveDraftAction({ draft: body, tags: ["x".repeat(41)] });

    expect(result).toMatchObject({ ok: false });
    expect(db.select().from(invoice).where(eq(invoice.userId, owner)).all()).toEqual([]);
  });

  test("[INV-010] vystavení přidělí číslo a vrátí adresu detailu", async () => {
    const owner = session.userId;
    const { customerId } = issuable(owner);
    const saved = await savedDraft(owner, { customerId });
    expect(saved.problems).toEqual([]);

    const preview = await issuePreviewAction({ id: saved.id });
    expect(preview).toMatchObject({ ok: true, variableSymbol: "2026001" });
    const number = (preview as { number: string }).number;

    const result = await issueAction({ id: saved.id, revision: saved.revision });

    expect(result).toEqual({ ok: true, id: saved.id, number });
  });

  test("[NUM-007] ruční variabilní symbol z dialogu se uloží", async () => {
    const owner = session.userId;
    const { customerId } = issuable(owner);
    const saved = await savedDraft(owner, { customerId });

    await issueAction({ id: saved.id, revision: saved.revision, variableSymbol: "778899" });

    expect(getInvoice(owner, saved.id)).toMatchObject({
      variableSymbol: "778899",
      variableSymbolManual: true,
    });
  });

  test("[INV-010] nevystavitelný koncept vrátí problémy", async () => {
    const owner = session.userId;
    const saved = await savedDraft(owner);

    const result = await issueAction({ id: saved.id, revision: saved.revision });

    expect(result).toMatchObject({ ok: false });
    const fields = (result as { problems: { field: string }[] }).problems.map((p) => p.field);
    expect(fields).toContain("customerId");
  });

  test("[INV-010] výchozí hodnoty zákazníka vrátí splatnost ve dnech", async () => {
    const owner = session.userId;
    const { customerId } = issuable(owner);

    const result = await customerDefaultsAction({ customerId });

    expect(result).toMatchObject({ ok: true, defaults: { dueDays: 30, currency: "EUR" } });
  });

  test("[INV-020] úprava vydané faktury vrátí revizi, u odeslané nabídne nové odeslání", async () => {
    const owner = session.userId;
    const { customerId } = issuable(owner);
    const { id } = await issued(owner, customerId);

    const edited = await updateIssuedAction(editInput(owner, id, { note: "oprava" }));
    expect(edited).toMatchObject({ ok: true, resendSuggested: false });

    markSent(actor(owner), id);
    const sent = await updateIssuedAction(editInput(owner, id, { note: "znovu" }));
    expect(sent).toMatchObject({ ok: true, resendSuggested: true });

    const again = await updateIssuedAction(editInput(owner, id, { note: "znovu" }));
    expect(again).toMatchObject({ ok: true, resendSuggested: false });
  });

  test("[INV-026] úprava vydané faktury uloží i štítky", async () => {
    const owner = session.userId;
    const { customerId } = issuable(owner);
    const { id } = await issued(owner, customerId);

    await updateIssuedAction(editInput(owner, id, {}, ["Štítek"]));

    expect(getInvoice(owner, id)?.tags.map((tag) => tag.name)).toEqual(["Štítek"]);
  });

  test("[INV-022] obsazené číslo vrátí srozumitelnou chybu", async () => {
    const owner = session.userId;
    const { customerId } = issuable(owner);
    const first = await issued(owner, customerId);
    const second = await issued(owner, customerId);

    const result = await updateIssuedAction(editInput(owner, second.id, { number: first.number }));

    expect(result).toMatchObject({ ok: false, error: TEXTS.invoices.validation.numberTaken });
  });

  test("[INV-013] řádek jde uložit do ceníku a najít", async () => {
    const owner = session.userId;

    const result = await saveLineToCatalogAction({
      name: "Konzultace",
      description: "Popis",
      unit: "hod.",
      priceMinor: 150_000,
      currency: "EUR",
    });
    if (!result.ok) throw new Error(result.error);

    expect(getCatalogItem(owner, result.id)).toMatchObject({
      name: "Konzultace",
      currency: "EUR",
      priceMinor: 150_000,
    });
    const found = await searchCatalogAction({ q: "konz" });
    expect(found).toMatchObject({ ok: true, items: [{ id: result.id, unit: "hod." }] });
  });

  test("[INV-011] hledání nevrátí cizí zákazníky", async () => {
    const owner = session.userId;
    issuable(owner);
    expect(await searchCustomersAction({ q: "alfa" })).toMatchObject({
      ok: true,
      customers: [{ name: "Alfa s.r.o." }],
    });

    seed();
    expect(await searchCustomersAction({ q: "alfa" })).toEqual({ ok: true, customers: [] });
  });

  test("[INV-013] hledání v ceníku nevrátí cizí položky", async () => {
    const owner = session.userId;
    saveCatalogItem(actor(owner), {
      name: "Moje",
      description: "",
      unit: "ks",
      priceMinor: 100,
      currency: "CZK",
      category: "",
      tags: [],
    });
    expect(db.select().from(catalogItem).where(eq(catalogItem.userId, owner)).all()).toHaveLength(
      1,
    );

    seed();
    expect(await searchCatalogAction({ q: "moje" })).toEqual({ ok: true, items: [] });
  });
});
