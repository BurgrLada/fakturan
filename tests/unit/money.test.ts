import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { CURRENCIES } from "@/lib/currency";
import { AmountOutOfRangeError, formatMoney, formatMoneyInput, parseMoney } from "@/lib/money";

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
    expect(formatMoneyInput(0)).toBe("0,00");
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

  test("[CAT-001] mínus nula je nula, ne záporná nula", () => {
    expect(Object.is(parseMoney("-0"), 0)).toBe(true);
    expect(Object.is(parseMoney("-0,00"), 0)).toBe(true);
  });

  test("[CAT-001] úzká nezlomitelná mezera seskupuje tisíce", () => {
    expect(parseMoney("1\u202F234,50")).toBe(123450);
    expect(parseMoney("1\u00A0234,50")).toBe(123450);
  });

  test("[CAT-001] každá podporovaná měna má dvě desetinná místa", () => {
    for (const currency of CURRENCIES) {
      const { minimumFractionDigits, maximumFractionDigits } = new Intl.NumberFormat("cs-CZ", {
        style: "currency",
        currency,
      }).resolvedOptions();
      expect([currency, minimumFractionDigits, maximumFractionDigits]).toEqual([currency, 2, 2]);
    }
  });

  test("[CAT-001] vlastnost: výstup formatMoney se přečte zpět na původní částku", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...CURRENCIES),
        fc.integer({ min: -1_000_000_000_000, max: 1_000_000_000_000 }),
        (currency, cents) => {
          const text = formatMoney(cents, currency).replace(/[^\d\s\u00A0\u202F,.\-−]/gu, "");
          expect(parseMoney(text.replace("−", "-")), text).toBe(cents);
        },
      ),
    );
  });

  test("[CAT-001] chyba rozsahu částky je v hlášení rozpoznatelná", () => {
    const error = new AmountOutOfRangeError();
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("AmountOutOfRangeError");
  });
});
