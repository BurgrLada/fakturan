import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatMoney } from "@/lib/money";
import {
  TAX_BASES,
  TAX_BASIS_PARAM,
  taxParams,
  taxYears,
  type TaxFilter,
} from "@/lib/report-filter";
import { lineNote, TAX_TEXT_REVIEWED, unconvertedText } from "@/lib/tax-text";
import { formatCalendarDate } from "@/lib/template-vars";
import { TEXTS } from "@/lib/texts";
import type { TaxOverview, TaxPage } from "@/server/reports/tax";

const T = TEXTS.tax;
const C = T.columns;

const day = (date: string | null) => (date ? formatCalendarDate(date, "d. M. yyyy") : "–");
const czk = (minor: number | null) => (minor === null ? "–" : formatMoney(minor, "CZK"));

// A GET form: the year and basis stay in the address, like the filters of the other reports.
function Picker({ filter, today }: { filter: TaxFilter; today: string }) {
  return (
    <form method="get" className="flex flex-wrap items-end gap-3" aria-label={T.title}>
      <label className="flex flex-col gap-1 text-sm">
        {T.year}
        <NativeSelect name="rok" defaultValue={String(filter.year)} className="w-28">
          {taxYears(today).map((year) => (
            <option key={year} value={year}>
              {year}
            </option>
          ))}
        </NativeSelect>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        {T.basis}
        <NativeSelect name="zaklad" defaultValue={TAX_BASIS_PARAM[filter.basis]} className="w-52">
          {TAX_BASES.map((basis) => (
            <option key={basis} value={TAX_BASIS_PARAM[basis]}>
              {T.bases[basis]}
            </option>
          ))}
        </NativeSelect>
      </label>
      <button type="submit" className={buttonVariants({ variant: "outline" })}>
        {T.show}
      </button>
    </form>
  );
}

