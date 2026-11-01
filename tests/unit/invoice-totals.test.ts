import { describe, expect, test } from "vitest";
import {
  allowsNegativePrice,
  appliedLineDiscount,
  cappedDiscounts,
  computeTotals,
  formatQuantity,
  MAX_DOCUMENT_MINOR,
  MAX_QUANTITY_MILLI,
  parseQuantity,
  type Discount,
} from "@/lib/invoice-totals";
import { AmountOutOfRangeError } from "@/lib/money";

const none: Discount = { kind: "none" };
const line = (quantityMilli: number, unitPriceMinor: number, discount: Discount = none) => ({
  quantityMilli,
  unitPriceMinor,
  discount,
});

describe("výpočet částek", () => {
  test("[INV-012] 1,5 hod. × 1 234,56 Kč = 1 851,84 Kč", () => {
    const totals = computeTotals([line(1500, 123456)], none, "none");
    expect(totals.lines[0]).toEqual({ grossMinor: 185184, discountMinor: 0, netMinor: 185184 });
    expect(totals.totalMinor).toBe(185184);
  });

  test("[INV-012] 0,333 ks × 0,10 Kč zaokrouhlí půl od nuly", () => {
    expect(computeTotals([line(333, 10)], none, "none").totalMinor).toBe(3);
    expect(computeTotals([line(500, 1)], none, "none").totalMinor).toBe(1);
    expect(computeTotals([line(1500, 1)], none, "none").totalMinor).toBe(2);
    expect(computeTotals([line(2500, 1)], none, "none").totalMinor).toBe(3);
    expect(computeTotals([line(499, 1)], none, "none").totalMinor).toBe(0);
  });

  test("[INV-012] řádky se zaokrouhlují každý zvlášť před součtem", () => {
    const totals = computeTotals([line(333, 10), line(333, 10), line(333, 10)], none, "none");
    expect(totals.subtotalMinor).toBe(9);
  });

  test("[INV-014] 10 % z 999,99 Kč po slevě řádku 5 % sedí na haléř", () => {
    const totals = computeTotals(
      [line(1000, 99999, { kind: "percent", basisPoints: 500 })],
      { kind: "percent", basisPoints: 1000 },
      "none",
    );
    expect(totals.lines[0]).toEqual({ grossMinor: 99999, discountMinor: 5000, netMinor: 94999 });
    expect(totals.subtotalMinor).toBe(94999);
    expect(totals.discountMinor).toBe(9500);
    expect(totals.totalMinor).toBe(85499);
  });

  test("[INV-014] sleva částkou se odečte jednou od součtu", () => {
    const totals = computeTotals(
      [line(1000, 10000), line(1000, 5000)],
      { kind: "amount", minor: 2500 },
      "none",
    );
    expect(totals.discountMinor).toBe(2500);
    expect(totals.totalMinor).toBe(12500);
  });

  test("[INV-012] sleva řádku půl haléře se zaokrouhlí nahoru", () => {
    const totals = computeTotals(
      [line(1000, 25, { kind: "percent", basisPoints: 5000 })],
      none,
      "none",
    );
    expect(totals.lines[0]!.discountMinor).toBe(13);
    expect(totals.totalMinor).toBe(12);
  });

  test("[INV-015] 100,50 Kč na koruny dá 101 Kč a rozdíl 0,50 Kč", () => {
    const totals = computeTotals([line(1000, 10050)], none, "whole");
    expect(totals.roundingMinor).toBe(50);
    expect(totals.totalMinor).toBe(10100);
  });

  test("[INV-015] 100,49 Kč na koruny dá 100 Kč a rozdíl -0,49 Kč", () => {
    const totals = computeTotals([line(1000, 10049)], none, "whole");
    expect(totals.roundingMinor).toBe(-49);
    expect(totals.totalMinor).toBe(10000);
  });

  test("[INV-015] celé koruny a režim bez zaokrouhlení nemají rozdíl", () => {
    expect(computeTotals([line(1000, 10000)], none, "whole").roundingMinor).toBe(0);
    expect(computeTotals([line(1000, 10049)], none, "none").roundingMinor).toBe(0);
  });

  test("[INV-012] prázdný doklad má nulové součty", () => {
    expect(computeTotals([], none, "whole")).toEqual({
      lines: [],
      subtotalMinor: 0,
      discountMinor: 0,
      roundingMinor: 0,
      totalMinor: 0,
    });
  });

  test("[TST-012] sleva nikdy nedá záporný řádek ani doklad", () => {
    const line1 = computeTotals([line(1000, 5000, { kind: "amount", minor: 8000 })], none, "none");
    expect(line1.lines[0]).toEqual({ grossMinor: 5000, discountMinor: 5000, netMinor: 0 });
    const line2 = computeTotals(
      [line(1000, 5000, { kind: "percent", basisPoints: 15000 })],
      none,
      "none",
    );
    expect(line2.lines[0]!.netMinor).toBe(0);
    const doc = computeTotals([line(1000, 10000)], { kind: "amount", minor: 20000 }, "whole");
    expect(doc.discountMinor).toBe(10000);
    expect(doc.totalMinor).toBe(0);
    expect(
      computeTotals([line(1000, 10000)], { kind: "percent", basisPoints: 20000 }, "none")
        .totalMinor,
    ).toBe(0);
  });

  test("[INV-012] cena za 1e12 Kč × 9 999 999,999 je odmítnutá AmountOutOfRangeError", () => {
    expect(() => computeTotals([line(MAX_QUANTITY_MILLI, 1e14)], none, "none")).toThrow(
      AmountOutOfRangeError,
    );
  });

  test("[INV-012] limit platí pro řádek, součet i zaokrouhlený výsledek", () => {
    expect(computeTotals([line(1000, MAX_DOCUMENT_MINOR)], none, "none").totalMinor).toBe(
      MAX_DOCUMENT_MINOR,
    );
    expect(() => computeTotals([line(1000, MAX_DOCUMENT_MINOR + 1)], none, "none")).toThrow(
      AmountOutOfRangeError,
    );
    expect(() =>
      computeTotals([line(1000, 60_000_000_000), line(1000, 60_000_000_000)], none, "none"),
    ).toThrow(AmountOutOfRangeError);
    expect(() => computeTotals([line(1000, MAX_DOCUMENT_MINOR)], none, "whole")).toThrow(
      AmountOutOfRangeError,
    );
    expect(() =>
      computeTotals([line(1000, MAX_DOCUMENT_MINOR, { kind: "amount", minor: 0 })], none, "none"),
    ).not.toThrow();
  });

  test("[INV-012] řádek s hrubou částkou nad limitem selže i při vysoké slevě", () => {
    expect(() =>
      computeTotals(
        [line(1000, MAX_DOCUMENT_MINOR + 1, { kind: "percent", basisPoints: 10000 })],
        none,
        "none",
      ),
    ).toThrow(AmountOutOfRangeError);
  });

  test("[INV-012] množství nad limitem a neplatné vstupy jsou odmítnuté", () => {
    expect(computeTotals([line(MAX_QUANTITY_MILLI, 1)], none, "none").totalMinor).toBe(10_000_000);
    expect(() => computeTotals([line(MAX_QUANTITY_MILLI + 1, 1)], none, "none")).toThrow(
      AmountOutOfRangeError,
    );
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => computeTotals([line(bad, 100)], none, "none"), `qty ${bad}`).toThrow(
        AmountOutOfRangeError,
      );
      expect(() =>
        computeTotals([line(1000, 100, { kind: "percent", basisPoints: bad })], none, "none"),
      ).toThrow(AmountOutOfRangeError);
      expect(() =>
        computeTotals([line(1000, 100, { kind: "amount", minor: bad })], none, "none"),
      ).toThrow(AmountOutOfRangeError);
      expect(() =>
        computeTotals([line(1000, 100)], { kind: "amount", minor: bad }, "none"),
      ).toThrow(AmountOutOfRangeError);
    }
    for (const bad of [1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => computeTotals([line(1000, bad)], none, "none"), `price ${bad}`).toThrow(
        AmountOutOfRangeError,
      );
    }
    expect(() =>
      computeTotals([line(1000, 100)], { kind: "percent", basisPoints: -1 }, "none"),
    ).toThrow(AmountOutOfRangeError);
  });

  test("[INV-012] množství se čte a zapisuje po tisícinách", () => {
    expect(parseQuantity("12 345")).toBe(12_345_000);
    expect(parseQuantity("1,5")).toBe(1500);
    expect(parseQuantity("1.5")).toBe(1500);
    expect(parseQuantity("0,333")).toBe(333);
    expect(parseQuantity(" 2 ")).toBe(2000);
    expect(parseQuantity("1 234,567")).toBe(1234567);
    expect(parseQuantity("9 999 999,999")).toBe(MAX_QUANTITY_MILLI);
    expect(parseQuantity("0")).toBe(0);
    for (const bad of [
      "",
      "abc",
      "-1",
      "1,2345",
      "1,",
      ",5",
      "1 23",
      "10 000 000",
      "1,5,5",
      "1e3",
    ]) {
      expect(parseQuantity(bad), bad).toBeNull();
    }
    expect(formatQuantity(1500)).toBe("1,5");
    expect(formatQuantity(2000)).toBe("2");
    expect(formatQuantity(333)).toBe("0,333");
    expect(formatQuantity(1005)).toBe("1,005");
    expect(formatQuantity(1230)).toBe("1,23");
    expect(formatQuantity(0)).toBe("0");
    expect(formatQuantity(MAX_QUANTITY_MILLI)).toBe("9999999,999");
  });
});

