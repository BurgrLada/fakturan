import "server-only";
import type { CalendarDate } from "@/lib/number-format";
import type { TaxFilter } from "@/lib/report-filter";
import { formatMoney } from "@/lib/money";
import { money, text, toCsv, type Cell, type Sheet } from "@/lib/tabular";
import { lineNote, unconvertedText } from "@/lib/tax-text";
import { TEXTS } from "@/lib/texts";
import { toXlsx } from "@/lib/xlsx-writer";
import type { Actor } from "../audit/context";
import { db } from "../db";
import { renderTaxOverviewPdf } from "../pdf/tax-overview";
import { RATE_RULES } from "../rate-limit";
import { taxOverview as overviewOf, type TaxOverview } from "../reports/tax";
import { enforceRateLimit, ServiceError } from "./access";
import { mutate } from "./mutation";

const T = TEXTS.tax;
const C = T.columns;

export const TAX_EXPORT_FORMATS = ["pdf", "xlsx", "csv"] as const;
export type TaxExportFormat = (typeof TAX_EXPORT_FORMATS)[number];

export type { TaxOverview };

export function taxOverview(ownerId: string, filter: TaxFilter, today: CalendarDate): TaxOverview {
  return overviewOf(db, ownerId, filter, today);
}

const date = (value: string | null): Cell => (value ? { kind: "date", value } : null);
const czk = (minor: number | null): Cell => (minor === null ? null : money(minor, "CZK"));

// R-29: the notice is the first row of the sheet, above anything a reader could copy on its own.
export function taxSheet(overview: TaxOverview): Sheet {
  const totalLabel =
    overview.basis === "paid" ? T.incomeTotal(overview.year) : T.issuedTotal(overview.year);
  const notes = [
    overview.estimated.count > 0
      ? T.estimated(overview.estimated.count, formatMoney(overview.estimated.czkMinor, "CZK"))
      : null,
    unconvertedText(overview.unconverted),
    unconvertedText(overview.unpaidUnconverted),
  ].filter((note): note is string => note !== null);
  const typeOf = (type: TaxOverview["lines"][number]["type"]) =>
    text(TEXTS.invoices.list.types[type]);
  return {
    name: `${T.title} ${overview.year}`,
    columns: [T.disclaimer],
    rows: [
      [text(`${T.title} ${overview.year}`), text(T.bases[overview.basis])],
      [],
      [C.date, C.number, C.type, C.customer, C.currency, C.amount, C.czk, C.note].map(text),
      ...overview.lines.map((line) => [
        date(line.date),
        text(line.number),
        typeOf(line.type),
        text(line.customer),
        text(line.currency),
        money(line.amountMinor, line.currency),
        czk(line.czkMinor),
        text(lineNote(line)),
      ]),
      [text(totalLabel), null, null, null, null, null, money(overview.totalCzkMinor, "CZK")],
      ...notes.map((note) => [text(note)]),
      [],
      [text(T.unpaidTitle(overview.asOf, overview.asOfToday))],
      [C.issueDate, C.dueDate, C.number, C.type, C.customer, C.currency, C.due, C.czk].map(text),
      ...overview.unpaid.map((row) => [
        date(row.issueDate),
        date(row.dueDate),
        text(row.number),
        typeOf(row.type),
        text(row.customer),
        text(row.currency),
        money(row.dueMinor, row.currency),
        czk(row.czkMinor),
      ]),
      [
        text(T.unpaidTotal),
        null,
        null,
        null,
        null,
        null,
        null,
        money(overview.unpaidCzkMinor, "CZK"),
      ],
      [text(T.cancelledNote)],
    ],
  };
}

export type TaxFile = { filename: string; contentType: string; body: string | Uint8Array };

// Computed straight from the database: an export must never come from a stale cache entry.
export async function exportTaxOverview(
  actor: Actor,
  input: TaxFilter & { today: CalendarDate },
  format: TaxExportFormat,
): Promise<TaxFile> {
  const ownerId = actor.userId;
  if (!ownerId) throw new ServiceError(T.errors.signedOut);
  enforceRateLimit(actor, RATE_RULES.exportUser);
  const overview = overviewOf(db, ownerId, input, input.today);
  mutate(actor, "tax.export", (_tx, audit) =>
    audit({
      entity: "tax_overview",
      entityId: String(input.year),
      ownerId,
      scope: "user",
      after: { format, year: input.year, basis: input.basis, lines: overview.lines.length },
    }),
  );
  const filename = `danovy-podklad-${input.year}-${input.basis}.${format}`;
  if (format === "pdf") {
    return {
      filename,
      contentType: "application/pdf",
      body: new Uint8Array(await renderTaxOverviewPdf(overview)),
    };
  }
  const sheet = taxSheet(overview);
  return format === "csv"
    ? { filename, contentType: "text/csv; charset=utf-8", body: toCsv(sheet) }
    : {
        filename,
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        body: toXlsx(sheet),
      };
}