function ExportButtons({ filter }: { filter: TaxFilter }) {
  return (
    <form
      method="post"
      action="/prehledy/dane/export"
      aria-label={T.exportLabel}
      className="flex flex-wrap gap-2"
    >
      {Object.entries(taxParams(filter)).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {(
        [
          ["pdf", T.exportPdf],
          ["xlsx", T.exportXlsx],
          ["csv", T.exportCsv],
        ] as const
      ).map(([format, label]) => (
        <button
          key={format}
          type="submit"
          name="format"
          value={format}
          className={buttonVariants({ variant: "outline" })}
        >
          {label}
        </button>
      ))}
    </form>
  );
}

export function TaxOverviewView({
  overview,
  filter,
  today,
}: {
  // The page gets at most TAX_PAGE_ROWS of each table and the full counts; the exports have all.
  overview: TaxOverview | TaxPage;
  filter: TaxFilter;
  today: string;
}) {
  const linesCount = "linesCount" in overview ? overview.linesCount : overview.lines.length;
  const unpaidCount = "unpaidCount" in overview ? overview.unpaidCount : overview.unpaid.length;
  const totalLabel =
    overview.basis === "paid" ? T.incomeTotal(overview.year) : T.issuedTotal(overview.year);
  const missing = unconvertedText(overview.unconverted);
  const unpaidMissing = unconvertedText(overview.unpaidUnconverted);
  return (
    <div className="space-y-4">
      <div
        role="note"
        data-testid="tax-disclaimer"
        className="space-y-1 rounded-md border bg-muted p-3 text-sm"
      >
        <p>{T.disclaimer}</p>
        {!TAX_TEXT_REVIEWED && (
          <p className="text-xs text-muted-foreground" data-testid="tax-review">
            {T.reviewPending}
          </p>
        )}
      </div>
      <Picker filter={filter} today={today} />
      <section aria-labelledby="tax-total" className="space-y-1 rounded-md border p-3">
        <p id="tax-total" className="text-sm text-muted-foreground">
          {totalLabel}
        </p>
        <p className="text-xl font-medium tabular-nums" data-testid="tax-total">
          {czk(overview.totalCzkMinor)}
        </p>
        {overview.estimated.count > 0 && (
          <p className="text-sm" data-testid="tax-estimated">
            {T.estimated(overview.estimated.count, czk(overview.estimated.czkMinor))}
          </p>
        )}
        {missing && (
          <p className="text-sm text-destructive" data-testid="tax-unconverted">
            {missing}
          </p>
        )}
      </section>
      <section className="space-y-2">
        <h2 className="text-lg">{T.linesTitle[overview.basis]}</h2>
        {overview.lines.length === 0 ? (
          <p className="text-sm text-muted-foreground">{T.empty}</p>
        ) : (
          <Table aria-label={T.linesTitle[overview.basis]}>
            <TableHeader>
              <TableRow>
                <TableHead>{C.date}</TableHead>
                <TableHead>{C.number}</TableHead>
                <TableHead className="hidden sm:table-cell">{C.customer}</TableHead>
                <TableHead className="text-right">{C.amount}</TableHead>
                <TableHead className="text-right">{C.czk}</TableHead>
                <TableHead className="hidden sm:table-cell">{C.note}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {overview.lines.map((line, index) => (
                <TableRow key={`${line.invoiceId}-${index}`}>
                  <TableCell>{day(line.date)}</TableCell>
                  <TableCell>
                    <Link
                      href={`/faktury/${line.invoiceId}`}
                      className="underline-offset-4 hover:underline"
                    >
                      {line.number}
                    </Link>
                  </TableCell>
                  <TableCell className="hidden whitespace-normal sm:table-cell">
                    {line.customer}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatMoney(line.amountMinor, line.currency)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{czk(line.czkMinor)}</TableCell>
                  <TableCell className="hidden whitespace-normal text-xs sm:table-cell">
                    {lineNote(line)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {linesCount > overview.lines.length && (
          <p className="text-sm text-muted-foreground">
            {T.truncated(overview.lines.length, linesCount)}
          </p>
        )}
      </section>
      <section className="space-y-2">
        <h2 className="text-lg">{T.unpaidTitle(day(overview.asOf), overview.asOfToday)}</h2>
        {overview.unpaid.length === 0 ? (
          <p className="text-sm text-muted-foreground">{T.unpaidEmpty}</p>
        ) : (
          <Table aria-label={T.unpaidTitle(day(overview.asOf), overview.asOfToday)}>
            <TableHeader>
              <TableRow>
                <TableHead>{C.number}</TableHead>
                <TableHead className="hidden sm:table-cell">{C.customer}</TableHead>
                <TableHead className="hidden sm:table-cell">{C.dueDate}</TableHead>
                <TableHead className="text-right">{C.due}</TableHead>
                <TableHead className="text-right">{C.czk}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {overview.unpaid.map((row) => (
                <TableRow key={row.invoiceId}>
                  <TableCell>
                    <Link
                      href={`/faktury/${row.invoiceId}`}
                      className="underline-offset-4 hover:underline"
                    >
                      {row.number}
                    </Link>
                  </TableCell>
                  <TableCell className="hidden whitespace-normal sm:table-cell">
                    {row.customer}
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">{day(row.dueDate)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatMoney(row.dueMinor, row.currency)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{czk(row.czkMinor)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {unpaidCount > overview.unpaid.length && (
          <p className="text-sm text-muted-foreground">
            {T.truncated(overview.unpaid.length, unpaidCount)}
          </p>
        )}
        <p className="text-sm">
          {T.unpaidTotal}: <span className="tabular-nums">{czk(overview.unpaidCzkMinor)}</span>
        </p>
        {unpaidMissing && <p className="text-sm text-destructive">{unpaidMissing}</p>}
        <p className="text-xs text-muted-foreground">{T.cancelledNote}</p>
      </section>
      <ExportButtons filter={filter} />
    </div>
  );
}
