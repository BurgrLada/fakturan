import { eq } from "drizzle-orm";
import type { Currency } from "@/lib/currency";
import type { InvoiceType } from "@/lib/invoice";
import { setClockForTests } from "@/server/clock";
import type { Db } from "@/server/db";
import { exchangeRate, invoice } from "@/server/db/schema";
import { createCreditNote } from "@/server/services/credit-notes";
import { finalOf } from "@/server/services/invoice-balance";
import { cancelInvoice, issueInvoice } from "@/server/services/invoice-lifecycle";
import {
  getInvoice,
  newDraftDefaults,
  saveDraft,
  type DraftInput,
} from "@/server/services/invoices";
import { addPayment } from "@/server/services/payments";
import { saveCustomer } from "@/server/services/customers";
import { seedOwner, webActor } from "../helpers/fixtures-mail";

export const REPORT_TODAY = "2026-11-02";

// 14:00 UTC is past the 14:30 Prague publication in both seasons, so a payment day picks its own list.
export function at(date: string): void {
  const now = new Date(`${date}T14:00:00Z`);
  setClockForTests({ now: () => now });
}

export const line = (unitPriceMinor: number, name = "Konzultace") => ({
  catalogItemId: null,
  name,
  description: "",
  quantityMilli: 1000,
  unit: "ks",
  unitPriceMinor,
  discountKind: "none" as const,
  discountValue: 0,
});

export function reportOwner(db: Db, date = "2026-01-01"): string {
  at(date);
  return seedOwner(db, new Date(`${date}T14:00:00Z`));
}

export function namedCustomer(owner: string, name: string): string {
  return saveCustomer(webActor(owner), {
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
  }).id;
}

type DocumentSpec = {
  issueDate: string;
  dueDate?: string | null;
  totalMinor?: number;
  type?: InvoiceType;
  currency?: Currency;
  rateMicros?: number;
  over?: Partial<DraftInput>;
};

export function draftDocument(owner: string, customerId: string, spec: DocumentSpec): string {
  at(spec.issueDate);
  const defaults = newDraftDefaults(owner, customerId, spec.type ?? "invoice");
  const currency = spec.currency ?? "CZK";
  const foreign = currency !== "CZK";
  return saveDraft(webActor(owner), {
    ...defaults,
    issueDate: spec.issueDate,
    dueDate: spec.dueDate === undefined ? spec.issueDate : spec.dueDate,
    currency,
    exchangeRateMicros: spec.rateMicros ?? null,
    exchangeRateSource: spec.rateMicros ? "manual" : null,
    ...(foreign && { paymentMethod: "cash" as const, bankAccountId: null }),
    lines: [line(spec.totalMinor ?? 100_000)],
    ...spec.over,
  }).id;
}

export function issue(owner: string, id: string): string {
  issueInvoice(webActor(owner), id, { revision: getInvoice(owner, id)!.revision });
  return id;
}

export function issuedDocument(owner: string, customerId: string, spec: DocumentSpec): string {
  return issue(owner, draftDocument(owner, customerId, spec));
}

export function pay(
  owner: string,
  id: string,
  paidOn: string,
  amountMinor: number,
  currency: Currency = "CZK",
  today = paidOn,
): string {
  at(today);
  return addPayment(webActor(owner), id, {
    revision: getInvoice(owner, id)!.revision,
    paidOn,
    amountMinor,
    currency,
    method: "transfer",
    note: "",
  }).id;
}

export function creditNote(owner: string, id: string, date: string, totalMinor: number): string {
  at(date);
  const actor = webActor(owner);
  const { id: noteId } = createCreditNote(actor, id);
  const { lines: _lines, tags: _tags, ...doc } = getInvoice(owner, noteId)!;
  saveDraft(actor, {
    id: noteId,
    revision: doc.revision,
    type: doc.type,
    customerId: doc.customerId,
    seriesId: doc.seriesId,
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
    note: doc.note,
    discountKind: doc.discountKind,
    discountValue: doc.discountValue,
    rounding: doc.rounding,
    appearance: doc.appearance,
    lines: [line(totalMinor)],
  });
  return issue(owner, noteId);
}

export type ReportScenario = {
  owner: string;
  customers: { alfa: string; beta: string; gama: string };
  ids: Record<
    "a" | "b" | "bNote" | "cAdvance" | "cFinal" | "d" | "dDraft" | "e" | "f" | "g",
    string
  >;
};

// The amounts behind the expected numbers in tests/backend/reports.test.ts; the clock is left at
// REPORT_TODAY.
export function seedReportScenario(db: Db): ReportScenario {
  const owner = reportOwner(db);
  const alfa = namedCustomer(owner, "Alfa s.r.o.");
  const beta = namedCustomer(owner, "Beta GmbH");
  const gama = namedCustomer(owner, "Gama a.s.");

  const a = issuedDocument(owner, alfa, {
    issueDate: "2026-01-15",
    dueDate: "2026-01-29",
    totalMinor: 1_210_000,
  });
  pay(owner, a, "2026-02-01", 1_210_000);

  const b = issuedDocument(owner, beta, {
    issueDate: "2026-03-10",
    dueDate: "2026-03-24",
    totalMinor: 100_000,
    currency: "EUR",
    rateMicros: 25_000_000,
  });
  const bNote = creditNote(owner, b, "2026-04-02", -10_000);
  db.insert(exchangeRate)
    .values({
      currency: "EUR",
      listDate: "2026-04-10",
      rateMicros: 24_500_000,
      fetchedAt: new Date("2026-04-10T13:00:00Z"),
    })
    .onConflictDoNothing()
    .run();
  pay(owner, b, "2026-04-10", 90_000, "EUR");

  const cAdvance = issuedDocument(owner, gama, {
    type: "advance",
    issueDate: "2026-05-04",
    dueDate: "2026-05-18",
    totalMinor: 500_000,
  });
  // The default automation drafts the final invoice on the day the payment is recorded.
  pay(owner, cAdvance, "2026-05-11", 500_000, "CZK", "2026-05-12");
  const cFinal = issue(owner, finalOf(db, owner, cAdvance)!.id);

  const g = issuedDocument(owner, alfa, {
    issueDate: "2026-06-01",
    dueDate: "2026-06-15",
    totalMinor: 150_000,
  });
  pay(owner, g, "2026-06-10", 150_000);
  // No service imports documents yet, so the flag an import would set is written here.
  db.update(invoice).set({ external: true }).where(eq(invoice.id, g)).run();

  const d = issuedDocument(owner, gama, { issueDate: "2026-07-01", totalMinor: 777_700 });
  cancelInvoice(webActor(owner), d);
  const dDraft = draftDocument(owner, gama, { issueDate: "2026-07-01", totalMinor: 888_800 });

  const e = issuedDocument(owner, gama, {
    issueDate: "2026-09-01",
    dueDate: "2026-09-15",
    totalMinor: 300_000,
  });
  pay(owner, e, "2026-09-20", 100_000);

  const f = issuedDocument(owner, gama, {
    type: "advance",
    issueDate: "2026-10-01",
    dueDate: "2026-10-15",
    totalMinor: 200_000,
  });

  at(REPORT_TODAY);
  return {
    owner,
    customers: { alfa, beta, gama },
    ids: { a, b, bNote, cAdvance, cFinal, d, dDraft, e, f, g },
  };
}
