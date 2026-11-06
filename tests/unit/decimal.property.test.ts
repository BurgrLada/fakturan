import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { decimalToMicros, decimalToMinor, quantityToMilli } from "@/lib/safe-input/decimal";
import { InputRejected } from "@/lib/safe-input/limits";

const ZERO = BigInt(0);
const TEN = BigInt(10);
const MAX = BigInt(Number.MAX_SAFE_INTEGER);

// Independent reference: exact rational N / 10^k, rounded half away from zero by integer division.
function reference(sign: string, whole: string, fraction: string, scale: number): bigint {
  const n = BigInt(whole + fraction);
  const k = TEN ** BigInt(fraction.length);
  const scaled = n * TEN ** BigInt(scale);
  const rounded = (scaled * BigInt(2) + k) / (k * BigInt(2));
  return sign === "-" ? -rounded : rounded;
}

describe("desetinná čísla z cizích souborů", () => {
  test("[IMP-001] číslo delší než 32 znaků se odmítne dřív, než se počítá", () => {
    expect(() => decimalToMinor(`${"0".repeat(40)}1`, 2)).toThrow(InputRejected);
    expect(() => decimalToMinor(`1,${"0".repeat(40)}`, 2)).toThrow(InputRejected);
    expect(() => decimalToMinor("9".repeat(5_000_000), 2)).toThrow(InputRejected);
    expect(decimalToMinor(`  ${"1".repeat(13)},50  `, 2)).toBe(111_111_111_111_150);
  });

  test("decimalToMinor odpovídá BigInt výpočtu pro všechny řetězce do 4 míst", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("", "+", "-"),
        fc.stringMatching(/^\d{1,13}$/),
        fc.stringMatching(/^\d{0,4}$/),
        fc.integer({ min: 0, max: 4 }),
        fc.constantFrom(".", ","),
        (sign, whole, fraction, scale, separator) => {
          const text = fraction ? `${sign}${whole}${separator}${fraction}` : `${sign}${whole}`;
          const expected = reference(sign, whole, fraction, scale);
          if (expected > MAX || -expected > MAX) {
            expect(() => decimalToMinor(text, scale)).toThrow(InputRejected);
            return;
          }
          const result = decimalToMinor(text, scale);
          expect(BigInt(result)).toBe(expected);
          if (expected === ZERO) expect(Object.is(result, -0)).toBe(false);
        },
      ),
      { numRuns: 2000 },
    );
  });

  test("zaokrouhlení půl od nuly, mezery a krajní tvary", () => {
    expect(decimalToMinor("1.005", 2)).toBe(101);
    expect(decimalToMinor("-1.005", 2)).toBe(-101);
    expect(decimalToMinor("-1.004", 2)).toBe(-100);
    expect(decimalToMinor(" 12.5 ", 0)).toBe(13);
    expect(decimalToMinor("-0.004", 2)).toBe(0);
    expect(Object.is(decimalToMinor("-0.004", 2), -0)).toBe(false);
    expect(decimalToMinor(".5", 2)).toBe(50);
    expect(decimalToMinor("5.", 2)).toBe(500);
    expect(decimalToMinor("1.23456789", 6)).toBe(1_234_568);
    expect(decimalToMicros("25.345")).toBe(25_345_000);
    expect(quantityToMilli("1.5")).toBe(1500);
  });

  test("exponent, prázdný řetězec, oddělovače tisíců a přetečení jsou odmítnuté", () => {
    for (const text of [
      "1e3",
      "1E-2",
      "",
      " ",
      ".",
      "-",
      "1.2.3",
      "1 000",
      "0x10",
      "Infinity",
      "NaN",
      "1,000.5",
      "--1",
    ]) {
      expect(() => decimalToMinor(text, 2), text).toThrow(InputRejected);
    }
    expect(decimalToMinor("90071992547409.91", 2)).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => decimalToMinor("90071992547409.92", 2)).toThrow(InputRejected);
    expect(() => decimalToMinor("-90071992547409.92", 2)).toThrow(InputRejected);
    expect(() => decimalToMinor("1", -1)).toThrow(RangeError);
  });
});
