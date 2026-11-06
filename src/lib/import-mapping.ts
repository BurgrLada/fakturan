import { z } from "zod";
import { CURRENCIES } from "./currency";
import { foldText } from "./fold-text";
import { isCalendarDate, type CalendarDate } from "./number-format";
import { decimalToMinor } from "./safe-input/decimal";
import { InputRejected } from "./safe-input/limits";
import { TEXTS } from "./texts";

const M = TEXTS.importing.mapping;

export const MAPPING_TARGETS = ["customers", "catalog", "invoices"] as const;
export type MappingTarget = (typeof MAPPING_TARGETS)[number];

export const DATE_FORMATS = ["dmy", "ymd", "mdy"] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];
export const DECIMAL_SEPARATORS = [",", "."] as const;
export type DecimalSeparator = (typeof DECIMAL_SEPARATORS)[number];

export type FieldKind = "text" | "date" | "money" | "quantity" | "rate" | "integer";
// `document`: a value of the whole invoice, read from its first line only; further lines of the
// same number may leave it empty.
export type FieldSpec = { kind: FieldKind; required?: true; document?: true };

const text: FieldSpec = { kind: "text" };
const money: FieldSpec = { kind: "money" };
const head = (kind: FieldKind): FieldSpec => ({ kind, document: true });

export const MAPPING_FIELDS = {
  customers: {
    name: { kind: "text", required: true },
    street: text,
    city: text,
    zip: text,
    country: text,
    ico: text,
    dic: text,
    email: text,
    phone: text,
    note: text,
    dueDays: { kind: "integer" },
    currency: text,
  },
  catalog: {
    name: { kind: "text", required: true },
    description: text,
    unit: text,
    price: { kind: "money", required: true },
    currency: text,
    category: text,
  },
  invoices: {
    number: { kind: "text", required: true },
    issueDate: { kind: "date", required: true, document: true },
    dueDate: head("date"),
    taxableDate: head("date"),
    paidOn: head("date"),
    variableSymbol: head("text"),
    customerName: head("text"),
    customerStreet: head("text"),
    customerCity: head("text"),
    customerZip: head("text"),
    customerCountry: head("text"),
    customerIco: head("text"),
    customerDic: head("text"),
    customerEmail: head("text"),
    currency: head("text"),
    exchangeRate: head("rate"),
    total: head("money"),
    note: head("text"),
    lineName: { kind: "text", required: true },
    lineDescription: text,
    lineQuantity: { kind: "quantity" },
    lineUnit: text,
    lineUnitPrice: money,
    lineTotal: money,
  },
} as const satisfies Record<MappingTarget, Record<string, FieldSpec>>;

export type MappingField<T extends MappingTarget = MappingTarget> =
  keyof (typeof MAPPING_FIELDS)[T] & string;

export function fieldsOf(target: MappingTarget): [string, FieldSpec][] {
  return Object.entries(MAPPING_FIELDS[target]);
}

export function fieldLabel(target: MappingTarget, field: string): string {
  return (M.fields[target] as Record<string, string>)[field] ?? field;
}

const header = z
  .string(M.errors.invalid)
  .trim()
  .min(1, M.errors.invalid)
  .max(200, M.errors.invalid);

// Columns are kept by header name, not position, so a preset still fits the next export.
export const mappingSchema = z
  .strictObject(
    {
      target: z.enum(MAPPING_TARGETS, M.errors.invalid),
      columns: z.record(z.string().max(40), header, M.errors.invalid),
      dateFormat: z.enum(DATE_FORMATS, M.errors.invalid),
      decimal: z.enum(DECIMAL_SEPARATORS, M.errors.invalid),
      currency: z.enum(CURRENCIES, M.errors.invalid),
      source: z.string(M.errors.invalid).trim().max(200, M.errors.invalid),
    },
    M.errors.invalid,
  )
  .superRefine((value, ctx) => {
    const fields = MAPPING_FIELDS[value.target] as Record<string, FieldSpec>;
    for (const key of Object.keys(value.columns)) {
      if (!(key in fields)) ctx.addIssue({ code: "custom", message: M.errors.unknownField });
    }
    for (const [key, spec] of Object.entries(fields)) {
      if (spec.required && !value.columns[key]) {
        ctx.addIssue({
          code: "custom",
          path: ["columns", key],
          message: M.errors.required(fieldLabel(value.target, key)),
        });
      }
    }
    if (value.target === "invoices") {
      if (!value.columns.lineUnitPrice && !value.columns.lineTotal) {
        ctx.addIssue({ code: "custom", message: M.errors.linePrice });
      }
      if (!value.source) ctx.addIssue({ code: "custom", message: M.errors.source });
    }
  });

