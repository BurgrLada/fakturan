import "server-only";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { registerSqlFunctions } from "@/lib/sql-functions";
import { env } from "../env";
import * as schema from "./schema";

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export function createDb(path: string): Db {
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  registerSqlFunctions(sqlite);
  return drizzle(sqlite, { schema });
}

export { runMigrations } from "./migrate";

let cached: Db | undefined;

export const db: Db = new Proxy({} as Db, {
  get(_, prop) {
    cached ??= createDb(env.DATABASE_PATH);
    const value = cached[prop as keyof Db];
    return typeof value === "function" ? value.bind(cached) : value;
  },
});

export function setDbForTests(instance: Db | null): void {
  cached = instance ?? undefined;
}
