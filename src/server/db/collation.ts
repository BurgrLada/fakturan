import { sql, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";

// czech_key is registered per connection by registerSqlFunctions.
export function czech(column: SQLiteColumn): SQL {
  return sql`czech_key(${column})`;
}
