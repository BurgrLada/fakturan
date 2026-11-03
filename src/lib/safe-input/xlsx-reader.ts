import { restoreNeutralized } from "./csv";
import {
  InputRejected,
  type TabularLimits,
  XML_LIMITS,
  type XmlLimits,
  ZIP_LIMITS,
} from "./limits";
import { walkXml } from "./xml";
import { readZipEntries } from "./zip";

export type SheetData = { name: string; rows: string[][] };

const MiB = 1024 * 1024;
const WORKBOOK = "xl/workbook.xml";
const WORKBOOK_RELS = "xl/_rels/workbook.xml.rels";
const SHARED_STRINGS = "xl/sharedStrings.xml";
const WORKSHEET = /^xl\/worksheets\/[^/]+\.xml$/;
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
// A sheet part compresses far better than an invoice; the archive total still caps the sum.
const XLSX_ZIP_LIMITS = { ...ZIP_LIMITS, maxEntryBytes: 50 * MiB };
const CELL_REF = /^([A-Z]{1,3})(\d+)$/;

function xmlLimits(limits: TabularLimits): XmlLimits {
  return {
    ...XML_LIMITS,
    maxBytes: XLSX_ZIP_LIMITS.maxEntryBytes,
    maxNodes: limits.maxRows * limits.maxColumns * 4 + 10_000,
    maxTextBytes: 128 * 1024,
  };
}

function columnIndex(letters: string): number {
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

function firstSheet(
  parts: Map<string, Uint8Array>,
  limits: XmlLimits,
): { name: string; path: string } | null {
  const workbook = parts.get(WORKBOOK);
  if (!workbook) return null;
  let sheet: { name: string; id: string } | null = null;
  walkXml(workbook, limits, {
    open(name, _ns, attributes) {
      if (name === "sheet" && !sheet) {
        sheet = { name: attributes.name ?? "", id: attributes[`{${REL_NS}}id`] ?? "" };
      }
    },
  });
  if (!sheet) return null;
  const { name, id } = sheet as { name: string; id: string };
  let target: string | undefined;
  const rels = parts.get(WORKBOOK_RELS);
  if (rels) {
    walkXml(rels, limits, {
      open(element, _ns, attributes) {
        if (element === "Relationship" && attributes.Id === id) target = attributes.Target;
      },
    });
  }
  const path =
    target === undefined
      ? "xl/worksheets/sheet1.xml"
      : target.startsWith("/")
        ? target.slice(1)
        : `xl/${target}`;
  return { name, path };
}

function sharedStrings(
  bytes: Uint8Array | undefined,
  xml: XmlLimits,
  limits: TabularLimits,
): string[] {
  if (!bytes) return [];
  const strings: string[] = [];
  const stack: string[] = [];
  let current = "";
  walkXml(bytes, xml, {
    open(name) {
      stack.push(name);
      if (name === "si") current = "";
    },
    text(value) {
      if (stack.at(-1) === "t" && !stack.includes("rPh")) current += value;
    },
    close(name) {
      stack.pop();
      if (name !== "si") return;
      strings.push(current);
      if (strings.length > limits.maxRows * limits.maxColumns) {
        throw new InputRejected("tabular_too_many_rows");
      }
    },
  });
  return strings;
}

function readSheet(
  bytes: Uint8Array,
  shared: string[],
  xml: XmlLimits,
  limits: TabularLimits,
): string[][] {
  const rows: string[][] = [];
  const stack: string[] = [];
  let row = -1;
  let column = -1;
  let type = "n";
  let value = "";
  let inline = "";

  walkXml(bytes, xml, {
    open(name, _ns, attributes) {
      stack.push(name);
      if (name === "row") {
        const r = attributes.r;
        row = r !== undefined && /^\d+$/.test(r) ? Number(r) - 1 : row + 1;
        if (row < 0 || row >= limits.maxRows) throw new InputRejected("tabular_too_many_rows");
        while (rows.length <= row) rows.push([]);
        column = -1;
      } else if (name === "c") {
        const ref = CELL_REF.exec(attributes.r ?? "");
        column = ref ? columnIndex(ref[1]!) : column + 1;
        if (column >= limits.maxColumns) throw new InputRejected("tabular_too_many_columns");
        type = attributes.t ?? "n";
        value = "";
        inline = "";
      }
    },
    // <f> is never read: a formula from a foreign file reaches nothing, only its cached <v> does.
    text(text) {
      const element = stack.at(-1);
      if (element === "v" && stack.at(-2) === "c") value += text;
      else if (element === "t" && stack.includes("is") && !stack.includes("rPh")) inline += text;
    },
    close(name) {
      stack.pop();
      if (name !== "c" || row < 0) return;
      const cells = rows[row]!;
      while (cells.length < column) cells.push("");
      cells[column] = cellValue(type, value, inline, shared);
    },
  });
  return rows;
}

function cellValue(type: string, value: string, inline: string, shared: string[]): string {
  switch (type) {
    case "s":
      return /^\d+$/.test(value) ? restoreNeutralized(shared[Number(value)] ?? "") : "";
    case "inlineStr":
      return restoreNeutralized(inline);
    case "str":
      return restoreNeutralized(value);
    case "e":
      return "";
    default:
      return value;
  }
}

async function readParts(bytes: Uint8Array, names: Set<string>): Promise<Map<string, Uint8Array>> {
  const parts = new Map<string, Uint8Array>();
  await readZipEntries(
    bytes,
    { ...XLSX_ZIP_LIMITS, select: (name) => names.has(name) },
    (entry) => {
      parts.set(entry.name, entry.bytes);
    },
  );
  return parts;
}

// Only the first sheet of the workbook is read. Two passes keep the other sheets out of memory:
// which part is the first sheet is known only after the workbook and its relations.
export async function readXlsx(bytes: Uint8Array, limits: TabularLimits): Promise<SheetData> {
  const xml = xmlLimits(limits);
  const sheet = firstSheet(await readParts(bytes, new Set([WORKBOOK, WORKBOOK_RELS])), xml);
  if (!sheet || !WORKSHEET.test(sheet.path)) throw new InputRejected("xlsx_no_sheet");
  const parts = await readParts(bytes, new Set([sheet.path, SHARED_STRINGS]));
  const sheetBytes = parts.get(sheet.path);
  if (!sheetBytes) throw new InputRejected("xlsx_no_sheet");
  const shared = sharedStrings(parts.get(SHARED_STRINGS), xml, limits);
  return { name: sheet.name, rows: readSheet(sheetBytes, shared, xml, limits) };
}
