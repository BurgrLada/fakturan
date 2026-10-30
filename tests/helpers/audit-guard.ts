import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { count } from "drizzle-orm";
import type { Db } from "@/server/db";
import { auditLog } from "@/server/db/schema";

const servicesDir = join(process.cwd(), "src/server/services");

const DIRECT_WRITE = /\bdb\s*\.\s*(?:insert|update|delete|transaction|run|\$client)\b/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith(".ts") ? [path] : [];
  });
}

export function expectAudited<T>(db: Db, run: () => T): T {
  const before = countRows(db);
  const result = run();
  if (countRows(db) <= before) throw new Error("Mutace nevytvořila auditní záznam");
  return result;
}

function countRows(db: Db): number {
  return db.select({ n: count() }).from(auditLog).get()?.n ?? 0;
}

// mutation.ts is the one place allowed to open the write transaction.
export function findWritesOutsideMutate(dir: string = servicesDir): string[] {
  return sourceFiles(dir)
    .filter((path) => relative(dir, path) !== "mutation.ts")
    .filter((path) => DIRECT_WRITE.test(readFileSync(path, "utf8")))
    .map((path) => relative(dir, path));
}