export type Mapping = z.output<typeof mappingSchema>;

export type SheetFormat = "csv" | "xlsx";
export type TabularSheet = { format: SheetFormat; headers: string[]; rows: string[][] };
export type TabularSample = TabularSheet & { total: number };
export const SAMPLE_ROWS = 20;

export function defaultMapping(target: MappingTarget, headers: string[]): Mapping {
  return {
    target,
    columns: guessColumns(target, headers),
    dateFormat: "dmy",
    decimal: ",",
    currency: "CZK",
    source: "",
  };
}

// Header names a person or a common export would use for a field, folded.
const ALIASES: Record<string, string[]> = {
  name: ["nazev", "jmeno", "name", "firma", "polozka"],
  street: ["ulice", "street", "adresa"],
  city: ["mesto", "obec", "city"],
  zip: ["psc", "zip"],
  country: ["zeme", "stat", "country"],
  ico: ["ico", "registration_no"],
  dic: ["dic", "vat_no"],
  email: ["e-mail", "email"],
  phone: ["telefon", "phone"],
  note: ["poznamka", "note"],
  dueDays: ["splatnost", "due"],
  currency: ["mena", "currency"],
  description: ["popis", "description"],
  unit: ["jednotka", "unit"],
  price: ["cena", "price", "cena za jednotku"],
  category: ["kategorie", "category"],
  number: ["cislo", "cislo dokladu", "cislo faktury", "number"],
  issueDate: ["datum vystaveni", "vystaveno", "issued_on"],
  dueDate: ["datum splatnosti", "splatno", "due_on"],
  taxableDate: ["duzp", "datum zdanitelneho plneni", "taxable_fulfillment_due"],
  paidOn: ["datum uhrady", "uhrazeno", "paid_on"],
  variableSymbol: ["variabilni symbol", "vs", "variable_symbol"],
  customerName: ["zakaznik", "odberatel", "client_name"],
  exchangeRate: ["kurz", "exchange_rate"],
  total: ["celkem", "total"],
  lineName: ["polozka", "nazev polozky"],
  lineQuantity: ["mnozstvi", "quantity"],
  lineUnit: ["jednotka", "unit"],
  lineUnitPrice: ["cena za jednotku", "jednotkova cena", "unit_price"],
  lineTotal: ["cena polozky", "cena celkem", "line_total"],
};

export function guessColumns(target: MappingTarget, headers: string[]): Record<string, string> {
  const columns: Record<string, string> = {};
  const used = new Set<string>();
  for (const [field] of fieldsOf(target)) {
    const wanted = new Set([foldText(fieldLabel(target, field)), ...(ALIASES[field] ?? [])]);
    const found = headers.find((h) => h.trim() && !used.has(h) && wanted.has(foldText(h.trim())));
    if (found) {
      columns[field] = found.trim();
      used.add(found);
    }
  }
  return columns;
}

export function missingColumns(headers: string[], mapping: Pick<Mapping, "columns">): string[] {
  const present = new Set(headers.map((h) => h.trim()));
  return [...new Set(Object.values(mapping.columns))].filter((h) => !present.has(h));
}

class CellInvalid extends Error {}

const SPACES = /[\s  ]/g;
const PLAIN = { ",": /^[+-]?\d+(,\d*)?$/, ".": /^[+-]?\d+(\.\d*)?$/ } as const;
const GROUPED = { ",": /^[+-]?\d{1,3}(\.\d{3})+(,\d*)?$/, ".": /^[+-]?\d{1,3}(,\d{3})+(\.\d*)?$/ };
// A number cell of a workbook holds the value itself, always with a dot.
const XLSX_NUMBER = /^-?\d+(\.\d+)?$/;

// Foreign decimals stay strings until decimalToMinor: never Number or parseFloat.
export function readDecimal(
  raw: string,
  scale: number,
  decimal: DecimalSeparator,
  format: SheetFormat,
): number {
  const value = raw.replace(SPACES, "");
  if (format === "xlsx" && XLSX_NUMBER.test(value)) return decimalToMinor(value, scale);
  const grouping = decimal === "," ? "." : ",";
  if (!PLAIN[decimal].test(value) && !GROUPED[decimal].test(value)) throw new CellInvalid();
  return decimalToMinor(value.replaceAll(grouping, "").replace(decimal, "."), scale);
}

