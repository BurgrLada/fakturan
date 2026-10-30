import type { CalendarDate } from "./number-format";
import type { DateFormat, Language } from "./preferences";

export const VARIABLE_NAMES = [
  "ctvrtleti",
  "pololeti",
  "mesic",
  "mesic_nazev",
  "rok",
  "obdobi_od",
  "obdobi_do",
  "cislo_faktury",
  "zakaznik",
] as const;

export type VariableName = (typeof VARIABLE_NAMES)[number];

export type VariablePeriod = { from: CalendarDate; to: CalendarDate };

export type VariableContext = {
  period: VariablePeriod;
  language: Language;
  dateFormat: DateFormat;
  number: string;
  customer: string;
};

// Printed on the document in its own language, so they do not belong to the UI texts.
const MONTH_NAMES: Record<Language, readonly string[]> = {
  cs: [
    "leden",
    "únor",
    "březen",
    "duben",
    "květen",
    "červen",
    "červenec",
    "srpen",
    "září",
    "říjen",
    "listopad",
    "prosinec",
  ],
  en: [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ],
};

const VARIABLE = /\{\{([^{}]*)\}\}/g;

function dateParts(date: CalendarDate) {
  const [year = "", month = "", day = ""] = date.split("-");
  return { year, month, day };
}

export function formatCalendarDate(date: CalendarDate, format: DateFormat): string {
  const { year, month, day } = dateParts(date);
  if (format === "yyyy-MM-dd") return date;
  if (format === "dd.MM.yyyy") return `${day}.${month}.${year}`;
  return `${Number(day)}. ${Number(month)}. ${year}`;
}

export function monthPeriod(date: CalendarDate): VariablePeriod {
  const { year, month } = dateParts(date);
  const lastDay = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  return { from: `${year}-${month}-01`, to: `${year}-${month}-${lastDay}` };
}

function variableValues(ctx: VariableContext): Record<VariableName, string> {
  const { year, month } = dateParts(ctx.period.from);
  const monthNumber = Number(month);
  return {
    ctvrtleti: String(Math.ceil(monthNumber / 3)),
    pololeti: monthNumber <= 6 ? "1" : "2",
    mesic: String(monthNumber),
    mesic_nazev: MONTH_NAMES[ctx.language][monthNumber - 1] ?? "",
    rok: year,
    obdobi_od: formatCalendarDate(ctx.period.from, ctx.dateFormat),
    obdobi_do: formatCalendarDate(ctx.period.to, ctx.dateFormat),
    cislo_faktury: ctx.number,
    zakaznik: ctx.customer,
  };
}

function isVariableName(name: string): name is VariableName {
  return (VARIABLE_NAMES as readonly string[]).includes(name);
}

// A single replace pass, so a substituted value is never scanned for further variables (SEC-011).
export function renderVariables(text: string, ctx: VariableContext): string {
  const values = variableValues(ctx);
  return text.replace(VARIABLE, (match, name: string) =>
    isVariableName(name) ? values[name] : match,
  );
}

export function validateVariables(text: string): string[] {
  const names = [...text.matchAll(VARIABLE)].map((match) => match[1]!);
  return [...new Set(names.filter((name) => !isVariableName(name)))];
}
