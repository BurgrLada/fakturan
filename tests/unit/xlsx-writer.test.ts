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

describe("XLSX balík", () => {
  test("[REP-004] list má přesný tvar, prázdná buňka chybí a každá část nese hlavičku XML", () => {
    const sheet: Sheet = {
      name: `  ${"Dlouhý název listu přes limit Excelu"}  `,
      columns: ["A", 'Uvozovky "x"'],
      rows: [
        [text("a\u0001b"), null],
        [null, { kind: "number", value: 2 }],
      ],
    };
    const files = unzipSync(toXlsx(sheet));
    const xml = strFromU8(files["xl/worksheets/sheet1.xml"]!);
    const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
    expect(xml).toBe(
      `${head}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>` +
        '<row r="1"><c r="A1" t="inlineStr" s="3"><is><t xml:space="preserve">A</t></is></c>' +
        '<c r="B1" t="inlineStr" s="3"><is><t xml:space="preserve">Uvozovky &quot;x&quot;</t></is></c></row>' +
        '<row r="2"><c r="A2" t="inlineStr"><is><t xml:space="preserve">ab</t></is></c></row>' +
        '<row r="3"><c r="B3"><v>2</v></c></row>' +
        "</sheetData></worksheet>",
    );
    expect(strFromU8(files["xl/workbook.xml"]!)).toContain(
      '<sheet name="Dlouhý název listu přes limit E" sheetId="1" r:id="rId1"/>',
    );
    for (const [path, part] of Object.entries(files)) {
      expect(strFromU8(part).startsWith(head), path).toBe(true);
    }
    expect(strFromU8(files["[Content_Types].xml"]!)).toContain(
      'PartName="/xl/worksheets/sheet1.xml"',
    );
    expect(strFromU8(files["_rels/.rels"]!)).toContain('Target="xl/workbook.xml"');
    expect(strFromU8(files["docProps/app.xml"]!)).toContain("<Application>Fakturan</Application>");
    expect(strFromU8(files["xl/_rels/workbook.xml.rels"]!)).toContain(
      'Target="worksheets/sheet1.xml"',
    );
  });

  test("sloupec za AZ je BA a archiv má pevné datum souborů", () => {
    const wide: Sheet = {
      name: "S",
      columns: Array.from({ length: 53 }, (_, i) => `${i}`),
      rows: [],
    };
    const zip = toXlsx(wide);
    const xml = strFromU8(unzipSync(zip)["xl/worksheets/sheet1.xml"]!);
    expect(xml).toContain('r="AZ1"');
    expect(xml).toContain('r="BA1"');
    expect(xml).not.toContain('r="BZ1"');
    const dosDate = zip[12]! | (zip[13]! << 8);
    expect([1999, 2000]).toContain((dosDate >> 9) + 1980);
  });
});
