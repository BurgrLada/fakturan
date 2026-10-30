import "server-only";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { join } from "node:path";
import type { Db } from "./index";

export function runMigrations(db: Db): void {
  migrate(db, { migrationsFolder: join(process.cwd(), "drizzle") });
}
