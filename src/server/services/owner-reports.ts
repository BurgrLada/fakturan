import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq, ne, or, sql } from "drizzle-orm";
import { formatMoney } from "@/lib/money";
import { calendarDateInPrague, isDailyDue, type CalendarDate } from "@/lib/number-format";
import {
  CATCH_UP_DAYS,
  finishedPeriod,
  LIMIT_MAIL_THRESHOLDS,
  limitMailThreshold,
  limitYears,
  lowerThresholds,
  periodOfKey,
  taxReminderDue,
  type LimitMailThreshold,
  type OwnerReportKind,
} from "@/lib/owner-reports";
import type { DateRange } from "@/lib/report-period";
import { formatCalendarDate } from "@/lib/template-vars";
import { TAX_TEXT_REVIEWED } from "@/lib/tax-text";
import { TEXTS } from "@/lib/texts";
import { clock } from "../clock";
import { db, type Tx } from "../db";
import { env } from "../env";
import {
  auditLog,
  automationSettings,
  job,
  limitMailSent,
  user,
  type Job,
  type JobPayload,
} from "../db/schema";
import { scoped } from "../db/scoped";
import { enqueue } from "../jobs/queue";
import { RetryLater } from "../jobs/registry";
import { periodSnapshot, type Money, type PeriodSummary } from "../reports/period-summary";
import { taxOverview, type TaxOverview } from "../reports/tax";
import { limitStates, type LimitState } from "../reports/turnover";
import type { Unconverted } from "../reports/types";
import { reportFailure } from "../scheduler/report";
import { getAutomation } from "./automation";
import { resolveTransport } from "./mail-settings";
import { mutate } from "./mutation";
import { getPreferences } from "./preferences";

const RETRY_MS = 30 * 60_000;
// Each of these goes out once a period, year or threshold, so a missing or failing mail server is
// waited out for half a day before the message is given up (M-3 of block C).
const ATTEMPTS = 24;

const T = TEXTS.ownerReports;

export type { Money, PeriodSummary };

