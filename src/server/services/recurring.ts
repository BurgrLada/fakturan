import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { addDays } from "@/lib/invoice";
import type { TemplateDocument } from "@/lib/invoice-template";
import { calendarDateInPrague, type CalendarDate } from "@/lib/number-format";
import {
  ISSUE_RULES,
  nextOccurrences,
  occurrencesBetween,
  RECURRENCE_FREQUENCIES,
  RECURRING_MODES,
  validateRule,
  type RecurrenceRule,
} from "@/lib/recurrence";
import { TEXTS } from "@/lib/texts";
import type { Actor } from "../audit/context";
import type { AuditAction } from "../audit/record";
import { clock } from "../clock";
import { db } from "../db";
import { czech } from "../db/collation";
import {
  customer,
  invoice,
  recurringInvoice,
  recurringRun,
  type RecurringInvoice,
  type RecurringRun,
} from "../db/schema";
import { scoped } from "../db/scoped";
import { ServiceError, type Reader } from "./access";
import { getAutomation } from "./automation";
import { renderDocumentTexts } from "./invoice-document";
import {
  assertKnownVariables,
  draftInputFromDocument,
  getTemplate,
  templateDocumentSchema,
} from "./invoice-templates";
import { assertReferencesOwned, ownerOf, totalsOf } from "./invoices";
import { mutate } from "./mutation";
import { getPreferences } from "./preferences";

const V = TEXTS.recurring.validation;
const MAX_NAME = 100;
const MAX_NOTIFY_DAYS = 30;

export const recurringInputSchema = z.object({
  id: z.string(V.invalid).min(1, V.invalid).optional(),
  name: z.string(V.invalid).trim().min(1, V.name).max(MAX_NAME, V.tooLong),
  customerId: z.string(V.invalid).min(1, V.invalid).nullable(),
  document: templateDocumentSchema,
  frequency: z.enum(RECURRENCE_FREQUENCIES, V.invalid),
  every: z.number(V.invalid),
  issueRule: z.enum(ISSUE_RULES, V.invalid),
  issueDay: z.number(V.invalid).nullable(),
  startsOn: z.string(V.invalid),
  endsOn: z.string(V.invalid).nullable(),
  maxCount: z.number(V.invalid).nullable(),
  periodOffset: z.number(V.invalid),
  mode: z.enum(RECURRING_MODES, V.invalid).default("draft"),
  notifyDaysBefore: z
    .number(V.notifyDays)
    .int(V.notifyDays)
    .min(1, V.notifyDays)
    .max(MAX_NOTIFY_DAYS, V.notifyDays)
    .nullable()
    .default(null),
  confirmSend: z.boolean(V.invalid).optional(),
});

export type RecurringInput = z.input<typeof recurringInputSchema>;
type ParsedInput = z.output<typeof recurringInputSchema>;

type RuleFields = RecurrenceRule & { createdAt: Date };

function plainRule(row: RecurrenceRule): RecurrenceRule {
  const { frequency, every, issueRule, issueDay, startsOn, endsOn, maxCount, periodOffset } = row;
  return { frequency, every, issueRule, issueDay, startsOn, endsOn, maxCount, periodOffset };
}

// The computation counts from startsOn, but a plan only owes occurrences from its creation on (R-18).
export function ruleOf(row: RuleFields): RecurrenceRule {
  const rule = plainRule(row);
  if (rule.maxCount === null) return rule;
  const created = calendarDateInPrague(row.createdAt);
  const unlimited = { ...rule, maxCount: null };
  const before = occurrencesBetween(unlimited, null, addDays(created, -1)).length;
  return { ...rule, maxCount: Math.min(rule.maxCount + before, Number.MAX_SAFE_INTEGER) };
}

function firstCursor(startsOn: CalendarDate, today: CalendarDate): CalendarDate {
  return addDays(startsOn > today ? startsOn : today, -1);
}

export function readPlan(q: Reader, ownerId: string, id: string): RecurringInvoice | null {
  return (
    q
      .select()
      .from(recurringInvoice)
      .where(scoped(ownerId).where(recurringInvoice, (t, { eq }) => eq(t.id, id)))
      .get() ?? null
  );
}

