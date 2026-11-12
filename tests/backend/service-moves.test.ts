import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, test, vi } from "vitest";
import { PER_GROUP } from "@/lib/quick-search";
import { auditLog, catalogItem, invoice, numberSeries } from "@/server/db/schema";
import { DEFAULT_MAIL_CONTENT } from "@/server/mail/defaults";
import { ServiceError } from "@/server/services/access";
import { convertAdvanceWithSeries } from "@/server/services/advances";
import { saveLineToCatalog } from "@/server/services/catalog";
import { lookupCompany } from "@/server/services/company-lookup";
import { createCreditNoteWithSeries } from "@/server/services/credit-notes";
import { resetEmailTemplateAndRead, saveEmailTemplate } from "@/server/services/email-templates";
import { checkIssuable } from "@/server/services/invoice-lifecycle";
import { updateIssuedWithTags } from "@/server/services/invoice-versions";
import { getInvoice, newDraftDefaults, saveDraftWithTags } from "@/server/services/invoices";
import { addPayment } from "@/server/services/payments";
import { quickSearch, searchAll } from "@/server/services/quick-search";
import { tagsOf } from "@/server/services/tags";
import { createTestDb } from "../helpers/db";
import {
  issuedAdvance,
  issuedInvoice,
  seedCustomer,
  seedOwner,
  webActor,
} from "../helpers/fixtures-mail";

vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-moves-")));

const db = createTestDb();
const NOW = new Date("2026-03-10T09:00:00Z");

afterEach(() => vi.unstubAllGlobals());

const line = {
  catalogItemId: null,
  name: "Konzultace",
  description: "",
  quantityMilli: 1000,
  unit: "hod.",
  unitPriceMinor: 150_000,
  discountKind: "none" as const,
  discountValue: 0,
};

function actionsOf(owner: string): string[] {
  return db
    .select({ action: auditLog.action })
    .from(auditLog)
    .where(eq(auditLog.ownerId, owner))
    .all()
    .map((row) => row.action);
}

function dropSeries(owner: string, type: "invoice" | "advance" | "credit_note") {
  db.delete(numberSeries)
    .where(and(eq(numberSeries.userId, owner), eq(numberSeries.documentType, type)))
    .run();
}

function hasSeries(owner: string, type: "invoice" | "advance" | "credit_note") {
  return db
    .select()
    .from(numberSeries)
    .where(and(eq(numberSeries.userId, owner), eq(numberSeries.documentType, type)))
    .all().length;
}

describe("saveDraftWithTags", () => {
  test("vytvoří výchozí řady, uloží koncept a štítky a vrátí problémy vystavení", () => {
    const owner = seedOwner(db, NOW);
    const customerId = seedCustomer(owner);
    dropSeries(owner, "credit_note");
    const saved = saveDraftWithTags(
      webActor(owner),
      { ...newDraftDefaults(owner, customerId), lines: [line] },
      ["Projekt A"],
    );
    expect(hasSeries(owner, "credit_note")).toBe(1);
    expect(tagsOf(db, owner, saved.id).map((tag) => tag.name)).toEqual(["Projekt A"]);
    expect(actionsOf(owner)).toEqual(expect.arrayContaining(["invoice.save", "invoice.tags_set"]));
    expect(saved.problems).toEqual(checkIssuable(owner, saved.id));
    expect(saved.revision).toBeGreaterThan(0);
  });

  test("neplatný název štítku odmítne dřív, než vznikne koncept", () => {
    const owner = seedOwner(db, NOW);
    const customerId = seedCustomer(owner);
    expect(() =>
      saveDraftWithTags(
        webActor(owner),
        { ...newDraftDefaults(owner, customerId), lines: [line] },
        ["x".repeat(41)],
      ),
    ).toThrow(ServiceError);
    expect(db.select().from(invoice).where(eq(invoice.userId, owner)).all()).toHaveLength(0);
  });
});