describe("záporné částky", () => {
  const percent = (basisPoints: number): Discount => ({ kind: "percent", basisPoints });
  const amount = (minor: number): Discount => ({ kind: "amount", minor });

  test("[INV-012] řádek 3 × -1 250,50 Kč se slevou 10 % dá -3 376,35 Kč", () => {
    const totals = computeTotals([line(3000, -125050, percent(1000))], none, "none");
    expect(totals.lines[0]).toEqual({
      grossMinor: -375150,
      discountMinor: -37515,
      netMinor: -337635,
    });
    expect(totals).toMatchObject({
      subtotalMinor: -337635,
      discountMinor: 0,
      roundingMinor: 0,
      totalMinor: -337635,
    });
  });

  test("[TST-014] oprava 3 × 1 250,50, sleva 10 %, sleva dokladu 100, na koruny: subtotal -3 376,35, discount -100,00, rounding +0,35, total -3 276,00", () => {
    const totals = computeTotals([line(3000, -125050, percent(1000))], amount(10000), "whole");
    expect(totals).toMatchObject({
      subtotalMinor: -337635,
      discountMinor: -10000,
      roundingMinor: 35,
      totalMinor: -327600,
    });
  });

  test("[TST-014] zaokrouhlení -12,50 Kč na koruny je -13,00 a rozdíl -0,50", () => {
    const totals = computeTotals([line(1000, -1250)], none, "whole");
    expect(totals).toMatchObject({ roundingMinor: -50, totalMinor: -1300 });
  });

  test("[TST-014] množství 0,333 × -100,01 Kč je -33,30 Kč", () => {
    expect(computeTotals([line(333, -10001)], none, "none").totalMinor).toBe(-3330);
  });

  test("[TST-014] odebrat a přidat: -1 000,00 a 2 × 150,25, sleva dokladu 10 %, na koruny je -630,00", () => {
    const totals = computeTotals([line(1000, -100000), line(2000, 15025)], percent(1000), "whole");
    expect(totals.lines.map((l) => l.netMinor)).toEqual([-100000, 30050]);
    expect(totals).toMatchObject({
      subtotalMinor: -69950,
      discountMinor: -6995,
      roundingMinor: -45,
      totalMinor: -63000,
    });
  });

  test("[TST-014] kladný součet smíšených řádků se počítá jako běžný doklad", () => {
    const totals = computeTotals([line(1000, -10000), line(1000, 25000)], amount(1000), "none");
    expect(totals).toMatchObject({ subtotalMinor: 15000, discountMinor: 1000, totalMinor: 14000 });
  });

  test("[TST-014] půlka haléře ve slevě -0,05 Kč zaokrouhlí velikost slevy nahoru", () => {
    const totals = computeTotals([line(1000, -5, percent(5000))], none, "none");
    expect(totals.lines[0]).toEqual({ grossMinor: -5, discountMinor: -3, netMinor: -2 });
  });

  test("sleva nad základem je omezená velikostí základu i v záporu", () => {
    const totals = computeTotals([line(1000, -5000, amount(8000))], amount(100), "none");
    expect(totals.lines[0]).toEqual({ grossMinor: -5000, discountMinor: -5000, netMinor: 0 });
    expect(totals).toMatchObject({ subtotalMinor: 0, discountMinor: 0, totalMinor: 0 });

    const document = computeTotals([line(1000, -5000)], amount(9000), "none");
    expect(document).toMatchObject({ discountMinor: -5000, totalMinor: 0 });
  });

  test("uplatněná sleva řádku je pro PDF kladná i v záporu", () => {
    const ask = (minor: number) =>
      appliedLineDiscount({ quantityMilli: 1000, unitPriceMinor: -10000, discount: amount(minor) });
    expect(ask(3000)).toBe(3000);
    expect(ask(30000)).toBe(10000);
  });

  test("omezenou slevu hlásí podle velikosti základu", () => {
    const check = (minor: number) => {
      const lines = [line(1000, -2000, amount(minor))];
      return cappedDiscounts(lines, amount(minor), computeTotals(lines, amount(minor), "none"));
    };
    expect(check(2000)).toEqual({ document: true, lines: [] });
    expect(check(2001)).toEqual({ document: true, lines: [1] });
    expect(check(1000)).toEqual({ document: false, lines: [] });

    const document = [line(1000, -2000)];
    const ask = (minor: number) =>
      cappedDiscounts(document, amount(minor), computeTotals(document, amount(minor), "none"));
    expect(ask(2000).document).toBe(false);
    expect(ask(2001).document).toBe(true);
  });

  test("částka mimo limit je odmítnutá v obou znaménkách", () => {
    const refused = (lines: ReturnType<typeof line>[], mode: "none" | "whole" = "none") =>
      expect(() => computeTotals(lines, none, mode)).toThrow(AmountOutOfRangeError);

    expect(computeTotals([line(1000, -MAX_DOCUMENT_MINOR)], none, "none").totalMinor).toBe(
      -MAX_DOCUMENT_MINOR,
    );
    refused([line(1000, -MAX_DOCUMENT_MINOR - 1)]);
    refused([line(1000, MAX_DOCUMENT_MINOR + 1)]);
    refused([line(1000, -MAX_DOCUMENT_MINOR), line(1000, -1)]);
    refused([line(1000, MAX_DOCUMENT_MINOR), line(1000, 1)]);
    refused([line(1000, -MAX_DOCUMENT_MINOR)], "whole");
    refused([line(1000, -(2 ** 53))]);
    refused([line(1000, -1.5)]);
  });

  test("součet nad limitem neprojde ani se slevou, která by ho vrátila pod limit", () => {
    const lines = [line(1000, -MAX_DOCUMENT_MINOR), line(1000, -1)];
    expect(() => computeTotals(lines, amount(1000), "none")).toThrow(AmountOutOfRangeError);
  });

  test("limit platí pro výsledný součet, takže pořadí řádků o přijetí nerozhoduje", () => {
    const lines = [line(1000, MAX_DOCUMENT_MINOR), line(1000, 1), line(1000, -2)];
    const expected = MAX_DOCUMENT_MINOR - 1;
    expect(computeTotals(lines, none, "none").totalMinor).toBe(expected);
    expect(computeTotals([...lines].reverse(), none, "none").totalMinor).toBe(expected);
  });

  test("cena nula se znaménkem mínus nedá zápornou nulu", () => {
    const totals = computeTotals([line(1000, -0)], none, "whole");
    expect(totals).toEqual({
      lines: [{ grossMinor: 0, discountMinor: 0, netMinor: 0 }],
      subtotalMinor: 0,
      discountMinor: 0,
      roundingMinor: 0,
      totalMinor: 0,
    });
  });

  test("zápornou cenu dovoluje jen opravná faktura", () => {
    expect(allowsNegativePrice("credit_note")).toBe(true);
    expect(allowsNegativePrice("invoice")).toBe(false);
    expect(allowsNegativePrice("advance")).toBe(false);
  });
});
