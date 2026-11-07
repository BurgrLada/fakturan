import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import {
  calendarDateInPrague,
  DOCUMENT_TYPES,
  formatNumber,
  isCalendarDate,
  periodKey,
  RESET_PERIODS,
  validateSeriesPeriod,
  validateTemplate,
  type CalendarDate,
  type DocumentType,
  type ResetPeriod,
} from "@/lib/number-format";
import { TEXTS } from "@/lib/texts";
import type { Actor } from "../audit/context";
import { clock } from "../clock";
import { db, type Db, type Tx } from "../db";
import { invoice, numberSeries, numberSeriesCounter } from "../db/schema";
import { scoped } from "../db/scoped";
import { assertRowLimit } from "./account-limits";
import { ServiceError, type Reader } from "./access";
import { mutate } from "./mutation";

export type NumberSeries = typeof numberSeries.$inferSelect;
export type SeriesRow = NumberSeries & { next: number; used: boolean };

const ERRORS = TEXTS.numberSeries.errors;
const MAX_NEXT = 999_999_999;

const DEFAULTS: Record<DocumentType, { name: string; template: string }> = {
  invoice: { name: TEXTS.numberSeries.documentTypes.invoice, template: "{RRRR}-{NNN}" },
  advance: { name: TEXTS.numberSeries.documentTypes.advance, template: "Z{RRRR}-{NNN}" },
  credit_note: { name: TEXTS.numberSeries.documentTypes.credit_note, template: "D{RRRR}-{NNN}" },
};

export const seriesInputSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().trim().min(1, ERRORS.name).max(100, ERRORS.nameTooLong),
    documentType: z.enum(DOCUMENT_TYPES),
    template: z.string().trim().min(1, ERRORS.oneSequence).max(50, ERRORS.templateTooLong),
    reset: z.enum(RESET_PERIODS),
  })
  .superRefine((value, ctx) => {
    const message =
      validateTemplate(value.template) ?? validateSeriesPeriod(value.template, value.reset);
    if (message) ctx.addIssue({ code: "custom", path: ["template"], message });
  });

export type SeriesInput = z.input<typeof seriesInputSchema>;

export const nextNumberInputSchema = z.object({
  id: z.string().min(1),
  next: z.number().int(ERRORS.nextRange).min(1, ERRORS.nextRange).max(MAX_NEXT, ERRORS.nextRange),
  date: z.string().refine(isCalendarDate, ERRORS.invalidDate).optional(),
});

function ownerOf(actor: Actor): string {
  if (!actor.userId) throw new ServiceError(ERRORS.forbidden);
  return actor.userId;
}

function findOwned(tx: Tx, userId: string, id: string): NumberSeries {
  const row = tx
    .select()
    .from(numberSeries)
    .where(scoped(userId).where(numberSeries, (t, { eq }) => eq(t.id, id)))
    .get();
  if (!row) throw new ServiceError(ERRORS.notFound);
  return row;
}

function countersOf(tx: Tx, userId: string, seriesId: string) {
  return tx
    .select()
    .from(numberSeriesCounter)
    .where(scoped(userId).where(numberSeriesCounter, (t, { eq }) => eq(t.seriesId, seriesId)))
    .all();
}

function isUsed(tx: Tx, userId: string, seriesId: string): boolean {
  return countersOf(tx, userId, seriesId).some((counter) => counter.highest > 0);
}

// A manually renumbered invoice (INV-022) can hold a number the counter has not reached yet.
export function isNumberTaken(
  tx: Tx,
  ownerId: string,
  number: string,
  exceptInvoiceId?: string,
): boolean {
  return !!tx
    .select({ id: invoice.id })
    .from(invoice)
    .where(
      scoped(ownerId).where(invoice, (t, { eq, and }) =>
        and(eq(t.number, number), exceptInvoiceId ? ne(t.id, exceptInvoiceId) : undefined),
      ),
    )
    .get();
}

// Period keys change format with the reset, so a next number set for the running period would
// otherwise be orphaned. Other periods are dropped: the series is unused, so no number is lost.
function rekeyUnusedCounters(
  tx: Tx,
  userId: string,
  series: NumberSeries,
  reset: ResetPeriod,
): number | null {
  const today = calendarDateInPrague(clock.now());
  const key = periodKey(series.reset, today);
  const current = countersOf(tx, userId, series.id).find((row) => row.periodKey === key);
  tx.delete(numberSeriesCounter)
    .where(scoped(userId).where(numberSeriesCounter, (t, { eq }) => eq(t.seriesId, series.id)))
    .run();
  if (!current) return null;
  tx.insert(numberSeriesCounter)
    .values({
      seriesId: series.id,
      periodKey: periodKey(reset, today),
      userId,
      next: current.next,
    })
    .run();
  return current.next;
}

function sequenceWidthFree(template: string): string {
  return template.replace(/\{N+\}/, "{N}");
}

