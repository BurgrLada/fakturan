import "server-only";
import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import { AUTOMATION_KEYS, type AutomationKey } from "@/lib/automation";
import type { Currency } from "@/lib/currency";
import type { TurnoverBasis } from "@/lib/preferences";
import { resolvePeriod, type DateRange } from "@/lib/report-period";
import { TEXTS } from "@/lib/texts";
import type { SystemWidgetId } from "@/lib/widget-config";
import { dueSql, openCondition } from "../db/invoice-sql";
import { invoice, preferences } from "../db/schema";
import { scoped } from "../db/scoped";
import { getAutomation } from "../services/automation";
import { listNotices, noticeCounts } from "../services/bank-notices";
import { dueAlerts, type AlertRow } from "../services/due-alerts";
import { listRecurring } from "../services/recurring";
import { FORECAST_SERIES, forecast } from "./forecast";
import * as core from "./queries";
import { limitStates, type LimitState } from "./turnover";
import { AGING_BANDS, type Unconverted } from "./types";
import {
  SYSTEM_WIDGET_RUNNERS,
  type SystemWidgetRunner,
  type WidgetContext,
  type WidgetResult,
} from "./widget-query";

const DEFAULT_ROWS = 5;
const AUTOMATION_RUNS = 3;

export type SystemDetail =
  | { kind: "due_alerts"; overdue: AlertRow[]; dueSoon: AlertRow[] }
  | {
      kind: "upcoming_recurring";
      count: number;
      plans: { id: string; name: string; customerName: string | null; nextIssueDate: string }[];
    }
  | {
      kind: "unmatched_payments";
      pending: number;
      unrecognized: number;
      notices: {
        id: string;
        status: "pending" | "unrecognized";
        paidOn: string | null;
        amountMinor: number | null;
        currency: Currency | null;
        variableSymbol: string | null;
        counterpartyName: string | null;
      }[];
    }
  | { kind: "limits"; year: number; basis: TurnoverBasis; states: LimitState[] }
  | {
      kind: "open_advances";
      count: number;
      advances: {
        id: string;
        number: string | null;
        customerName: string;
        dueDate: string | null;
        amountDueMinor: number;
        currency: Currency;
      }[];
    }
  // Only the account's own switches and dates: no customer data beyond what the user set (R-22).
  | {
      kind: "automation_status";
      paused: boolean;
      sendTime: string;
      enabled: Record<AutomationKey, boolean>;
      next: { id: string; name: string; date: string }[];
    };

const today = (context: WidgetContext): DateRange => ({ from: context.today, to: context.today });

function result(
  range: DateRange,
  over: Partial<Omit<WidgetResult, "kind" | "range">> = {},
): WidgetResult {
  return {
    kind: "system",
    series: [],
    rows: [],
    total: null,
    range,
    unconverted: core.NOTHING,
    ...over,
  };
}

function merged(list: Unconverted[]): Unconverted {
  const byCurrency = new Map<Currency, number>();
  let count = 0;
  for (const item of list) {
    count += item.count;
    for (const { currency, amountMinor } of item.byCurrency) {
      byCurrency.set(currency, (byCurrency.get(currency) ?? 0) + amountMinor);
    }
  }
  return {
    count,
    byCurrency: [...byCurrency]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, amountMinor]) => ({ currency, amountMinor })),
  };
}

const total = (value: SQL): SQL<number> => sql<number>`coalesce(sum(${value}), 0)`;

// Documents issued in the period, split by what is still open on them today.
const paidRatio: SystemWidgetRunner = (q, ownerId, config, context) => {
  const global = context.globalFilter ?? {};
  const range = resolvePeriod(global.period ?? config.period ?? "this_year", context.today);
  const filter = { range, currency: global.currency, includeExternal: true };
  const where = and(core.documentFilter(q, ownerId, filter), core.notAdvance) as SQL;
  const row = q
    .select({
      invoiced: total(core.documentMoney(filter, invoice.totalMinor)),
      open: total(sql`CASE WHEN ${openCondition} THEN ${core.documentMoney(filter, dueSql)} END`),
    })
    .from(invoice)
    .where(where)
    .get()!;
  const name = TEXTS.dashboard.system;
  return result(range, {
    total: row.invoiced,
    rows: [
      { kind: "row", key: "paid", name: name.paid, value: row.invoiced - row.open },
      { kind: "row", key: "unpaid", name: name.unpaid, value: row.open },
    ],
    unconverted: core.documentsUnconverted(q, where, invoice.totalMinor, !filter.currency),
  });
};

const aging: SystemWidgetRunner = (q, ownerId, _config, context) => {
  const filter = { range: today(context), includeExternal: true };
  const { bands, unconverted } = core.agingBands(q, ownerId, filter, context.today);
  const rows = AGING_BANDS.map((band) => ({
    kind: "row" as const,
    key: band,
    name: TEXTS.reports.aging[band],
    value: bands[band],
  }));
  return result(filter.range, {
    rows,
    total: rows.reduce((sum, row) => sum + row.value, 0),
    unconverted,
  });
};

const alerts: SystemWidgetRunner = (_q, ownerId, _config, context) => {
  const { overdue, dueSoon } = dueAlerts(ownerId, context.today);
  return result(today(context), {
    rows: [
      { kind: "row", key: "overdue", name: TEXTS.reminders.alerts.overdue, value: overdue.length },
      { kind: "row", key: "dueSoon", name: TEXTS.reminders.alerts.dueSoon, value: dueSoon.length },
    ],
    detail: { kind: "due_alerts", overdue, dueSoon },
  });
};

