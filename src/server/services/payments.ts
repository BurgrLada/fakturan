import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { daysBetween, MAX_BULK_DOCUMENTS } from "@/lib/invoice";
import { calendarDateInPrague, isCalendarDate, type CalendarDate } from "@/lib/number-format";
import {
  canTakePayment,
  deriveStatus,
  paymentInputSchema,
  type PaymentChannel,
  type PaymentInput,
  type PaymentKind,
} from "@/lib/payments";
import type { PaymentMethod } from "@/lib/preferences";
import { amountDue } from "@/lib/qr-payload";
import { TEXTS } from "@/lib/texts";
import type { Actor } from "../audit/context";
import type { AuditAction } from "../audit/record";
import { clock } from "../clock";
import { db, type Tx } from "../db";
import { bankNotification, invoice, payment } from "../db/schema";
import { scoped } from "../db/scoped";
import { ServiceError, type Reader } from "./access";
import { findOwned, ownerOf, type Invoice } from "./invoices";
import { holdQueuedMail } from "./mail-hold";
import { mutate, type Audit } from "./mutation";

const E = TEXTS.payments.errors;

export type Payment = typeof payment.$inferSelect;
export type NewPayment = Pick<
  Payment,
  "paidOn" | "amountMinor" | "currency" | "creditedMinor" | "method" | "note" | "source"
> & { kind?: PaymentKind; action?: AuditAction; notificationId?: string };

const CHANNEL_OF_METHOD: Record<PaymentMethod, PaymentChannel> = {
  transfer: "transfer",
  cash: "cash",
  card: "other",
};

function today(): CalendarDate {
  return calendarDateInPrague(clock.now());
}

function assertPaidOn(paidOn: CalendarDate): void {
  if (!isCalendarDate(paidOn)) throw new ServiceError(E.date);
  if (paidOn > today()) throw new ServiceError(E.future);
}

function parseInput(raw: PaymentInput) {
  const parsed = paymentInputSchema.safeParse(raw);
  if (!parsed.success) throw new ServiceError(parsed.error.issues[0]?.message ?? E.invalid);
  assertPaidOn(parsed.data.paidOn);
  return parsed.data;
}

function assertPayable(row: Invoice): void {
  if (!canTakePayment(row.status) || row.type === "credit_note") {
    throw new ServiceError(E.notPayable);
  }
}

function assertRevision(row: Invoice, revision: number): void {
  if (row.revision !== revision) throw new ServiceError(TEXTS.invoices.stale);
}

function creditedFor(row: Invoice, input: ReturnType<typeof parseInput>): number {
  if (input.currency === row.currency) return input.amountMinor;
  if (!input.creditedMinor) throw new ServiceError(E.creditedRequired);
  return input.creditedMinor;
}

function readPayment(q: Reader, ownerId: string, id: string): Payment {
  const row = q
    .select()
    .from(payment)
    .where(scoped(ownerId).where(payment, (t, { eq }) => eq(t.id, id)))
    .get();
  if (!row) throw new ServiceError(E.notFound);
  return row;
}

function auditFields(row: Payment) {
  const { invoiceId, kind, source, paidOn, amountMinor, creditedMinor, currency, method } = row;
  return { invoiceId, kind, source, paidOn, amountMinor, creditedMinor, currency, method };
}

export function hasPayments(q: Reader, ownerId: string, invoiceId: string): boolean {
  const found = q
    .select({ id: payment.id })
    .from(payment)
    .where(scoped(ownerId).where(payment, (t, { eq }) => eq(t.invoiceId, invoiceId)))
    .limit(1)
    .get();
  return found !== undefined;
}

