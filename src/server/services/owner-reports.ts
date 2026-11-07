import "server-only";
import { and, eq, ne, sql } from "drizzle-orm";
import type { Currency } from "@/lib/currency";
import { formatMoney } from "@/lib/money";
import { calendarDateInPrague, isDailyDue, type CalendarDate } from "@/lib/number-format";
import {
  CATCH_UP_DAYS,
  finishedPeriod,
  periodOfKey,
  type OwnerReportKind,
} from "@/lib/owner-reports";
import type { DateRange } from "@/lib/report-period";
import { fxCzk } from "@/lib/sql-functions";
import { formatCalendarDate } from "@/lib/template-vars";
import { TEXTS } from "@/lib/texts";
import { clock } from "../clock";
import { db } from "../db";
import { automationSettings, job, user, type Job, type JobPayload } from "../db/schema";
import { scoped } from "../db/scoped";
import { enqueue } from "../jobs/queue";
import { RetryLater } from "../jobs/registry";
import { forecast, FORECAST_SERIES } from "../reports/forecast";
import { reportSummary } from "../reports/queries";
import type { Unconverted } from "../reports/types";
import { reportFailure } from "../scheduler/report";
import { getAutomation } from "./automation";
import { dueAlerts } from "./due-alerts";
import { resolveTransport } from "./mail-settings";
import { mutate } from "./mutation";
import { getPreferences } from "./preferences";

const RETRY_MS = 30 * 60_000;

const T = TEXTS.ownerReports;

export type Money = { minor: number; unconverted: Unconverted };

export type PeriodSummary = {
  range: DateRange;
  next: DateRange;
  today: CalendarDate;
  invoiced: Money;
  income: Money;
  outstanding: Money;
  overdue: Money & { count: number };
  outlook: Money;
};

class Missing {
  private byCurrency = new Map<Currency, number>();
  private count = 0;

  add(unconverted: Unconverted): void {
    this.count += unconverted.count;
    for (const { currency, amountMinor } of unconverted.byCurrency) {
      this.byCurrency.set(currency, (this.byCurrency.get(currency) ?? 0) + amountMinor);
    }
  }

  one(currency: Currency, amountMinor: number): void {
    this.add({ count: 1, byCurrency: [{ currency, amountMinor }] });
  }

  get value(): Unconverted {
    return {
      count: this.count,
      byCurrency: [...this.byCurrency]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([currency, amountMinor]) => ({ currency, amountMinor })),
    };
  }
}

function monthIndex(month: string): number {
  const [year, number] = month.split("-").map(Number) as [number, number];
  return year * 12 + number - 1;
}

// Every series of the forecast for the months of the next period. On the first days of a period
// today's month is its first month, so the forecast starts exactly there.
function outlookOf(ownerId: string, next: DateRange, today: CalendarDate): Money {
  const first = next.from.slice(0, 7);
  const last = next.to.slice(0, 7);
  const months = Math.max(1, monthIndex(last) - monthIndex(today.slice(0, 7)) + 1);
  const missing = new Missing();
  let minor = 0;
  for (const month of forecast(db, ownerId, today, months)) {
    if (month.month < first || month.month > last) continue;
    for (const series of FORECAST_SERIES) {
      minor += month[series];
      missing.add(month.unconverted[series]);
    }
  }
  return { minor, unconverted: missing.value };
}

function overdueOf(ownerId: string, today: CalendarDate): Money & { count: number } {
  const { overdue } = dueAlerts(ownerId, today);
  const missing = new Missing();
  let minor = 0;
  for (const row of overdue) {
    const czk = fxCzk(row.currency, row.amountDueMinor, row.rateMicros);
    if (czk === null) missing.one(row.currency, row.amountDueMinor);
    else minor += Number(czk);
  }
  return { count: overdue.length, minor, unconverted: missing.value };
}

// Flows follow the finished period; balances and the outlook are as of today (R-16).
export function periodSummary(
  ownerId: string,
  range: DateRange,
  next: DateRange,
  today: CalendarDate,
): PeriodSummary {
  const summary = reportSummary(db, ownerId, { range, includeExternal: true }, today);
  return {
    range,
    next,
    today,
    invoiced: { minor: summary.invoicedMinor, unconverted: summary.unconverted.invoiced },
    income: { minor: summary.incomeMinor, unconverted: summary.unconverted.income },
    outstanding: {
      minor: summary.outstandingMinor,
      unconverted: summary.unconverted.outstanding,
    },
    overdue: overdueOf(ownerId, today),
    outlook: outlookOf(ownerId, next, today),
  };
}

export function periodLabel(range: DateRange): string {
  const [year, month] = range.from.split("-").map(Number) as [number, number];
  if (range.from.slice(0, 7) === range.to.slice(0, 7)) return `${T.months[month - 1]} ${year}`;
  return T.quarter(Math.floor((month - 1) / 3) + 1, year);
}

const czk = (minor: number) => formatMoney(minor, "CZK");

