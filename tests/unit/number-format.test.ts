import { describe, expect, test } from "vitest";
import {
  calendarDateInPrague,
  formatNumber,
  NUMBER_PRESETS,
  periodKey,
  previewNumber,
  validateSeriesPeriod,
  validateTemplate,
  variableSymbolFrom,
} from "@/lib/number-format";

describe("šablona čísla", () => {
  test("[NUM-001] {RRRR}-{NNN} pro 40. fakturu 2026 je 2026-040", () => {
    expect(formatNumber("{RRRR}-{NNN}", "2026-03-14", 40)).toBe("2026-040");
  });

  test("[NUM-001] šablona bez {N} nebo se dvěma je neplatná", () => {
    expect(validateTemplate("{RRRR}")).toBeTruthy();
    expect(validateTemplate("{N}-{NN}")).toBeTruthy();
    expect(validateTemplate("{RRRR}-{NNN}")).toBeNull();
  });

  test("[NUM-001] neznámý token, sedm míst a osamělá závorka jsou neplatné", () => {
    expect(validateTemplate("{ROK}-{N}")).toBeTruthy();
    expect(validateTemplate("{NNNNNNN}")).toBeTruthy();
    expect(validateTemplate("{N}{")).toBeTruthy();
    expect(validateTemplate("{N}}")).toBeTruthy();
    expect(validateTemplate("{NNNNNN}")).toBeNull();
  });

  test("[NUM-001] {NN} po 99 dá 100, nezkrátí se", () => {
    expect(formatNumber("{NN}", "2026-01-01", 99)).toBe("99");
    expect(formatNumber("{NN}", "2026-01-01", 100)).toBe("100");
  });

  test("[NUM-001] {Q} dá čtvrtletí a {DD} den z data dokladu", () => {
    expect(formatNumber("{RR}Q{Q}-{MM}{DD}-{N}", "2026-04-07", 3)).toBe("26Q2-0407-3");
    expect(formatNumber("{Q}", "2026-12-31", 1).startsWith("4")).toBe(true);
  });

  test("[NUM-001] volný text se zachová beze změny", () => {
    expect(formatNumber("$&-FV/{N}", "2026-01-01", 7)).toBe("$&-FV/7");
  });

  test("[NUM-001] nesmyslné datum dokladu se odmítne", () => {
    expect(() => formatNumber("{N}", "2026-13-01", 1)).toThrow();
    expect(() => formatNumber("{N}", "2026-02-30", 1)).toThrow();
    expect(() => formatNumber("{N}", "30.10.2026", 1)).toThrow();
  });

  test("[NUM-008] každá předvolba dá očekávaný příklad", () => {
    const examples = NUMBER_PRESETS.map((p) => formatNumber(p.template, "2026-10-30", 40));

    expect(examples).toEqual([
      "2026-040",
      "2026-0040",
      "2026040",
      "26040",
      "2026/040",
      "FV-2026-040",
      "40/2026",
      "202610040",
    ]);
    for (const preset of NUMBER_PRESETS) {
      expect(validateTemplate(preset.template)).toBeNull();
      expect(validateSeriesPeriod(preset.template, preset.reset)).toBeNull();
    }
  });

  test("[NUM-006] náhled formátu", () => {
    expect(previewNumber("FV-{RRRR}-{NNN}", "2026-10-30", 7)).toBe("FV-2026-007");
    expect(previewNumber("{RRRR}", "2026-10-30", 7)).toBeNull();
  });
});

describe("období počítadla", () => {
  test("[NUM-002] klíč období se bere z data dokladu", () => {
    expect(periodKey("yearly", "2026-12-31")).toBe("2026");
    expect(periodKey("quarterly", "2026-04-01")).toBe("2026-Q2");
    expect(periodKey("monthly", "2026-04-01")).toBe("2026-04");
    expect(periodKey("never", "2026-04-01")).toBe("all");
  });

  test("[NUM-002] reset vyžaduje v šabloně období, jinak by se čísla opakovala", () => {
    expect(validateSeriesPeriod("{NNN}", "yearly")).toBeTruthy();
    expect(validateSeriesPeriod("{MM}-{NNN}", "monthly")).toBeTruthy();
    expect(validateSeriesPeriod("{RRRR}-{NNN}", "monthly")).toBeTruthy();
    expect(validateSeriesPeriod("{RRRR}-{NNN}", "quarterly")).toBeTruthy();
    expect(validateSeriesPeriod("{RR}{Q}{NNN}", "quarterly")).toBeNull();
    expect(validateSeriesPeriod("{RR}{MM}{NNN}", "quarterly")).toBeNull();
    expect(validateSeriesPeriod("{RRRR}{MM}{NNN}", "monthly")).toBeNull();
    expect(validateSeriesPeriod("{NNN}", "never")).toBeNull();
  });

  test("[NUM-002] dnešek se počítá v pražském čase", () => {
    expect(calendarDateInPrague(new Date("2026-12-31T23:30:00Z"))).toBe("2027-01-01");
  });
});

describe("variabilní symbol", () => {
  test("[NUM-007] 2026-040 dá VS 2026040 a delší číslo se omezí na 10 číslic", () => {
    expect(variableSymbolFrom("2026-040")).toBe("2026040");
    expect(variableSymbolFrom("FV-2026/10-123456")).toBe("2610123456");
  });
});
