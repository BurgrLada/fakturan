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

  const SHEET = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const text = (value: string) => new TextEncoder().encode(value);
  const sheetXml = (data: string) =>
    text(`<worksheet xmlns="${SHEET}"><sheetData>${data}</sheetData></worksheet>`);
  const rows = async (data: string, shared: string[] = [], limits = TABULAR_LIMITS) =>
    (await readXlsx(xlsxOf(data, shared), limits)).rows;

  test("[IMP-001] odkaz buňky určí sloupec jen v úplném tvaru písmena a číslo", async () => {
    expect(await rows('<row r="12"><c r="C12"><v>1</v></c></row>')).toEqual([
      ...Array.from({ length: 11 }, () => []),
      ["", "", "1"],
    ]);
    expect(await rows('<row r="1"><c r="AB1"><v>1</v></c></row>')).toEqual([
      [...Array.from({ length: 27 }, () => ""), "1"],
    ]);
    expect(await rows('<row r="1"><c r="xB1"><v>1</v></c><c r="D1x"><v>2</v></c></row>')).toEqual([
      ["1", "2"],
    ]);
  });

  test("[IMP-001] řádek bez čísla nebo s neplatným číslem navazuje na předchozí", async () => {
    expect(
      await rows(
        '<row><c><v>a</v></c></row><row r="x"><c><v>b</v></c></row><row r="2x"><c><v>c</v></c></row><row r="x9"><c><v>d</v></c></row>',
      ),
    ).toEqual([["a"], ["b"], ["c"], ["d"]]);
    expect(
      await rejected(readXlsx(xlsxOf('<row r="0"><c><v>1</v></c></row>'), TABULAR_LIMITS)),
    ).toBe("tabular_too_many_rows");
    expect(await rows('<c r="A1"><v>mimo</v></c><row r="1"><c><v>1</v></c></row>')).toEqual([
      ["1"],
    ]);
  });

  test("[SEC-005] sloupec na limitu projde, za ním ne", async () => {
    const limits = { ...TABULAR_LIMITS, maxColumns: 2 };
    expect(await rows('<row r="1"><c r="B1"><v>1</v></c></row>', [], limits)).toEqual([["", "1"]]);
    expect(
      await rejected(readXlsx(xlsxOf('<row r="1"><c r="C1"><v>1</v></c></row>'), limits)),
    ).toBe("tabular_too_many_columns");
  });

  test("[IMP-001] sdílené řetězce: běhy textu, výslovnost vynechána, každý zvlášť a s limitem", async () => {
    const shared = ["<r><t>a</t></r><r><t>b</t></r><rPh><t>x</t></rPh>", "c"];
    const xml = text(`<sst xmlns="${SHEET}"><si>${shared[0]}</si><si>zz<t>c</t></si></sst>`);
    const book = rawZip([
      ...unzipped(
        xlsxOf(
          '<row r="1"><c t="s"><v>0</v></c><c t="s"><v>1</v></c><c t="s"><v>7</v></c><c t="s"><v>1x</v></c></row>',
        ),
      ).filter((part) => part.name !== "xl/sharedStrings.xml"),
      { name: "xl/sharedStrings.xml", data: xml },
    ]);
    expect((await readXlsx(book, TABULAR_LIMITS)).rows).toEqual([["ab", "c", "", ""]]);
    const many = xlsxOf('<row r="1"><c><v>1</v></c></row>', ["a", "b", "c"]);
    expect(await rejected(readXlsx(many, { maxRows: 1, maxColumns: 2 }))).toBe(
      "tabular_too_many_rows",
    );
    const fits = xlsxOf('<row r="1"><c><v>1</v></c></row>', ["a", "b"]);
    expect((await readXlsx(fits, { maxRows: 1, maxColumns: 2 })).rows).toEqual([["1"]]);
  });

  test("[IMP-001] typy buněk str, inlineStr mimo is a číslo bez typu", async () => {
    expect(
      await rows(
        '<row r="1"><c t="str"><v>=A1</v></c><c t="inlineStr"><t>x</t></c><c><v>5</v><t>y</t></c><c t="n"><is><t>z</t></is><v>6</v></c></row>',
      ),
    ).toEqual([["=A1", "", "5", "6"]]);
    expect(await rows('<row r="1"><c t="str"><v>\'=A1</v></c></row>')).toEqual([["=A1"]]);
  });

  test("[SEC-005] list se čte s limity XML: hloubka i dlouhý text jsou odmítnuté", async () => {
    const deep = `<row r="1"><c><v>1</v></c></row>${"<x>".repeat(40)}${"</x>".repeat(40)}`;
    expect(await rejected(readXlsx(xlsxOf(deep), TABULAR_LIMITS))).toBe("xml_depth");
    const long = `<row r="1"><c t="str"><v>${"a".repeat(130 * 1024)}</v></c></row>`;
    expect(await rejected(readXlsx(xlsxOf(long), TABULAR_LIMITS))).toBe("xml_text");
  });

  test("[IMP-001] cesta k prvnímu listu: výchozí bez vztahů, relativní, absolutní a mimo listy", async () => {
    const book = (rels: string | null, sheets: Record<string, string>, workbook?: string) =>
      rawZip([
        {
          name: "xl/workbook.xml",
          data: text(
            workbook ??
              `<workbook xmlns="${SHEET}" xmlns:r="${REL}"><sheets><sheet name="A" r:id="r1"/><sheet name="B" r:id="r2"/></sheets></workbook>`,
          ),
        },
        ...(rels === null ? [] : [{ name: "xl/_rels/workbook.xml.rels", data: text(rels) }]),
        ...Object.entries(sheets).map(([name, data]) => ({ name, data: sheetXml(data) })),
      ]);
    const rel = (id: string, target: string) => `<Relationship Id="${id}" Target="${target}"/>`;
    const one = '<row r="1"><c><v>1</v></c></row>';
    const two = '<row r="1"><c><v>2</v></c></row>';
    expect(await readXlsx(book(null, { "xl/worksheets/sheet1.xml": one }), TABULAR_LIMITS)).toEqual(
      {
        name: "A",
        rows: [["1"]],
      },
    );
    const rels = (...items: string[]) => `<Relationships>${items.join("")}</Relationships>`;
    expect(
      (
        await readXlsx(
          book(rels(rel("r2", "worksheets/sheet1.xml"), rel("r1", "worksheets/b.xml")), {
            "xl/worksheets/sheet1.xml": one,
            "xl/worksheets/b.xml": two,
          }),
          TABULAR_LIMITS,
        )
      ).rows,
    ).toEqual([["2"]]);
    expect(
      (
        await readXlsx(
          book(rels(rel("r1", "/xl/worksheets/b.xml")), { "xl/worksheets/b.xml": two }),
          TABULAR_LIMITS,
        )
      ).rows,
    ).toEqual([["2"]]);
    expect(
      (
        await readXlsx(
          book(rels(rel("r1", "worksheets/b.xml"), rel("r2", "worksheets/sheet1.xml")), {
            "xl/worksheets/sheet1.xml": one,
            "xl/worksheets/b.xml": two,
          }),
          TABULAR_LIMITS,
        )
      ).rows,
    ).toEqual([["2"]]);
    for (const [target, stored] of [
      ["/a/xl/worksheets/b.xml", "a/xl/worksheets/b.xml"],
      ["worksheets/b.xml.bak", "xl/worksheets/b.xml.bak"],
    ]) {
      expect(
        await rejected(readXlsx(book(rels(rel("r1", target)), { [stored]: two }), TABULAR_LIMITS)),
        target,
      ).toBe("xlsx_no_sheet");
    }
    for (const target of ["../evil.xml", "worksheets/sub/b.xml", "x/worksheets/b.xml"]) {
      expect(
        await rejected(
          readXlsx(book(rels(rel("r1", target)), { "xl/worksheets/b.xml": two }), TABULAR_LIMITS),
        ),
        target,
      ).toBe("xlsx_no_sheet");
    }
    expect(
      await rejected(readXlsx(book(rels(rel("r1", "worksheets/chybi.xml")), {}), TABULAR_LIMITS)),
    ).toBe("xlsx_no_sheet");
    const unnamed = `<workbook xmlns="${SHEET}"><sheets><sheet/></sheets></workbook>`;
    expect(
      await readXlsx(
        book(
          rels(rel("", "worksheets/b.xml")),
          { "xl/worksheets/sheet1.xml": one, "xl/worksheets/b.xml": two },
          unnamed,
        ),
        TABULAR_LIMITS,
      ),
    ).toEqual({
      name: "",
      rows: [["2"]],
    });
    expect(
      await rejected(
        readXlsx(
          rawZip([{ name: "xl/worksheets/sheet1.xml", data: sheetXml(one) }]),
          TABULAR_LIMITS,
        ),
      ),
    ).toBe("xlsx_no_sheet");
  });

  test("[IMP-001] sdílený řetězec s víceciferným indexem", async () => {
    const shared = Array.from({ length: 11 }, (_, i) => `s${i}`);
    expect(await rows('<row r="1"><c t="s"><v>10</v></c></row>', shared)).toEqual([["s10"]]);
  });
});