// Flows follow the finished period; balances and the outlook are as of today (R-16).
export function periodSummary(
  ownerId: string,
  range: DateRange,
  next: DateRange,
  today: CalendarDate,
): PeriodSummary {
  return periodSnapshot(db, ownerId, range, next, today);
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

function enqueueReport(
  tx: Tx,
  audit: Parameters<Parameters<typeof mutate>[2]>[1],
  userId: string,
  key: string,
  payload: ReportPayload,
): void {
  const { created } = enqueue(tx, {
    kind: "user.report",
    key,
    userId,
    payload,
    maxAttempts: ATTEMPTS,
  });
  if (!created) return;
  audit({ entity: "automation", entityId: userId, ownerId: userId, scope: "user", after: payload });
}

// An existing job with the key means the report was already planned, whatever became of it (R-15).
// The job outlives the window in which the summary and the reminder are planned.
function planReport(userId: string, key: string, payload: ReportPayload): void {
  if (planned(userId, key)) return;
  mutate({ userId, source: "scheduler" }, "mail.owner_report_plan", (tx, audit) =>
    enqueueReport(tx, audit, userId, key, payload),
  );
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

const MAIL_THRESHOLDS = new Map<string, LimitMailThreshold>(
  LIMIT_MAIL_THRESHOLDS.map((value) => [String(value), value]),
);

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

// Whether the year holds anything is decided when the reminder is built, not by the account's age:
// an account opened in January may carry the previous year from an import or a restore.
function planTax(account: Account, today: CalendarDate): void {
  const due = taxReminderDue(today);
  if (!account.tax || !due) return;
  planReport(account.userId, `tax:${account.userId}:${due.year}`, {
    report: "tax",
    period: String(due.year),
  });
}

function vatState(userId: string, year: number): (LimitState & { watched: true }) | null {
  const state = limitStates(db, userId, year).find((item) => item.key === "vat");
  return state?.watched ? state : null;
}

function sentThresholds(userId: string, year: number): Set<string> {
  return new Set(
    db
      .select({ threshold: limitMailSent.threshold })
      .from(limitMailSent)
      .where(scoped(userId).where(limitMailSent, (t, ops) => ops.eq(t.year, year)))
      .all()
      .map((row) => row.threshold),
  );
}

// The lasting record, not the job, keeps a threshold from repeating once the job is purged (C-1).
// Only the highest threshold crossed is sent; the lower ones are recorded with it.
function planLimitYear(userId: string, year: number): void {
  const sent = sentThresholds(userId, year);
  if (sent.has("over")) return;
  const state = vatState(userId, year);
  const threshold = state && limitMailThreshold(state.level);
  if (!threshold || sent.has(String(threshold))) return;
  mutate({ userId, source: "scheduler" }, "mail.owner_report_plan", (tx, audit) => {
    for (const value of [...lowerThresholds(threshold), threshold]) {
      tx.insert(limitMailSent)
        .values({
          id: randomUUID(),
          userId,
          year,
          threshold: String(value),
          createdAt: clock.now(),
        })
        .onConflictDoNothing()
        .run();
    }
    enqueueReport(tx, audit, userId, `limit:${userId}:${year}:${threshold}`, {
      report: "limit",
      period: String(year),
      threshold: String(threshold),
    });
  });
}

// A daily check (R-16): the year's turnover is summed once a day per account, not on every tick.
const limitCheckedOn = new Map<string, CalendarDate>();

function planLimit(account: Account, today: CalendarDate): void {
  if (!account.limit || limitCheckedOn.get(account.userId) === today) return;
  limitCheckedOn.set(account.userId, today);
  for (const year of limitYears(today)) planLimitYear(account.userId, year);
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

const REVIEW = TAX_TEXT_REVIEWED ? [] : [`(${TEXTS.tax.reviewPending})`];

function yearOverview(ownerId: string, year: number): TaxOverview {
  const today = calendarDateInPrague(clock.now());
  return taxOverview(db, ownerId, { year, basis: "paid" }, today);
}

function taxText(ownerId: string, year: number, overview: TaxOverview): string {
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
    ...REVIEW,
  ].join("\n");
}

// The one place that builds the January reminder, for the HTML layout to wrap.
export function taxReminderText(ownerId: string, year: number): string {
  return taxText(ownerId, year, yearOverview(ownerId, year));
}

// The one place that builds the VAT limit message, for the HTML layout to wrap. The wording follows
// the threshold of the job, so a later rise is left to the job of its own threshold (M-2).
export function limitMailText(
  _ownerId: string,
  state: LimitState & { watched: true },
  year: number,
  threshold: LimitMailThreshold = limitMailThreshold(state.level) ?? LIMIT_MAIL_THRESHOLDS[0],
): string {
  const L = T.limit;
  const url = new URL("/prehledy?zalozka=limity", env.BETTER_AUTH_URL).href;
  const headline =
    threshold === "over"
      ? [L.over(year, L.vat), L.registration, ...REVIEW]
      : [L.reached(year, threshold, L.vat)];
  return [
    ...headline,
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
  // Changing the kind and back within days 1–3 leaves this period without a summary: the planned
  // job used its key (M-8 of block C).
  if (getAutomation(userId).periodSummary !== period.mode) return null;
  const today = calendarDateInPrague(clock.now());
  // Held up past its own period, the outlook would start after the period it describes (M-7).
  if (finishedPeriod(today, period.mode).key !== key) return null;
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
  const overview = yearOverview(userId, year);
  // A reminder with nothing in it is skipped, an account with data from a later import is not (I-2).
  const empty =
    overview.totalCzkMinor === 0 &&
    overview.unconverted.count === 0 &&
    overview.unpaid.length === 0;
  if (empty) return null;
  return {
    subject: T.tax.subject(year),
    text: taxText(userId, year, overview),
    after: { report: "tax", period: String(year) },
  };
}

function limitDelivery(userId: string, period: unknown, value: unknown): Delivery | null {
  const year = yearOf(period);
  const threshold = MAIL_THRESHOLDS.get(String(value));
  if (!threshold) throw new Error(`Neznámý práh limitu: ${String(value)}`);
  if (!getAutomation(userId).limitMail) return null;
  const state = vatState(userId, year);
  const reached = state && limitMailThreshold(state.level);
  const rank = (item: LimitMailThreshold) => LIMIT_MAIL_THRESHOLDS.indexOf(item);
  if (!state || !reached || rank(reached) < rank(threshold)) return null;
  return {
    subject:
      threshold === "over"
        ? T.limit.overSubject(T.limit.vat)
        : T.limit.subject(threshold, T.limit.vat),
    text: limitMailText(userId, state, year, threshold),
    after: { report: "limit", period: String(year), threshold: String(threshold) },
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
  if (!transport) throw new RetryLater("E-mail pro vlastníka čeká na nastavení pošty", RETRY_MS);
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
