import "server-only";
import { and, eq, inArray, isNotNull, ne, notInArray, or } from "drizzle-orm";
import { isFinalInvoice } from "@/lib/invoice";
import { TEXTS } from "@/lib/texts";
import type { Actor } from "../audit/context";
import { clock } from "../clock";
import {
  catalogItem,
  customer,
  file,
  importBatch,
  invoice,
  invoiceLine,
  payment,
  recurringInvoice,
} from "../db/schema";
import { scoped } from "../db/scoped";
import { ServiceError } from "./access";
import { syncAdvance } from "./advances";
import { findBatch, removeBlobs } from "./import-batch";
import { refreshBalance } from "./invoice-balance";
import { auditSnapshot } from "./invoices";
import { mutate } from "./mutation";

const E = TEXTS.importing.errors;

// R-20: one transaction takes the whole batch back, or nothing if a person built on it.
export function undoBatch(actor: Actor, batchId: string): void {
  const userId = actor.userId;
  if (!userId) throw new ServiceError(TEXTS.invoices.validation.forbidden);
  const removedFiles = mutate(actor, "import.undo", (tx, audit) => {
    const batch = findBatch(tx, userId, batchId);
    if (batch.status !== "done") throw new ServiceError(E.notUndoable);
    const documents = tx
      .select()
      .from(invoice)
      .where(scoped(userId).where(invoice, (t, { eq }) => eq(t.importBatchId, batchId)))
      .all();
    const ids = documents.map((row) => row.id);
    const numberOf = (id: string) => documents.find((row) => row.id === id)?.number ?? "";

    if (ids.length > 0) {
      const foreignPayments = tx
        .select({ invoiceId: payment.invoiceId })
        .from(payment)
        .where(
          scoped(userId).where(payment, (t) =>
            and(inArray(t.invoiceId, ids), ne(t.source, "import")),
          ),
        )
        .all();
      if (foreignPayments.length > 0) {
        const numbers = [...new Set(foreignPayments.map((row) => numberOf(row.invoiceId)))];
        throw new ServiceError(E.undoPayments(numbers.join(", ")));
      }
      const linked = tx
        .select({ relatedInvoiceId: invoice.relatedInvoiceId })
        .from(invoice)
        .where(
          scoped(userId).where(invoice, (t) =>
            and(inArray(t.relatedInvoiceId, ids), notInArray(t.id, ids)),
          ),
        )
        .all();
      if (linked.length > 0) {
        const numbers = [...new Set(linked.map((row) => numberOf(row.relatedInvoiceId!)))];
        throw new ServiceError(E.undoLinked(numbers.join(", ")));
      }
    }

    tx.delete(payment)
      .where(
        scoped(userId).where(payment, (t) => inArray(t.invoiceId, ids.length > 0 ? ids : [""])),
      )
      .run();
    // Children first: the self reference to the original or the advance does not cascade, and
    // a credit note may point at a final invoice that points at an advance.
    const ordered: typeof documents = [];
    let left = documents;
    while (left.length > 0) {
      const leaves = left.filter((row) => !left.some((other) => other.relatedInvoiceId === row.id));
      ordered.push(...leaves);
      left = left.filter((row) => !leaves.includes(row));
    }
    for (const row of ordered) {
      const lines = tx
        .select({ id: invoiceLine.id })
        .from(invoiceLine)
        .where(scoped(userId).where(invoiceLine, (t, { eq }) => eq(t.invoiceId, row.id)))
        .all().length;
      tx.delete(invoice)
        .where(scoped(userId).where(invoice, (t, { eq }) => eq(t.id, row.id)))
        .run();
      audit({
        entity: "invoice",
        entityId: row.id,
        ownerId: userId,
        scope: "user",
        before: auditSnapshot(row, lines),
      });
    }
    for (const row of ordered) {
      if (!row.relatedInvoiceId || ids.includes(row.relatedInvoiceId)) continue;
      if (row.type === "credit_note") refreshBalance(tx, audit, userId, row.relatedInvoiceId);
      if (isFinalInvoice(row)) syncAdvance(tx, audit, userId, row.relatedInvoiceId, row.id);
    }

    const created = tx
      .select({ id: customer.id, name: customer.name })
      .from(customer)
      .where(scoped(userId).where(customer, (t, { eq }) => eq(t.importBatchId, batchId)))
      .all();
    const kept = new Set(
      tx
        .select({ id: invoice.customerId })
        .from(invoice)
        .where(scoped(userId).where(invoice, (t) => isNotNull(t.customerId)))
        .all()
        .concat(
          tx
            .select({ id: recurringInvoice.customerId })
            .from(recurringInvoice)
            .where(scoped(userId).where(recurringInvoice, (t) => isNotNull(t.customerId)))
            .all(),
        )
        .map((row) => row.id),
    );
    const dropped = created.filter((row) => !kept.has(row.id));
    if (dropped.length > 0) {
      tx.delete(customer)
        .where(
          scoped(userId).where(customer, (t) =>
            inArray(
              t.id,
              dropped.map((row) => row.id),
            ),
          ),
        )
        .run();
    }
    for (const row of dropped) {
      audit({
        entity: "customer",
        entityId: row.id,
        ownerId: userId,
        scope: "user",
        before: { name: row.name },
      });
    }
    const items = tx
      .select({ id: catalogItem.id })
      .from(catalogItem)
      .where(scoped(userId).where(catalogItem, (t, { eq }) => eq(t.importBatchId, batchId)))
      .all();
    const usedItems = new Set(
      tx
        .select({ id: invoiceLine.catalogItemId })
        .from(invoiceLine)
        .where(scoped(userId).where(invoiceLine, (t) => isNotNull(t.catalogItemId)))
        .all()
        .map((row) => row.id),
    );
    const spareItems = items.filter((row) => !usedItems.has(row.id)).map((row) => row.id);
    if (spareItems.length > 0) {
      tx.delete(catalogItem)
        .where(scoped(userId).where(catalogItem, (t) => inArray(t.id, spareItems)))
        .run();
    }

    const pdfs = tx
      .delete(file)
      .where(
        scoped(userId).where(file, (t) =>
          and(
            eq(t.importBatchId, batchId),
            or(eq(t.kind, "import_pdf"), eq(t.kind, "import_upload")),
          ),
        ),
      )
      .returning({ id: file.id })
      .all()
      .map((row) => row.id);
    const now = clock.now();
    tx.update(importBatch)
      .set({ status: "undone", undoneAt: now, updatedAt: now })
      .where(scoped(userId).where(importBatch, (t, { eq }) => eq(t.id, batchId)))
      .run();
    audit({
      entity: "import_batch",
      entityId: batchId,
      ownerId: userId,
      scope: "user",
      after: {
        documents: documents.length,
        customers: dropped.length,
        catalogItems: spareItems.length,
        files: pdfs.length,
      },
    });
    return pdfs;
  });
  removeBlobs(userId, removedFiles);
}
