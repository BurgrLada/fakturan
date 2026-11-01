import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { addDays, daysBetween, isConvertibleAdvance, isFinalInvoice } from "@/lib/invoice";
import { lineBody } from "@/lib/invoice-diff";
import { calendarDateInPrague } from "@/lib/number-format";
import { TEXTS } from "@/lib/texts";
import type { Actor } from "../audit/context";
import { clock } from "../clock";
import type { Tx } from "../db";
import { invoice } from "../db/schema";
import { ServiceError } from "./access";
import { finalOf, refreshBalance } from "./invoice-balance";
import {
  accountForCopy,
  auditSnapshot,
  findOwned,
  insertLines,
  linesOf,
  ownerOf,
  searchTextOf,
  sumsOf,
  totalsOf,
  Unchanged,
  unlessUnchanged,
  type Invoice,
} from "./invoices";
import { mutate, type Audit } from "./mutation";
import { resolveEntityNotifications } from "./notifications";
import { defaultSeriesFor } from "./number-series";
import { linkTags, tagsOf } from "./tags";

const V = TEXTS.invoices.validation;

// The rate stays empty: a final invoice is a document of its own and resolves one when issued.
export function createFinalIn(
  tx: Tx,
  audit: Audit,
  userId: string,
  advance: Invoice,
  note: Record<string, unknown> = {},
): { id: string } {
  const existing = finalOf(tx, userId, advance.id);
  if (existing) return { id: existing.id };
  resolveEntityNotifications(tx, userId, "advance_final_cancelled", advance.id);

  const lines = linesOf(tx, userId, advance.id);
  const id = randomUUID();
  const now = clock.now();
  const today = calendarDateInPrague(now);
  const dueDate =
    advance.issueDate && advance.dueDate
      ? addDays(today, Math.max(0, daysBetween(advance.issueDate, advance.dueDate)))
      : null;
  tx.insert(invoice)
    .values({
      id,
      userId,
      type: "invoice",
      relatedInvoiceId: advance.id,
      seriesId: defaultSeriesFor(userId, "invoice")?.id ?? null,
      customerId: advance.customerId,
      customerName: advance.customerName,
      bankAccountId: accountForCopy(tx, userId, advance),
      issueDate: today,
      dueDate,
      language: advance.language,
      currency: advance.currency,
      foreign: advance.foreign,
      clause: advance.clause,
      paymentMethod: advance.paymentMethod,
      orderRef: advance.orderRef,
      reference: advance.reference,
      textBefore: advance.textBefore,
      textAfter: advance.textAfter,
      note: advance.note,
      discountKind: advance.discountKind,
      discountValue: advance.discountValue,
      rounding: advance.rounding,
      ...sumsOf(totalsOf(lines, advance)),
      appearance: advance.appearance,
      searchText: searchTextOf({ customerName: advance.customerName, lines }),
      revision: 1,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  insertLines(
    tx,
    userId,
    id,
    lines.map(({ id: _i, invoiceId: _v, userId: _u, ...line }) => line),
  );
  linkTags(
    tx,
    userId,
    id,
    tagsOf(tx, userId, advance.id).map((tag) => tag.id),
  );
  audit({
    action: "invoice.final_from_advance",
    entity: "invoice",
    entityId: id,
    ownerId: userId,
    scope: "user",
    after: {
      ...note,
      advanceId: advance.id,
      ...auditSnapshot(findOwned(tx, userId, id), lines.length),
      lines: lines.map(lineBody),
    },
  });
  refreshBalance(tx, audit, userId, id);
  return { id };
}

export function convertAdvance(actor: Actor, advanceId: string): { id: string } {
  const userId = ownerOf(actor);
  return unlessUnchanged(() =>
    mutate(actor, "invoice.final_from_advance", (tx, audit) => {
      const advance = findOwned(tx, userId, advanceId);
      if (!isConvertibleAdvance(advance)) throw new ServiceError(V.notConvertible);
      const existing = finalOf(tx, userId, advanceId);
      if (existing) throw new Unchanged({ id: existing.id });
      return createFinalIn(tx, audit, userId, advance);
    }),
  );
}

// Only an issued final invoice replaces the advance (R-27). The revision moves like with a payment,
// which stops a queued message about the advance.
export function syncSuperseded(tx: Tx, audit: Audit, userId: string, finalId: string): void {
  const final = findOwned(tx, userId, finalId);
  if (!isFinalInvoice(final)) return;
  const advance = findOwned(tx, userId, final.relatedInvoiceId!);
  const active = finalOf(tx, userId, advance.id);
  const replaced = active !== null && active.status !== "draft";
  if (replaced === (advance.supersededAt !== null)) return;

  const now = clock.now();
  const supersededAt = replaced ? now : null;
  tx.update(invoice)
    .set({ supersededAt, revision: advance.revision + 1, updatedAt: now })
    .where(and(eq(invoice.id, advance.id), eq(invoice.userId, userId)))
    .run();
  audit({
    action: "invoice.superseded",
    entity: "invoice",
    entityId: advance.id,
    ownerId: userId,
    scope: "user",
    before: { supersededAt: advance.supersededAt },
    after: { supersededAt, finalId },
  });
}
