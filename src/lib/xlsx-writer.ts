import { strToU8, zipSync } from "fflate";
import { decimalMinor, neutralizeCsvCell, type Cell, type Sheet } from "./tabular";

// The smallest SpreadsheetML workbook Excel and LibreOffice open: one sheet, inline strings and
// built-in number formats 4 (#,##0.00) and 14 (date), so no shared strings or custom formats.
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

function inline(ref: string, value: string, style?: number): string {
  const s = style === undefined ? "" : ` s="${style}"`;
  return `<c r="${ref}" t="inlineStr"${s}><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

function cellXml(ref: string, cell: Cell): string {
  if (cell === null) return "";
  switch (cell.kind) {
    case "text":
      return inline(ref, neutralizeCsvCell(cell.value));
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

function worksheet(sheet: Sheet): string {
  const header = `<row r="1">${sheet.columns
    .map((column, index) =>
      inline(`${columnName(index)}1`, neutralizeCsvCell(column), STYLE.header),
    )
    .join("")}</row>`;
  const rows = sheet.rows.map((row, rowIndex) => {
    const r = rowIndex + 2;
    return `<row r="${r}">${row.map((cell, index) => cellXml(`${columnName(index)}${r}`, cell)).join("")}</row>`;
  });
  return `${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${header}${rows.join("")}</sheetData></worksheet>`;
}

const CONTENT_TYPES = `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;

const ROOT_RELS = `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`;

const APP = `${XML}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Fakturan</Application></Properties>`;

const WORKBOOK_RELS = `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

const STYLES = `${XML}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`;

function workbook(name: string): string {
  return `${XML}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${escapeXml(sheetName(name))}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
}

export function toXlsx(sheet: Sheet): Uint8Array {
  // A fixed timestamp keeps the archive byte-identical for the same sheet.
  const mtime = new Date(Date.UTC(2000, 0, 1));
  return zipSync(
    {
      "[Content_Types].xml": strToU8(CONTENT_TYPES),
      "_rels/.rels": strToU8(ROOT_RELS),
      "docProps/app.xml": strToU8(APP),
      "xl/workbook.xml": strToU8(workbook(sheet.name)),
      "xl/_rels/workbook.xml.rels": strToU8(WORKBOOK_RELS),
      "xl/styles.xml": strToU8(STYLES),
      "xl/worksheets/sheet1.xml": strToU8(worksheet(sheet)),
    },
    { level: 6, mtime },
  );
}
