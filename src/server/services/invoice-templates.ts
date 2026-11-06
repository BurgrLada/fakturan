import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { addDays, daysBetween, INVOICE_TYPES } from "@/lib/invoice";
import type { TemplateDocument } from "@/lib/invoice-template";
import type { CalendarDate } from "@/lib/number-format";
import { validateVariables } from "@/lib/template-vars";
import { TEXTS } from "@/lib/texts";
import type { Actor } from "../audit/context";
import { clock } from "../clock";
import { db } from "../db";
import { czech } from "../db/collation";
import { catalogItem, customer, invoiceTemplate } from "../db/schema";
import { scoped } from "../db/scoped";
import { assertRowLimit } from "./account-limits";
import { ServiceError, type Reader } from "./access";
import { defaultAccountFor, listBankAccounts } from "./bank-accounts";
import {
  assertReferencesOwned,
  checkDiscount,
  assertStoredDocument,
  checkDocumentSize,
  checkPriceSign,
  documentFields,
  findOwned,
  linesOf,
  newDraftDefaults,
  ownerOf,
  saveDraft,
  withoutStrayDiscount,
  type DraftInput,
} from "./invoices";
import { mutate } from "./mutation";
import { defaultSeriesFor, ensureDefaultSeries } from "./number-series";
import { getPreferences } from "./preferences";

const V = TEXTS.invoices.templates.validation;
const MAX_NAME = 100;
const MAX_DUE_DAYS = 365;

export type InvoiceTemplate = typeof invoiceTemplate.$inferSelect;
export type TemplateRow = Omit<InvoiceTemplate, "document" | "userId"> & {
  customerName: string | null;
  lineCount: number;
};

const {
  bankAccountId,
  language,
  currency,
  paymentMethod,
  orderRef,
  reference,
  textBefore,
  textAfter,
  note,
  discountKind,
  discountValue,
  rounding,
  appearance,
  foreign,
  clause,
  lines,
} = documentFields;

export const templateDocumentSchema = z
  .object({
    type: z.enum(INVOICE_TYPES, TEXTS.invoices.validation.type),
    bankAccountId,
    dueDays: z.number(V.dueDays).int(V.dueDays).min(0, V.dueDays).max(MAX_DUE_DAYS, V.dueDays),
    language,
    currency,
    paymentMethod,
    orderRef,
    reference,
    textBefore,
    textAfter,
    note,
    discountKind,
    discountValue,
    rounding,
    appearance,
    foreign,
    clause,
    lines,
  })
  .superRefine(checkDiscount)
  .superRefine(checkPriceSign)
  .superRefine(checkDocumentSize)
  .refine((value) => value.type !== "credit_note", TEXTS.invoices.validation.creditNoteCopy)
  .transform(withoutStrayDiscount);

export const templateInputSchema = z.object({
  id: z.string(V.invalid).min(1, V.invalid).optional(),
  name: z.string(V.invalid).trim().min(1, V.name).max(MAX_NAME, V.tooLong),
  customerId: z.string(V.invalid).min(1, V.invalid).nullable(),
  document: templateDocumentSchema,
});

export type TemplateInput = z.input<typeof templateInputSchema>;

function variableTexts(document: TemplateDocument): string[] {
  return [
    document.orderRef,
    document.reference,
    document.textBefore,
    document.textAfter,
    document.note,
    ...document.lines.flatMap((line) => [line.name, line.description]),
  ];
}

// A template is rendered later, when the period and number are known, so a typo must not slip in.
export function assertKnownVariables(document: TemplateDocument): void {
  const unknown = [...new Set(variableTexts(document).flatMap((text) => validateVariables(text)))];
  if (unknown.length > 0) throw new ServiceError(V.unknownVariable(unknown));
}

function readTemplate(q: Reader, ownerId: string, id: string): InvoiceTemplate | null {
  return (
    q
      .select()
      .from(invoiceTemplate)
      .where(scoped(ownerId).where(invoiceTemplate, (t, { eq }) => eq(t.id, id)))
      .get() ?? null
  );
}

