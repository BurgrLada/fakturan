import fc from "fast-check";
import { describe, expect, test } from "vitest";
import type { InvoiceDocument } from "@/lib/invoice-document";
import { computeTotals } from "@/lib/invoice-totals";
import { amountDue } from "@/lib/qr-payload";
import { XML_LIMITS } from "@/lib/safe-input/limits";
import { parseXml } from "@/lib/safe-input/xml";
import { buildIsdoc } from "@/server/isdoc/build";
import { parseIsdoc } from "@/server/isdoc/parse";
import { isdocRules } from "@/server/isdoc/rules";
import { validateIsdoc } from "@/server/isdoc/validate";
import { fixtureLine, INVOICE_FIXTURES as F } from "../fixtures/invoices";

const encoder = new TextEncoder();

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
  .map((r): InvoiceDocument => {
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
  });

describe("ISDOC tam a zpět", () => {
  test("[TST-015] buildIsdoc → parseIsdoc zachová všechny peněžní částky", async () => {
    const exports: Uint8Array[] = [];
    fc.assert(
      fc.property(documentArb, (doc) => {
        const bytes = encoder.encode(
          buildIsdoc(doc, { uuid: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" }),
        );
        exports.push(bytes);
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
