import "server-only";
import { and, count, desc, eq, ne, or, sql } from "drizzle-orm";
import type { Currency } from "@/lib/currency";
import { formatMoney } from "@/lib/money";
import { calendarDateInPrague, isDailyDue, type CalendarDate } from "@/lib/number-format";
import {
  CATCH_UP_DAYS,
  finishedPeriod,
  limitMailThreshold,
  periodOfKey,
  taxReminderDue,
  type OwnerReportKind,
} from "@/lib/owner-reports";
import type { DateRange } from "@/lib/report-period";
import { formatCalendarDate } from "@/lib/template-vars";
import { LIMIT_HIGH_PERCENT, LIMIT_WARN_PERCENT } from "@/lib/turnover-limits";
import { TEXTS } from "@/lib/texts";
import { clock } from "../clock";
import { db } from "../db";
import { env } from "../env";
import { overdueCondition } from "../db/invoice-sql";
import {
  auditLog,
  automationSettings,
  invoice,
  job,
  user,
  type Job,
  type JobPayload,
} from "../db/schema";
import { scoped } from "../db/scoped";
import { enqueue } from "../jobs/queue";
import { RetryLater } from "../jobs/registry";
import { forecast, FORECAST_SERIES } from "../reports/forecast";
import { notAdvance, reportSummary, stateFilter } from "../reports/queries";
import { taxOverview } from "../reports/tax";
import { limitStates, type LimitState } from "../reports/turnover";
import type { ReportFilter, Unconverted } from "../reports/types";
import { reportFailure } from "../scheduler/report";
import { getAutomation } from "./automation";
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

// Counted like the overdue amount of reportSummary and the dashboard: advances stay out.
function overdueCount(ownerId: string, filter: ReportFilter, today: CalendarDate): number {
  const where = and(stateFilter(db, ownerId, filter), overdueCondition(today), notAdvance);
  return db.select({ n: count() }).from(invoice).where(where).get()?.n ?? 0;
}

