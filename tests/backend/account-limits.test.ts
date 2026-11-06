import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ACCOUNT_ROW_LIMITS } from "@/lib/account-limits";
import { TEXTS } from "@/lib/texts";
import { setClockForTests } from "@/server/clock";
import {
  customer,
  dashboard,
  invoiceTemplate,
  invoiceVersion,
  recurringInvoice,
  supplier,
  unit,
} from "@/server/db/schema";
import { DOCUMENT_INPUT_BYTES, jsonBytes, STORED_JSON_BYTES } from "@/lib/backup-format";
import { issueInvoice } from "@/server/services/invoice-lifecycle";
import { restoreVersion, updateIssuedInvoice } from "@/server/services/invoice-versions";
import { getInvoice } from "@/server/services/invoices";
import { planRecurringRuns } from "@/server/services/recurring-run";
import { forecast } from "@/server/reports/forecast";
import { saveUnit } from "@/server/services/catalog";
import { createDashboard, ensureDashboards } from "@/server/services/dashboards";
import { saveTemplate } from "@/server/services/invoice-templates";
import { newDraftDefaults } from "@/server/services/invoices";
import { createTestDb } from "../helpers/db";
import { draftFor, seedCustomer, seedOwner, webActor } from "../helpers/fixtures-mail";
import { savePlan } from "../helpers/fixtures-recurring";

vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-limits-")));

const db = createTestDb();
const NOW = new Date("2026-03-20T10:00:00Z");
const L = TEXTS.accountLimits;

beforeEach(() => setClockForTests({ now: () => NOW }));
afterEach(() => setClockForTests(null));

const templateInput = (owner: string) => {
  const draft = newDraftDefaults(owner, null);
  return {
    name: "Šablona",
    customerId: null,
    document: {
      type: "invoice" as const,
      bankAccountId: null,
      dueDays: 14,
      language: draft.language,
      currency: draft.currency,
      paymentMethod: draft.paymentMethod,
      orderRef: "",
      reference: "",
      textBefore: "",
      textAfter: "",
      note: "",
      discountKind: "none" as const,
      discountValue: 0,
      rounding: draft.rounding,
      appearance: draft.appearance,
      lines: [],
    },
  };
};

describe("strop řádků konfiguračních tabulek", () => {
  test("[SEC-005] 501. šablona a 501. pravidelná faktura se neuloží", () => {
    const owner = seedOwner(db, NOW);
    saveTemplate(webActor(owner), templateInput(owner));
    const template = db
      .select()
      .from(invoiceTemplate)
      .where(eq(invoiceTemplate.userId, owner))
      .get()!;
    db.insert(invoiceTemplate)
      .values(
        Array.from({ length: ACCOUNT_ROW_LIMITS.invoice_template - 1 }, () => ({
          ...template,
          id: randomUUID(),
        })),
      )
      .run();
    expect(() => saveTemplate(webActor(owner), templateInput(owner))).toThrow(
      L.tooMany(L.names.invoice_template, ACCOUNT_ROW_LIMITS.invoice_template),
    );

    savePlan(owner, null);
    const plan = db
      .select()
      .from(recurringInvoice)
      .where(eq(recurringInvoice.userId, owner))
      .get()!;
    for (let start = 1; start < ACCOUNT_ROW_LIMITS.recurring_invoice; start += 100) {
      const count = Math.min(100, ACCOUNT_ROW_LIMITS.recurring_invoice - start);
      db.insert(recurringInvoice)
        .values(Array.from({ length: count }, () => ({ ...plan, id: randomUUID() })))
        .run();
    }
    expect(() => savePlan(owner, null)).toThrow(
      L.tooMany(L.names.recurring_invoice, ACCOUNT_ROW_LIMITS.recurring_invoice),
    );
  });

  test("[SEC-005] 501. jednotka a 51. nástěnka se nezaloží", () => {
    const owner = seedOwner(db, NOW);
    saveUnit(webActor(owner), "první");
    const existing = db.select().from(unit).where(eq(unit.userId, owner)).all().length;
    db.insert(unit)
      .values(
        Array.from({ length: ACCOUNT_ROW_LIMITS.unit - existing }, (_, index) => ({
          id: randomUUID(),
          userId: owner,
          name: `j${index}`,
          position: 100 + index,
          createdAt: NOW,
        })),
      )
      .run();
    expect(() => saveUnit(webActor(owner), "navíc")).toThrow(
      L.tooMany(L.names.unit, ACCOUNT_ROW_LIMITS.unit),
    );

    ensureDashboards(webActor(owner));
    const first = db.select().from(dashboard).where(eq(dashboard.userId, owner)).get()!;
    const have = db.select().from(dashboard).where(eq(dashboard.userId, owner)).all().length;
    db.insert(dashboard)
      .values(
        Array.from({ length: ACCOUNT_ROW_LIMITS.dashboard - have }, (_, index) => ({
          ...first,
          id: randomUUID(),
          name: `N${index}`,
          isDefault: false,
        })),
      )
      .run();
    expect(() => createDashboard(webActor(owner), { name: "Další" })).toThrow(
      L.tooMany(L.names.dashboard, ACCOUNT_ROW_LIMITS.dashboard),
    );
  });
});

