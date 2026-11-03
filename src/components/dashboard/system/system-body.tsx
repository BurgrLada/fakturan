import { Chart } from "@/components/charts/chart";
import type { ChartSpec } from "@/components/charts/chart-spec";
import { DueAlerts } from "@/components/overview/due-alerts";
import { LimitsCard } from "@/components/reports/limits-card";
import { bucketLabel } from "@/lib/report-filter";
import { CHART_TOKENS } from "@/lib/chart-tokens";
import { TEXTS } from "@/lib/texts";
import type { SystemWidgetConfig } from "@/lib/widget-config";
import type { WidgetResult } from "@/server/reports/widget-query";
import type { WidgetEnv } from "../widget-body";
import { WidgetEmpty } from "../widget-empty";
import { WidgetNumber, type WidgetUnit } from "../widget-number";
import { AdvancesList, AutomationState, NoticeList, PlanList } from "./lists";

const T = TEXTS.dashboard;

function money(unit: WidgetUnit): ChartSpec["format"] {
  return unit.kind === "money" ? { kind: "money", currency: unit.currency } : { kind: "number" };
}

function token(config: SystemWidgetConfig, offset: number) {
  const start = CHART_TOKENS.indexOf(config.color);
  return CHART_TOKENS[(start + offset) % CHART_TOKENS.length]!;
}

export function SystemBody({
  config,
  result,
  env,
  unit,
  height,
}: {
  config: SystemWidgetConfig;
  result: WidgetResult;
  env: WidgetEnv;
  unit: WidgetUnit;
  height: number;
}) {
  const title = config.title || T.gallery[config.systemId];
  const detail = result.detail;
  const rows = config.rows ?? 5;
  switch (config.systemId) {
    case "due_alerts": {
      if (detail?.kind !== "due_alerts") break;
      if (detail.overdue.length + detail.dueSoon.length === 0) {
        return (
          <WidgetEmpty
            text={T.empty.dueAlerts}
            action={{ href: "/faktury", label: T.actions.invoices }}
          />
        );
      }
      return (
        <DueAlerts
          overdue={detail.overdue}
          dueSoon={detail.dueSoon}
          dateFormat={env.dateFormat}
          limit={rows}
        />
      );
    }
    case "upcoming_recurring":
      if (detail?.kind !== "upcoming_recurring") break;
      if (detail.count === 0) {
        return (
          <WidgetEmpty
            text={T.empty.recurring}
            action={{ href: "/pravidelne/nova", label: T.actions.newRecurring }}
          />
        );
      }
      return <PlanList detail={detail} dateFormat={env.dateFormat} />;
    case "unmatched_payments":
      if (detail?.kind !== "unmatched_payments") break;
      if (detail.pending + detail.unrecognized === 0) {
        return (
          <WidgetEmpty
            text={T.empty.notices}
            action={{ href: "/platby", label: T.actions.payments }}
          />
        );
      }
      return <NoticeList detail={detail} dateFormat={env.dateFormat} />;
    case "open_advances":
      if (detail?.kind !== "open_advances") break;
      if (detail.count === 0 && result.unconverted.count === 0) {
        return (
          <WidgetEmpty
            text={T.empty.advances}
            action={{ href: "/faktury/nova", label: T.actions.newInvoice }}
          />
        );
      }
      return (
        <>
          <WidgetNumber result={result} unit={unit} format={config.format} />
          <AdvancesList detail={detail} dateFormat={env.dateFormat} />
        </>
      );
    case "automation_status":
      if (detail?.kind !== "automation_status") break;
      return <AutomationState detail={detail} dateFormat={env.dateFormat} />;
    case "limits":
      if (detail?.kind !== "limits") break;
      return <LimitsCard limits={detail} />;
    case "paid_ratio":
      if (!result.total && result.unconverted.count === 0) {
        return (
          <WidgetEmpty
            text={T.empty.invoices}
            action={{ href: "/faktury/nova", label: T.actions.newInvoice }}
          />
        );
      }
      return (
        <Chart
          height={height}
          spec={{
            kind: "donut",
            ariaLabel: title,
            format: money(unit),
            series: result.rows.map((row, index) => ({
              key: row.key,
              label: row.name,
              token: token(config, index),
            })),
            rows: [
              {
                x: "total",
                label: T.view.total,
                values: Object.fromEntries(result.rows.map((row) => [row.key, row.value ?? 0])),
              },
            ],
          }}
        />
      );
    case "aging":
      if (!result.total && result.unconverted.count === 0) {
        return (
          <WidgetEmpty
            text={T.empty.balances}
            action={{ href: "/faktury", label: T.actions.invoices }}
          />
        );
      }
      return (
        <>
          <WidgetNumber result={result} unit={unit} format={config.format} />
          <Chart
            height={height}
            spec={{
              kind: "bar",
              ariaLabel: title,
              format: money(unit),
              series: [{ key: "amount", label: TEXTS.reports.columns.amount, token: config.color }],
              rows: result.rows.map((row) => ({
                x: row.key,
                label: row.name,
                values: { amount: row.value ?? 0 },
              })),
            }}
          />
        </>
      );
    case "forecast":
      if (!result.total && result.unconverted.count === 0) {
        return (
          <WidgetEmpty
            text={T.empty.forecast}
            action={{ href: "/faktury/nova", label: T.actions.newInvoice }}
          />
        );
      }
      return (
        <Chart
          height={height}
          spec={{
            kind: "stacked_bar",
            ariaLabel: title,
            format: money(unit),
            series: result.series.map((series, index) => ({
              key: series.key,
              label: series.name,
              token: token(config, index),
            })),
            rows: (result.series[0]?.points ?? []).map((point, index) => ({
              x: point.key,
              label: bucketLabel(point.key, "month"),
              values: Object.fromEntries(
                result.series.map((series) => [series.key, series.points[index]?.value ?? 0]),
              ),
            })),
          }}
        />
      );
  }
  throw new Error(`Widget ${config.systemId} vrátil neočekávaný výsledek`);
}
