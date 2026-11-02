import { and, gt, inArray, lt, sql, type SQL } from "drizzle-orm";
import { AWAITING_PAYMENT, type InvoiceStatus } from "@/lib/invoice";
import { invoice } from "./schema";

export const NOT_IN_TOTALS = ["draft", "cancelled"] as const satisfies InvoiceStatus[];

export const fullDue = sql`${invoice.totalMinor} + ${invoice.creditsMinor} - ${invoice.advanceMinor} - ${invoice.paidMinor}`;

// The SQL form of amountDue in lib/qr-payload.
export const dueSql: SQL<number> = sql<number>`CASE WHEN ${invoice.supersededAt} IS NULL THEN ${fullDue} ELSE min(0, ${fullDue}) END`;

// A zero document keeps a stranded payment as awaiting, and that must not lower what is owed.
export const openCondition = and(inArray(invoice.status, AWAITING_PAYMENT), gt(dueSql, 0)) as SQL;

// The SQL form of isOverdue in lib/invoice; tests compare the two.
export function overdueCondition(today: string): SQL {
  return and(openCondition, lt(invoice.dueDate, today)) as SQL;
}
