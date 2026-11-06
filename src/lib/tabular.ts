import type { Currency } from "./currency";
import type { CalendarDate } from "./number-format";

// Text is always neutralized (EXP-008); money never is, or a negative amount would turn into text.
export type Cell =
  | { kind: "text"; value: string }
  | { kind: "money"; minor: number; currency: Currency }
  | { kind: "number"; value: number }
  | { kind: "date"; value: CalendarDate }
  | null;

export type Money = Extract<Cell, { kind: "money" }>;

export type Sheet = { name: string; columns: string[]; rows: Cell[][] };

export const text = (value: string): Cell => ({ kind: "text", value });
export const money = (minor: number, currency: Currency): Cell => ({
  kind: "money",
  minor,
  currency,
});
export const count = (value: number): Cell => ({ kind: "number", value });

// A leading apostrophe makes spreadsheets read the cell as text (EXP-008).
export function neutralizeCsvCell(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

// Integer arithmetic only: minor units never pass through a float.
export function decimalMinor(minor: number, separator: "," | "."): string {
  if (!Number.isSafeInteger(minor)) throw new RangeError(`Neplatná částka: ${minor}`);
  const abs = Math.abs(minor);
  const whole = Math.trunc(abs / 100);
  const fraction = String(abs % 100).padStart(2, "0");
  return `${minor < 0 ? "-" : ""}${whole}${separator}${fraction}`;
}

function czechDate(date: CalendarDate): string {
  const [year, month, day] = date.split("-").map(Number);
  return `${day}.${month}.${year}`;
}

function csvValue(cell: Cell): string {
  if (cell === null) return "";
  switch (cell.kind) {
    case "text":
      return neutralizeCsvCell(cell.value);
    case "money":
      return decimalMinor(cell.minor, ",");
    case "number":
      return String(cell.value).replace(".", ",");
    case "date":
      return czechDate(cell.value);
  }
}

function csvField(value: string): string {
  return /[";\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export const CSV_BOM = "\ufeff";

export function csvHeader(columns: string[]): string {
  return `${columns.map((column) => csvField(neutralizeCsvCell(column))).join(";")}\r\n`;
}

export function csvRow(row: Cell[]): string {
  return `${row.map((cell) => csvField(csvValue(cell))).join(";")}\r\n`;
}

// Czech Excel opens it directly: UTF-8 BOM, semicolons and a decimal comma (REP-004).
export function toCsv(sheet: Sheet): string {
  return CSV_BOM + csvHeader(sheet.columns) + sheet.rows.map(csvRow).join("");
}