// The only writer of paid_minor: always a fresh SUM, so a repeated or partial run cannot drift.
export function applyPayments(tx: Tx, userId: string, invoiceId: string): Invoice {
  const row = findOwned(tx, userId, invoiceId);
  const paidMinor = tx
    .select({ sum: sql<number>`coalesce(sum(${payment.creditedMinor}), 0)` })
    .from(payment)
    .where(scoped(userId).where(payment, (t, { eq }) => eq(t.invoiceId, invoiceId)))
    .get()!.sum;
  tx.update(invoice)
    .set({
      paidMinor,
      status: deriveStatus({ ...row, paidMinor }),
      revision: row.revision + 1,
      updatedAt: clock.now(),
    })
    .where(and(eq(invoice.id, invoiceId), eq(invoice.userId, userId)))
    .run();
  return findOwned(tx, userId, invoiceId);
}

export function insertPayment(
  tx: Tx,
  audit: Audit,
  userId: string,
  invoiceId: string,
  input: NewPayment,
): { id: string } {
  const { action = "payment.create", kind = "payment", ...fields } = input;
  assertPaidOn(fields.paidOn);
  const before = findOwned(tx, userId, invoiceId);
  assertPayable(before);
  if (before.totalMinor <= 0) throw new ServiceError(E.zeroTotal);
  if (fields.amountMinor <= 0 || fields.creditedMinor <= 0) throw new ServiceError(E.amount);

  const id = randomUUID();
  const now = clock.now();
  tx.insert(payment)
    .values({ ...fields, id, userId, invoiceId, kind, createdAt: now, updatedAt: now })
    .run();
  const after = applyPayments(tx, userId, invoiceId);
  audit({
    action,
    entity: "payment",
    entityId: id,
    ownerId: userId,
    scope: "user",
    before: { invoiceId, status: before.status },
    after: { ...auditFields(readPayment(tx, userId, id)), status: after.status },
  });
  return { id };
}

// R-22: the one way back from a matched notice. Every payment of the notice goes, each invoice's
// state is recomputed, and the notice returns to the queue, from where nothing matches it again.
export function undoNoticeIn(tx: Tx, audit: Audit, userId: string, noticeId: string): void {
  const notice = tx
    .select()
    .from(bankNotification)
    .where(scoped(userId).where(bankNotification, (t, { eq }) => eq(t.id, noticeId)))
    .get();
  if (!notice) throw new ServiceError(TEXTS.bankQueue.errors.notFound);
  if (notice.status !== "matched") throw new ServiceError(TEXTS.bankQueue.errors.notMatched);

  const removed = tx
    .select()
    .from(payment)
    .where(scoped(userId).where(payment, (t, { eq }) => eq(t.notificationId, noticeId)))
    .all();
  const touched = [...new Set(removed.map((row) => row.invoiceId))];
  // A closed difference was computed from the money this notice brought: removing the payment
  // would leave a paid document whose difference no longer matches.
  const closed = tx
    .select({ id: payment.id })
    .from(payment)
    .where(
      scoped(userId).where(payment, (t, { and, eq }) =>
        and(eq(t.kind, "difference"), inArray(t.invoiceId, touched)),
      ),
    )
    .limit(1)
    .get();
  if (closed) throw new ServiceError(TEXTS.bankQueue.errors.differenceClosed);

  tx.delete(payment)
    .where(scoped(userId).where(payment, (t, { eq }) => eq(t.notificationId, noticeId)))
    .run();
  for (const invoiceId of new Set(removed.map((row) => row.invoiceId))) {
    const before = findOwned(tx, userId, invoiceId);
    const after = applyPayments(tx, userId, invoiceId);
    for (const row of removed.filter((item) => item.invoiceId === invoiceId)) {
      audit({
        action: "payment.delete",
        entity: "payment",
        entityId: row.id,
        ownerId: userId,
        scope: "user",
        before: { ...auditFields(row), status: before.status },
        after: { invoiceId, status: after.status },
      });
    }
  }
  tx.update(bankNotification)
    .set({ status: "pending", reason: "undone", updatedAt: clock.now() })
    .where(scoped(userId).where(bankNotification, (t, { eq }) => eq(t.id, noticeId)))
    .run();
  audit({
    action: "notice.undone",
    entity: "bank_notification",
    entityId: noticeId,
    ownerId: userId,
    scope: "user",
    after: {
      amountMinor: notice.amountMinor,
      currency: notice.currency,
      reason: "undone",
      invoiceIds: touched,
    },
  });
}

