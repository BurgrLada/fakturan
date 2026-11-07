import fc from "fast-check";
import { describe, expect, test } from "vitest";
import type { InvoiceDocument } from "@/lib/invoice-document";
import { toCzkMinor } from "@/lib/fx";
import { computeTotals } from "@/lib/invoice-totals";
import { decimalToMinor } from "@/lib/safe-input/decimal";
import { amountDue } from "@/lib/qr-payload";
import { XML_LIMITS } from "@/lib/safe-input/limits";
import { parseXml } from "@/lib/safe-input/xml";
import { buildIsdoc } from "@/server/isdoc/build";
import { parseIsdoc } from "@/server/isdoc/parse";
import { isdocRules } from "@/server/isdoc/rules";
import { validateIsdoc } from "@/server/isdoc/validate";
import { fixtureLine, INVOICE_FIXTURES as F } from "../fixtures/invoices";

const encoder = new TextEncoder();

type DocumentSpec = {
  type: "invoice" | "advance" | "credit_note";
  currency: "CZK" | "EUR";
  rate: number;
  lines: { quantityMilli: number; unitPriceMinor: number }[];
  discount: number;
  rounding: "none" | "whole";
  paid: number;
  advance: number;
};

const documentArb = fc
  .record({
    type: fc.constantFrom("invoice" as const, "advance" as const, "credit_note" as const),
    currency: fc.constantFrom("CZK" as const, "EUR" as const),
    rate: fc.integer({ min: 1, max: 100_000_000 }).filter((r) => r !== 1_000_000),
    lines: fc.array(
      fc.record({
        quantityMilli: fc.integer({ min: 0, max: 100_000 }),
        unitPriceMinor: fc.integer({ min: 0, max: 5_000_000 }),
      }),
      { minLength: 1, maxLength: 5 },
    ),
    discount: fc.integer({ min: 0, max: 200_000 }),
    rounding: fc.constantFrom("none" as const, "whole" as const),
    paid: fc.integer({ min: 0, max: 1_000_000 }),
    advance: fc.integer({ min: 0, max: 1_000_000 }),
  })
  .map((r) => documentOf(r));

function documentOf(r: DocumentSpec): InvoiceDocument {
  {
    const sign = r.type === "credit_note" ? -1 : 1;
    const lines = r.lines.map((l) =>
      fixtureLine({
        quantityMilli: l.quantityMilli,
        unitPriceMinor: sign * l.unitPriceMinor || 0,
        netMinor: 0,
      }),
    );
    const totals = computeTotals(
      lines.map((l) => ({
        quantityMilli: l.quantityMilli,
        unitPriceMinor: l.unitPriceMinor,
        discount: { kind: "none" },
      })),
      { kind: "amount", minor: r.discount },
      r.rounding,
    );
    return {
      ...F.short,
      type: r.type,
      currency: r.currency,
      exchangeRateMicros: r.currency === "CZK" ? null : r.rate,
      rounding: r.rounding,
      discountKind: "amount",
      discountValue: r.discount,
      lines: lines.map((l, i) => ({ ...l, netMinor: totals.lines[i]!.netMinor })),
      relatedDocument:
        r.type === "credit_note"
          ? { type: "invoice", number: "2026-001", issueDate: "2026-03-01" }
          : null,
      totals: {
        ...F.short.totals,
        subtotalMinor: totals.subtotalMinor,
        discountMinor: totals.discountMinor,
        roundingMinor: totals.roundingMinor,
        totalMinor: totals.totalMinor,
        paidMinor: sign * r.paid || 0,
        advanceMinor: r.type === "invoice" ? r.advance : 0,
      },
    };
  }
}

const home = (xml: string, name: string) => {
  const total = /<LegalMonetaryTotal>[\s\S]*?<\/LegalMonetaryTotal>/.exec(xml)![0];
  const found = new RegExp(`<${name}>(-?[\\d.]+)<`).exec(total);
  return found ? decimalToMinor(found[1]!, 2) : 0;
};

const lineHomes = (xml: string) =>
  [...xml.matchAll(/<LineExtensionAmount>(-?[\d.]+)</g)].map((m) => decimalToMinor(m[1]!, 2));

// The document's own CZK value, as reports and the tax overview compute it (fx.ts): the CZK total
// with rounding is toCzkMinor(totalMinor), and the lines add up to it to the haléř.
function expectHomeTotals(doc: InvoiceDocument, xml: string): void {
  const sign = doc.type === "credit_note" ? -1 : 1;
  const czk = (minor: number) =>
    doc.currency === "CZK" ? minor : toCzkMinor(minor, doc.exchangeRateMicros!);
  const total = sign * czk(doc.totals.totalMinor) || 0;
  const rounding = sign * czk(doc.totals.roundingMinor) || 0;
  expect(home(xml, "TaxInclusiveAmount") + home(xml, "PayableRoundingAmount")).toBe(total);
  expect(home(xml, "PayableRoundingAmount")).toBe(rounding);
  expect(home(xml, "TaxExclusiveAmount")).toBe(total - rounding);
  expect(lineHomes(xml).reduce((sum, value) => sum + value, 0)).toBe(total - rounding);
}

