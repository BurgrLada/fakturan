import Link from "next/link";
import { FilterField } from "@/components/filter-field";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { CURRENCIES } from "@/lib/currency";
import {
  COMPARE_MODES,
  COMPARE_PARAM,
  CUSTOM_PERIOD,
  PERIOD_PARAM,
  reportPeriodToken,
  type ParsedReportFilter,
} from "@/lib/report-filter";
import { PERIOD_TOKENS } from "@/lib/report-period";
import { TEXTS } from "@/lib/texts";

const T = TEXTS.reports.filter;

// A plain GET form: the filter lives in the URL and works without JavaScript. A relative period
// wins over the dates, which only apply with "Vlastní podle dat".
export function ReportFilter({ filter, today }: { filter: ParsedReportFilter; today: string }) {
  const token = reportPeriodToken(filter.range, today);
  return (
    <form
      method="get"
      action="/prehledy"
      aria-label={T.label}
      className="grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-4"
    >
      <input type="hidden" name="zalozka" value={filter.tab} />
      <FilterField label={T.period}>
        <NativeSelect name="obdobi" defaultValue={token ? PERIOD_PARAM[token] : CUSTOM_PERIOD}>
          {PERIOD_TOKENS.map((period) => (
            <option key={period} value={PERIOD_PARAM[period]}>
              {T.periods[period]}
            </option>
          ))}
          <option value={CUSTOM_PERIOD}>{T.custom}</option>
        </NativeSelect>
      </FilterField>
      <FilterField label={T.from}>
        <Input name="od" type="date" defaultValue={filter.range.from} />
      </FilterField>
      <FilterField label={T.to}>
        <Input name="do" type="date" defaultValue={filter.range.to} />
      </FilterField>
      <FilterField label={T.compare}>
        <NativeSelect name="porovnani" defaultValue={COMPARE_PARAM[filter.compare]}>
          {COMPARE_MODES.map((mode) => (
            <option key={mode} value={COMPARE_PARAM[mode]}>
              {T.compares[mode]}
            </option>
          ))}
        </NativeSelect>
      </FilterField>
      <FilterField label={T.currency}>
        <NativeSelect name="mena" defaultValue={filter.currency ?? ""}>
          <option value="">{T.allCurrencies}</option>
          {CURRENCIES.map((currency) => (
            <option key={currency} value={currency}>
              {currency}
            </option>
          ))}
        </NativeSelect>
      </FilterField>
      <FilterField label={T.external}>
        <NativeSelect name="importovane" defaultValue={filter.includeExternal ? "" : "ne"}>
          <option value="">{T.externalOptions.include}</option>
          <option value="ne">{T.externalOptions.exclude}</option>
        </NativeSelect>
      </FilterField>
      <div className="flex gap-2">
        <Button type="submit">{T.apply}</Button>
        <Link
          href={`/prehledy?zalozka=${filter.tab}`}
          className={buttonVariants({ variant: "outline" })}
        >
          {T.reset}
        </Link>
      </div>
    </form>
  );
}
