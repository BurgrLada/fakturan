import { strFromU8, unzipSync } from "fflate";
import { describe, expect, test } from "vitest";
import { money, neutralizeCsvCell, text, toCsv, type Sheet } from "@/lib/tabular";
import { toXlsx } from "@/lib/xlsx-writer";

const sheet = (rows: Sheet["rows"]): Sheet => ({
  name: "Fakturace",
  columns: ["Název", "Částka"],
  rows,
});

describe("CSV", () => {
  test("[REP-004] CSV má BOM, středník, desetinnou čárku a částku -2 500,00 jako číslo", () => {
    const csv = toCsv(
      sheet([
        [text("Dobropis"), money(-250_000, "CZK")],
        [text("Faktura; „A“"), money(123_456_789, "EUR")],
        [text('Řádek "s" uvozovkami'), money(5, "CZK")],
        [null, { kind: "number", value: 12.5 }],
        [text("Den"), { kind: "date", value: "2026-11-02" }],
      ]),
    );
    expect(csv.startsWith("﻿")).toBe(true);
    const lines = csv.slice(1).split("\r\n");
    expect(lines[0]).toBe("Název;Částka");
    expect(lines[1]).toBe("Dobropis;-2500,00");
    expect(lines[2]).toBe('"Faktura; „A“";1234567,89');
    expect(lines[3]).toBe('"Řádek ""s"" uvozovkami";0,05');
    expect(lines[4]).toBe(";12,5");
    expect(lines[5]).toBe("Den;2.11.2026");
    expect(lines.at(-1)).toBe("");
  });

  test("[REP-004] text =1+1, +cmd, -2+3 a @SUM se neutralizuje v CSV i XLSX, záporná částka ne", () => {
    const dangerous = ["=1+1", "+cmd", "-2+3", "@SUM(A1)"];
    const data = sheet(dangerous.map((value) => [text(value), money(-100, "CZK")]));
    const csv = toCsv(data);
    for (const value of dangerous) expect(csv).toContain(`'${value};-1,00`);
    expect(csv).not.toContain("'-1,00");

    const files = unzipSync(toXlsx(data));
    const xml = strFromU8(files["xl/worksheets/sheet1.xml"]!);
    for (const value of dangerous) expect(xml).toContain(`<t xml:space="preserve">'${value}</t>`);
    expect(xml).toContain("<v>-1.00</v>");
    expect(xml).not.toContain("<f>");
  });

  test("neutralizace nechá běžný text beze změny", () => {
    expect(neutralizeCsvCell("Faktura 1")).toBe("Faktura 1");
    expect(neutralizeCsvCell("\tx")).toBe("'\tx");
  });
});
