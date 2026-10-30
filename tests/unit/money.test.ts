import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { formatMoney, formatMoneyInput, parseMoney } from "@/lib/money";

describe("peníze", () => {
  test("[CAT-001] 1 234,50 se přečte na 123450 haléřů", () => {
    expect(parseMoney("1 234,50")).toBe(123450);
    expect(parseMoney("1 234,5")).toBe(123450);
    expect(parseMoney("1234.5")).toBe(123450);
    expect(parseMoney("  99 ")).toBe(9900);
    expect(parseMoney("0,05")).toBe(5);
    expect(parseMoney("-12,30")).toBe(-1230);
  });

  test("[CAT-001] neplatný zápis částky vrátí null", () => {
    for (const bad of [
      "",
      " ",
      "abc",
      "1,234,5",
      "1,234",
      "12,345",
      "1 23",
      ",5",
      "1,",
      "--1",
      "1e5",
    ]) {
      expect(parseMoney(bad), bad).toBeNull();
    }
    expect(parseMoney("99999999999999999")).toBeNull();
  });

  test("[CAT-001] formatMoney používá českou podobu s měnou", () => {
    expect(formatMoney(123450, "CZK").replace(/\s/g, " ")).toBe("1 234,50 Kč");
    expect(formatMoney(5, "EUR").replace(/\s/g, " ")).toBe("0,05 €");
    expect(formatMoneyInput(123450)).toBe("1234,50");
    expect(formatMoneyInput(-5)).toBe("-0,05");
  });

  test("[CAT-001] vlastnost: zápis do formuláře a zpět dá původní částku", () => {
    fc.assert(
      fc.property(fc.integer({ min: -1_000_000_000_000, max: 1_000_000_000_000 }), (cents) => {
        expect(parseMoney(formatMoneyInput(cents))).toBe(cents);
      }),
    );
  });

  test("[CAT-001] vlastnost: seskupení tisíců nemění hodnotu", () => {
    fc.assert(
      fc.property(fc.nat({ max: 1_000_000_000_000 }), (cents) => {
        const [whole, fraction] = formatMoneyInput(cents).split(",");
        const grouped = whole.replace(/\B(?=(\d{3})+$)/g, " ");
        expect(parseMoney(`${grouped},${fraction}`)).toBe(cents);
      }),
    );
  });
});