describe("updateIssuedWithTags", () => {
  test("upraví vystavenou fakturu a nastaví štítky", () => {
    const owner = seedOwner(db, NOW);
    const id = issuedInvoice(owner);
    const { lines, ...doc } = getInvoice(owner, id)!;
    const result = updateIssuedWithTags(
      webActor(owner),
      id,
      {
        revision: doc.revision,
        number: doc.number!,
        variableSymbol: doc.variableSymbol ?? "",
        bankAccountId: doc.bankAccountId,
        issueDate: doc.issueDate,
        dueDate: doc.dueDate,
        taxableDate: doc.taxableDate,
        language: doc.language,
        currency: doc.currency,
        exchangeRateMicros: doc.exchangeRateMicros,
        paymentMethod: doc.paymentMethod,
        orderRef: doc.orderRef,
        reference: doc.reference,
        textBefore: doc.textBefore,
        textAfter: doc.textAfter,
        note: "Upraveno",
        discountKind: doc.discountKind,
        discountValue: doc.discountValue,
        rounding: doc.rounding,
        appearance: doc.appearance,
        lines: lines.map((item) => ({
          catalogItemId: item.catalogItemId,
          name: item.name,
          description: item.description,
          quantityMilli: item.quantityMilli,
          unit: item.unit,
          unitPriceMinor: item.unitPriceMinor,
          discountKind: item.discountKind,
          discountValue: item.discountValue,
        })),
      },
      ["Hotovo"],
    );
    expect(result).toBeDefined();
    expect(getInvoice(owner, id)!.note).toBe("Upraveno");
    expect(tagsOf(db, owner, id).map((tag) => tag.name)).toEqual(["Hotovo"]);
  });

  test("neplatný štítek nezmění vystavenou fakturu", () => {
    const owner = seedOwner(db, NOW);
    const id = issuedInvoice(owner);
    const before = getInvoice(owner, id)!.revision;
    expect(() => updateIssuedWithTags(webActor(owner), id, {} as never, ["x".repeat(41)])).toThrow(
      ServiceError,
    );
    expect(getInvoice(owner, id)!.revision).toBe(before);
  });
});

describe("dobropis a konečná faktura s řadami", () => {
  test("createCreditNoteWithSeries doplní chybějící řadu a vytvoří dobropis", () => {
    const owner = seedOwner(db, NOW);
    const id = issuedInvoice(owner);
    dropSeries(owner, "credit_note");
    const note = createCreditNoteWithSeries(webActor(owner), id);
    expect(hasSeries(owner, "credit_note")).toBe(1);
    expect(getInvoice(owner, note.id)!.type).toBe("credit_note");
  });

  test("convertAdvanceWithSeries doplní chybějící řadu a vytvoří konečnou fakturu", () => {
    const owner = seedOwner(db, NOW);
    const advanceId = issuedAdvance(owner);
    addPayment(webActor(owner), advanceId, {
      revision: getInvoice(owner, advanceId)!.revision,
      paidOn: "2026-03-10",
      amountMinor: 1_000_000,
      currency: "CZK",
      method: "transfer",
      note: "",
    });
    dropSeries(owner, "invoice");
    const final = convertAdvanceWithSeries(webActor(owner), advanceId);
    expect(hasSeries(owner, "invoice")).toBe(1);
    expect(getInvoice(owner, final.id)!.type).toBe("invoice");
  });
});

describe("katalog, hledání, ARES a šablony", () => {
  test("saveLineToCatalog uloží řádek bez kategorie a štítků", () => {
    const owner = seedOwner(db, NOW);
    const { id } = saveLineToCatalog(webActor(owner), {
      name: "Revize",
      unit: "ks",
      priceMinor: 50_000,
      currency: "CZK",
    });
    const row = db.select().from(catalogItem).where(eq(catalogItem.id, id)).get()!;
    expect(row).toMatchObject({
      name: "Revize",
      description: "",
      category: "",
      priceMinor: 50_000,
    });
  });

  test("quickSearch s 1 znakem vrátí prázdné bez spotřeby limitu", () => {
    const owner = seedOwner(db, NOW);
    seedCustomer(owner);
    for (let i = 0; i < 200; i += 1) {
      expect(quickSearch(webActor(owner), "A")).toEqual({ hits: [], limited: false });
    }
    expect(quickSearch(webActor(owner), "Alfa")).toEqual({
      hits: searchAll(owner, "Alfa", PER_GROUP),
      limited: false,
    });
  });

  test("quickSearch po vyčerpání searchUser vrátí limited", () => {
    const owner = seedOwner(db, NOW);
    for (let i = 0; i < 120; i += 1) quickSearch(webActor(owner), "Alfa");
    expect(quickSearch(webActor(owner), "Alfa")).toEqual({ hits: [], limited: true });
  });

  test("lookupCompany po vyčerpání aresLookup hodí ServiceError", async () => {
    const owner = seedOwner(db, NOW);
    const fetcher = vi.fn(async () => new Response("{}", { status: 404 }));
    vi.stubGlobal("fetch", fetcher);
    for (let i = 0; i < 30; i += 1) {
      expect(await lookupCompany(webActor(owner), "27082440")).toBeNull();
    }
    await expect(lookupCompany(webActor(owner), "27082440")).rejects.toThrow(ServiceError);
    expect(fetcher).toHaveBeenCalledTimes(30);
  });

  test("resetEmailTemplateAndRead vrátí výchozí předmět a text", () => {
    const owner = seedOwner(db, NOW);
    saveEmailTemplate(webActor(owner), {
      kind: "invoice",
      language: "cs",
      subject: "Vlastní předmět",
      body: "Vlastní text",
    });
    expect(resetEmailTemplateAndRead(webActor(owner), "invoice", "cs")).toEqual(
      DEFAULT_MAIL_CONTENT.cs.invoice,
    );
  });
});
