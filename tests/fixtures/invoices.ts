import { randomUUID } from "node:crypto";
import type { InvoiceStatus } from "@/lib/invoice";
import type { DocumentLine, InvoiceDocument } from "@/lib/invoice-document";
import { deriveStatus } from "@/lib/payments";
import type { Db } from "@/server/db";

export const FIXTURE_LOGO_ID = "fixture-logo";

export const FIXTURE_LOGO_SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="80" viewBox="0 0 240 80">' +
    '<rect width="240" height="80" rx="12" fill="#14532d"/>' +
    '<circle cx="40" cy="40" r="22" fill="#bbf7d0"/></svg>',
);

export const fixtureLine = (over: Partial<DocumentLine> = {}): DocumentLine => ({
  catalogItemId: null,
  name: "Konzultace",
  description: "Návrh řešení a příprava podkladů",
  quantityMilli: 2000,
  unit: "hod.",
  unitPriceMinor: 150_000,
  discountKind: "none",
  discountValue: 0,
  netMinor: 300_000,
  ...over,
});

const short: InvoiceDocument = {
  id: "fixture-short",
  type: "invoice",
  status: "issued",
  number: "2026-001",
  variableSymbol: "2026001",
  variableSymbolManual: false,
  seriesId: null,
  customerId: null,
  customerName: "Příliš žluťoučký kůň s.r.o.",
  bankAccountId: null,
  issueDate: "2026-03-10",
  dueDate: "2026-03-24",
  taxableDate: "2026-03-09",
  language: "cs",
  currency: "CZK",
  exchangeRateMicros: null,
  paymentMethod: "transfer",
  orderRef: "OBJ-77",
  reference: "Zakázka Vltava",
  textBefore: "Fakturujeme Vám za dodané služby.",
  textAfter: "Děkujeme za spolupráci.",
  note: "Poznámka k dokladu",
  discountKind: "none",
  discountValue: 0,
  rounding: "none",
  dateFormat: "d. M. yyyy",
  periodFrom: null,
  periodTo: null,
  appearance: {
    designId: "cisty",
    colors: { accent: "", surface: "", text: "", line: "" },
    logoPosition: "left",
    showLogo: true,
    showQr: true,
    showQrLogo: false,
    showSignature: false,
    showDuzp: true,
  },
  lines: [fixtureLine()],
  snapshot: {
    supplier: {
      name: "Jan Novák",
      street: "Dlouhá 1",
      city: "Praha",
      zip: "110 00",
      country: "Česká republika",
      ico: "27082440",
      dic: "",
      email: "jan@example.cz",
      phone: "+420 777 123 456",
      web: "jannovak.example.cz",
      registryNote: "Zapsán v živnostenském rejstříku v Praze",
      contactPerson: "Jan Novák",
      vatIdentified: false,
      footerText: "",
      notVatPayerCs: "Nejsem plátce DPH.",
      notVatPayerEn: "I am not a VAT payer.",
    },
    customer: {
      name: "Příliš žluťoučký kůň s.r.o.",
      street: "Krátká 2",
      city: "Brno",
      zip: "602 00",
      country: "Česká republika",
      ico: "12345678",
      dic: "CZ12345678",
      email: "",
      phone: "",
    },
    account: {
      name: "Hlavní účet",
      currency: "CZK",
      number: "19-2000145399",
      bankCode: "0800",
      iban: "CZ6508000000192000145399",
      swift: "GIBACZPX",
    },
  },
  images: { logoFileId: FIXTURE_LOGO_ID, qrLogoFileId: null, signatureFileId: null },
  totals: {
    subtotalMinor: 300_000,
    discountMinor: 0,
    roundingMinor: 0,
    totalMinor: 300_000,
    paidMinor: 0,
  },
};

const long: InvoiceDocument = {
  ...short,
  id: "fixture-long",
  lines: Array.from({ length: 300 }, (_, index) =>
    fixtureLine({
      name: `Položka ${String(index + 1).padStart(3, "0")}`,
      description: "",
      quantityMilli: 1000,
      unitPriceMinor: 10_000,
      netMinor: 10_000,
    }),
  ),
  totals: { ...short.totals, subtotalMinor: 3_000_000, totalMinor: 3_000_000 },
};

const eur: InvoiceDocument = {
  ...short,
  id: "fixture-eur",
  currency: "EUR",
  exchangeRateMicros: 25_000_000,
  snapshot: {
    ...short.snapshot,
    account: {
      name: "Účet EUR",
      currency: "EUR",
      number: "",
      bankCode: "",
      iban: "DE89370400440532013000",
      swift: "COBADEFFXXX",
    },
  },
};

const english: InvoiceDocument = {
  ...short,
  id: "fixture-english",
  language: "en",
  dateFormat: "yyyy-MM-dd",
  textBefore: "We invoice you for the services delivered.",
  textAfter: "Thank you for your business.",
  note: "",
  lines: [fixtureLine({ name: "Consulting", description: "Solution design", unit: "h" })],
};

const noLogo: InvoiceDocument = {
  ...short,
  id: "fixture-no-logo",
  images: { logoFileId: null, qrLogoFileId: null, signatureFileId: null },
};

const longNames: InvoiceDocument = {
  ...short,
  id: "fixture-long-names",
  customerName: `Společnost ${"dlouhýnázev".repeat(12)}`,
  lines: [
    fixtureLine({
      name: `Služba ${"bezmezer".repeat(25)}`,
      description: `${"Velmi dlouhý popis položky s diakritikou. ".repeat(48)}Konec popisu.`,
    }),
    fixtureLine({ name: "Druhá položka", description: "w".repeat(200) }),
  ],
  snapshot: {
    ...short.snapshot,
    customer: {
      ...short.snapshot.customer!,
      name: `Společnost ${"dlouhýnázev".repeat(12)}`,
    },
  },
};

// Raw SQL, because the Docker PDF smoke test bundles this file. Like the direct writes it replaces,
// it keeps the revision, so a test's stored revision stays valid.
export function seedPayment(db: Db, invoiceId: string, creditedMinor: number): void {
  const client = db.$client;
  const row = client
    .prepare<
      [string],
      {
        user_id: string;
        status: string;
        sent_at: number | null;
        currency: string;
        total_minor: number;
      }
    >("SELECT user_id, status, sent_at, currency, total_minor FROM invoice WHERE id = ?")
    .get(invoiceId)!;
  client
    .prepare(
      `INSERT INTO payment (id, user_id, invoice_id, kind, paid_on, amount_minor, currency,
        credited_minor, method, source, created_at, updated_at)
       VALUES (?, ?, ?, 'payment', '2026-03-10', ?, ?, ?, 'transfer', 'manual', 0, 0)`,
    )
    .run(randomUUID(), row.user_id, invoiceId, creditedMinor, row.currency, creditedMinor);
  const paidMinor = client
    .prepare<[string], { paid: number }>(
      "SELECT sum(credited_minor) AS paid FROM payment WHERE invoice_id = ?",
    )
    .get(invoiceId)!.paid;
  const status = deriveStatus({
    status: row.status as InvoiceStatus,
    sentAt: row.sent_at === null ? null : new Date(row.sent_at),
    totalMinor: row.total_minor,
    paidMinor,
  });
  client
    .prepare("UPDATE invoice SET paid_minor = ?, status = ? WHERE id = ?")
    .run(paidMinor, status, invoiceId);
}

export const INVOICE_FIXTURES = { short, long, eur, english, noLogo, longNames };
