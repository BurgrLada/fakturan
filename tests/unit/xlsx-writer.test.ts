import { strFromU8, strToU8, unzipSync, Zip, ZipDeflate } from "fflate";
import { describe, expect, test } from "vitest";
import { TABULAR_LIMITS } from "@/lib/safe-input/limits";
import { readXlsx } from "@/lib/safe-input/xlsx-reader";
import { money, text, toCsv, type Sheet } from "@/lib/tabular";
import { buildSheets, toXlsx } from "@/lib/xlsx-writer";

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

function memorySink() {
  const chunks: Uint8Array[] = [];
  const zip = new Zip((error, chunk) => {
    if (error) throw error;
    chunks.push(chunk);
  });
  const deflatedEntry = (name: string) => {
    const entry = new ZipDeflate(name, { level: 6 });
    zip.add(entry);
    return {
      push: (chunk: string) => entry.push(strToU8(chunk), false),
      end: () => entry.push(new Uint8Array(0), true),
    };
  };
  return {
    addDeflated(name: string, data: string) {
      const entry = deflatedEntry(name);
      entry.push(data);
      entry.end();
    },
    deflatedEntry,
    bytes() {
      zip.end();
      const out = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
      }
      return out;
    },
  };
}

async function* slowRows(count: number) {
  for (let i = 0; i < count; i += 1) {
    await Promise.resolve();
    yield [text(`Doklad ${i}`), money(-50_000, "CZK")];
  }
}

describe("XLSX více listů proudově", () => {
  test("[EXP-001] buildSheets zapíše dva listy po řádcích a první přečte i čtečka importu", async () => {
    const sink = memorySink();
    await buildSheets(sink, [
      { name: "Doklady", columns: ["Číslo", "Celkem"], rows: slowRows(450) },
      { name: "Doklady", columns: ["Název"], rows: [[text("=1+1")], [text("Položka")]] },
    ]);
    const bytes = sink.bytes();
    const files = unzipSync(bytes);
    const workbook = strFromU8(files["xl/workbook.xml"]!);
    expect(workbook).toContain('<sheet name="Doklady" sheetId="1" r:id="rId1"/>');
    expect(workbook).toContain('<sheet name="Doklady (2)" sheetId="2" r:id="rId2"/>');
    const rels = strFromU8(files["xl/_rels/workbook.xml.rels"]!);
    expect(rels).toContain('Id="rId2"');
    expect(rels).toContain(
      'Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles"',
    );
    expect(strFromU8(files["[Content_Types].xml"]!)).toContain("/xl/worksheets/sheet2.xml");

    const first = await readXlsx(bytes, TABULAR_LIMITS);
    expect(first.rows).toHaveLength(451);
    expect(first.rows[450]).toEqual(["Doklad 449", "-500.00"]);

    const second = strFromU8(files["xl/worksheets/sheet2.xml"]!);
    expect(second).toContain('<t xml:space="preserve">\'=1+1</t>');
    expect(second.endsWith("</sheetData></worksheet>")).toBe(true);
  });

  test("toXlsx a buildSheets dají pro jeden list stejné části", async () => {
    const sink = memorySink();
    await buildSheets(sink, [SHEET]);
    const streamed = unzipSync(sink.bytes());
    const whole = unzipSync(toXlsx(SHEET));
    for (const name of Object.keys(whole)) {
      expect(strFromU8(streamed[name]!), name).toBe(strFromU8(whole[name]!));
    }
  });
});
