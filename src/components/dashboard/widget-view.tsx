import { Chart } from "@/components/charts/chart";
import { CHART_TOKENS, type ChartSpec, type ValueFormat } from "@/components/charts/chart-spec";
import { UnconvertedNote } from "@/components/reports/unconverted-note";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ChartToken } from "@/lib/chart-tokens";
import type { DateFormat } from "@/lib/preferences";
import type { CompareMode } from "@/lib/report-period";
import { bucketLabel } from "@/lib/report-filter";
import { formatCalendarDate } from "@/lib/template-vars";
import { TEXTS } from "@/lib/texts";
import {
  isAdditive,
  isBucketUnit,
  type QueryWidgetConfig,
  type WidgetConfig,
} from "@/lib/widget-config";
import type { WidgetResult, WidgetRow, WidgetSeries } from "@/server/reports/widget-query";
import { SystemBody } from "./system/system-body";
import { WidgetEmpty } from "./widget-empty";
import { formatWidgetValue, WidgetNumber, type WidgetUnit } from "./widget-number";

// Rendering only, without data access, so the configurator preview draws exactly what the card does.

const T = TEXTS.dashboard;
const V = T.view;
const R = TEXTS.reports;

export function widgetTitle(config: WidgetConfig | null): string {
  if (!config) return V.untitled;
  if (config.title) return config.title;
  return config.kind === "system" ? T.gallery[config.systemId] : V.untitled;
}

function isBalance(config: WidgetConfig): boolean {
  if (config.kind === "query")
    return config.measure === "outstanding" || config.measure === "overdue";
  return ["aging", "open_advances", "due_alerts", "unmatched_payments"].includes(config.systemId);
}

function hasPeriod(config: WidgetConfig): boolean {
  if (config.kind === "query") return !isBalance(config);
  return config.systemId === "paid_ratio" || config.systemId === "forecast";
}

// The card says which period it really shows, so "Fakturováno letos" under a filter does not lie.
function Subtitle({
  config,
  result,
  dateFormat,
}: {
  config: WidgetConfig;
  result?: WidgetResult;
  dateFormat: DateFormat;
}) {
  let text: string | null = null;
  if (isBalance(config)) text = V.asOfToday;
  else if (hasPeriod(config) && result) {
    text = V.range(
      formatCalendarDate(result.range.from, dateFormat),
      formatCalendarDate(result.range.to, dateFormat),
    );
  }
  if (!text) return null;
  return (
    <p data-testid="widget-range" className="-mt-1 text-xs text-muted-foreground">
      {text}
    </p>
  );
}

function emptyState(config: QueryWidgetConfig) {
  if (config.measure === "outstanding" || config.measure === "overdue") {
    return { text: T.empty.balances, action: { href: "/faktury", label: T.actions.invoices } };
  }
  switch (config.source) {
    case "payments":
      return { text: T.empty.payments, action: { href: "/faktury", label: T.actions.invoices } };
    case "customers":
      return {
        text: T.empty.customers,
        action: { href: "/zakaznici/novy", label: T.actions.newCustomer },
      };
    default:
      return {
        text: T.empty.invoices,
        action: { href: "/faktury/nova", label: T.actions.newInvoice },
      };
  }
}

function isEmpty(result: WidgetResult, config: QueryWidgetConfig): boolean {
  if (result.unconverted.count > 0 || result.compare?.total) return false;
  // Zero days to pay is an answer; no paid invoice at all is not.
  if (config.metric === "days_to_pay") return result.total === null;
  if (result.kind === "rows") return result.rows.every((row) => !row.value);
  if (result.kind === "series") {
    return result.series.every((series) => series.points.every((point) => !point.value));
  }
  return !result.total;
}

function rowLabel(row: WidgetRow, config: QueryWidgetConfig): string {
  if (row.kind === "others") return R.others;
  if (row.kind === "adjustment") return R.adjustment;
  switch (config.groupBy) {
    case "status":
      return TEXTS.invoices.statuses[row.key as keyof typeof TEXTS.invoices.statuses] ?? row.key;
    case "type":
      return (
        TEXTS.invoices.list.types[row.key as keyof typeof TEXTS.invoices.list.types] ?? row.key
      );
    case "customer":
      return row.name || R.noCustomer;
    case "item":
      return row.name || R.noName;
    default:
      return row.name || row.key;
  }
}

function tokenAt(first: ChartToken, offset: number): ChartToken {
  const start = CHART_TOKENS.indexOf(first);
  return CHART_TOKENS[(start + offset) % CHART_TOKENS.length]!;
}

function valueFormat(unit: WidgetUnit): ValueFormat {
  return unit.kind === "money" ? { kind: "money", currency: unit.currency } : { kind: "number" };
}

function seriesLabel(series: WidgetSeries, title: string): string {
  if (series.kind === "others") return R.others;
  return series.name || title;
}

