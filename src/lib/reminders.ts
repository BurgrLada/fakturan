import { z } from "zod";
import { mailContentSchema } from "./email-template";
import { addDays, daysBetween, type InvoiceStatus, type InvoiceType } from "./invoice";
import { calendarDateInPrague, type CalendarDate } from "./number-format";
import type { Language } from "./preferences";
import { amountDue, type Balance } from "./qr-payload";
import { MAIL_VARIABLE_NAMES, validateVariables } from "./template-vars";
import { TEXTS } from "./texts";

const E = TEXTS.reminders.errors;

export const MAX_STAGE_AGE_DAYS = 3;
export const MAX_SNOOZE_DAYS = 30;
export const MAX_OFFSET_DAYS = 365;
export const MAX_REMINDER_RULES = 20;

// A manual reminder without a stage: no rule ever carries this key.
export const MANUAL_STAGE = "manual";

export type ReminderContent = z.output<typeof mailContentSchema>;
export type ReminderTexts = Partial<Record<Language, ReminderContent>>;

export type ReminderRule = {
  id: string;
  offsetDays: number;
  // The day this offset came to exist: nothing dated up to it is ever caught up on.
  activeSince: CalendarDate;
  texts: ReminderTexts | null;
};

const content = mailContentSchema.superRefine((value, ctx) => {
  const unknown = validateVariables(`${value.subject}\n${value.body}`, MAIL_VARIABLE_NAMES);
  if (unknown.length > 0) {
    ctx.addIssue({ code: "custom", message: E.unknownVariable(unknown) });
  }
});

export const reminderRuleSchema = z.object({
  id: z.string(E.invalid).min(1, E.invalid).optional(),
  offsetDays: z
    .number(E.offset)
    .int(E.offset)
    .min(-MAX_OFFSET_DAYS, E.offset)
    .max(MAX_OFFSET_DAYS, E.offset),
  texts: z.object({ cs: content.optional(), en: content.optional() }, E.invalid).nullable(),
});

export type ReminderRuleInput = z.input<typeof reminderRuleSchema>;

type StageInvoice = {
  dueDate: CalendarDate | null;
  remindersSnoozeUntil: CalendarDate | null;
  sentAt: Date | null;
};

type StageInput<R> = {
  invoice: StageInvoice;
  rules: R[];
  // Days, not rule ids: a deleted and recreated stage is still the same stage for the client.
  sentOffsets: number[];
  today: CalendarDate;
  openSince: CalendarDate;
};

export function days(count: number): string {
  if (count === 1) return "1 den";
  return count >= 2 && count <= 4 ? `${count} dny` : `${count} dní`;
}

export function stageLabel(offsetDays: number): string {
  const { before, after, onDay } = TEXTS.reminders.rules;
  if (offsetDays === 0) return onDay;
  return offsetDays < 0 ? before(days(-offsetDays)) : after(days(offsetDays));
}

// A snooze only delays: the opening date always judges the undelayed date, so it revives nothing.
export function stageDate(
  invoice: Pick<StageInvoice, "remindersSnoozeUntil"> & { dueDate: CalendarDate },
  offsetDays: number,
): CalendarDate {
  const date = addDays(invoice.dueDate, offsetDays);
  const snooze = invoice.remindersSnoozeUntil;
  return snooze && snooze > date ? snooze : date;
}

type Dated<R> = { rule: R; plain: CalendarDate; date: CalendarDate };

function latestStage<R extends ReminderRule>(
  { invoice, rules, sentOffsets }: StageInput<R>,
  matches: (stage: Dated<R>) => boolean,
): R | null {
  const { dueDate } = invoice;
  if (!dueDate) return null;
  const dated = { ...invoice, dueDate };
  const latestSent = Math.max(-Infinity, ...sentOffsets);
  const open = rules.filter((rule) =>
    matches({
      rule,
      plain: addDays(dueDate, rule.offsetDays),
      date: stageDate(dated, rule.offsetDays),
    }),
  );
  const latest = open.reduce<R | null>(
    (best, rule) => (best && best.offsetDays > rule.offsetDays ? best : rule),
    null,
  );
  return latest && latest.offsetDays > latestSent ? latest : null;
}

const isFresh = (date: CalendarDate, today: CalendarDate) =>
  daysBetween(date, today) <= MAX_STAGE_AGE_DAYS;

// An outage may leave several stages open: only the latest goes, so the order never runs backwards.
export function dueStage<R extends ReminderRule>(input: StageInput<R>): R | null {
  const { invoice, today, openSince } = input;
  if (!invoice.sentAt) return null;
  const sentOn = calendarDateInPrague(invoice.sentAt);
  return latestStage(
    input,
    ({ rule, plain, date }) =>
      plain > openSince &&
      plain > sentOn &&
      plain > rule.activeSince &&
      date <= today &&
      isFresh(date, today),
  );
}

export function stageForReview<R extends ReminderRule>(input: StageInput<R>): R | null {
  const { today, openSince } = input;
  return latestStage(
    input,
    ({ plain, date }) => date <= today && (plain <= openSince || !isFresh(date, today)),
  );
}

export const REMINDABLE_TYPES: readonly InvoiceType[] = ["invoice", "advance"];

type EligibleInvoice = Balance & {
  type: InvoiceType;
  status: InvoiceStatus;
  sentAt: Date | null;
  remindersOff: boolean;
  remindersPartial: boolean;
};

// The customer's true adds nothing: it may only block, never override the account switch (R-12).
export function isEligibleForReminder(
  invoice: EligibleInvoice,
  customer: { remindersEnabled: boolean | null } | null,
): boolean {
  if (!REMINDABLE_TYPES.includes(invoice.type) || amountDue(invoice) <= 0) return false;
  if (!invoice.sentAt) return false;
  if (invoice.remindersOff || customer?.remindersEnabled === false) return false;
  // A final invoice with a rest after its advance keeps the base status, but it is a part payment.
  const partial =
    invoice.status === "partially_paid" || (invoice.status === "sent" && invoice.advanceMinor > 0);
  return partial ? invoice.remindersPartial : invoice.status === "sent";
}
