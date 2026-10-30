import { describe, expect, test } from "vitest";
import {
  computeTotals,
  type Discount,
  type RoundingMode,
  type TotalsLine,
} from "@/lib/invoice-totals";

const none: Discount = { kind: "none" };
const pct = (basisPoints: number): Discount => ({ kind: "percent", basisPoints });
const amt = (minor: number): Discount => ({ kind: "amount", minor });
const l = (
  quantityMilli: number,
  unitPriceMinor: number,
  discount: Discount = none,
): TotalsLine => ({
  quantityMilli,
  unitPriceMinor,
  discount,
});

type Example = {
  name: string;
  lines: TotalsLine[];
  discount: Discount;
  rounding: RoundingMode;
  expected: {
    lines: [gross: number, discount: number, net: number][];
    subtotal: number;
    discount: number;
    rounding: number;
    total: number;
  };
};

// Every expected value was worked out by hand in minor units (haléře), not taken from the implementation.
const EXAMPLES: Example[] = [
  {
    name: "jedna položka za 100,00 Kč",
    lines: [l(1000, 10000)],
    discount: none,
    rounding: "none",
    expected: {
      lines: [[10000, 0, 10000]],
      subtotal: 10000,
      discount: 0,
      rounding: 0,
      total: 10000,
    },
  },
  {
    name: "1,5 hod. po 1 234,56 Kč",
    lines: [l(1500, 123456)],
    discount: none,
    rounding: "none",
    expected: {
      lines: [[185184, 0, 185184]],
      subtotal: 185184,
      discount: 0,
      rounding: 0,
      total: 185184,
    },
  },
  {
    name: "slevy řádků i dokladu a zaokrouhlení nahoru",
    // 2×1500,00 −10 % = 3000,00−300,00; 0,5×999,99 = 499,995→500,00 −5 % = 475,00; Σ 3175,00; −10 % = 317,50; 2857,50→2858,00
    lines: [l(2000, 150000, pct(1000)), l(500, 99999, pct(500))],
    discount: pct(1000),
    rounding: "whole",
    expected: {
      lines: [
        [300000, 30000, 270000],
        [50000, 2500, 47500],
      ],
      subtotal: 317500,
      discount: 31750,
      rounding: 50,
      total: 285800,
    },
  },
  {
    name: "10 % z 999,99 Kč po slevě řádku 5 %",
    // 999,99 −5 % (49,9995→50,00) = 949,99; −10 % (94,999→95,00) = 854,99
    lines: [l(1000, 99999, pct(500))],
    discount: pct(1000),
    rounding: "none",
    expected: {
      lines: [[99999, 5000, 94999]],
      subtotal: 94999,
      discount: 9500,
      rounding: 0,
      total: 85499,
    },
  },
  {
    name: "tři řádky, sleva částkou, celé koruny",
    // 19,99 + 2,5×49,50 = 123,75 + 0,75×33,33 = 24,9975→25,00; Σ 168,74; −8,74 = 160,00
    lines: [l(1000, 1999), l(2500, 4950), l(750, 3333)],
    discount: amt(874),
    rounding: "whole",
    expected: {
      lines: [
        [1999, 0, 1999],
        [12375, 0, 12375],
        [2500, 0, 2500],
      ],
      subtotal: 16874,
      discount: 874,
      rounding: 0,
      total: 16000,
    },
  },
  {
    name: "sleva dokladu 33,33 % a zaokrouhlení nahoru",
    // 100,01 × 33,33 % = 33,333333→33,33; 66,68→67,00
    lines: [l(1000, 10001)],
    discount: pct(3333),
    rounding: "whole",
    expected: {
      lines: [[10001, 0, 10001]],
      subtotal: 10001,
      discount: 3333,
      rounding: 32,
      total: 6700,
    },
  },
  {
    name: "sleva řádku částkou nad základ dá nulu",
    lines: [l(1000, 5000, amt(8000))],
    discount: none,
    rounding: "none",
    expected: { lines: [[5000, 5000, 0]], subtotal: 0, discount: 0, rounding: 0, total: 0 },
  },
  {
    name: "největší povolené množství po 0,10 Kč",
    // 9 999 999,999 × 0,10 = 999 999,9999→1 000 000,00
    lines: [l(9_999_999_999, 10)],
    discount: none,
    rounding: "whole",
    expected: {
      lines: [[100_000_000, 0, 100_000_000]],
      subtotal: 100_000_000,
      discount: 0,
      rounding: 0,
      total: 100_000_000,
    },
  },
  {
    name: "tři řádky po 0,03 Kč zaokrouhlené na koruny",
    // 3 × (0,333×0,10 = 0,0333→0,03) = 0,09 → 0,00
    lines: [l(333, 10), l(333, 10), l(333, 10)],
    discount: none,
    rounding: "whole",
    expected: {
      lines: [
        [3, 0, 3],
        [3, 0, 3],
        [3, 0, 3],
      ],
      subtotal: 9,
      discount: 0,
      rounding: -9,
      total: 0,
    },
  },
  {
    name: "tři různé slevy a zaokrouhlení dolů",
    // 3×25,99=77,97 −15 % (11,6955→11,70)=66,27; 1,25×80=100,00 −10,00=90,00; 0,1×123,45=12,345→12,35
    // Σ 168,62; −5 % (8,431→8,43)=160,19; →160,00
    lines: [l(3000, 2599, pct(1500)), l(1250, 8000, amt(1000)), l(100, 12345)],
    discount: pct(500),
    rounding: "whole",
    expected: {
      lines: [
        [7797, 1170, 6627],
        [10000, 1000, 9000],
        [1235, 0, 1235],
      ],
      subtotal: 16862,
      discount: 843,
      rounding: -19,
      total: 16000,
    },
  },
  {
    name: "0,25 × 49,99 Kč a sleva dokladu 0,50 Kč",
    // 12,4975→12,50 − 0,50 = 12,00
    lines: [l(250, 4999)],
    discount: amt(50),
    rounding: "none",
    expected: { lines: [[1250, 0, 1250]], subtotal: 1250, discount: 50, rounding: 0, total: 1200 },
  },
  {
    name: "sleva řádku 50 % z 100,01 Kč se zaokrouhlí nahoru",
    // 50,005→50,01 sleva, zbývá 50,00
    lines: [l(1000, 10001, pct(5000))],
    discount: none,
    rounding: "whole",
    expected: {
      lines: [[10001, 5001, 5000]],
      subtotal: 5000,
      discount: 0,
      rounding: 0,
      total: 5000,
    },
  },
  {
    name: "nulové množství nic nepřidá",
    lines: [l(0, 500000), l(1000, 100)],
    discount: none,
    rounding: "none",
    expected: {
      lines: [
        [0, 0, 0],
        [100, 0, 100],
      ],
      subtotal: 100,
      discount: 0,
      rounding: 0,
      total: 100,
    },
  },
];

describe("vzorové faktury", () => {
  EXAMPLES.forEach((example, index) => {
    test(`[TST-014] vzorová faktura č. ${index + 1}: ${example.name}`, () => {
      const totals = computeTotals(example.lines, example.discount, example.rounding);
      expect(totals).toEqual({
        lines: example.expected.lines.map(([grossMinor, discountMinor, netMinor]) => ({
          grossMinor,
          discountMinor,
          netMinor,
        })),
        subtotalMinor: example.expected.subtotal,
        discountMinor: example.expected.discount,
        roundingMinor: example.expected.rounding,
        totalMinor: example.expected.total,
      });
    });
  });
});
