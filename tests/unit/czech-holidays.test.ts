import { describe, expect, test } from "vitest";
import { czechHolidays, easterSunday, isWorkingDay } from "@/lib/czech-holidays";

describe("české svátky", () => {
  test.each([
    [2024, "2024-03-31"],
    [2025, "2025-04-20"],
    [2026, "2026-04-05"],
    [2027, "2027-03-28"],
    [2028, "2028-04-16"],
    [2029, "2029-04-01"],
    [2030, "2030-04-21"],
  ])("Velikonoce 2024 až 2030 odpovídají tabulce: %i", (year, date) => {
    expect(easterSunday(year)).toBe(date);
  });

  // The extremes of the Gregorian computus, including the years where the Gauss rule needs a correction.
  test.each([
    [1818, "1818-03-22"],
    [1954, "1954-04-18"],
    [1981, "1981-04-19"],
    [2000, "2000-04-23"],
    [2008, "2008-03-23"],
    [2011, "2011-04-24"],
    [2033, "2033-04-17"],
    [2038, "2038-04-25"],
    [2049, "2049-04-18"],
    [2076, "2076-04-19"],
    [2100, "2100-03-28"],
    [2285, "2285-03-22"],
  ])("Velikonoce v mezních letech: %i", (year, date) => {
    expect(easterSunday(year)).toBe(date);
  });

  test("rok 2026 má 13 svátků včetně Velkého pátku a Velikonočního pondělí, seřazených", () => {
    expect(czechHolidays(2026)).toEqual([
      "2026-01-01",
      "2026-04-03",
      "2026-04-06",
      "2026-05-01",
      "2026-05-08",
      "2026-07-05",
      "2026-07-06",
      "2026-09-28",
      "2026-10-28",
      "2026-11-17",
      "2026-12-24",
      "2026-12-25",
      "2026-12-26",
    ]);
  });

  test("Velký pátek a pondělí přes hranici měsíce", () => {
    expect(czechHolidays(2024).slice(0, 3)).toEqual(["2024-01-01", "2024-03-29", "2024-04-01"]);
    expect(czechHolidays(2029).slice(0, 3)).toEqual(["2029-01-01", "2029-03-30", "2029-04-02"]);
  });

  test.each([
    ["2026-10-30", true, "pátek"],
    ["2026-11-02", true, "pondělí"],
    ["2026-04-02", true, "čtvrtek před Velkým pátkem"],
    ["2026-04-07", true, "úterý po Velikonocích"],
    ["2026-01-02", true, "pátek po Novém roce"],
    ["2026-10-31", false, "sobota"],
    ["2026-11-01", false, "neděle"],
    ["2026-10-28", false, "svátek ve středu"],
    ["2026-04-03", false, "Velký pátek"],
    ["2026-04-06", false, "Velikonoční pondělí"],
    ["2026-01-01", false, "Nový rok"],
  ])("[REC-002] pracovní den %s je %s (%s)", (date, expected) => {
    expect(isWorkingDay(date)).toBe(expected);
  });
});
