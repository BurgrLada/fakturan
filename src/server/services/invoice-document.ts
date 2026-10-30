import "server-only";
import type {
  AccountSnapshot,
  CustomerSnapshot,
  DocumentImages,
  InvoiceDocument,
  InvoiceSnapshot,
  SupplierSnapshot,
} from "@/lib/invoice-document";
import { invoiceDocument } from "@/lib/invoice-document";
import { calendarDateInPrague, type CalendarDate } from "@/lib/number-format";
import type { Language } from "@/lib/preferences";
import { monthPeriod, renderVariables, type VariableContext } from "@/lib/template-vars";
import { clock } from "../clock";
import { db } from "../db";
import { bankAccount, customer, supplier } from "../db/schema";
import { scoped } from "../db/scoped";
import type { Reader } from "./access";
import { getInvoice, type Invoice, type InvoiceLine } from "./invoices";
import { getPreferences } from "./preferences";

export type CurrentParties = { snapshot: InvoiceSnapshot; images: DocumentImages };

function supplierSnapshotOf(row: typeof supplier.$inferSelect): SupplierSnapshot {
  return {
    name: row.name,
    street: row.street,
    city: row.city,
    zip: row.zip,
    country: row.country,
    ico: row.ico,
    dic: row.dic,
    email: row.email,
    phone: row.phone,
    web: row.web,
    registryNote: row.registryNote,
    contactPerson: row.contactPerson,
    vatIdentified: row.vatIdentified,
    footerText: row.footerText,
    notVatPayerCs: row.notVatPayerCs,
    notVatPayerEn: row.notVatPayerEn,
  };
}

function customerSnapshotOf(row: typeof customer.$inferSelect): CustomerSnapshot {
  return {
    name: row.name,
    street: row.street,
    city: row.city,
    zip: row.zip,
    country: row.country,
    ico: row.ico,
    dic: row.dic,
    email: row.email,
    phone: row.phone,
  };
}

function accountSnapshotOf(row: typeof bankAccount.$inferSelect): AccountSnapshot {
  return {
    name: row.name,
    currency: row.currency,
    number: row.number,
    bankCode: row.bankCode,
    iban: row.iban,
    swift: row.swift,
  };
}

export function currentParties(
  q: Reader,
  ownerId: string,
  row: Pick<Invoice, "customerId" | "bankAccountId">,
): CurrentParties {
  const { customerId, bankAccountId } = row;
  const profile = q.select().from(supplier).where(scoped(ownerId).where(supplier)).get();
  const client = customerId
    ? q
        .select()
        .from(customer)
        .where(scoped(ownerId).where(customer, (t, { eq }) => eq(t.id, customerId)))
        .get()
    : undefined;
  const account = bankAccountId
    ? q
        .select()
        .from(bankAccount)
        .where(scoped(ownerId).where(bankAccount, (t, { eq }) => eq(t.id, bankAccountId)))
        .get()
    : undefined;
  return {
    snapshot: {
      supplier: profile ? supplierSnapshotOf(profile) : null,
      customer: client ? customerSnapshotOf(client) : null,
      account: account ? accountSnapshotOf(account) : null,
    },
    images: {
      logoFileId: profile?.logoFileId ?? null,
      qrLogoFileId: profile?.qrLogoFileId ?? null,
      signatureFileId: profile?.signatureFileId ?? null,
    },
  };
}

export function variablesFor(
  ownerId: string,
  row: { issueDate: CalendarDate | null; language: Language },
  number: string,
  customerName: string,
): VariableContext {
  return {
    period: monthPeriod(row.issueDate ?? calendarDateInPrague(clock.now())),
    language: row.language,
    dateFormat: getPreferences(ownerId).dateFormat,
    number,
    customer: customerName,
  };
}

export function renderDocumentTexts<L extends Pick<InvoiceLine, "name" | "description">>(
  row: Pick<Invoice, "textBefore" | "textAfter" | "note">,
  lines: L[],
  ctx: VariableContext,
) {
  return {
    textBefore: renderVariables(row.textBefore, ctx),
    textAfter: renderVariables(row.textAfter, ctx),
    note: renderVariables(row.note, ctx),
    lines: lines.map((line) => ({
      ...line,
      name: renderVariables(line.name, ctx),
      description: renderVariables(line.description, ctx),
    })),
  };
}

// A draft has no snapshots yet, so it shows what issuing it now would store.
export function loadInvoiceDocument(ownerId: string, id: string): InvoiceDocument | null {
  const row = getInvoice(ownerId, id);
  if (!row) return null;
  const document = invoiceDocument(row);
  if (row.status !== "draft") return document;

  const { snapshot, images } = currentParties(db, ownerId, row);
  const customerName = snapshot.customer?.name ?? row.customerName;
  const ctx = variablesFor(ownerId, row, "", customerName);
  const texts = renderDocumentTexts(row, document.lines, ctx);
  return { ...document, ...texts, dateFormat: ctx.dateFormat, customerName, snapshot, images };
}
