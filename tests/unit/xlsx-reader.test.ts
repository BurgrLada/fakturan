import { unzipSync } from "fflate";
import { describe, expect, test } from "vitest";
import { InputRejected, TABULAR_LIMITS } from "@/lib/safe-input/limits";
import { readXlsx } from "@/lib/safe-input/xlsx-reader";
import { toXlsx } from "@/lib/xlsx-writer";
import { hostile, rawZip, xlsxOf, xlsxWithFormula } from "../helpers/hostile-files";

function unzipped(bytes: Uint8Array) {
  return Object.entries(unzipSync(bytes)).map(([name, data]) => ({ name, data }));
}

async function rejected(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(InputRejected);
  return (error as InputRejected).code;
}

describe("čtení XLSX", () => {
  test("[SEC-005] XLSX s <f> vrací uloženou hodnotu, vzorec se nikam nedostane", async () => {
    const sheet = await readXlsx(xlsxWithFormula(), TABULAR_LIMITS);
    expect(sheet).toEqual({
      name: "Data",
      rows: [
        ["Název", "Částka"],
        ["klik", "1234.5"],
      ],
    });
    expect(JSON.stringify(sheet)).not.toMatch(/HYPERLINK|CMD|calc/);
  });

  test("první list podle sešitu, mezery v řádcích a sloupcích, typy buněk", async () => {
    const data =
      '<row r="1"><c r="B1" t="inlineStr"><is><r><t>a</t></r><r><t>b</t></r><rPh><t>x</t></rPh></is></c>' +
      '<c r="D1" t="b"><v>1</v></c><c r="E1" t="e"><v>#DIV/0!</v></c></row>' +
      '<row r="3"><c t="s"><v>0</v></c><c><v>-0.5</v></c></row>';
    const sheet = await readXlsx(xlsxOf(data, ["sdílený"]), TABULAR_LIMITS);
    expect(sheet.rows).toEqual([["", "ab", "", "1", ""], [], ["sdílený", "-0.5"]]);
  });

  test("vlastní export se přečte zpět a apostrof před spouštěčem zmizí", async () => {
    const bytes = toXlsx({
      name: "Faktury",
      columns: ["Číslo", "Částka", "Poznámka"],
      rows: [
        [
          { kind: "text", value: "2026-001" },
          { kind: "money", minor: -12345, currency: "CZK" },
          { kind: "text", value: "=SUM(A1)" },
        ],
      ],
    });
    const sheet = await readXlsx(bytes, TABULAR_LIMITS);
    expect(sheet.rows).toEqual([
      ["Číslo", "Částka", "Poznámka"],
      ["2026-001", "-123.45", "=SUM(A1)"],
    ]);
  });

  test("[SEC-005] limit řádků, sloupců a ZIP bomba v sešitu", async () => {
    const rows = Array.from(
      { length: 11 },
      (_, i) => `<row r="${i + 1}"><c><v>1</v></c></row>`,
    ).join("");
    expect(await rejected(readXlsx(xlsxOf(rows), { ...TABULAR_LIMITS, maxRows: 10 }))).toBe(
      "tabular_too_many_rows",
    );
    expect(
      await rejected(readXlsx(xlsxOf('<row r="1"><c r="GT1"><v>1</v></c></row>'), TABULAR_LIMITS)),
    ).toBe("tabular_too_many_columns");
    expect(
      await rejected(
        readXlsx(xlsxOf('<row r="50001"><c r="A50001"><v>1</v></c></row>'), TABULAR_LIMITS),
      ),
    ).toBe("tabular_too_many_rows");
    expect(await rejected(readXlsx(hostile.trueHeaderBomb(), TABULAR_LIMITS))).toMatch(
      /^zip_(ratio|entry_too_large)$/,
    );
  });

  test("[SEC-005] list mimo první se do paměti nenačte", async () => {
    // Stored, so it costs no inflate time; read whole it would break the 50 MiB limit of a sheet.
    const big = rawZip([
      ...unzipped(xlsxWithFormula()),
      {
        name: "xl/worksheets/obrovsky.xml",
        data: new Uint8Array(51 * 1024 * 1024).fill(0x20),
        method: 0,
      },
    ]);
    const sheet = await readXlsx(big, TABULAR_LIMITS);
    expect(sheet.rows[1]).toEqual(["klik", "1234.5"]);
  });

  test("soubor bez listu je chyba", async () => {
    const empty = rawZip([
      { name: "xl/workbook.xml", data: new TextEncoder().encode("<workbook/>") },
    ]);
    expect(await rejected(readXlsx(empty, TABULAR_LIMITS))).toBe("xlsx_no_sheet");
  });
});
