import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { fioParser } from "@/lib/bank-notices/fio";
import type { NoticeMeta } from "@/lib/bank-notices/types";

const SUBJECTS = [
  "Fio banka - new income on account",
  "Fio banka - příjem na kontě",
  "Fio banka - příjem na účtu",
];
const LABELS = ["Amount: ", "Částka: ", "VS: ", "Variable symbol: ", "Date: ", "zůstatek účtu "];

const meta = (subject: string): NoticeMeta => ({ from: ["automat@fio.cz"], subject });

function formatted(minor: number, separator: string, decimal: string): string {
  const whole = String(Math.trunc(minor / 100)).replace(/\B(?=(\d{3})+$)/g, separator);
  return `${whole}${decimal}${String(minor % 100).padStart(2, "0")}`;
}

describe("parser na náhodném vstupu", () => {
  test("[TST-012] náhodný text nikdy nevyhodí výjimku a kladná částka se vrátí beze ztráty", () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(fc.string(), fc.constantFrom(...LABELS)), { maxLength: 8 }),
        fc.constantFrom(...SUBJECTS),
        (parts, subject) => {
          const parsed = fioParser.parse(parts.join("\n"), meta(subject));
          if (parsed) expect(parsed.amountMinor).toBeGreaterThan(0);
        },
      ),
    );

    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
        fc.constantFrom(" ", " ", " ", ""),
        (minor, separator) => {
          const en = [
            "Account: 9999999999",
            `Amount: ${formatted(minor, separator, ".")}`,
            "Currency: CZK",
            "Date: 1/2/2026",
            "Instruction ID: 1",
          ].join("\n");
          const cs = [
            "Příjem na kontě: 9999999999",
            `Částka: ${formatted(minor, separator, ",")}`,
            "Měna: CZK",
            "Datum: 2.1.2026",
            "ID pokynu: 1",
          ].join("\n");
          expect(fioParser.parse(en, meta(SUBJECTS[0]!))?.amountMinor).toBe(minor);
          expect(fioParser.parse(cs, meta(SUBJECTS[1]!))?.amountMinor).toBe(minor);
        },
      ),
    );
  });
});