export function listPayments(ownerId: string, invoiceId: string): Payment[] {
  return db
    .select()
    .from(payment)
    .where(scoped(ownerId).where(payment, (t, { eq }) => eq(t.invoiceId, invoiceId)))
    .orderBy(asc(payment.paidOn), asc(payment.createdAt), asc(payment.id))
    .all();
}

export function addPayment(actor: Actor, invoiceId: string, raw: PaymentInput): { id: string } {
  const userId = ownerOf(actor);
  const input = parseInput(raw);
  return mutate(actor, "payment.create", (tx, audit) => {
    const row = findOwned(tx, userId, invoiceId);
    assertRevision(row, input.revision);
    const { paidOn, amountMinor, currency, method, note } = input;
    return insertPayment(tx, audit, userId, invoiceId, {
      paidOn,
      amountMinor,
      currency,
      creditedMinor: creditedFor(row, input),
      method,
      note,
      source: "manual",
    });
  });
}

// R-10 keeps a notice's money as the bank reported it; a difference is only ever removed whole.
function assertAmountsEditable(
  before: Payment,
  next: Pick<Payment, "amountMinor" | "currency" | "creditedMinor">,
): void {
  if (before.kind === "difference") throw new ServiceError(E.differenceLocked);
  if (before.source !== "notice") return;
  const same =
    next.amountMinor === before.amountMinor &&
    next.currency === before.currency &&
    next.creditedMinor === before.creditedMinor;
  if (!same) throw new ServiceError(E.noticeLocked);
}

export function updatePayment(actor: Actor, id: string, raw: PaymentInput): { id: string } {
  const userId = ownerOf(actor);
  const input = parseInput(raw);
  return mutate(actor, "payment.update", (tx, audit) => {
    const before = readPayment(tx, userId, id);
    const row = findOwned(tx, userId, before.invoiceId);
    assertPayable(row);
    assertRevision(row, input.revision);
    const { paidOn, amountMinor, currency, method, note } = input;
    const creditedMinor = creditedFor(row, input);
    assertAmountsEditable(before, { amountMinor, currency, creditedMinor });

    tx.update(payment)
      .set({ paidOn, amountMinor, currency, creditedMinor, method, note, updatedAt: clock.now() })
      .where(scoped(userId).where(payment, (t, { eq }) => eq(t.id, id)))
      .run();
    const told =
      paidOn === before.paidOn &&
      amountMinor === before.amountMinor &&
      creditedMinor === before.creditedMinor &&
      currency === before.currency;
    // {{prijato}} is already rendered into a queued message, which would state the old values.
    if (!told) {
      holdQueuedMail(tx, audit, userId, (t) => eq(t.paymentId, id), {
        reason: TEXTS.invoiceMail.reasons.paymentChanged,
        quiet: true,
      });
    }
    const after = applyPayments(tx, userId, before.invoiceId);
    audit({
      entity: "payment",
      entityId: id,
      ownerId: userId,
      scope: "user",
      before: { ...auditFields(before), status: row.status },
      after: { ...auditFields(readPayment(tx, userId, id)), status: after.status },
    });
    return { id };
  });
}

export function deletePayment(actor: Actor, id: string, revision: number): void {
  const userId = ownerOf(actor);
  mutate(actor, "payment.delete", (tx, audit) => {
    const before = readPayment(tx, userId, id);
    const row = findOwned(tx, userId, before.invoiceId);
    assertPayable(row);
    assertRevision(row, revision);
    if (before.notificationId) return undoNoticeIn(tx, audit, userId, before.notificationId);
    if (before.source === "notice") throw new ServiceError(E.noticeDelete);

    tx.delete(payment)
      .where(scoped(userId).where(payment, (t, { eq }) => eq(t.id, id)))
      .run();
    const after = applyPayments(tx, userId, before.invoiceId);
    audit({
      entity: "payment",
      entityId: id,
      ownerId: userId,
      scope: "user",
      before: { ...auditFields(before), status: row.status },
      after: { invoiceId: before.invoiceId, status: after.status },
    });
  });
}