const DATE_PATTERNS: Record<DateFormat, RegExp> = {
  dmy: /^(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})$/,
  ymd: /^(\d{4})-(\d{1,2})-(\d{1,2})$/,
  mdy: /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/,
};
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 86_400_000;
const EXCEL_SERIAL = /^\d{1,7}(\.\d+)?$/;
const MAX_SERIAL = 2_958_465;

export function readDate(raw: string, dateFormat: DateFormat, format: SheetFormat): CalendarDate {
  const value = raw.trim();
  if (format === "xlsx" && EXCEL_SERIAL.test(value)) {
    const serial = Number(value.split(".")[0]);
    if (serial < 1 || serial > MAX_SERIAL) throw new CellInvalid();
    return new Date(EXCEL_EPOCH + serial * MS_PER_DAY).toISOString().slice(0, 10);
  }
  // A date with a time after it, as some exports write it: only the day counts.
  const day = value.replace(/[ T]\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?Z?$/, "");
  const match = DATE_PATTERNS[dateFormat].exec(day);
  if (!match) throw new CellInvalid();
  const [a, b, c] = match.slice(1) as [string, string, string];
  const [year, month, dayOfMonth] =
    dateFormat === "dmy" ? [c, b, a] : dateFormat === "mdy" ? [c, a, b] : [a, b, c];
  const result = `${year}-${month.padStart(2, "0")}-${dayOfMonth.padStart(2, "0")}`;
  if (!isCalendarDate(result)) throw new CellInvalid();
  return result;
}

export type MappedValue = string | number | null;
export type MappedRow = {
  // The line in the file as a spreadsheet shows it: the header is line 1.
  line: number;
  values: Record<string, MappedValue>;
  errors: string[];
};

const shown = (value: string) => (value.length > 40 ? `${value.slice(0, 40)}…` : value);

function convert(kind: FieldKind, raw: string, mapping: Mapping, format: SheetFormat): MappedValue {
  switch (kind) {
    case "text":
      return raw;
    case "date":
      return readDate(raw, mapping.dateFormat, format);
    case "money":
      return readDecimal(raw, 2, mapping.decimal, format);
    case "quantity":
      return readDecimal(raw, 3, mapping.decimal, format);
    case "rate":
      return readDecimal(raw, 6, mapping.decimal, format);
    case "integer":
      if (!/^\d{1,6}$/.test(raw)) throw new CellInvalid();
      return Number(raw);
  }
}

// Empty lines are left out; every other line keeps its number, so an error points into the file.
export function applyMapping(sheet: TabularSheet, mapping: Mapping): MappedRow[] {
  const index = new Map<string, number>();
  sheet.headers.forEach((h, i) => {
    if (!index.has(h.trim())) index.set(h.trim(), i);
  });
  const fields = MAPPING_FIELDS[mapping.target] as Record<string, FieldSpec>;
  const rows: MappedRow[] = [];
  sheet.rows.forEach((cells, i) => {
    if (cells.every((cell) => cell.trim() === "")) return;
    const line = i + 2;
    const values: Record<string, MappedValue> = {};
    const errors: string[] = [];
    for (const [field, column] of Object.entries(mapping.columns)) {
      const spec = fields[field];
      if (!spec) continue;
      const at = index.get(column);
      const raw = at === undefined ? "" : (cells[at] ?? "").trim();
      if (raw === "") {
        values[field] = spec.kind === "text" ? "" : null;
        if (spec.required && !spec.document) errors.push(M.errors.missingValue(line, column));
        continue;
      }
      try {
        values[field] = convert(spec.kind, raw, mapping, sheet.format);
      } catch (error) {
        if (!(error instanceof CellInvalid) && !(error instanceof InputRejected)) throw error;
        values[field] = null;
        errors.push(
          spec.kind === "date"
            ? M.errors.date(line, column, shown(raw))
            : M.errors.number(line, column, shown(raw)),
        );
      }
    }
    rows.push({ line, values, errors });
  });
  return rows;
}

export const textOf = (row: MappedRow, field: string): string => {
  const value = row.values[field];
  return typeof value === "string" ? value : "";
};

export const numberOf = (row: MappedRow, field: string): number | null => {
  const value = row.values[field];
  return typeof value === "number" ? value : null;
};

export const dateOf = (row: MappedRow, field: string): CalendarDate | null => {
  const value = row.values[field];
  return typeof value === "string" && value !== "" ? value : null;
};

export function rowsLabel(lines: number[]): string {
  if (lines.length === 1) return M.line(lines[0]!);
  const listed = lines.slice(0, 5).join(", ");
  return M.lines(lines.length > 5 ? `${listed}, …` : listed);
}
