import { describe, expect, test } from "vitest";
import {
  MAIL_VARIABLE_NAMES,
  monthPeriod,
  renderVariables,
  validateVariables,
  VARIABLE_NAMES,
  type VariableContext,
} from "@/lib/template-vars";

const ctx = (over: Partial<VariableContext> = {}): VariableContext => ({
  period: { from: "2026-07-01", to: "2026-09-30" },
  language: "cs",
  dateFormat: "d. M. yyyy",
  number: "2026-040",
  customer: "Příklad, s.r.o.",
  ...over,
});

describe("proměnné v textu", () => {
  test("[TPL-004] dosadí všechny proměnné ze specifikace", () => {
    const text = VARIABLE_NAMES.map((name) => `${name}={{${name}}}`).join("|");

    expect(renderVariables(text, ctx())).toBe(
      "ctvrtleti=3|pololeti=2|mesic=7|mesic_nazev=červenec|rok=2026|" +
        "obdobi_od=1. 7. 2026|obdobi_do=30. 9. 2026|cislo_faktury=2026-040|zakaznik=Příklad, s.r.o.",
    );
  });

  test("[TPL-004] první pololetí a první čtvrtletí", () => {
    const period = { from: "2026-01-01", to: "2026-01-31" };

    expect(renderVariables("{{pololeti}}/{{ctvrtleti}}", ctx({ period }))).toBe("1/1");
  });

  test("[TPL-004] název měsíce a data se řídí jazykem a formátem", () => {
    const period = { from: "2026-03-01", to: "2026-03-31" };
    const en = ctx({ period, language: "en", dateFormat: "yyyy-MM-dd" });

    expect(renderVariables("{{mesic_nazev}} {{obdobi_od}}", en)).toBe("March 2026-03-01");
    expect(renderVariables("{{obdobi_do}}", ctx({ period, dateFormat: "dd.MM.yyyy" }))).toBe(
      "31.03.2026",
    );
  });

  test("[TPL-004] věta z příkladu specifikace", () => {
    expect(renderVariables("faktura za {{ctvrtleti}}. čtvrtletí {{rok}}", ctx())).toBe(
      "faktura za 3. čtvrtletí 2026",
    );
  });

  test("[SEC-011] hodnota obsahující proměnnou se dál nerozvine", () => {
    expect(renderVariables("{{zakaznik}} {{rok}}", ctx({ customer: "{{rok}}" }))).toBe(
      "{{rok}} 2026",
    );
  });

  test("[SEC-011] náhradní vzor v hodnotě se bere doslova", () => {
    expect(renderVariables("{{zakaznik}}", ctx({ customer: "$& $1" }))).toBe("$& $1");
  });

  test("[TPL-004] neznámá proměnná zůstane jako text", () => {
    expect(renderVariables("{{neznama}} {{constructor}}", ctx())).toBe(
      "{{neznama}} {{constructor}}",
    );
  });

  test("[TPL-004] validateVariables vrátí neznámé názvy bez opakování", () => {
    expect(validateVariables("{{rok}} {{neco}} {{neco}} {{ rok }}")).toEqual(["neco", " rok "]);
    expect(validateVariables("bez proměnných {{rok}}")).toEqual([]);
  });

  test("[TPL-004] období je kalendářní měsíc data", () => {
    expect(monthPeriod("2026-03-10")).toEqual({ from: "2026-03-01", to: "2026-03-31" });
    expect(monthPeriod("2024-02-29")).toEqual({ from: "2024-02-01", to: "2024-02-29" });
    expect(monthPeriod("2026-12-01")).toEqual({ from: "2026-12-01", to: "2026-12-31" });
  });
});

describe("proměnné e-mailů", () => {
  const extra = { castka: "3 000,00 Kč", zbyva: "1 000,00 Kč" };

  test("[MAIL-003] doplňkové proměnné se dosadí jen když je volající předá", () => {
    expect(renderVariables("{{castka}} / {{zbyva}} / {{rok}}", ctx(), extra)).toBe(
      "3 000,00 Kč / 1 000,00 Kč / 2026",
    );
    expect(renderVariables("{{zbyva}}", ctx())).toBe("{{zbyva}}");
  });

  test("[SEC-011] hodnota doplňkové proměnné se dál nerozvine", () => {
    expect(renderVariables("{{castka}} {{rok}}", ctx(), { castka: "{{rok}}" })).toBe(
      "{{rok}} 2026",
    );
  });

  test("[MAIL-003] doplňkový název z prototypu objektu se nebere", () => {
    expect(renderVariables("{{constructor}} {{toString}}", ctx(), {})).toBe(
      "{{constructor}} {{toString}}",
    );
  });

  test("[MAIL-003] validace zná seznam e-mailů a ten v dokladech zůstává užší", () => {
    expect(validateVariables("{{zbyva}} {{vs}} {{rok}} {{nic}}", MAIL_VARIABLE_NAMES)).toEqual([
      "nic",
    ]);
    expect(validateVariables("{{zbyva}}")).toEqual(["zbyva"]);
  });
});