function missingDefaults(tx: Tx | Db, userId: string): DocumentType[] {
  const present = new Set(
    tx
      .select({ type: numberSeries.documentType })
      .from(numberSeries)
      .where(scoped(userId).where(numberSeries, (t, { eq }) => eq(t.isDefault, true)))
      .all()
      .map((row) => row.type),
  );
  return DOCUMENT_TYPES.filter((type) => !present.has(type));
}

function insertDefaults(tx: Tx, userId: string, types: DocumentType[]): void {
  const now = clock.now();
  for (const documentType of types) {
    tx.insert(numberSeries)
      .values({
        id: randomUUID(),
        userId,
        documentType,
        ...DEFAULTS[documentType],
        reset: "yearly",
        isDefault: true,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }
}

export function hasMissingDefaults(ownerId: string): boolean {
  return missingDefaults(db, ownerId).length > 0;
}

// Reads first so an ordinary page view does not take the write lock.
export function ensureDefaultSeries(actor: Actor): void {
  const userId = ownerOf(actor);
  if (missingDefaults(db, userId).length === 0) return;
  mutate(actor, "number_series.ensure_defaults", (tx, audit) => {
    // Re-read inside the lock: a concurrent request may have created them meanwhile.
    const created = missingDefaults(tx, userId);
    insertDefaults(tx, userId, created);
    audit({
      entity: "number_series",
      entityId: null,
      ownerId: userId,
      scope: "user",
      after: { created },
    });
  });
}

export function listSeries(ownerId: string, date?: CalendarDate): SeriesRow[] {
  const day = date ?? calendarDateInPrague(clock.now());
  const counters = db
    .select()
    .from(numberSeriesCounter)
    .where(scoped(ownerId).where(numberSeriesCounter))
    .all();
  return db
    .select()
    .from(numberSeries)
    .where(scoped(ownerId).where(numberSeries))
    .orderBy(asc(numberSeries.documentType), asc(numberSeries.createdAt), asc(numberSeries.id))
    .all()
    .map((row) => {
      const own = counters.filter((counter) => counter.seriesId === row.id);
      const key = periodKey(row.reset, day);
      return {
        ...row,
        next: own.find((counter) => counter.periodKey === key)?.next ?? 1,
        used: own.some((counter) => counter.highest > 0),
      };
    });
}

export function defaultSeriesFor(ownerId: string, type: DocumentType): NumberSeries | null {
  return (
    db
      .select()
      .from(numberSeries)
      .where(
        scoped(ownerId).where(numberSeries, (t, { and, eq }) =>
          and(eq(t.documentType, type), eq(t.isDefault, true)),
        ),
      )
      .get() ?? null
  );
}

export function saveSeries(actor: Actor, raw: SeriesInput): string {
  const userId = ownerOf(actor);
  const parsed = seriesInputSchema.safeParse(raw);
  // Stryker disable next-line OptionalChaining: equivalent, a failed parse has at least one issue
  if (!parsed.success) throw new ServiceError(parsed.error.issues[0]?.message ?? ERRORS.invalid);
  const { id: existingId, ...columns } = parsed.data;

  return mutate(actor, "number_series.save", (tx, audit) => {
    const created = missingDefaults(tx, userId);
    if (created.length > 0) {
      insertDefaults(tx, userId, created);
      audit({
        action: "number_series.ensure_defaults",
        entity: "number_series",
        entityId: null,
        ownerId: userId,
        scope: "user",
        after: { created },
      });
    }
    const before = existingId ? findOwned(tx, userId, existingId) : null;
    if (before && before.documentType !== columns.documentType) {
      throw new ServiceError(ERRORS.typeLocked);
    }
    const resetChanges = !!before && before.reset !== columns.reset;
    if (before && isUsed(tx, userId, before.id)) {
      if (resetChanges) throw new ServiceError(ERRORS.resetLocked);
      // Freeing a used template would let a new series, starting at 1, repeat its numbers.
      if (before.template !== columns.template) throw new ServiceError(ERRORS.templateLocked);
    }
    // Same template means same numbers, whichever document type or width the other series has.
    const clash = tx
      .select({ id: numberSeries.id, template: numberSeries.template })
      .from(numberSeries)
      .where(scoped(userId).where(numberSeries))
      .all()
      .some(
        (other) =>
          other.id !== before?.id &&
          sequenceWidthFree(other.template) === sequenceWidthFree(columns.template),
      );
    if (clash) throw new ServiceError(ERRORS.templateTaken);

    const id = before?.id ?? randomUUID();
    const now = clock.now();
    const carriedNext = resetChanges
      ? rekeyUnusedCounters(tx, userId, before, columns.reset)
      : null;
    if (before) {
      tx.update(numberSeries)
        .set({ ...columns, updatedAt: now })
        .where(and(eq(numberSeries.id, id), eq(numberSeries.userId, userId)))
        .run();
    } else {
      assertRowLimit(tx, "number_series", numberSeries, userId);
      tx.insert(numberSeries)
        .values({ id, userId, ...columns, createdAt: now, updatedAt: now })
        .run();
    }
    audit({
      entity: "number_series",
      entityId: id,
      ownerId: userId,
      scope: "user",
      before,
      after: carriedNext === null ? columns : { ...columns, carriedNext },
    });
    return id;
  });
}

export function setDefaultSeries(actor: Actor, id: string): void {
  const userId = ownerOf(actor);
  mutate(actor, "number_series.set_default", (tx, audit) => {
    const series = findOwned(tx, userId, id);
    tx.update(numberSeries)
      .set({ isDefault: false, updatedAt: clock.now() })
      .where(
        scoped(userId).where(numberSeries, (t, { and, eq }) =>
          and(eq(t.documentType, series.documentType), eq(t.isDefault, true)),
        ),
      )
      .run();
    tx.update(numberSeries)
      .set({ isDefault: true, updatedAt: clock.now() })
      .where(and(eq(numberSeries.id, id), eq(numberSeries.userId, userId)))
      .run();
    audit({
      entity: "number_series",
      entityId: id,
      ownerId: userId,
      scope: "user",
      before: { isDefault: series.isDefault },
      after: { isDefault: true, documentType: series.documentType },
    });
  });
}

export function setNextNumber(actor: Actor, id: string, next: number, date?: CalendarDate): void {
  const userId = ownerOf(actor);
  const parsed = nextNumberInputSchema.safeParse({ id, next, date });
  // Stryker disable next-line OptionalChaining: equivalent, a failed parse has at least one issue
  if (!parsed.success) throw new ServiceError(parsed.error.issues[0]?.message ?? ERRORS.invalid);
  const day = date ?? calendarDateInPrague(clock.now());

  mutate(actor, "number_series.set_next", (tx, audit) => {
    const series = findOwned(tx, userId, id);
    const key = periodKey(series.reset, day);
    const counter = countersOf(tx, userId, id).find((row) => row.periodKey === key);
    if (
      next <= (counter?.highest ?? 0) ||
      isNumberTaken(tx, userId, formatNumber(series.template, day, next))
    ) {
      throw new ServiceError(ERRORS.nextUsed);
    }
    tx.insert(numberSeriesCounter)
      .values({ seriesId: id, periodKey: key, userId, next })
      .onConflictDoUpdate({
        target: [numberSeriesCounter.seriesId, numberSeriesCounter.periodKey],
        set: { next },
      })
      .run();
    audit({
      entity: "number_series",
      entityId: id,
      ownerId: userId,
      scope: "user",
      before: { next: counter?.next ?? 1 },
      after: { next, periodKey: key },
    });
  });
}

export function deleteSeries(actor: Actor, id: string): void {
  const userId = ownerOf(actor);
  mutate(actor, "number_series.delete", (tx, audit) => {
    const series = findOwned(tx, userId, id);
    if (series.isDefault) throw new ServiceError(ERRORS.defaultLocked);
    if (isUsed(tx, userId, id)) throw new ServiceError(ERRORS.usedLocked);
    tx.delete(numberSeriesCounter)
      .where(scoped(userId).where(numberSeriesCounter, (t, { eq }) => eq(t.seriesId, id)))
      .run();
    tx.delete(numberSeries)
      .where(and(eq(numberSeries.id, id), eq(numberSeries.userId, userId)))
      .run();
    audit({
      entity: "number_series",
      entityId: id,
      ownerId: userId,
      scope: "user",
      before: series,
    });
  });
}

// A preview for checks outside the issuing transaction; allocateNumber may still skip past it.
export function peekNumber(
  q: Reader,
  ownerId: string,
  series: NumberSeries,
  date: CalendarDate,
): string {
  const key = periodKey(series.reset, date);
  const counter = q
    .select({ next: numberSeriesCounter.next })
    .from(numberSeriesCounter)
    .where(
      scoped(ownerId).where(numberSeriesCounter, (t, { and, eq }) =>
        and(eq(t.seriesId, series.id), eq(t.periodKey, key)),
      ),
    )
    .get();
  return formatNumber(series.template, date, counter?.next ?? 1);
}

// Must run inside the caller's mutate. The upsert is a single statement, and a rollback of the
// issuing transaction returns the number, so the sequence stays gapless apart from numbers skipped
// because a manual renumbering (INV-022) already holds them.
export function allocateNumber(
  tx: Tx,
  ownerId: string,
  seriesId: string,
  date: CalendarDate,
): { number: string; n: number; skipped: string[] } {
  const series = findOwned(tx, ownerId, seriesId);
  const skipped: string[] = [];
  for (;;) {
    const { n } = tx
      .insert(numberSeriesCounter)
      .values({
        seriesId,
        periodKey: periodKey(series.reset, date),
        userId: ownerId,
        next: 2,
        highest: 1,
      })
      .onConflictDoUpdate({
        target: [numberSeriesCounter.seriesId, numberSeriesCounter.periodKey],
        set: {
          next: sql`${numberSeriesCounter.next} + 1`,
          highest: numberSeriesCounter.next,
        },
      })
      .returning({ n: numberSeriesCounter.highest })
      .get();
    const number = formatNumber(series.template, date, n);
    if (!isNumberTaken(tx, ownerId, number)) return { number, n, skipped };
    skipped.push(number);
  }
}
