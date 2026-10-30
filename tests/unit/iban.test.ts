import { describe, expect, test } from "vitest";
import { czechAccountToIban, isValidIban } from "@/lib/iban";

describe("IBAN", () => {
  test("[SET-020] číslo 1234567890/2010 se převede na platný IBAN", () => {
    const iban = czechAccountToIban("1234567890", "2010");

    expect(iban).toMatch(/^CZ\d{2}2010000000\d{10}$/);
    expect(iban).toBe("CZ2120100000001234567890");
    expect(isValidIban(iban)).toBe(true);
  });

  test("[SET-020] předčíslí se doplní nulami na šest míst", () => {
    expect(czechAccountToIban("2000145399", "0800", "19")).toBe("CZ6508000000192000145399");
    expect(czechAccountToIban("19-2000145399", "0800")).toBe("CZ6508000000192000145399");
  });

  test("[SET-020] neplatné české číslo účtu se odmítne", () => {
    expect(() => czechAccountToIban("12ab", "2010")).toThrow();
    expect(() => czechAccountToIban("1-2-3456789", "2010")).toThrow();
    expect(() => czechAccountToIban("1234567890", "20")).toThrow();
    expect(() => czechAccountToIban("12345678901", "2010")).toThrow();
    expect(() => czechAccountToIban("1234567890", "2010", "1234567")).toThrow();
  });

  test("[SET-020] isValidIban zná platné a neplatné IBAN", () => {
    expect(isValidIban("CZ65 0800 0000 1920 0014 5399")).toBe(true);
    expect(isValidIban("de89370400440532013000")).toBe(true);
    expect(isValidIban("CZ6608000000192000145399")).toBe(false);
    expect(isValidIban("CZ65")).toBe(false);
    expect(isValidIban("")).toBe(false);
  });
});
