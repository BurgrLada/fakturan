import "server-only";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { ACTIVE_CREDIT_STATUSES } from "@/lib/invoice";
import { deriveStatus } from "@/lib/payments";
import { clock } from "../clock";
import type { Tx } from "../db";
import { invoice, payment } from "../db/schema";
import { scoped } from "../db/scoped";
import type { Reader } from "./access";
import { findOwned, type Invoice } from "./invoices";
import type { Audit } from "./mutation";

export function hasPayments(q: Reader, ownerId: string, invoiceId: string): boolean {
  const found = q
    .select({ id: payment.id })
    .from(payment)
    .where(scoped(ownerId).where(payment, (t, { eq }) => eq(t.invoiceId, invoiceId)))
    .limit(1)
    .get();
  return found !== undefined;
}

export function finalOf(q: Reader, ownerId: string, advanceId: string): Invoice | null {
  return (
    q
      .select()
      .from(invoice)
      .where(
        scoped(ownerId).where(invoice, (t) =>
          and(eq(t.relatedInvoiceId, advanceId), eq(t.type, "invoice"), ne(t.status, "cancelled")),
        ),
      )
      .get() ?? null
  );
}

function creditsOf(q: Reader, ownerId: string, invoiceId: string): number {
  return q
    .select({ sum: sql<number>`coalesce(sum(${invoice.totalMinor}), 0)` })
    .from(invoice)
    .where(
      scoped(ownerId).where(invoice, (t) =>
        and(
          eq(t.type, "credit_note"),
          eq(t.relatedInvoiceId, invoiceId),
          inArray(t.status, ACTIVE_CREDIT_STATUSES),
        ),
      ),
    )
    .get()!.sum;
}

function advancePaidOf(q: Reader, ownerId: string, row: Invoice): number {
  const { relatedInvoiceId } = row;
  if (!relatedInvoiceId) return 0;
  const advance = q
    .select({ paidMinor: invoice.paidMinor })
    .from(invoice)
    .where(
      scoped(ownerId).where(invoice, (t) => and(eq(t.id, relatedInvoiceId), eq(t.type, "advance"))),
    )
    .get();
  return advance?.paidMinor ?? 0;
}

// The only writer of credits_minor and advance_minor: always a fresh sum, so a repeated run cannot
// drift. The revision moves like with a payment, which stops a queued message with the old amount.
export function refreshBalance(tx: Tx, audit: Audit, userId: string, invoiceId: string): Invoice {
  const before = findOwned(tx, userId, invoiceId);
  const creditsMinor = creditsOf(tx, userId, invoiceId);
  const advanceMinor = advancePaidOf(tx, userId, before);
  const status = deriveStatus({ ...before, creditsMinor, advanceMinor });
  tx.update(invoice)
    .set({
      creditsMinor,
      advanceMinor,
      status,
      revision: before.revision + 1,
      updatedAt: clock.now(),
    })
    .where(and(eq(invoice.id, invoiceId), eq(invoice.userId, userId)))
    .run();
  audit({
    action: "invoice.balance",
    entity: "invoice",
    entityId: invoiceId,
    ownerId: userId,
    scope: "user",
    before: {
      creditsMinor: before.creditsMinor,
      advanceMinor: before.advanceMinor,
      status: before.status,
    },
    after: { creditsMinor, advanceMinor, status },
  });
  return findOwned(tx, userId, invoiceId);
}