export function findPlan(q: Reader, ownerId: string, id: string): RecurringInvoice {
  const row = readPlan(q, ownerId, id);
  if (!row) throw new ServiceError(V.notFound);
  return row;
}

function parseInput(raw: RecurringInput): ParsedInput {
  const parsed = recurringInputSchema.safeParse(raw);
  if (!parsed.success) throw new ServiceError(parsed.error.issues[0]?.message ?? V.invalid);
  const invalid = validateRule(plainRule(parsed.data));
  if (invalid.length > 0) {
    const fields = [...new Set(invalid.map((field) => TEXTS.recurring.ruleFields[field] ?? field))];
    throw new ServiceError(V.rule(fields));
  }
  assertKnownVariables(parsed.data.document);
  totalsOf(parsed.data.document.lines, parsed.data.document);
  return parsed.data;
}

function assertNoOverlap(
  q: Reader,
  ownerId: string,
  planId: string,
  rule: RecurrenceRule,
  cursor: CalendarDate,
): void {
  const runs = q
    .select()
    .from(recurringRun)
    .where(scoped(ownerId).where(recurringRun, (t, { eq }) => eq(t.recurringId, planId)))
    .all();
  const lastBilled = runs.reduce((last, run) => (run.periodTo > last ? run.periodTo : last), "");
  for (let after = cursor; ;) {
    const next = nextOccurrences(rule, after, 1)[0];
    if (!next || next.billedPeriod.from > lastBilled) return;
    const { from, to } = next.billedPeriod;
    // The same key meets the unique index, so that occurrence cannot produce a second invoice.
    const clash = runs.some(
      (run) => run.periodKey !== next.periodKey && run.periodFrom <= to && run.periodTo >= from,
    );
    if (clash) throw new ServiceError(V.periodOverlap);
    after = next.issueDate;
  }
}

