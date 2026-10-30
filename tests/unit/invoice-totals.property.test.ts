import fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  computeTotals,
  formatQuantity,
  parseQuantity,
  type Discount,
  type RoundingMode,
} from "@/lib/invoice-totals";

const discount: fc.Arbitrary<Discount> = fc.oneof(
  fc.constant<Discount>({ kind: "none" }),
  fc
    .integer({ min: 0, max: 12_000 })
    .map((basisPoints): Discount => ({ kind: "percent", basisPoints })),
  fc.integer({ min: 0, max: 5_000_000 }).map((minor): Discount => ({ kind: "amount", minor })),
);
const line = fc.record({
  quantityMilli: fc.integer({ min: 0, max: 100_000 }),
  unitPriceMinor: fc.integer({ min: 0, max: 1_000_000 }),
  discount,
});
const lines = fc.array(line, { maxLength: 8 });
const rounding = fc.constantFrom<RoundingMode[]>("none", "whole");

// Half away from zero for non-negative integers without BigInt, valid while the products stay below 2^53.
const half = (n: number, d: number) => Math.floor((2 * n + d) / (2 * d));
const cap = (base: number, d: Discount) =>
  Math.min(
    base,
    d.kind === "percent" ? half(base * d.basisPoints, 10_000) : d.kind === "amount" ? d.minor : 0,
  );

describe("výpočet částek, vlastnosti", () => {
  test("[TST-012] total = Σ net − sleva dokladu + zaokrouhlení pro libovolné vstupy", () => {
    fc.assert(
      fc.property(lines, discount, rounding, (input, docDiscount, mode) => {
        const totals = computeTotals(input, docDiscount, mode);
        const nets = input.map((l) => {
          const gross = half(l.quantityMilli * l.unitPriceMinor, 1000);
          return { gross, discount: cap(gross, l.discount), net: gross - cap(gross, l.discount) };
        });
        totals.lines.forEach((l, i) => {
          expect(l).toEqual({
            grossMinor: nets[i]!.gross,
            discountMinor: nets[i]!.discount,
            netMinor: nets[i]!.net,
          });
        });
        const sum = nets.reduce((acc, n) => acc + n.net, 0);
        expect(totals.subtotalMinor).toBe(sum);
        expect(totals.discountMinor).toBe(cap(sum, docDiscount));
        expect(totals.totalMinor).toBe(sum - totals.discountMinor + totals.roundingMinor);
        expect(totals.totalMinor).toBe(
          totals.lines.reduce((a, l) => a + l.netMinor, 0) -
            totals.discountMinor +
            totals.roundingMinor,
        );
        if (mode === "none") expect(totals.roundingMinor).toBe(0);
        else {
          expect(totals.totalMinor % 100).toBe(0);
          expect(totals.roundingMinor).toBeGreaterThanOrEqual(-49);
          expect(totals.roundingMinor).toBeLessThanOrEqual(50);
        }
      }),
      { numRuns: 500 },
    );
  });

  test("[TST-012] sleva nikdy nedá záporný řádek ani doklad", () => {
    fc.assert(
      fc.property(lines, discount, rounding, (input, docDiscount, mode) => {
        const totals = computeTotals(input, docDiscount, mode);
        for (const l of totals.lines) {
          expect(l.netMinor).toBeGreaterThanOrEqual(0);
          expect(l.discountMinor).toBeLessThanOrEqual(l.grossMinor);
        }
        expect(totals.discountMinor).toBeLessThanOrEqual(totals.subtotalMinor);
        expect(totals.totalMinor).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 500 },
    );
  });

  test("[ARC-002] všechny částky jsou celá čísla v haléřích", () => {
    fc.assert(
      fc.property(lines, discount, rounding, (input, docDiscount, mode) => {
        const totals = computeTotals(input, docDiscount, mode);
        const all = [
          totals.subtotalMinor,
          totals.discountMinor,
          totals.roundingMinor,
          totals.totalMinor,
          ...totals.lines.flatMap((l) => [l.grossMinor, l.discountMinor, l.netMinor]),
        ];
        for (const value of all) expect(Number.isSafeInteger(value)).toBe(true);
      }),
    );
  });

  test("[TST-012] pořadí řádků na výsledku nezáleží", () => {
    fc.assert(
      fc.property(lines, discount, rounding, (input, docDiscount, mode) => {
        const a = computeTotals(input, docDiscount, mode);
        const b = computeTotals([...input].reverse(), docDiscount, mode);
        expect(b.totalMinor).toBe(a.totalMinor);
        expect(b.subtotalMinor).toBe(a.subtotalMinor);
      }),
    );
  });

  test("[INV-012] formatQuantity a parseQuantity jsou navzájem inverzní", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 9_999_999_999 }), (milli) => {
        expect(parseQuantity(formatQuantity(milli))).toBe(milli);
      }),
    );
  });
});