export function getTemplate(ownerId: string, id: string): InvoiceTemplate | null {
  return readTemplate(db, ownerId, id);
}

// Without the documents: a list never needs them, and each may take up to STORED_JSON_BYTES.
export function listTemplates(ownerId: string): TemplateRow[] {
  return db
    .select({
      id: invoiceTemplate.id,
      name: invoiceTemplate.name,
      customerId: invoiceTemplate.customerId,
      createdAt: invoiceTemplate.createdAt,
      updatedAt: invoiceTemplate.updatedAt,
      lineCount: sql<number>`coalesce(json_array_length(${invoiceTemplate.document}, '$.lines'), 0)`,
      customerName: customer.name,
    })
    .from(invoiceTemplate)
    .leftJoin(customer, eq(customer.id, invoiceTemplate.customerId))
    .where(scoped(ownerId).where(invoiceTemplate))
    .orderBy(asc(czech(invoiceTemplate.name)), asc(invoiceTemplate.id))
    .all();
}

function persist(
  actor: Actor,
  action: "invoice_template.save" | "invoice_template.from_invoice",
  raw: TemplateInput,
): { id: string } {
  const userId = ownerOf(actor);
  const parsed = templateInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ServiceError(parsed.error.issues[0]?.message ?? V.invalid);
  }
  const { id: existingId, name, customerId, document } = parsed.data;
  assertKnownVariables(document);
  assertStoredDocument(document);

  return mutate(actor, action, (tx, audit) => {
    const before = existingId ? readTemplate(tx, userId, existingId) : null;
    if (existingId && !before) throw new ServiceError(V.notFound);
    assertReferencesOwned(tx, userId, {
      customerId,
      bankAccountId: document.bankAccountId,
      seriesId: null,
      lines: document.lines,
    });
    const id = before?.id ?? randomUUID();
    const now = clock.now();
    if (before) {
      tx.update(invoiceTemplate)
        .set({ name, customerId, document, updatedAt: now })
        .where(and(eq(invoiceTemplate.id, id), eq(invoiceTemplate.userId, userId)))
        .run();
    } else {
      assertRowLimit(tx, "invoice_template", invoiceTemplate, userId);
      tx.insert(invoiceTemplate)
        .values({ id, userId, name, customerId, document, createdAt: now, updatedAt: now })
        .run();
    }
    audit({
      entity: "invoice_template",
      entityId: id,
      ownerId: userId,
      scope: "user",
      before: before && {
        name: before.name,
        customerId: before.customerId,
        document: before.document,
      },
      after: { name, customerId, document },
    });
    return { id };
  });
}

export function saveTemplate(actor: Actor, raw: TemplateInput): { id: string } {
  return persist(actor, "invoice_template.save", raw);
}

export function deleteTemplate(actor: Actor, id: string): void {
  const userId = ownerOf(actor);
  mutate(actor, "invoice_template.delete", (tx, audit) => {
    const row = readTemplate(tx, userId, id);
    if (!row) throw new ServiceError(V.notFound);
    tx.delete(invoiceTemplate)
      .where(and(eq(invoiceTemplate.id, id), eq(invoiceTemplate.userId, userId)))
      .run();
    audit({
      entity: "invoice_template",
      entityId: id,
      ownerId: userId,
      scope: "user",
      before: { name: row.name, customerId: row.customerId, document: row.document },
    });
  });
}

