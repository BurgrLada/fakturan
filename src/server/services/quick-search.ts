import "server-only";
import { asc, desc, or, sql } from "drizzle-orm";
import { formatMoney } from "@/lib/money";
import { foldText } from "@/lib/fold-text";
import { MIN_QUERY_LENGTH, PER_GROUP, type SearchHit } from "@/lib/quick-search";
import { TEXTS } from "@/lib/texts";
import { db } from "../db";
import { czech } from "../db/collation";
import { invoice, recurringInvoice } from "../db/schema";
import { scoped } from "../db/scoped";
import { searchCatalog } from "./catalog";
import { escapeLike, searchCustomers } from "./customers";

export type { SearchHit } from "@/lib/quick-search";

const T = TEXTS.quickSearch;

function searchInvoices(ownerId: string, term: string, limit: number): SearchHit[] {
  const folded = `%${escapeLike(foldText(term))}%`;
  const literal = `%${escapeLike(term)}%`;
  return db
    .select({
      id: invoice.id,
      number: invoice.number,
      customerName: invoice.customerName,
    })
    .from(invoice)
    .where(
      scoped(ownerId).where(invoice, (t) =>
        or(
          sql`${t.searchText} LIKE ${folded} ESCAPE '\\'`,
          sql`${t.number} LIKE ${literal} ESCAPE '\\'`,
        ),
      ),
    )
    .orderBy(desc(invoice.updatedAt), asc(invoice.id))
    .limit(limit)
    .all()
    .map((row) => ({
      group: "invoice",
      id: row.id,
      label: row.number ?? T.draft,
      detail: row.customerName,
      href: `/faktury/${row.id}`,
    }));
}

function searchPlans(ownerId: string, term: string, limit: number): SearchHit[] {
  const folded = `%${escapeLike(foldText(term))}%`;
  return db
    .select({ id: recurringInvoice.id, name: recurringInvoice.name })
    .from(recurringInvoice)
    .where(
      scoped(ownerId).where(
        recurringInvoice,
        (t) => sql`fold_text(${t.name}) LIKE ${folded} ESCAPE '\\'`,
      ),
    )
    .orderBy(asc(czech(recurringInvoice.name)), asc(recurringInvoice.id))
    .limit(limit)
    .all()
    .map((row) => ({
      group: "recurring",
      id: row.id,
      label: row.name,
      detail: T.groups.recurring,
      href: `/pravidelne/${row.id}`,
    }));
}

export function searchAll(ownerId: string, q: string, perGroup = PER_GROUP): SearchHit[] {
  const term = q.trim();
  if (term.length < MIN_QUERY_LENGTH) return [];
  const customers = searchCustomers(ownerId, term, perGroup, "all").map((row): SearchHit => ({
    group: "customer",
    id: row.id,
    label: row.name,
    detail: [row.ico, row.archivedAt ? T.archived : ""].filter(Boolean).join(" · "),
    href: `/zakaznici/${row.id}`,
  }));
  const items = searchCatalog(ownerId, term, perGroup).map((row): SearchHit => ({
    group: "catalog",
    id: row.id,
    label: row.name,
    detail: `${formatMoney(row.priceMinor, row.currency)} / ${row.unit}`,
    href: `/cenik/${row.id}`,
  }));
  return [
    ...searchInvoices(ownerId, term, perGroup),
    ...customers,
    ...items,
    ...searchPlans(ownerId, term, perGroup),
  ];
}
