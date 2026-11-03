"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type FormEvent, type ReactNode } from "react";
import { addWidgetAction, updateWidgetAction } from "@/app/(app)/dashboardy/actions";
import { FilterField } from "@/components/filter-field";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { CHART_TOKENS, type ChartToken } from "@/lib/chart-tokens";
import type { DateFormat } from "@/lib/preferences";
import { PERIOD_TOKENS, type Period } from "@/lib/report-period";
import { TEXTS } from "@/lib/texts";
import {
  MAX_TOP_N,
  WIDGET_FORMATS,
  type QueryWidgetConfig,
  type SystemWidgetConfig,
  type WidgetConfig,
  type WidgetFormat,
} from "@/lib/widget-config";
import {
  getQueryField,
  labelsAllowed,
  queryOptions,
  setQueryField,
  type QueryField,
} from "@/lib/widget-options";
import { cn } from "@/lib/utils";
import { WidgetPreview } from "./widget-preview";

const T = TEXTS.dashboard.configurator;
const R = TEXTS.reports.filter;
const E = TEXTS.dashboard.edit;

const NONE = "";
const CUSTOM = "custom";
const ROWS_SYSTEM = new Set([
  "due_alerts",
  "upcoming_recurring",
  "unmatched_payments",
  "open_advances",
]);

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="grid gap-3 sm:grid-cols-2">
      <legend className="mb-2 text-sm font-medium">{title}</legend>
      {children}
    </fieldset>
  );
}

function Check({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        className="size-4 accent-primary"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  );
}

type Labels = Record<string, string>;

// Only values the schema accepts are offered; "" stands for an unset optional field.
function QuerySelect({
  label,
  config,
  field,
  labels,
  none,
  onChange,
}: {
  label: string;
  config: QueryWidgetConfig;
  field: QueryField;
  labels: Labels;
  none?: string;
  onChange: (config: QueryWidgetConfig) => void;
}) {
  const options = queryOptions(config, field);
  if (options.every((value) => value === undefined)) return null;
  const current = getQueryField(config, field);
  return (
    <FilterField label={label}>
      <NativeSelect
        value={current === undefined ? NONE : String(current)}
        onChange={(event) =>
          onChange(setQueryField(config, field, event.target.value || undefined))
        }
      >
        {options.map((value) =>
          value === undefined ? (
            none !== undefined && (
              <option key={NONE} value={NONE}>
                {none}
              </option>
            )
          ) : (
            <option key={String(value)} value={String(value)}>
              {labels[String(value)] ?? String(value)}
            </option>
          ),
        )}
      </NativeSelect>
    </FilterField>
  );
}

function PeriodField({
  period,
  allowed,
  onChange,
}: {
  period: Period | undefined;
  allowed: readonly unknown[];
  onChange: (period: Period | undefined) => void;
}) {
  const range = typeof period === "object" ? period : null;
  const tokens = PERIOD_TOKENS.filter((token) => allowed.includes(token));
  if (tokens.length === 0) return null;
  return (
    <>
      <FilterField label={T.period}>
        <NativeSelect
          value={range ? CUSTOM : typeof period === "string" ? period : tokens[0]}
          onChange={(event) => {
            const value = event.target.value;
            if (value === CUSTOM) {
              onChange({
                from: `${new Date().getFullYear()}-01-01`,
                to: `${new Date().getFullYear()}-12-31`,
              });
            } else onChange(value as Period);
          }}
        >
          {tokens.map((token) => (
            <option key={token} value={token}>
              {R.periods[token]}
            </option>
          ))}
          <option value={CUSTOM}>{R.custom}</option>
        </NativeSelect>
      </FilterField>
      {range && (
        <>
          <FilterField label={R.from}>
            <Input
              type="date"
              value={range.from}
              onChange={(event) => onChange({ ...range, from: event.target.value })}
            />
          </FilterField>
          <FilterField label={R.to}>
            <Input
              type="date"
              value={range.to}
              onChange={(event) => onChange({ ...range, to: event.target.value })}
            />
          </FilterField>
        </>
      )}
    </>
  );
}

function QueryFields({
  config,
  onChange,
}: {
  config: QueryWidgetConfig;
  onChange: (config: QueryWidgetConfig) => void;
}) {
  const set = (field: QueryField, value: unknown) => onChange(setQueryField(config, field, value));
  const topAllowed = queryOptions(config, "topN").some((value) => value !== undefined);
  const cumulativeAllowed = queryOptions(config, "cumulative").includes(true);
  const externalAllowed = queryOptions(config, "filter:includeExternal").includes(false);
  const select = (label: string, field: QueryField, labels: Labels, none?: string) => (
    <QuerySelect
      label={label}
      config={config}
      field={field}
      labels={labels}
      none={none}
      onChange={onChange}
    />
  );
  return (
    <Section title={T.data}>
      {select(T.source, "source", T.sources)}
      {select(T.measure, "measure", T.measures)}
      {select(T.metric, "metric", T.metrics)}
      {select(T.display, "display", T.displays)}
      {select(T.groupBy, "groupBy", T.groups, T.none)}
      {select(T.splitBy, "splitBy", T.groups, T.noSplit)}
      <PeriodField
        period={config.period}
        allowed={queryOptions(config, "period")}
        onChange={(period) => onChange({ ...config, period })}
      />
      {select(T.compare, "compare", R.compares, T.noCompare)}
      {select(T.currency, "filter:currency", {}, R.allCurrencies)}
      {topAllowed && (
        <div className="flex flex-col gap-2">
          <Check
            label={T.top}
            checked={config.topN !== undefined}
            onChange={(checked) => set("topN", checked ? 5 : undefined)}
          />
          {config.topN !== undefined && (
            <FilterField label={T.topN}>
              <Input
                type="number"
                min={1}
                max={MAX_TOP_N}
                value={config.topN}
                onChange={(event) => {
                  const value = Math.trunc(Number(event.target.value));
                  if (value >= 1 && value <= MAX_TOP_N) set("topN", value);
                }}
              />
            </FilterField>
          )}
        </div>
      )}
      {cumulativeAllowed && (
        <Check
          label={T.cumulative}
          checked={config.cumulative === true}
          onChange={(checked) => set("cumulative", checked || undefined)}
        />
      )}
      {externalAllowed && (
        <Check
          label={T.external}
          checked={config.filters?.includeExternal !== false}
          onChange={(checked) => set("filter:includeExternal", checked ? undefined : false)}
        />
      )}
    </Section>
  );
}

