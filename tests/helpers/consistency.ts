import { getTableColumns, getTableName, is, sql } from "drizzle-orm";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import type { Db } from "@/server/db";
import * as schema from "@/server/db/schema";

const OWNER_COLUMNS = ["userId", "ownerId"] as const;

function ownedTables(): { table: string; column: string }[] {
  return Object.values(schema as Record<string, unknown>)
    .filter((value): value is SQLiteTable => is(value, SQLiteTable))
    .flatMap((table) => {
      const columns = getTableColumns(table) as Record<string, { name: string } | undefined>;
      const key = OWNER_COLUMNS.find((name) => columns[name]);
      return key && getTableName(table) !== "audit_log"
        ? [{ table: getTableName(table), column: columns[key]!.name }]
        : [];
    });
}

const OWNED = ownedTables();

function count(db: Db, query: ReturnType<typeof sql>): number {
  return db.get<{ n: number }>(query)?.n ?? 0;
}

// Throws on the first broken invariant. Plans extend it as new entities arrive.
export function assertConsistent(db: Db, ownerId: string): void {
  const problems: string[] = [];

  const accountExists = count(db, sql`SELECT count(*) AS n FROM user WHERE id = ${ownerId}`) > 0;
  for (const { table, column } of OWNED) {
    const rows = count(
      db,
      sql`SELECT count(*) AS n FROM ${sql.identifier(table)} WHERE ${sql.identifier(column)} = ${ownerId}`,
    );
    if (rows > 0 && !accountExists) problems.push(`${table}: ${rows} řádků neexistujícího účtu`);
  }

  const foreignCounters = count(
    db,
    sql`SELECT count(*) AS n FROM number_series_counter c
      LEFT JOIN number_series s ON s.id = c.series_id
      WHERE c.user_id = ${ownerId} AND (s.id IS NULL OR s.user_id <> c.user_id)`,
  );
  if (foreignCounters > 0) {
    problems.push(`number_series_counter: ${foreignCounters} čítačů cizí nebo chybějící řady`);
  }

  const orphanAudit = count(
    db,
    sql`SELECT count(*) AS n FROM audit_log WHERE scope = 'user' AND owner_id IS NULL`,
  );
  if (orphanAudit > 0)
    problems.push(`audit_log: ${orphanAudit} uživatelských záznamů bez vlastníka`);

  if (problems.length > 0) {
    throw new Error(`Data účtu ${ownerId} nejsou konzistentní:\n${problems.join("\n")}`);
  }
}