function unconvertedLine({ count, byCurrency }: Unconverted): string[] {
  if (count === 0) return [];
  const amounts = byCurrency.map((row) => formatMoney(row.amountMinor, row.currency)).join(", ");
  return [T.summary.unconverted(count, amounts)];
}

// The one place that builds the summary body, so a later HTML layout can wrap it unchanged.
export function summaryText(ownerId: string, summary: PeriodSummary): string {
  const { dateFormat } = getPreferences(ownerId);
  const date = (value: CalendarDate) => formatCalendarDate(value, dateFormat);
  const S = T.summary;
  return [
    S.title(periodLabel(summary.range), date(summary.range.from), date(summary.range.to)),
    "",
    S.invoiced(czk(summary.invoiced.minor)),
    ...unconvertedLine(summary.invoiced.unconverted),
    S.income(czk(summary.income.minor)),
    ...unconvertedLine(summary.income.unconverted),
    S.outstanding(date(summary.today), czk(summary.outstanding.minor)),
    ...unconvertedLine(summary.outstanding.unconverted),
    S.overdue(summary.overdue.count, czk(summary.overdue.minor)),
    ...unconvertedLine(summary.overdue.unconverted),
    S.outlook(periodLabel(summary.next), czk(summary.outlook.minor)),
    ...unconvertedLine(summary.outlook.unconverted),
    "",
    S.note,
  ].join("\n");
}

function planned(userId: string, key: string): boolean {
  return Boolean(
    db
      .select({ id: job.id })
      .from(job)
      .where(scoped(userId).where(job, (t, ops) => ops.eq(t.key, key)))
      .get(),
  );
}

// An existing job with the key means the report was already planned, whatever became of it (R-15).
function planReport(
  userId: string,
  key: string,
  payload: JobPayload & { report: OwnerReportKind },
): void {
  if (planned(userId, key)) return;
  mutate({ userId, source: "scheduler" }, "mail.owner_report_plan", (tx, audit) => {
    const { created } = enqueue(tx, { kind: "user.report", key, userId, payload });
    if (!created) return;
    audit({
      entity: "automation",
      entityId: userId,
      ownerId: userId,
      scope: "user",
      after: payload,
    });
  });
}

function summaryAccounts() {
  return db
    .select({
      userId: automationSettings.userId,
      sendTime: automationSettings.sendTime,
      mode: automationSettings.periodSummary,
    })
    .from(automationSettings)
    .innerJoin(user, eq(user.id, automationSettings.userId))
    .where(and(ne(automationSettings.periodSummary, "off"), sql`coalesce(${user.banned}, 0) = 0`))
    .all();
}

// Runs under the master switch as well: these messages go to the account owner alone (R-15).
export function planOwnerReports(now: Date): void {
  const today = calendarDateInPrague(now);
  for (const { userId, sendTime, mode } of summaryAccounts()) {
    if (mode === "off" || !isDailyDue(now, sendTime)) continue;
    const period = finishedPeriod(today, mode);
    if (period.dayOfPeriod > CATCH_UP_DAYS) continue;
    try {
      planReport(userId, `summary:${userId}:${period.key}`, {
        report: "summary",
        period: period.key,
      });
    } catch (error) {
      reportFailure(error, { task: "owner-report-plan", userId });
    }
  }
}

type Delivery = { subject: string; text: string; after: JobPayload };

function summaryDelivery(userId: string, key: string): Delivery | null {
  const period = periodOfKey(key);
  if (!period) throw new Error(`Neznámé období souhrnu: ${key}`);
  if (getAutomation(userId).periodSummary !== period.mode) return null;
  const today = calendarDateInPrague(clock.now());
  const summary = periodSummary(userId, period.range, period.next, today);
  return {
    subject: T.summary.subject(periodLabel(period.range)),
    text: summaryText(userId, summary),
    after: { report: "summary", period: key },
  };
}

export async function deliverOwnerReport(row: Job): Promise<void> {
  const userId = row.userId;
  if (!userId) throw new Error("E-mail pro vlastníka nemá vlastníka");
  const account = db
    .select({ email: user.email, banned: user.banned })
    .from(user)
    .where(eq(user.id, userId))
    .get();
  if (!account || account.banned) return;
  const { report, period } = row.payload;
  if (report !== "summary") throw new Error(`Neznámý druh e-mailu pro vlastníka: ${report}`);
  // The switch is read again: turning the summary off or changing its kind stops a planned one.
  const delivery = summaryDelivery(userId, String(period));
  if (!delivery) return;
  const transport = await resolveTransport(userId);
  if (!transport) return;
  const { from, replyTo } = transport.identity;
  try {
    // Without the account's standing copies: this message is for the owner alone.
    await transport.send({
      from,
      ...(replyTo ? { replyTo } : {}),
      to: account.email,
      subject: delivery.subject,
      text: delivery.text,
    });
  } catch {
    throw new RetryLater("E-mail pro vlastníka se zopakuje", RETRY_MS);
  }
  mutate({ userId, source: "scheduler" }, "mail.owner_report", (_tx, audit) =>
    audit({
      entity: "automation",
      entityId: userId,
      ownerId: userId,
      scope: "user",
      after: delivery.after,
    }),
  );
}