function activePlans(ownerId: string) {
  return listRecurring(ownerId)
    .filter((plan) => plan.status === "active" && plan.nextIssueDate !== null)
    .sort(
      (a, b) =>
        a.nextIssueDate!.localeCompare(b.nextIssueDate!) || a.name.localeCompare(b.name, "cs"),
    );
}

const upcomingRecurring: SystemWidgetRunner = (_q, ownerId, config, context) => {
  const plans = activePlans(ownerId);
  return result(today(context), {
    total: plans.length,
    detail: {
      kind: "upcoming_recurring",
      count: plans.length,
      plans: plans.slice(0, config.rows ?? DEFAULT_ROWS).map((plan) => ({
        id: plan.id,
        name: plan.name,
        customerName: plan.customerName,
        nextIssueDate: plan.nextIssueDate!,
      })),
    },
  });
};

const forecastWidget: SystemWidgetRunner = (q, ownerId, _config, context) => {
  const months = forecast(q, ownerId, context.today);
  const series = FORECAST_SERIES.map((key) => ({
    key,
    name: TEXTS.reports.forecast[key],
    kind: "row" as const,
    points: months.map((month) => ({ key: month.month, value: month[key] })),
  }));
  const last = months.at(-1)!.month;
  const [year, month] = last.split("-").map(Number) as [number, number];
  const to = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  return result(
    { from: context.today, to },
    {
      series,
      total: months.reduce(
        (sum, item) => sum + FORECAST_SERIES.reduce((inner, key) => inner + item[key], 0),
        0,
      ),
      unconverted: merged(
        months.flatMap((item) => FORECAST_SERIES.map((key) => item.unconverted[key])),
      ),
    },
  );
};

const unmatchedPayments: SystemWidgetRunner = (_q, ownerId, config, context) => {
  const counts = noticeCounts(ownerId);
  const notices = listNotices(ownerId, {
    statuses: ["pending", "unrecognized"],
    limit: config.rows ?? DEFAULT_ROWS,
  });
  return result(today(context), {
    total: counts.pending + counts.unrecognized,
    detail: {
      kind: "unmatched_payments",
      ...counts,
      notices: notices.map((row) => ({
        id: row.id,
        status: row.status as "pending" | "unrecognized",
        paidOn: row.paidOn,
        amountMinor: row.amountMinor,
        currency: row.currency,
        variableSymbol: row.variableSymbol,
        counterpartyName: row.counterpartyName,
      })),
    },
  });
};

const limits: SystemWidgetRunner = (q, ownerId, _config, context) => {
  const year = Number(context.today.slice(0, 4));
  const basis =
    q
      .select({ basis: preferences.turnoverBasis })
      .from(preferences)
      .where(scoped(ownerId).where(preferences))
      .get()?.basis ?? "taxable";
  const states = limitStates(q, ownerId, year);
  return result(
    { from: `${year}-01-01`, to: `${year}-12-31` },
    {
      total: states[0]?.turnoverMinor ?? 0,
      unconverted: states[0]?.unconverted ?? core.NOTHING,
      detail: { kind: "limits", year, basis, states },
    },
  );
};

// The CZK total is the advanceOpenMinor of the Statistics page; the rows stay in their currency.
const openAdvances: SystemWidgetRunner = (q, ownerId, config, context) => {
  const range = today(context);
  const summary = core.reportSummary(q, ownerId, { range, includeExternal: true }, context.today);
  const where = scoped(ownerId).where(invoice, (t) => and(openCondition, eq(t.type, "advance")));
  const count = q
    .select({ n: sql<number>`count(*)` })
    .from(invoice)
    .where(where)
    .get()!.n;
  const advances = q
    .select({
      id: invoice.id,
      number: invoice.number,
      customerName: invoice.customerName,
      dueDate: invoice.dueDate,
      amountDueMinor: dueSql,
      currency: invoice.currency,
    })
    .from(invoice)
    .where(where)
    .orderBy(sql`${invoice.dueDate} IS NULL`, asc(invoice.dueDate), asc(invoice.id))
    .limit(config.rows ?? DEFAULT_ROWS)
    .all();
  return result(range, {
    total: summary.advanceOpenMinor,
    unconverted: summary.unconverted.advanceOpen,
    detail: { kind: "open_advances", count, advances },
  });
};

const automationStatus: SystemWidgetRunner = (_q, ownerId, config, context) => {
  const settings = getAutomation(ownerId);
  const next = activePlans(ownerId)
    .filter((plan) => plan.mode === "send")
    .slice(0, config.rows ?? AUTOMATION_RUNS)
    .map((plan) => ({ id: plan.id, name: plan.name, date: plan.nextIssueDate! }));
  return result(today(context), {
    detail: {
      kind: "automation_status",
      paused: settings.paused,
      sendTime: settings.sendTime,
      enabled: Object.fromEntries(AUTOMATION_KEYS.map((key) => [key, settings[key]])) as Record<
        AutomationKey,
        boolean
      >,
      next,
    },
  });
};

const RUNNERS: Record<SystemWidgetId, SystemWidgetRunner> = {
  paid_ratio: paidRatio,
  aging,
  due_alerts: alerts,
  upcoming_recurring: upcomingRecurring,
  forecast: forecastWidget,
  unmatched_payments: unmatchedPayments,
  limits,
  open_advances: openAdvances,
  automation_status: automationStatus,
};

export function registerSystemWidgets(): void {
  Object.assign(SYSTEM_WIDGET_RUNNERS, RUNNERS);
}