function persist(actor: Actor, action: AuditAction, raw: RecurringInput): { id: string } {
  const userId = ownerOf(actor);
  const input = parseInput(raw);
  const { id: existingId, confirmSend, name, customerId, document, mode } = input;
  const fields = {
    name,
    customerId,
    document: document as TemplateDocument,
    mode,
    notifyDaysBefore: input.notifyDaysBefore,
    ...plainRule(input),
  };

  return mutate(actor, action, (tx, audit) => {
    const before = existingId ? findPlan(tx, userId, existingId) : null;
    assertReferencesOwned(tx, userId, {
      customerId,
      bankAccountId: document.bankAccountId,
      seriesId: null,
      lines: document.lines,
    });
    const now = clock.now();
    const confirmedBefore = before?.mode === "send" ? before.sendConfirmedAt : null;
    if (mode === "send" && !confirmedBefore) {
      if (!getAutomation(userId).recurringSend) throw new ServiceError(V.sendDisabled);
      if (!confirmSend) throw new ServiceError(V.sendNotConfirmed);
    }
    const sendConfirmedAt = mode === "send" ? (confirmedBefore ?? now) : null;

    const id = before?.id ?? randomUUID();
    if (before) {
      const rule = ruleOf({ ...fields, createdAt: before.createdAt });
      assertNoOverlap(tx, userId, id, rule, before.cursorDate);
      tx.update(recurringInvoice)
        .set({ ...fields, sendConfirmedAt, updatedAt: now })
        .where(and(eq(recurringInvoice.id, id), eq(recurringInvoice.userId, userId)))
        .run();
    } else {
      tx.insert(recurringInvoice)
        .values({
          ...fields,
          id,
          userId,
          sendConfirmedAt,
          cursorDate: firstCursor(input.startsOn, calendarDateInPrague(now)),
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }
    audit({
      entity: "recurring_invoice",
      entityId: id,
      ownerId: userId,
      scope: "user",
      before,
      after: { ...fields, sendConfirmedAt },
    });
    return { id };
  });
}

export function saveRecurring(actor: Actor, raw: RecurringInput): { id: string } {
  return persist(actor, "recurring.save", raw);
}

export function recurringFromTemplate(actor: Actor, templateId: string): { id: string } {
  const userId = ownerOf(actor);
  const template = getTemplate(userId, templateId);
  if (!template) throw new ServiceError(TEXTS.invoices.templates.validation.notFound);
  const { document } = template;
  // The template's references are not foreign keys, so they may point at something already gone.
  const usable = draftInputFromDocument(userId, document, template.customerId, {});
  const today = calendarDateInPrague(clock.now());
  return persist(actor, "recurring.from_template", {
    name: template.name,
    customerId: usable.customerId,
    document: { ...document, bankAccountId: usable.bankAccountId, lines: usable.lines },
    frequency: "monthly",
    every: 1,
    issueRule: "day",
    issueDay: Number(today.slice(8)),
    startsOn: today,
    endsOn: null,
    maxCount: null,
    periodOffset: 0,
  });
}

export function deleteRecurring(actor: Actor, id: string): void {
  const userId = ownerOf(actor);
  mutate(actor, "recurring.delete", (tx, audit) => {
    const row = findPlan(tx, userId, id);
    tx.delete(recurringInvoice)
      .where(and(eq(recurringInvoice.id, id), eq(recurringInvoice.userId, userId)))
      .run();
    audit({
      entity: "recurring_invoice",
      entityId: id,
      ownerId: userId,
      scope: "user",
      before: row,
    });
  });
}

export function getRecurring(ownerId: string, id: string): RecurringInvoice | null {
  return readPlan(db, ownerId, id);
}

export type RecurringRow = RecurringInvoice & {
  customerName: string | null;
  nextIssueDate: CalendarDate | null;
};

export function listRecurring(ownerId: string): RecurringRow[] {
  return db
    .select({ plan: recurringInvoice, customerName: customer.name })
    .from(recurringInvoice)
    .leftJoin(customer, eq(customer.id, recurringInvoice.customerId))
    .where(scoped(ownerId).where(recurringInvoice))
    .orderBy(asc(czech(recurringInvoice.name)), asc(recurringInvoice.id))
    .all()
    .map(({ plan, customerName }) => ({
      ...plan,
      customerName,
      nextIssueDate:
        plan.status === "finished"
          ? null
          : (nextOccurrences(ruleOf(plan), plan.cursorDate, 1)[0]?.issueDate ?? null),
    }));
}

export type RunRow = RecurringRun & { invoiceNumber: string | null };

export function listRuns(ownerId: string, id: string): RunRow[] {
  return db
    .select({ run: recurringRun, invoiceNumber: invoice.number })
    .from(recurringRun)
    .leftJoin(invoice, eq(invoice.id, recurringRun.invoiceId))
    .where(scoped(ownerId).where(recurringRun, (t, { eq }) => eq(t.recurringId, id)))
    .orderBy(desc(recurringRun.plannedDate))
    .all()
    .map(({ run, invoiceNumber }) => ({ ...run, invoiceNumber }));
}

export function previewRecurring(ownerId: string, raw: RecurringInput, count = 12) {
  const input = parseInput(raw);
  const existing = input.id ? findPlan(db, ownerId, input.id) : null;
  const now = clock.now();
  const rule = ruleOf({ ...plainRule(input), createdAt: existing?.createdAt ?? now });
  const cursor = existing?.cursorDate ?? firstCursor(input.startsOn, calendarDateInPrague(now));
  const customerName = input.customerId
    ? (db
        .select({ name: customer.name })
        .from(customer)
        .where(scoped(ownerId).where(customer, (t, { eq }) => eq(t.id, input.customerId!)))
        .get()?.name ?? "")
    : "";
  const { dateFormat } = getPreferences(ownerId);
  const { document } = input;
  return nextOccurrences(rule, cursor, count).map(({ issueDate, billedPeriod }) => ({
    issueDate,
    billedPeriod,
    texts: renderDocumentTexts(document, document.lines, {
      period: billedPeriod,
      language: document.language,
      dateFormat,
      number: "",
      customer: customerName,
    }),
  }));
}
