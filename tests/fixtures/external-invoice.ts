import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Currency } from "@/lib/currency";
import { appearanceFrom, type InvoiceType } from "@/lib/invoice";
import type { CalendarDate } from "@/lib/number-format";
import { clock } from "@/server/clock";
import type { Db } from "@/server/db";
import { importBatch, invoice, invoiceLine } from "@/server/db/schema";
import { refreshBalance } from "@/server/services/invoice-balance";
import { mutate } from "@/server/services/mutation";
import { insertImportedPayment } from "@/server/services/payments";
import { getPreferences } from "@/server/services/preferences";

export const importActor = (userId: string) => ({ userId, source: "import" as const });

export const EXTERNAL_SUPPLIER = {
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

export const EXTERNAL_CUSTOMER = {
  name: "Beta s.r.o.",
  street: "Nová 3",
  city: "Ostrava",
  zip: "702 00",
  country: "Česká republika",
  ico: "",
  dic: "",
  email: "beta@example.cz",
  phone: "",
};

export const EXTERNAL_ACCOUNT = {
  name: "Účet",
  currency: "CZK" as const,
  number: "19-2000145399",
  bankCode: "0800",
  iban: "",
  swift: "",
};

export type ExternalOptions = {
  type?: InvoiceType;
  number?: string;
  totalMinor?: number;
  currency?: Currency;
  exchangeRateMicros?: number | null;
  issueDate?: CalendarDate;
  dueDate?: CalendarDate;
  customerId?: string | null;
  variableSymbol?: string | null;
  relatedInvoiceId?: string;
  batchId?: string;
  importUuid?: string | null;
  transfer?: boolean;
  // Paid as an import records it: an estimated day, nothing that could start an automation.
  paid?: "none" | "full" | "partial";
};

export function seedImportBatch(db: Db, owner: string): string {
  const id = randomUUID();
  const now = clock.now();
  db.insert(importBatch)
    .values({
      id,
      userId: owner,
      kind: "isdoc",
      status: "done",
      createdAt: now,
      updatedAt: now,
      committedAt: now,
    })
    .run();
  return id;
}

// Written straight to the table on purpose: an import keeps its own number and never touches a
// series counter (IMP-004).
export function externalInvoice(db: Db, owner: string, opts: ExternalOptions = {}): string {
  const id = randomUUID();
  const type = opts.type ?? "invoice";
  const currency = opts.currency ?? "CZK";
  const sign = type === "credit_note" ? -1 : 1;
  const totalMinor = sign * Math.abs(opts.totalMinor ?? 1_210_000);
  const issueDate = opts.issueDate ?? "2026-01-15";
  const dueDate = opts.dueDate ?? "2026-01-29";
  const related = opts.relatedInvoiceId
    ? db.select().from(invoice).where(eq(invoice.id, opts.relatedInvoiceId)).get()!
    : null;
  const foreign = currency !== "CZK";
  const rate = foreign ? (opts.exchangeRateMicros ?? null) : null;
  const now = clock.now();
  mutate(importActor(owner), "import.commit", (tx, audit) => {
    tx.insert(invoice)
      .values({
        id,
        userId: owner,
        type,
        status: "issued",
        number: opts.number ?? `IMP-${id.slice(0, 8)}`,
        variableSymbol:
          type === "credit_note"
            ? null
            : (opts.variableSymbol ?? `9${id.replace(/\D/g, "").slice(0, 8)}`),
        variableSymbolManual: true,
        customerId: opts.customerId ?? null,
        customerName: EXTERNAL_CUSTOMER.name,
        issueDate,
        dueDate,
        language: "cs",
        currency,
        exchangeRateMicros: rate,
        exchangeRateSource: foreign ? "import" : null,
        exchangeRateDate: foreign && rate !== null ? issueDate : null,
        paymentMethod: opts.transfer ? "transfer" : "cash",
        accountSnapshot: opts.transfer ? EXTERNAL_ACCOUNT : null,
        subtotalMinor: totalMinor,
        totalMinor,
        appearance: appearanceFrom(getPreferences(owner)),
        supplierSnapshot: EXTERNAL_SUPPLIER,
        customerSnapshot: EXTERNAL_CUSTOMER,
        dateFormat: "d. M. yyyy",
        relatedInvoiceId: related?.id ?? null,
        relatedSnapshot: related
          ? { type: related.type, number: related.number!, issueDate: related.issueDate! }
          : null,
        external: true,
        importBatchId: opts.batchId ?? seedImportBatch(db, owner),
        importUuid: opts.importUuid === undefined ? randomUUID() : opts.importUuid,
        sourceSystem: "Fakturovač",
        searchText: EXTERNAL_CUSTOMER.name.toLowerCase(),
        revision: 1,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    tx.insert(invoiceLine)
      .values({
        id: randomUUID(),
        invoiceId: id,
        userId: owner,
        position: 0,
        name: "Služby",
        quantityMilli: 1000,
        unit: "ks",
        unitPriceMinor: totalMinor,
        netMinor: totalMinor,
      })
      .run();
    audit({
      entity: "invoice",
      entityId: id,
      ownerId: owner,
      scope: "user",
      after: { type, totalMinor, currency, external: true },
    });
    if (related) refreshBalance(tx, audit, owner, related.id);
    const paid = opts.paid ?? "none";
    if (paid !== "none" && type !== "credit_note") {
      insertImportedPayment(tx, audit, {
        userId: owner,
        invoiceId: id,
        paidOn: dueDate,
        amountMinor: paid === "full" ? totalMinor : Math.floor(totalMinor / 2),
        rateMicros: rate,
        dateEstimated: true,
      });
    }
  });
  return id;
}
