import { z } from "zod";
import { mailContentSchema } from "./email-template";
import { addDays, daysBetween, type InvoiceStatus, type InvoiceType } from "./invoice";
import type { CalendarDate } from "./number-format";
import type { Language } from "./preferences";
import { amountDue } from "./qr-payload";
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

export type ReminderRule = { id: string; offsetDays: number; texts: ReminderTexts | null };

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

type StageInvoice = { dueDate: CalendarDate | null; remindersSnoozeUntil: CalendarDate | null };

type StageInput<R> = {
  invoice: StageInvoice;
  rules: R[];
  sentStages: string[];
  today: CalendarDate;
  openSince: CalendarDate;
};

export function stageLabel(offsetDays: number): string {
  const { before, after, onDay } = TEXTS.reminders.rules;
  if (offsetDays === 0) return onDay;
  return offsetDays < 0 ? before(-offsetDays) : after(offsetDays);
}

export function stageDate(
  invoice: StageInvoice & { dueDate: CalendarDate },
  offsetDays: number,
): CalendarDate {
  const date = addDays(invoice.dueDate, offsetDays);
  const snooze = invoice.remindersSnoozeUntil;
  return snooze && snooze > date ? snooze : date;
}

function pickStage<R extends ReminderRule>(
  { invoice, rules, sentStages }: StageInput<R>,
  matches: (date: CalendarDate) => boolean,
): R | null {
  const { dueDate } = invoice;
  if (!dueDate) return null;
  const sent = rules.filter((rule) => sentStages.includes(rule.id));
  const latestSent = Math.max(-Infinity, ...sent.map((rule) => rule.offsetDays));
  const dated = { ...invoice, dueDate };
  const open = rules.filter((rule) => matches(stageDate(dated, rule.offsetDays)));
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
  const { today, openSince } = input;
  return pickStage(input, (date) => date > openSince && date <= today && isFresh(date, today));
}

export function stageForReview<R extends ReminderRule>(input: StageInput<R>): R | null {
  const { today, openSince } = input;
  return pickStage(input, (date) => date <= today && (date <= openSince || !isFresh(date, today)));
}

const REMINDABLE_TYPES: readonly InvoiceType[] = ["invoice", "advance"];

type EligibleInvoice = {
  type: InvoiceType;
  status: InvoiceStatus;
  totalMinor: number;
  paidMinor: number;
  remindersOff: boolean;
  remindersPartial: boolean;
};

// The customer's true adds nothing: it may only block, never override the account switch (R-12).
export function isEligibleForReminder(
  invoice: EligibleInvoice,
  customer: { remindersEnabled: boolean | null } | null,
): boolean {
  if (!REMINDABLE_TYPES.includes(invoice.type) || amountDue(invoice) <= 0) return false;
  if (invoice.remindersOff || customer?.remindersEnabled === false) return false;
  return (
    invoice.status === "sent" || (invoice.status === "partially_paid" && invoice.remindersPartial)
  );
}