describe("doklad z formuláře jde vystavit i upravit", () => {
  test("[SEC-005] doklad těsně pod stropem formuláře s nejdelšími snapshoty projde až do verze", () => {
    const owner = seedOwner(db, NOW);
    const customerId = seedCustomer(owner);
    // A control character takes six bytes of JSON; the form lets every field be full of them.
    const filled = (length: number) => `a${"\u0001".repeat(length - 2)}a`;
    db.update(supplier)
      .set({
        name: filled(200),
        street: filled(200),
        city: filled(100),
        country: filled(100),
        web: filled(200),
        registryNote: filled(500),
        contactPerson: filled(200),
        footerText: filled(1000),
        notVatPayerCs: filled(300),
        notVatPayerEn: filled(300),
        advanceNoteCs: filled(300),
        advanceNoteEn: filled(300),
      })
      .where(eq(supplier.userId, owner))
      .run();
    db.update(customer)
      .set({ name: filled(200), street: filled(200), city: filled(100), country: filled(60) })
      .where(eq(customer.id, customerId))
      .run();
    const line = (index: number, size: number) => ({
      catalogItemId: null,
      name: `${index}`,
      description: filled(size),
      quantityMilli: 1000,
      unit: "ks",
      unitPriceMinor: 100,
      discountKind: "none" as const,
      discountValue: 0,
    });
    // The most lines the form allows, each as long as the cap leaves room for.
    let size = 1;
    const linesOf = (length: number) =>
      Array.from({ length: 500 }, (_, index) => line(index, length));
    while (jsonBytes({ lines: linesOf(size + 1) }) < DOCUMENT_INPUT_BYTES - 1_000) size += 1;
    const lines = linesOf(size);
    const { id, revision } = draftFor(owner, customerId, { lines });
    issueInvoice(webActor(owner), id, { revision });
    const doc = getInvoice(owner, id)!;
    const { lines: stored, ...fields } = doc;
    updateIssuedInvoice(webActor(owner), id, {
      revision: doc.revision,
      number: doc.number!,
      variableSymbol: doc.variableSymbol ?? "",
      bankAccountId: fields.bankAccountId,
      issueDate: fields.issueDate,
      dueDate: fields.dueDate,
      taxableDate: fields.taxableDate,
      language: fields.language,
      currency: fields.currency,
      exchangeRateMicros: fields.exchangeRateMicros,
      paymentMethod: fields.paymentMethod,
      orderRef: fields.orderRef,
      reference: fields.reference,
      textBefore: fields.textBefore,
      textAfter: fields.textAfter,
      note: "Upraveno",
      discountKind: fields.discountKind,
      discountValue: fields.discountValue,
      rounding: fields.rounding,
      appearance: fields.appearance,
      lines: stored.map((item) => ({
        catalogItemId: item.catalogItemId,
        name: item.name,
        description: item.description,
        quantityMilli: item.quantityMilli,
        unit: item.unit,
        unitPriceMinor: item.unitPriceMinor,
        discountKind: item.discountKind,
        discountValue: item.discountValue,
      })),
    });
    const version = db.select().from(invoiceVersion).where(eq(invoiceVersion.invoiceId, id)).get()!;
    // The frozen version is larger than the cap of ordinary JSON, so it needs its own.
    expect(jsonBytes(version.document)).toBeGreaterThan(STORED_JSON_BYTES);
  });
});