export function templateFromInvoice(actor: Actor, invoiceId: string, name: string): { id: string } {
  const userId = ownerOf(actor);
  const source = findOwned(db, userId, invoiceId);
  if (source.type === "credit_note")
    throw new ServiceError(TEXTS.invoices.validation.creditNoteCopy);
  const sourceLines = linesOf(db, userId, invoiceId);
  const dueDays =
    source.issueDate && source.dueDate
      ? Math.min(MAX_DUE_DAYS, Math.max(0, daysBetween(source.issueDate, source.dueDate)))
      : getPreferences(userId).dueDays;
  return persist(actor, "invoice_template.from_invoice", {
    name,
    customerId: source.customerId,
    document: {
      type: source.type,
      bankAccountId: source.bankAccountId,
      dueDays,
      language: source.language,
      currency: source.currency,
      paymentMethod: source.paymentMethod,
      orderRef: source.orderRef,
      reference: source.reference,
      textBefore: source.textBefore,
      textAfter: source.textAfter,
      note: source.note,
      discountKind: source.discountKind,
      discountValue: source.discountValue,
      rounding: source.rounding,
      appearance: source.appearance,
      foreign: source.foreign,
      clause: source.clause,
      lines: sourceLines.map((line) => ({
        catalogItemId: line.catalogItemId,
        name: line.name,
        description: line.description,
        quantityMilli: line.quantityMilli,
        unit: line.unit,
        unitPriceMinor: line.unitPriceMinor,
        discountKind: line.discountKind,
        discountValue: line.discountValue,
      })),
    },
  });
}

function usableCustomerId(ownerId: string, customerId: string | null): string | null {
  if (!customerId) return null;
  const row = db
    .select({ archivedAt: customer.archivedAt })
    .from(customer)
    .where(scoped(ownerId).where(customer, (t, { eq }) => eq(t.id, customerId)))
    .get();
  return row && !row.archivedAt ? customerId : null;
}

function usableAccountId(ownerId: string, document: TemplateDocument): string | null {
  const wanted = document.bankAccountId;
  if (wanted) {
    const kept = listBankAccounts(ownerId).find(
      (account) => account.id === wanted && !account.hidden,
    );
    if (kept) return kept.id;
  }
  return defaultAccountFor(ownerId, document.currency)?.id ?? null;
}

function existingCatalogIds(ownerId: string, document: TemplateDocument): Set<string> {
  const ids = [...new Set(document.lines.flatMap((line) => line.catalogItemId ?? []))];
  if (ids.length === 0) return new Set();
  return new Set(
    db
      .select({ id: catalogItem.id })
      .from(catalogItem)
      .where(scoped(ownerId).where(catalogItem, (t) => inArray(t.id, ids)))
      .all()
      .map((row) => row.id),
  );
}

// `issueDate` is left out for "as of today"; a recurring plan passes the date of its occurrence.
export function draftInputFromDocument(
  ownerId: string,
  document: TemplateDocument,
  customerId: string | null,
  dates: { issueDate?: CalendarDate },
): DraftInput {
  const base = newDraftDefaults(ownerId, usableCustomerId(ownerId, customerId), document.type);
  const issueDate = dates.issueDate ?? base.issueDate;
  const items = existingCatalogIds(ownerId, document);
  return {
    ...base,
    type: document.type,
    seriesId: defaultSeriesFor(ownerId, document.type)?.id ?? null,
    bankAccountId: usableAccountId(ownerId, document),
    issueDate,
    dueDate: issueDate ? addDays(issueDate, document.dueDays) : null,
    language: document.language,
    currency: document.currency,
    paymentMethod: document.paymentMethod,
    orderRef: document.orderRef,
    reference: document.reference,
    textBefore: document.textBefore,
    textAfter: document.textAfter,
    note: document.note,
    discountKind: document.discountKind,
    discountValue: document.discountValue,
    rounding: document.rounding,
    appearance: document.appearance,
    foreign: document.foreign ?? false,
    clause: document.clause ?? "",
    lines: document.lines.map((line) => ({
      ...line,
      catalogItemId:
        line.catalogItemId && items.has(line.catalogItemId) ? line.catalogItemId : null,
    })),
  };
}

export function draftFromTemplate(actor: Actor, templateId: string): { id: string } {
  const userId = ownerOf(actor);
  const template = readTemplate(db, userId, templateId);
  if (!template) throw new ServiceError(V.notFound);
  ensureDefaultSeries(actor);
  return saveDraft(
    actor,
    {
      ...draftInputFromDocument(userId, template.document, template.customerId, {}),
      clientId: randomUUID(),
    },
    { fromTemplate: { id: template.id, name: template.name } },
  );
}
