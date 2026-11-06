import "server-only";
import { count, type AnyColumn } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { ACCOUNT_ROW_LIMITS, type LimitedTable } from "@/lib/account-limits";
import { TEXTS } from "@/lib/texts";
import { scoped } from "../db/scoped";
import { ServiceError, type Reader } from "./access";

type Owned = SQLiteTable & { userId: AnyColumn };

// Called before a row of a configuration table is created, inside the same transaction.
export function assertRowLimit(q: Reader, name: LimitedTable, table: Owned, ownerId: string): void {
  const limit = ACCOUNT_ROW_LIMITS[name];
  const rows =
    q.select({ n: count() }).from(table).where(scoped(ownerId).where(table)).get()?.n ?? 0;
  if (rows >= limit) {
    throw new ServiceError(TEXTS.accountLimits.tooMany(TEXTS.accountLimits.names[name], limit));
  }
}
