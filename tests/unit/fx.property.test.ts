import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { convertMinor, RATE_UNIT, toCzkMinor } from "@/lib/fx";

const amount = fc.integer({ min: 0, max: 99_999_999_999 });
const rate = fc.integer({ min: 100_000, max: 1_000_000_000 });

describe("převod měn", () => {
  test("[TST-012] pro libovolnou částku a kurz je převod symetrický v záporu a nepřekročí bezpečné číslo", () => {
    fc.assert(
      fc.property(amount, rate, rate, (minor, from, to) => {
        const positive = convertMinor(minor, from, to);
        expect(Number.isSafeInteger(positive)).toBe(true);
        expect(convertMinor(-minor, from, to)).toBe(positive === 0 ? 0 : -positive);
        expect(Object.is(convertMinor(-minor, from, to), -0)).toBe(false);
      }),
    );
  });

  test("[TST-012] převod do téže měny a kurzem 1:1 nic nemění", () => {
    fc.assert(
      fc.property(amount, rate, (minor, value) => {
        expect(convertMinor(minor, value, value)).toBe(minor);
        expect(toCzkMinor(minor, RATE_UNIT)).toBe(minor);
      }),
    );
  });

  test("[TST-012] výsledek se od přesného podílu liší nejvýš o půl haléře", () => {
    fc.assert(
      fc.property(amount, rate, rate, (minor, from, to) => {
        const exact = (BigInt(minor) * BigInt(from) * BigInt(2)) / BigInt(to);
        const doubled = BigInt(convertMinor(minor, from, to)) * BigInt(2);
        expect(doubled - exact <= BigInt(1) && exact - doubled <= BigInt(1)).toBe(true);
      }),
    );
  });
});
