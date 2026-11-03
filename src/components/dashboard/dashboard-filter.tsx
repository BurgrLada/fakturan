import Link from "next/link";
import { FilterField } from "@/components/filter-field";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { CURRENCIES } from "@/lib/currency";
import { DASHBOARD_PARAM, dashboardHref, type GlobalFilter } from "@/lib/dashboard-filter";
import { COMPARE_MODES, COMPARE_PARAM, CUSTOM_PERIOD, PERIOD_PARAM } from "@/lib/report-filter";
import { PERIOD_TOKENS } from "@/lib/report-period";
import { TEXTS } from "@/lib/texts";

const T = TEXTS.dashboard.filter;
const R = TEXTS.reports.filter;

// A plain GET form, as on the Statistics page: the filter lives in the URL and is never saved (R-21).
export function DashboardFilter({
  filter,
  dashboardId,
}: {
  filter: GlobalFilter;
  dashboardId: string | null;
}) {
  const { period } = filter;
  const periodValue =
    period === undefined ? "" : typeof period === "string" ? PERIOD_PARAM[period] : CUSTOM_PERIOD;
  const range = typeof period === "object" ? period : undefined;
  return (
    <form
      method="get"
      action="/"
      aria-label={T.label}
      className="grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-6"
    >
      {dashboardId && <input type="hidden" name={DASHBOARD_PARAM} value={dashboardId} />}
      <FilterField label={T.period}>
        <NativeSelect name="obdobi" defaultValue={periodValue}>
          <option value="">{T.widgetPeriod}</option>
          {PERIOD_TOKENS.map((token) => (
            <option key={token} value={PERIOD_PARAM[token]}>
              {R.periods[token]}
            </option>
          ))}
          <option value={CUSTOM_PERIOD}>{R.custom}</option>
        </NativeSelect>
      </FilterField>
      <FilterField label={R.from}>
        <Input name="od" type="date" defaultValue={range?.from ?? ""} />
      </FilterField>
      <FilterField label={R.to}>
        <Input name="do" type="date" defaultValue={range?.to ?? ""} />
      </FilterField>
      <FilterField label={T.currency}>
        <NativeSelect name="mena" defaultValue={filter.currency ?? ""}>
          <option value="">{T.widgetCurrency}</option>
          {CURRENCIES.map((currency) => (
            <option key={currency} value={currency}>
              {currency}
            </option>
          ))}
        </NativeSelect>
      </FilterField>
      <FilterField label={T.compare}>
        <NativeSelect
          name="porovnani"
          defaultValue={filter.compare ? COMPARE_PARAM[filter.compare] : ""}
        >
          <option value="">{T.widgetCompare}</option>
          {COMPARE_MODES.map((mode) => (
            <option key={mode} value={COMPARE_PARAM[mode]}>
              {R.compares[mode]}
            </option>
          ))}
        </NativeSelect>
      </FilterField>
      <div className="flex gap-2">
        <Button type="submit">{T.apply}</Button>
        <Link
          href={dashboardHref(dashboardId, {})}
          className={buttonVariants({ variant: "outline" })}
        >
          {T.reset}
        </Link>
      </div>
    </form>
  );
}
