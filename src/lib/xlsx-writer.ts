import { strToU8, zipSync } from "fflate";
import { decimalMinor, type Cell, type Sheet } from "./tabular";

// The smallest SpreadsheetML workbook Excel and LibreOffice open: inline strings and built-in
// number formats 4 (#,##0.00) and 14 (date), so no shared strings or custom formats.
const STYLE = { money: 1, date: 2, header: 3 } as const;
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 86_400_000;

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

function escapeXml(value: string): string {
  return value
    .replace(/[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/gu, "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function columnName(index: number): string {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return name;
}

// An inlineStr cell is text by type and never evaluates, so it needs no CSV apostrophe (EXP-008).
function inline(ref: string, value: string, style?: number): string {
  const s = style === undefined ? "" : ` s="${style}"`;
  return `<c r="${ref}" t="inlineStr"${s}><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

function cellXml(ref: string, cell: Cell): string {
  if (cell === null) return "";
  switch (cell.kind) {
    case "text":
      return inline(ref, cell.value);
    case "money":
      return `<c r="${ref}" s="${STYLE.money}"><v>${decimalMinor(cell.minor, ".")}</v></c>`;
    case "number":
      return `<c r="${ref}"><v>${Number.isFinite(cell.value) ? cell.value : 0}</v></c>`;
    case "date": {
      const [year, month, day] = cell.value.split("-").map(Number) as [number, number, number];
      const serial = (Date.UTC(year, month - 1, day) - EXCEL_EPOCH) / MS_PER_DAY;
      return `<c r="${ref}" s="${STYLE.date}"><v>${serial}</v></c>`;
    }
  }
}

// Excel rejects names over 31 characters and the characters []:*?/\ in a sheet name.
function sheetName(name: string): string {
  const clean = name
    .replace(/[[\]:*?/\\]/g, "")
    .trim()
    .slice(0, 31);
  return clean || "List1";
}

const WORKSHEET_OPEN = `${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>`;
const WORKSHEET_CLOSE = "</sheetData></worksheet>";

function headerRow(columns: string[]): string {
  return `<row r="1">${columns
    .map((column, index) => inline(`${columnName(index)}1`, column, STYLE.header))
    .join("")}</row>`;
}

function rowXml(row: Cell[], rowIndex: number): string {
  const r = rowIndex + 2;
  return `<row r="${r}">${row.map((cell, index) => cellXml(`${columnName(index)}${r}`, cell)).join("")}</row>`;
}

function worksheet(sheet: Sheet): string {
  return `${WORKSHEET_OPEN}${headerRow(sheet.columns)}${sheet.rows.map(rowXml).join("")}${WORKSHEET_CLOSE}`;
}

function contentTypes(count: number): string {
  const sheets = Array.from(
    { length: count },
    (_, i) =>
      `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
  ).join("");
  return `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;
}

const ROOT_RELS = `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`;

const APP = `${XML}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Fakturan</Application></Properties>`;

// The styles part takes the id after the last sheet.
function workbookRels(count: number): string {
  const sheets = Array.from(
    { length: count },
    (_, i) =>
      `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
  ).join("");
  return `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets}<Relationship Id="rId${count + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
}

const STYLES = `${XML}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`;

// Excel refuses a workbook with two sheets of the same name, compared without case.
function sheetNames(names: string[]): string[] {
  const taken = new Set<string>();
  return names.map((name) => {
    const base = sheetName(name);
    let candidate = base;
    for (let n = 2; taken.has(candidate.toLocaleLowerCase("cs")); n += 1) {
      const suffix = ` (${n})`;
      candidate = base.slice(0, 31 - suffix.length) + suffix;
    }
    taken.add(candidate.toLocaleLowerCase("cs"));
    return candidate;
  });
}

function workbook(names: string[]): string {
  const sheets = sheetNames(names)
    .map((name, i) => `<sheet name="${escapeXml(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join("");
  return `${XML}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets}</sheets></workbook>`;
}

function fixedParts(names: string[]): Record<string, string> {
  return {
    "[Content_Types].xml": contentTypes(names.length),
    "_rels/.rels": ROOT_RELS,
    "docProps/app.xml": APP,
    "xl/workbook.xml": workbook(names),
    "xl/_rels/workbook.xml.rels": workbookRels(names.length),
    "xl/styles.xml": STYLES,
  };
}

export function toXlsx(sheet: Sheet): Uint8Array {
  // A fixed timestamp keeps the archive byte-identical for the same sheet.
  const mtime = new Date(Date.UTC(2000, 0, 1));
  const parts = Object.fromEntries(
    Object.entries(fixedParts([sheet.name])).map(([name, xml]) => [name, strToU8(xml)]),
  );
  return zipSync(
    { ...parts, "xl/worksheets/sheet1.xml": strToU8(worksheet(sheet)) },
    { level: 6, mtime },
  );
}

export type SheetStream = {
  name: string;
  columns: string[];
  rows: Iterable<Cell[]> | AsyncIterable<Cell[]>;
};

// The archive the workbook goes into; a zip-writer on disk in production.
export type XlsxSink = {
  addDeflated(name: string, data: string): void;
  deflatedEntry(name: string): { push(chunk: string): void; end(): void };
};

const ROWS_PER_CHUNK = 200;

// Several sheets row by row: a sheet is never assembled in memory, so its size is bounded only by
// the archive limit of the sink.
export async function buildSheets(sink: XlsxSink, sheets: SheetStream[]): Promise<void> {
  for (const [name, xml] of Object.entries(fixedParts(sheets.map((sheet) => sheet.name)))) {
    sink.addDeflated(name, xml);
  }
  for (const [index, sheet] of sheets.entries()) {
    const entry = sink.deflatedEntry(`xl/worksheets/sheet${index + 1}.xml`);
    entry.push(WORKSHEET_OPEN + headerRow(sheet.columns));
    let rowIndex = 0;
    let chunk = "";
    for await (const row of sheet.rows) {
      chunk += rowXml(row, rowIndex);
      rowIndex += 1;
      if (rowIndex % ROWS_PER_CHUNK === 0) {
        entry.push(chunk);
        chunk = "";
      }
    }
    entry.push(chunk + WORKSHEET_CLOSE);
    entry.end();
  }
}