describe("ISDOC tam a zpět", () => {
  test("[TST-015] buildIsdoc → parseIsdoc zachová všechny peněžní částky", async () => {
    const exports: Uint8Array[] = [];
    fc.assert(
      fc.property(documentArb, (doc) => {
        const bytes = encoder.encode(
          buildIsdoc(doc, { uuid: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" }),
        );
        exports.push(bytes);
        expectHomeTotals(doc, new TextDecoder().decode(bytes));
        expect(isdocRules(parseXml(bytes, XML_LIMITS))).toEqual([]);
        const parsed = parseIsdoc(bytes);
        const t = doc.totals;
        const sign = doc.type === "credit_note" ? -1 : 1;
        expect(parsed.type).toBe(doc.type);
        expect(parsed.currency).toBe(doc.currency);
        expect(parsed.exchangeRateMicros).toBe(doc.exchangeRateMicros);
        expect(parsed.totalMinor).toBe(t.totalMinor);
        expect(parsed.roundingMinor).toBe(t.roundingMinor);
        expect(parsed.subtotalMinor).toBe(t.subtotalMinor - t.discountMinor);
        const nets = doc.lines.map((l) => l.netMinor);
        if (t.discountMinor !== 0) nets.push(-t.discountMinor);
        expect(parsed.lines.map((l) => l.netMinor)).toEqual(nets);
        expect(parsed.lines.map((l) => l.quantityMilli)).toEqual([
          ...doc.lines.map((l) => l.quantityMilli),
          ...(t.discountMinor !== 0 ? [1000] : []),
        ]);
        if (doc.currency === "CZK") {
          expect(parsed.lines.slice(0, doc.lines.length).map((l) => l.unitPriceMinor)).toEqual(
            doc.lines.map((l) => l.unitPriceMinor),
          );
        }
        const ceiling = sign * (t.totalMinor - t.advanceMinor - t.paidMinor);
        expect(parsed.payableMinor).toBe(
          sign * Math.max(0, Math.min(sign * amountDue(t), ceiling)) || 0,
        );
        expect(parsed.paidDepositsMinor).toBe(t.advanceMinor + t.paidMinor);
      }),
      { numRuns: 150 },
    );
    const results = await validateIsdoc(exports.map((xml, i) => ({ name: `e${i}`, xml })));
    expect(results.filter((r) => r.errors.length > 0)).toEqual([]);
  });
});

// Seed -374271957 of TST-015: the CZK amounts of each line were rounded on their own and summed,
// so a document worth 0,00 EUR came out as -0,01 Kč, and a credit note turned negative.
describe("ISDOC: CZK celek z celku dokladu", () => {
  const spec = (over: Partial<DocumentSpec>): DocumentSpec => ({
    type: "credit_note",
    currency: "EUR",
    rate: 24_688_552,
    lines: [],
    discount: 0,
    rounding: "none",
    paid: 0,
    advance: 0,
    ...over,
  });

  const exported = (doc: InvoiceDocument) =>
    buildIsdoc(doc, { uuid: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" });

  test("[TST-015] protipříklad seedu -374271957: dobropis 0,00 EUR má celek 0,00 Kč", () => {
    const doc = documentOf(
      spec({
        lines: [
          { quantityMilli: 14_250, unitPriceMinor: 6 },
          { quantityMilli: 1, unitPriceMinor: 2_053_500 },
        ],
        discount: 2_140,
      }),
    );
    expect(doc.totals.totalMinor).toBe(0);
    const xml = exported(doc);

    expect(isdocRules(parseXml(encoder.encode(xml), XML_LIMITS))).toEqual([]);
    expectHomeTotals(doc, xml);
  });

  // A credit note the app does issue (total below zero) at a manual rate of 0,01 Kč.
  test("[TST-015] vystavitelný dobropis -0,01 EUR při ručním kurzu 0,01 nemá záporný celek v Kč", () => {
    const doc = documentOf(
      spec({
        rate: 10_000,
        lines: [
          { quantityMilli: 1_000, unitPriceMinor: 149 },
          { quantityMilli: 1_000, unitPriceMinor: 149 },
        ],
        discount: 297,
      }),
    );
    expect(doc.totals.totalMinor).toBe(-1);
    const xml = exported(doc);

    expect(isdocRules(parseXml(encoder.encode(xml), XML_LIMITS))).toEqual([]);
    expectHomeTotals(doc, xml);
  });

  test("[TST-015] 250 řádků po 3,00 EUR při kurzu 24,688552 dají řádky v Kč přesně do celku", () => {
    const doc = documentOf(
      spec({
        type: "invoice",
        lines: Array.from({ length: 250 }, () => ({ quantityMilli: 1_000, unitPriceMinor: 300 })),
      }),
    );
    expect(doc.totals.totalMinor).toBe(75_000);
    const xml = exported(doc);

    expect(isdocRules(parseXml(encoder.encode(xml), XML_LIMITS))).toEqual([]);
    expect(home(xml, "TaxInclusiveAmount")).toBe(toCzkMinor(75_000, 24_688_552));
    expectHomeTotals(doc, xml);
  });

  test("[TST-015] zaokrouhlení na celé: celek v Kč s haléřovým vyrovnáním = toCzkMinor(celku)", () => {
    const doc = documentOf(
      spec({
        type: "invoice",
        rounding: "whole",
        lines: [{ quantityMilli: 1_000, unitPriceMinor: 1_001 }],
      }),
    );
    expect(doc.totals).toMatchObject({ totalMinor: 1_000, roundingMinor: -1 });
    const xml = exported(doc);

    expect(home(xml, "TaxInclusiveAmount") + home(xml, "PayableRoundingAmount")).toBe(
      toCzkMinor(1_000, 24_688_552),
    );
    expectHomeTotals(doc, xml);
  });
});