function settle(tx: Tx, audit: Audit, userId: string, row: Invoice, paidOn: CalendarDate) {
  assertPayable(row);
  const due = amountDue(row);
  if (due <= 0) throw new ServiceError(E.nothingDue);
  return insertPayment(tx, audit, userId, row.id, {
    action: "payment.mark_paid",
    paidOn,
    amountMinor: due,
    currency: row.currency,
    creditedMinor: due,
    method: CHANNEL_OF_METHOD[row.paymentMethod],
    note: "",
    source: "manual",
  });
}

export function markPaid(
  actor: Actor,
  invoiceId: string,
  opts: { revision: number; paidOn?: CalendarDate },
): { id: string } {
  const userId = ownerOf(actor);
  const paidOn = opts.paidOn ?? today();
  assertPaidOn(paidOn);
  return mutate(actor, "payment.mark_paid", (tx, audit) => {
    const row = findOwned(tx, userId, invoiceId);
    assertRevision(row, opts.revision);
    return settle(tx, audit, userId, row, paidOn);
  });
}

// A batch stops for nobody: one document already changed elsewhere must not block the others.
export function markPaidMany(actor: Actor, ids: string[]): { done: number; skipped: number } {
  const userId = ownerOf(actor);
  const unique = [...new Set(ids)];
  if (unique.length > MAX_BULK_DOCUMENTS) {
    throw new ServiceError(TEXTS.invoices.list.bulk.tooMany(MAX_BULK_DOCUMENTS));
  }
  const paidOn = today();
  let done = 0;
  for (const id of unique) {
    try {
      mutate(actor, "payment.mark_paid", (tx, audit) =>
        settle(tx, audit, userId, findOwned(tx, userId, id), paidOn),
      );
      done += 1;
    } catch (error) {
      if (!(error instanceof ServiceError)) throw error;
    }
  }
  return { done, skipped: unique.length - done };
}

export function closeDifference(
  actor: Actor,
  invoiceId: string,
  opts: { revision: number; confirmed: boolean },
): { id: string; differenceMinor: number } {
  const userId = ownerOf(actor);
  return mutate(actor, "payment.close_difference", (tx, audit) => {
    const row = findOwned(tx, userId, invoiceId);
    assertRevision(row, opts.revision);
    if (row.status !== "partially_paid") throw new ServiceError(E.notClosable);
    if (!opts.confirmed) throw new ServiceError(E.confirmDifference);
    const differenceMinor = amountDue(row);
    const { id } = insertPayment(tx, audit, userId, invoiceId, {
      action: "payment.close_difference",
      kind: "difference",
      paidOn: today(),
      amountMinor: differenceMinor,
      currency: row.currency,
      creditedMinor: differenceMinor,
      method: "other",
      note: "",
      source: "manual",
    });
    return { id, differenceMinor };
  });
}

// A closed difference says nothing about how fast the client paid, so its document stays out.
export function averagePaymentDays(ownerId: string, customerId: string): number | null {
  const rows = db
    .select({
      issueDate: invoice.issueDate,
      lastPaidOn: sql<
        string | null
      >`max(CASE WHEN ${payment.kind} = 'payment' THEN ${payment.paidOn} END)`,
      differences: sql<number>`sum(CASE WHEN ${payment.kind} = 'difference' THEN 1 ELSE 0 END)`,
    })
    .from(payment)
    .innerJoin(invoice, eq(invoice.id, payment.invoiceId))
    .where(
      scoped(ownerId).where(invoice, (t, { eq, and }) =>
        and(eq(t.customerId, customerId), eq(t.status, "paid")),
      ),
    )
    .groupBy(invoice.id)
    .all();
  const days = rows.flatMap(({ issueDate, lastPaidOn, differences }) =>
    issueDate && lastPaidOn && differences === 0 ? [daysBetween(issueDate, lastPaidOn)] : [],
  );
  if (days.length === 0) return null;
  return days.reduce((sum, value) => sum + value, 0) / days.length;
}