function SystemFields({
  config,
  onChange,
}: {
  config: SystemWidgetConfig;
  onChange: (config: SystemWidgetConfig) => void;
}) {
  const rows = ROWS_SYSTEM.has(config.systemId);
  const period = config.systemId === "paid_ratio";
  if (!rows && !period) return null;
  return (
    <Section title={T.data}>
      {rows && (
        <FilterField label={T.rows}>
          <Input
            type="number"
            min={1}
            max={MAX_TOP_N}
            value={config.rows ?? 5}
            onChange={(event) => {
              const value = Math.trunc(Number(event.target.value));
              if (value >= 1 && value <= MAX_TOP_N) onChange({ ...config, rows: value });
            }}
          />
        </FilterField>
      )}
      {period && (
        <PeriodField
          period={config.period}
          allowed={PERIOD_TOKENS}
          onChange={(next) => onChange({ ...config, period: next })}
        />
      )}
    </Section>
  );
}

function ColorField({
  value,
  onChange,
}: {
  value: ChartToken;
  onChange: (token: ChartToken) => void;
}) {
  const name = useId();
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="mb-1 text-xs/relaxed font-medium">{T.color}</legend>
      <div className="flex flex-wrap gap-2">
        {CHART_TOKENS.map((token) => (
          <label
            key={token}
            className={cn(
              "flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-xs has-checked:border-ring has-focus-visible:ring-2 has-focus-visible:ring-ring/30",
            )}
          >
            <input
              type="radio"
              name={name}
              value={token}
              checked={value === token}
              onChange={() => onChange(token)}
              className="sr-only"
            />
            <span aria-hidden className={cn("size-3 rounded-full", SWATCH[token])} />
            {T.colors[token]}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

const SWATCH: Record<ChartToken, string> = {
  "chart-1": "bg-chart-1",
  "chart-2": "bg-chart-2",
  "chart-3": "bg-chart-3",
  "chart-4": "bg-chart-4",
  "chart-5": "bg-chart-5",
};

export function WidgetConfigurator({
  dashboardId,
  widgetId,
  initial,
  dateFormat,
}: {
  dashboardId: string;
  widgetId: string | null;
  initial: WidgetConfig;
  dateFormat: DateFormat;
}) {
  const router = useRouter();
  const [config, setConfig] = useState<WidgetConfig>(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const editor = `/dashboardy/${dashboardId}/upravit`;
  const update = (next: WidgetConfig) => {
    setConfig(next);
    setError(null);
  };

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startTransition(async () => {
      try {
        const reply = widgetId
          ? await updateWidgetAction({ id: widgetId, config })
          : await addWidgetAction({ dashboardId, config });
        if (!reply.ok) {
          setError(reply.expired ? E.expired : reply.error);
          return;
        }
        router.push(editor);
      } catch {
        setError(T.failed);
      }
    });
  }

  const query = config.kind === "query" ? config : null;
  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <form aria-label={T.form} className="flex flex-col gap-6" onSubmit={save}>
        <Section title={T.look}>
          <FilterField label={T.name}>
            <Input
              value={config.title}
              maxLength={80}
              onChange={(event) => update({ ...config, title: event.target.value })}
            />
          </FilterField>
          <FilterField label={T.format}>
            <NativeSelect
              value={config.format}
              onChange={(event) =>
                update({ ...config, format: event.target.value as WidgetFormat })
              }
            >
              {WIDGET_FORMATS.map((format) => (
                <option key={format} value={format}>
                  {T.formats[format]}
                </option>
              ))}
            </NativeSelect>
          </FilterField>
          <ColorField value={config.color} onChange={(color) => update({ ...config, color })} />
          {query && labelsAllowed(query) && (
            <Check
              label={T.labels}
              checked={query.labels === true}
              onChange={(checked) => update({ ...query, labels: checked || undefined })}
            />
          )}
        </Section>
        {query ? (
          <QueryFields config={query} onChange={update} />
        ) : (
          config.kind === "system" && <SystemFields config={config} onChange={update} />
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={pending}>
            {widgetId ? T.save : T.add}
          </Button>
          <Link href={editor} className={buttonVariants({ variant: "outline" })}>
            {T.cancel}
          </Link>
        </div>
      </form>
      <WidgetPreview config={config} dateFormat={dateFormat} />
    </div>
  );
}
