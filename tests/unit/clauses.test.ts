import { describe, expect, test } from "vitest";
import {
  EU_COUNTRY_CODES,
  isEuVatId,
  REVERSE_CHARGE_CLAUSE,
  splitVatId,
  suggestedClause,
} from "@/lib/clauses";

const base = {
  foreign: true,
  language: "cs" as const,
  vatIdentified: true,
  customerDic: "DE123456789",
  texts: REVERSE_CHARGE_CLAUSE,
};

describe("doložka o přenesení daňové povinnosti", () => {
  test("[FOR-006] identifikovaná osoba a DE123456789 dostanou doložku v češtině", () => {
    expect(suggestedClause(base)).toBe(REVERSE_CHARGE_CLAUSE.cs);
  });

  test("[FOR-006] neidentifikovaná osoba, CZ DIČ a třetí země doložku nedostanou", () => {
    expect(suggestedClause({ ...base, vatIdentified: false })).toBe("");
    expect(suggestedClause({ ...base, customerDic: "CZ12345678" })).toBe("");
    expect(suggestedClause({ ...base, customerDic: "GB123456789" })).toBe("");
    expect(suggestedClause({ ...base, customerDic: "" })).toBe("");
    expect(suggestedClause({ ...base, foreign: false })).toBe("");
  });

  test("[FOR-007] doložka je v jazyce faktury a z nastavení dodavatele", () => {
    expect(suggestedClause({ ...base, language: "en" })).toBe(REVERSE_CHARGE_CLAUSE.en);
    const texts = { cs: "Vlastní", en: "Own" };
    expect(suggestedClause({ ...base, language: "en", texts })).toBe("Own");
  });

  test("[FOR-006] VAT ID se pozná i s mezerami a malými písmeny, řecké má prefix EL", () => {
    expect(isEuVatId("de 123 456 789")).toBe(true);
    expect(isEuVatId("EL123456789")).toBe(true);
    expect(isEuVatId("cz12345678")).toBe(false);
    expect(isEuVatId("123456789")).toBe(false);
    expect(EU_COUNTRY_CODES).not.toContain("CZ");
    expect(EU_COUNTRY_CODES).toHaveLength(26);
  });

  test("rozdělení VAT ID", () => {
    expect(splitVatId("DE 123")).toEqual({ country: "DE", number: "123" });
    expect(splitVatId("x")).toBeNull();
  });
});