// Flows follow the finished period; balances and the outlook are as of today (R-16).
export function periodSummary(
  ownerId: string,
  range: DateRange,
  next: DateRange,
  today: CalendarDate,
): PeriodSummary {
  const filter: ReportFilter = { range, includeExternal: true };
  const summary = reportSummary(db, ownerId, filter, today);
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
    overdue: {
      count: overdueCount(ownerId, filter, today),
      minor: summary.overdueMinor,
      unconverted: summary.unconverted.overdue,
    },
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

type ReportPayload = JobPayload & { report: OwnerReportKind };

// An existing job with the key means the report was already planned, whatever became of it (R-15).
// A settled key is recorded as done without a message, like a lower threshold jumped over.
function planReport(
  userId: string,
  key: string,
  payload: ReportPayload,
  settled: { key: string; payload: ReportPayload }[] = [],
): void {
  if (planned(userId, key)) return;
  mutate({ userId, source: "scheduler" }, "mail.owner_report_plan", (tx, audit) => {
    for (const skip of settled) {
      const { id, created } = enqueue(tx, { kind: "user.report", userId, ...skip });
      if (created) {
        tx.update(job).set({ status: "done", updatedAt: clock.now() }).where(eq(job.id, id)).run();
      }
    }
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

function reportAccounts() {
  return db
    .select({
      userId: automationSettings.userId,
      sendTime: automationSettings.sendTime,
      summary: automationSettings.periodSummary,
      tax: automationSettings.taxReminder,
      limit: automationSettings.limitMail,
      createdAt: user.createdAt,
    })
    .from(automationSettings)
    .innerJoin(user, eq(user.id, automationSettings.userId))
    .where(
      and(
        or(
          ne(automationSettings.periodSummary, "off"),
          eq(automationSettings.taxReminder, true),
          eq(automationSettings.limitMail, true),
        ),
        sql`coalesce(${user.banned}, 0) = 0`,
      ),
    )
    .all();
}

type Account = ReturnType<typeof reportAccounts>[number] & { since: CalendarDate };

function planSummary(account: Account, today: CalendarDate): void {
  if (account.summary === "off") return;
  const period = finishedPeriod(today, account.summary);
  if (period.dayOfPeriod > CATCH_UP_DAYS) return;
  // A period that ended before the account existed has nothing of the account in it.
  if (account.since > period.range.to) return;
  planReport(account.userId, `summary:${account.userId}:${period.key}`, {
    report: "summary",
    period: period.key,
  });
}

function planTax(account: Account, today: CalendarDate): void {
  const due = taxReminderDue(today);
  if (!account.tax || !due || account.since > `${due.year}-12-31`) return;
  planReport(account.userId, `tax:${account.userId}:${due.year}`, {
    report: "tax",
    period: String(due.year),
  });
}

function vatState(userId: string, year: number): (LimitState & { watched: true }) | null {
  const state = limitStates(db, userId, year).find((item) => item.key === "vat");
  return state?.watched ? state : null;
}

function planLimit(account: Account, today: CalendarDate): void {
  if (!account.limit) return;
  const year = Number(today.slice(0, 4));
  const state = vatState(account.userId, year);
  const threshold = state && limitMailThreshold(state.level);
  if (!threshold) return;
  const keyOf = (value: number) => `limit:${account.userId}:${year}:${value}`;
  const payloadOf = (value: number): ReportPayload => ({
    report: "limit",
    period: String(year),
    threshold: value,
  });
  // Only the highest threshold crossed is sent; the lower one is settled so it never follows.
  const lower = threshold === LIMIT_HIGH_PERCENT ? [LIMIT_WARN_PERCENT] : [];
  planReport(
    account.userId,
    keyOf(threshold),
    payloadOf(threshold),
    lower.map((value) => ({ key: keyOf(value), payload: { ...payloadOf(value), settled: true } })),
  );
}

const PLANNERS = [planSummary, planTax, planLimit];

// Runs under the master switch as well: these messages go to the account owner alone (R-15).
export function planOwnerReports(now: Date): void {
  const today = calendarDateInPrague(now);
  for (const row of reportAccounts()) {
    if (!isDailyDue(now, row.sendTime)) continue;
    const account = { ...row, since: calendarDateInPrague(row.createdAt) };
    for (const plan of PLANNERS) {
      try {
        plan(account, today);
      } catch (error) {
        reportFailure(error, { task: "owner-report-plan", userId: row.userId });
      }
    }
  }
}

function isEmpty(summary: PeriodSummary): boolean {
  const money = [summary.invoiced, summary.income, summary.outstanding, summary.overdue];
  return (
    summary.overdue.count === 0 &&
    [...money, summary.outlook].every((m) => m.minor === 0 && m.unconverted.count === 0)
  );
}

// Turned on (or changed) only after the period ended: the catch-up is the first summary it sends.
function switchedOnAfter(userId: string, end: CalendarDate): boolean {
  const last = db
    .select({ at: auditLog.at })
    .from(auditLog)
    .where(
      scoped(userId).where(auditLog, (t, ops) => ops.eq(t.action, "automation.period_summary")),
    )
    .orderBy(desc(auditLog.id))
    .limit(1)
    .get();
  return last !== undefined && calendarDateInPrague(last.at) > end;
}

// The one place that builds the January reminder, for the HTML layout to wrap.
export function taxReminderText(ownerId: string, year: number): string {
  const today = calendarDateInPrague(clock.now());
  const overview = taxOverview(db, ownerId, { year, basis: "paid" }, today);
  const { dateFormat } = getPreferences(ownerId);
  const X = T.tax;
  const url = new URL(`/prehledy/dane?rok=${year}`, env.BETTER_AUTH_URL).href;
  return [
    X.title(year),
    "",
    X.income(year, czk(overview.totalCzkMinor)),
    ...unconvertedLine(overview.unconverted),
    ...(overview.estimated.count > 0
      ? [X.estimated(overview.estimated.count, czk(overview.estimated.czkMinor))]
      : []),
    X.unpaid(
      formatCalendarDate(overview.asOf, dateFormat),
      overview.unpaid.length,
      czk(overview.unpaidCzkMinor),
    ),
    ...unconvertedLine(overview.unpaidUnconverted),
    "",
    X.link(url),
    "",
    TEXTS.tax.disclaimer,
  ].join("\n");
}

// The one place that builds the VAT limit message, for the HTML layout to wrap.
export function limitMailText(
  _ownerId: string,
  state: LimitState & { watched: true },
  year: number,
): string {
  const L = T.limit;
  const threshold = limitMailThreshold(state.level) ?? LIMIT_WARN_PERCENT;
  const url = new URL("/prehledy?zalozka=limity", env.BETTER_AUTH_URL).href;
  return [
    state.level === "over" ? L.over(year, L.vat) : L.reached(year, threshold, L.vat),
    L.usage(czk(state.turnoverMinor), czk(state.limitMinor), state.percent),
    ...unconvertedLine(state.unconverted),
    "",
    L.link(url),
    "",
    L.note,
  ].join("\n");
}

type Delivery = { subject: string; text: string; after: JobPayload };

function summaryDelivery(userId: string, key: string): Delivery | null {
  const period = periodOfKey(key);
  if (!period) throw new Error(`Neznámé období souhrnu: ${key}`);
  if (getAutomation(userId).periodSummary !== period.mode) return null;
  const today = calendarDateInPrague(clock.now());
  const summary = periodSummary(userId, period.range, period.next, today);
  if (isEmpty(summary) && switchedOnAfter(userId, period.range.to)) return null;
  return {
    subject: T.summary.subject(periodLabel(period.range)),
    text: summaryText(userId, summary),
    after: { report: "summary", period: key },
  };
}

function yearOf(period: unknown): number {
  const year = Number(period);
  if (!Number.isInteger(year) || year < 1900 || year > 9999) {
    throw new Error(`Neznámý rok e-mailu pro vlastníka: ${String(period)}`);
  }
  return year;
}

function taxDelivery(userId: string, period: unknown): Delivery | null {
  const year = yearOf(period);
  if (!getAutomation(userId).taxReminder) return null;
  return {
    subject: T.tax.subject(year),
    text: taxReminderText(userId, year),
    after: { report: "tax", period: String(year) },
  };
}

function limitDelivery(userId: string, period: unknown, threshold: unknown): Delivery | null {
  const year = yearOf(period);
  if (!getAutomation(userId).limitMail) return null;
  const state = vatState(userId, year);
  const reached = state && limitMailThreshold(state.level);
  if (!state || !reached || reached < Number(threshold)) return null;
  return {
    subject: T.limit.subject(reached, T.limit.vat),
    text: limitMailText(userId, state, year),
    after: { report: "limit", period: String(year), threshold: reached },
  };
}

// Each kind reads its own switch again, so turning it off stops a message already planned.
function deliveryOf(userId: string, payload: JobPayload): Delivery | null {
  const { report, period, threshold } = payload;
  if (report === "summary") return summaryDelivery(userId, String(period));
  if (report === "tax") return taxDelivery(userId, period);
  if (report === "limit") return limitDelivery(userId, period, threshold);
  throw new Error(`Neznámý druh e-mailu pro vlastníka: ${String(report)}`);
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
  const delivery = deliveryOf(userId, row.payload);
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