function chartSpec(
  config: QueryWidgetConfig,
  result: WidgetResult,
  unit: WidgetUnit,
  title: string,
  mode?: CompareMode,
): ChartSpec {
  const kind = config.display as ChartSpec["kind"];
  const format = valueFormat(unit);
  if (result.kind === "rows") {
    const rows = result.rows.filter((row) => row.kind !== "adjustment");
    const corner =
      config.groupBy && !isBucketUnit(config.groupBy) ? R.chart.corners[config.groupBy] : undefined;
    if (kind === "donut") {
      const slices = rows.filter((row) => (row.value ?? 0) > 0);
      return {
        kind,
        ariaLabel: title,
        corner,
        format,
        series: slices.map((row, index) => ({
          key: row.key || "none",
          label: rowLabel(row, config),
          token: tokenAt(config.color, index),
        })),
        rows: [
          {
            x: "total",
            label: V.total,
            values: Object.fromEntries(slices.map((row) => [row.key || "none", row.value ?? 0])),
          },
        ],
      };
    }
    return {
      kind,
      ariaLabel: title,
      corner,
      format,
      series: [{ key: "value", label: title, token: config.color }],
      rows: rows.map((row) => ({
        x: row.key || "none",
        label: rowLabel(row, config),
        values: { value: row.value ?? 0 },
      })),
    };
  }
  const bucket = isBucketUnit(config.groupBy) ? config.groupBy : "month";
  const previous = result.compare?.points;
  const series = result.series.map((item, index) => ({
    key: item.key,
    label: previous && !item.name ? R.series.current : seriesLabel(item, title),
    token: tokenAt(config.color, index),
  }));
  if (previous) {
    series.push({
      key: "previous",
      label: (config.compare ?? mode) === "year" ? R.series.year : R.series.previous,
      token: tokenAt(config.color, series.length),
    });
  }
  const keys = result.series[0]?.points.map((point) => point.key) ?? [];
  return {
    kind,
    ariaLabel: title,
    format,
    series,
    rows: keys.map((key, index) => ({
      x: key,
      label: bucketLabel(key, bucket),
      values: {
        ...Object.fromEntries(
          result.series.map((item) => [item.key, item.points[index]?.value ?? 0]),
        ),
        ...(previous && { previous: previous[index] ?? 0 }),
      },
    })),
  };
}

type DisplayProps = {
  config: QueryWidgetConfig;
  result: WidgetResult;
  unit: WidgetUnit;
  title: string;
  mode?: CompareMode;
};

function WidgetTable({ config, result, unit, title, mode }: DisplayProps) {
  const format = (value: number | null) => formatWidgetValue(value, unit, config.format);
  if (result.kind === "series") {
    const spec = chartSpec({ ...config, display: "bar" }, result, unit, title, mode);
    return (
      <Table aria-label={title}>
        <TableHeader>
          <TableRow>
            <TableHead>{R.columns.period}</TableHead>
            {spec.series.map((series) => (
              <TableHead key={series.key} className="text-right">
                {series.label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {spec.rows.map((row) => (
            <TableRow key={row.x}>
              <TableCell>{row.label}</TableCell>
              {spec.series.map((series) => (
                <TableCell key={series.key} className="text-right tabular-nums">
                  {format(row.values[series.key] ?? 0)}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );
  }
  const rows: WidgetRow[] =
    result.kind === "rows"
      ? result.rows
      : [{ kind: "row", key: "total", name: V.total, value: result.total }];
  return (
    <Table aria-label={title}>
      <TableHeader>
        <TableRow>
          <TableHead>{V.name}</TableHead>
          <TableHead className="text-right">{V.value}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={`${row.kind}:${row.key}`}>
            <TableCell>{result.kind === "rows" ? rowLabel(row, config) : row.name}</TableCell>
            <TableCell className="text-right tabular-nums">{format(row.value)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
      {result.kind === "rows" && isAdditive(config.metric) && (
        <TableFooter>
          <TableRow>
            <TableCell>{V.total}</TableCell>
            <TableCell className="text-right tabular-nums">{format(result.total)}</TableCell>
          </TableRow>
        </TableFooter>
      )}
    </Table>
  );
}

function QueryDisplay({
  config,
  result,
  unit,
  title,
  mode,
  height,
}: DisplayProps & { height: number }) {
  if (config.display === "table") {
    return <WidgetTable config={config} result={result} unit={unit} title={title} mode={mode} />;
  }
  if (result.kind === "total") {
    return <WidgetNumber result={result} unit={unit} format={config.format} />;
  }
  const spec = chartSpec(config, result, unit, title, mode);
  return <Chart spec={config.labels ? { ...spec, labels: true } : spec} height={height} />;
}

export function chartHeight(h: number): number {
  return Math.max(140, h * 80 - 110);
}

export function WidgetView({
  config,
  result,
  unit,
  title,
  h,
  dateFormat,
  mode,
}: {
  config: WidgetConfig;
  result: WidgetResult;
  unit: WidgetUnit;
  title: string;
  h: number;
  dateFormat: DateFormat;
  mode?: CompareMode;
}) {
  return (
    <div
      data-testid="widget-body"
      data-display={config.kind === "query" ? config.display : config.systemId}
      className="flex min-w-0 flex-1 flex-col gap-2"
    >
      <Subtitle config={config} result={result} dateFormat={dateFormat} />
      {config.kind === "system" ? (
        <SystemBody
          config={config}
          result={result}
          dateFormat={dateFormat}
          unit={unit}
          height={chartHeight(h)}
        />
      ) : isEmpty(result, config) ? (
        <WidgetEmpty {...emptyState(config)} />
      ) : (
        <QueryDisplay
          config={config}
          result={result}
          unit={unit}
          title={title}
          mode={mode}
          height={chartHeight(h)}
        />
      )}
      {result.truncated && (
        <p data-testid="widget-truncated" className="text-xs text-muted-foreground">
          {V.truncated}
        </p>
      )}
      <UnconvertedNote unconverted={result.unconverted} />
    </div>
  );
}
