import { strFromU8, unzipSync } from "fflate";
import { describe, expect, test } from "vitest";
import { money, text, toCsv, type Sheet } from "@/lib/tabular";
import { toXlsx } from "@/lib/xlsx-writer";

const SHEET: Sheet = {
  name: "Zákazníci [2026]: A/B",
  columns: ["Zákazník", "Fakturováno", "Dokladů", "Den"],
  rows: [
    [text("Alfa & <Beta>"), money(4_410_000, "CZK"), { kind: "number", value: 3 }, null],
    [
      text("Gama"),
      money(-250_000, "CZK"),
      { kind: "number", value: 1 },
      { kind: "date", value: "2026-11-02" },
    ],
  ],
};

describe("XLSX", () => {
  test("[REP-004] XLSX po rozbalení obsahuje list, typy buněk a shodné hodnoty", () => {
    const files = unzipSync(toXlsx(SHEET));
    expect(Object.keys(files).sort()).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "docProps/app.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      "xl/workbook.xml",
      "xl/worksheets/sheet1.xml",
    ]);
    const workbook = strFromU8(files["xl/workbook.xml"]!);
    expect(workbook).toContain('<sheet name="Zákazníci 2026 AB" sheetId="1" r:id="rId1"/>');

    const xml = strFromU8(files["xl/worksheets/sheet1.xml"]!);
    expect(xml).toContain(
      '<c r="A1" t="inlineStr" s="3"><is><t xml:space="preserve">Zákazník</t></is></c>',
    );
    expect(xml).toContain(
      '<c r="A2" t="inlineStr"><is><t xml:space="preserve">Alfa &amp; &lt;Beta&gt;</t></is></c>',
    );
    expect(xml).toContain('<c r="B2" s="1"><v>44100.00</v></c>');
    expect(xml).toContain('<c r="C2"><v>3</v></c>');
    expect(xml).toContain('<c r="B3" s="1"><v>-2500.00</v></c>');
    expect(xml).toContain('<c r="D3" s="2"><v>46328</v></c>');
    expect(xml).not.toContain('r="D2"');

    const styles = strFromU8(files["xl/styles.xml"]!);
    expect(styles).toContain('numFmtId="4"');
    expect(styles).toContain('numFmtId="14"');

    const csv = toCsv(SHEET);
    expect(csv).toContain("Gama;-2500,00;1;2.11.2026");
  });

  test("sloupce za Z pokračují AA a list bez řádků má jen záhlaví", () => {
    const wide: Sheet = {
      name: "",
      columns: Array.from({ length: 28 }, (_, i) => `S${i}`),
      rows: [],
    };
    const files = unzipSync(toXlsx(wide));
    const xml = strFromU8(files["xl/worksheets/sheet1.xml"]!);
    expect(xml).toContain('r="AB1"');
    expect(strFromU8(files["xl/workbook.xml"]!)).toContain('name="List1"');
  });
});
