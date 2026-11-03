import type { Currency } from "@/lib/currency";
import type { GlobalFilter } from "@/lib/dashboard-filter";
import { formatMoney } from "@/lib/money";
import { TEXTS } from "@/lib/texts";
import type { WidgetConfig, WidgetFormat } from "@/lib/widget-config";
import type { WidgetResult } from "@/server/reports/widget-query";

const V = TEXTS.dashboard.view;
const NUMBER = new Intl.NumberFormat("cs-CZ", { maximumFractionDigits: 0 });
const DAYS = TEXTS.reports.summary.days;

export type WidgetUnit =
  | { kind: "money"; currency: Currency }
  | { kind: "count" }
  | { kind: "days" };

export function widgetUnit(config: WidgetConfig, filter: GlobalFilter): WidgetUnit {
  if (config.kind === "system") {
    const currency = config.systemId === "paid_ratio" ? filter.currency : undefined;
    return { kind: "money", currency: currency ?? "CZK" };
  }
  if (config.metric === "days_to_pay") return { kind: "days" };
  if (config.metric === "count" || config.source === "customers") return { kind: "count" };
  return { kind: "money", currency: config.filters?.currency ?? filter.currency ?? "CZK" };
}

// Integers only: half away from zero, like every other rounding of money.
function rounded(value: number, unit: number): number {
  const magnitude = Math.abs(value);
  const whole = Math.floor(magnitude / unit);
  const result = whole + (2 * (magnitude - whole * unit) >= unit ? 1 : 0);
  return value < 0 ? -result : result;
}

function currencySymbol(currency: Currency): string {
  return (
    new Intl.NumberFormat("cs-CZ", { style: "currency", currency })
      .formatToParts(0)
      .find((part) => part.type === "currency")?.value ?? currency
  );
}

export function formatWidgetValue(
  value: number | null,
  unit: WidgetUnit,
  format: WidgetFormat = "auto",
): string {
  if (value === null) return "–";
  if (unit.kind === "days") return DAYS(value);
  if (unit.kind === "count") return NUMBER.format(value);
  if (format === "whole") {
    return new Intl.NumberFormat("cs-CZ", {
      style: "currency",
      currency: unit.currency,
      maximumFractionDigits: 0,
      minimumFractionDigits: 0,
    }).format(rounded(value, 100));
  }
  if (format === "thousands") {
    return V.thousands(NUMBER.format(rounded(value, 100_000)), currencySymbol(unit.currency));
  }
  return formatMoney(value, unit.currency);
}

// Whole percent, half away from zero; a zero base has no meaningful share, so none is shown.
export function percentChange(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || previous === 0) return null;
  const delta = BigInt(current - previous) * BigInt(100);
  const base = BigInt(Math.abs(previous));
  const magnitude = ((delta < BigInt(0) ? -delta : delta) * BigInt(2) + base) / (BigInt(2) * base);
  return Number(delta < BigInt(0) ? -magnitude : magnitude);
}

function signed(text: string, value: number): string {
  return value > 0 ? `+${text}` : text;
}

export function WidgetNumber({
  result,
  unit,
  format,
}: {
  result: Pick<WidgetResult, "total" | "compare">;
  unit: WidgetUnit;
  format?: WidgetFormat;
}) {
  const { compare } = result;
  const percent = compare ? percentChange(result.total, compare.total) : null;
  return (
    <div className="space-y-1">
      <p data-testid="widget-value" className="text-2xl font-medium tabular-nums">
        {formatWidgetValue(result.total, unit, format)}
      </p>
      {compare && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 text-xs tabular-nums">
          <dt className="text-muted-foreground">{V.previous}</dt>
          <dd data-testid="widget-previous">{formatWidgetValue(compare.total, unit, format)}</dd>
          <dt className="text-muted-foreground">{V.change}</dt>
          <dd data-testid="widget-change">
            {compare.delta === null
              ? "–"
              : signed(formatWidgetValue(compare.delta, unit, format), compare.delta)}
            {percent !== null && ` (${V.percent(percent)})`}
          </dd>
        </dl>
      )}
    </div>
  );
}
