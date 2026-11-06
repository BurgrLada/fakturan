import "server-only";
import { count, gte, inArray, lte, ne, sql, type SQL } from "drizzle-orm";
import type { ExportFilter, ExportFormat } from "@/lib/export-filter";
import { db } from "../db";
import { invoice } from "../db/schema";
import { scoped } from "../db/scoped";
import { ownedCustomerId } from "./invoices";

// The documents an invoice export takes; shared by the run and by the cap checked before a job is
// created, so both count the same rows.
export function invoiceWhere(ownerId: string, filter: ExportFilter, format: ExportFormat): SQL {
  // ISDOC has no way to mark a cancellation, so an accountant would book it as a live invoice.
  // Picked by status or by hand from the list, a cancelled document is what the person asked for.
  const withoutCancelled = format === "isdoc_zip" && !filter.statuses?.length && !filter.ids;
  const wantsCustomer = filter.customerId !== undefined;
  const customerId = ownedCustomerId(ownerId, filter.customerId);
  return scoped(ownerId).where(invoice, (t, { and: all, eq: is }) =>
    all(
      // A draft has no number and no final content, so no export ever carries one (R-24).
      ne(t.status, "draft"),
      withoutCancelled ? ne(t.status, "cancelled") : undefined,
      filter.from ? gte(t.issueDate, filter.from) : undefined,
      filter.to ? lte(t.issueDate, filter.to) : undefined,
      filter.types?.length ? inArray(t.type, filter.types) : undefined,
      filter.statuses?.length ? inArray(t.status, filter.statuses) : undefined,
      // A customer of another account narrows to nothing instead of being ignored.
      wantsCustomer ? (customerId ? is(t.customerId, customerId) : sql`0`) : undefined,
      filter.ids ? inArray(t.id, filter.ids) : undefined,
    ),
  );
}

export function countExportInvoices(
  ownerId: string,
  filter: ExportFilter,
  format: ExportFormat,
): number {
  return (
    db
      .select({ n: count() })
      .from(invoice)
      .where(invoiceWhere(ownerId, filter, format))
      .get()?.n ?? 0
  );
}
