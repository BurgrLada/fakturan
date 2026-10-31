import "server-only";
import { desc, inArray } from "drizzle-orm";
import { addDays, appearanceFrom, INVOICE_STATUSES, type Appearance } from "@/lib/invoice";
import type { InvoiceDocument } from "@/lib/invoice-document";
import { calendarDateInPrague } from "@/lib/number-format";
import { clock } from "../clock";
import { db } from "../db";
import { invoice } from "../db/schema";
import { scoped } from "../db/scoped";
import { LABELS } from "../pdf/labels";
import { renderInvoicePdf } from "../pdf/render";
import { buildInvoiceView } from "../pdf/view";
import { defaultAccountFor } from "./bank-accounts";
import { currentParties, loadInvoiceDocument } from "./invoice-document";
import { ownerImageReader } from "./invoice-pdf";
import { getPreferences } from "./preferences";

const PREVIEW_STATUSES = INVOICE_STATUSES.filter(
  (status) => status !== "draft" && status !== "cancelled" && status !== "credited",
);
const SAMPLE_NUMBER = "2026-001";
const SAMPLE_VARIABLE_SYMBOL = "2026001";

export type PreviewAppearance = Partial<Pick<Appearance, "designId" | "colors" | "logoPosition">>;

export function samplePreviewDocument(ownerId: string): InvoiceDocument {
  const prefs = getPreferences(ownerId);
  const sample = LABELS[prefs.language].sample;
  const account = defaultAccountFor(ownerId, prefs.currency);
  const { snapshot, images } = currentParties(db, ownerId, {
    customerId: null,
    bankAccountId: account?.id ?? null,
  });
  const today = calendarDateInPrague(clock.now());
  const line = {
    catalogItemId: null,
    discountKind: "none",
    discountValue: 0,
  } as const;
  const lines = [
    {
      ...line,
      name: sample.lineName,
      description: sample.lineDescription,
      quantityMilli: 2000,
      unit: prefs.unit,
      unitPriceMinor: 150_000,
      netMinor: 300_000,
    },
    {
      ...line,
      name: sample.secondLineName,
      description: "",
      quantityMilli: 1000,
      unit: prefs.unit,
      unitPriceMinor: 90_000,
      netMinor: 90_000,
    },
  ];
  const totalMinor = lines.reduce((sum, row) => sum + row.netMinor, 0);
  return {
    id: "preview",
    type: "invoice",
    status: "issued",
    number: SAMPLE_NUMBER,
    variableSymbol: SAMPLE_VARIABLE_SYMBOL,
    variableSymbolManual: false,
    seriesId: null,
    customerId: null,
    customerName: sample.customer,
    bankAccountId: account?.id ?? null,
    issueDate: today,
    dueDate: addDays(today, prefs.dueDays),
    taxableDate: today,
    language: prefs.language,
    currency: prefs.currency,
    exchangeRateMicros: null,
    paymentMethod: prefs.paymentMethod,
    orderRef: "",
    reference: "",
    textBefore: prefs.textBefore,
    textAfter: prefs.textAfter,
    note: prefs.note,
    discountKind: "none",
    discountValue: 0,
    rounding: "none",
    dateFormat: prefs.dateFormat,
    periodFrom: null,
    periodTo: null,
    appearance: appearanceFrom(prefs),
    lines,
    snapshot: {
      ...snapshot,
      customer: {
        name: sample.customer,
        street: sample.street,
        city: sample.city,
        zip: sample.zip,
        country: sample.country,
        ico: "",
        dic: "",
        email: "",
        phone: "",
      },
    },
    images,
    totals: {
      subtotalMinor: totalMinor,
      discountMinor: 0,
      roundingMinor: 0,
      totalMinor,
      paidMinor: 0,
    },
  };
}

function lastIssuedDocument(ownerId: string): InvoiceDocument | null {
  const row = db
    .select({ id: invoice.id })
    .from(invoice)
    .where(scoped(ownerId).where(invoice, (t) => inArray(t.status, PREVIEW_STATUSES)))
    .orderBy(desc(invoice.issuedAt))
    .get();
  return row ? loadInvoiceDocument(ownerId, row.id) : null;
}

export async function designPreviewPdf(
  ownerId: string,
  appearance: PreviewAppearance,
): Promise<Buffer> {
  const doc = lastIssuedDocument(ownerId) ?? samplePreviewDocument(ownerId);
  const view = await buildInvoiceView(
    { ...doc, appearance: { ...doc.appearance, ...appearance } },
    {
      today: calendarDateInPrague(clock.now()),
      draft: false,
      readImage: ownerImageReader(ownerId),
    },
  );
  return renderInvoicePdf(view);
}