describe("plány bez dokumentu", () => {
  test("[SEC-005] hodinové plánování a předpověď čtou dokument jen po jednom plánu", () => {
    const owner = seedOwner(db, NOW);
    const customerId = seedCustomer(owner);
    for (let index = 0; index < 3; index++) savePlan(owner, customerId);
    const statements = vi.spyOn(db.$client, "prepare");
    planRecurringRuns(NOW);
    forecast(db, owner, "2026-03-20");
    const texts = statements.mock.calls.map(([text]) => String(text));
    statements.mockRestore();
    const whole = texts.filter(
      (text) =>
        /from "recurring_invoice"/i.test(text) &&
        text.includes('"document"') &&
        !/"recurring_invoice"\."id" = \?|"id" = \?/.test(text),
    );
    expect(texts.some((text) => /from "recurring_invoice"/i.test(text))).toBe(true);
    expect(whole).toEqual([]);
  });
});

describe("obnovení verze dokladu", () => {
  test("[SEC-005] verze nad strop položek nebo bajtů formuláře se neobnoví", () => {
    const owner = seedOwner(db, NOW);
    const customerId = seedCustomer(owner);
    const { id, revision } = draftFor(owner, customerId);
    issueInvoice(webActor(owner), id, { revision });
    const doc = getInvoice(owner, id)!;
    const { lines: stored, ...fields } = doc;
    updateIssuedInvoice(webActor(owner), id, {
      revision: doc.revision,
      number: doc.number!,
      variableSymbol: doc.variableSymbol ?? "",
      bankAccountId: fields.bankAccountId,
      issueDate: fields.issueDate,
      dueDate: fields.dueDate,
      taxableDate: fields.taxableDate,
      language: fields.language,
      currency: fields.currency,
      exchangeRateMicros: fields.exchangeRateMicros,
      paymentMethod: fields.paymentMethod,
      orderRef: fields.orderRef,
      reference: fields.reference,
      textBefore: fields.textBefore,
      textAfter: fields.textAfter,
      note: "Jiná poznámka",
      discountKind: fields.discountKind,
      discountValue: fields.discountValue,
      rounding: fields.rounding,
      appearance: fields.appearance,
      lines: stored.map((item) => ({
        catalogItemId: item.catalogItemId,
        name: item.name,
        description: item.description,
        quantityMilli: item.quantityMilli,
        unit: item.unit,
        unitPriceMinor: item.unitPriceMinor,
        discountKind: item.discountKind,
        discountValue: item.discountValue,
      })),
    });
    const version = db.select().from(invoiceVersion).where(eq(invoiceVersion.invoiceId, id)).get()!;
    const line = version.document.lines[0]!;
    const set = (document: typeof version.document) =>
      db.update(invoiceVersion).set({ document }).where(eq(invoiceVersion.id, version.id)).run();
    set({ ...version.document, lines: Array.from({ length: 501 }, () => line) });
    expect(() => restoreVersion(webActor(owner), version.id)).toThrow(
      TEXTS.invoices.validation.tooManyLines,
    );
    set({
      ...version.document,
      lines: [{ ...line, description: "x".repeat(DOCUMENT_INPUT_BYTES) }],
    });
    expect(() => restoreVersion(webActor(owner), version.id)).toThrow(
      TEXTS.invoices.validation.documentTooLarge,
    );
  });
});
