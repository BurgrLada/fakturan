import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { count, getTableColumns, getTableName, is, Table } from "drizzle-orm";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import type { Db } from "@/server/db";
import { auditLog } from "@/server/db/schema";

const servicesDir = join(process.cwd(), "src/server/services");

const WRITE_METHODS = "insert|update|delete|transaction|run";
const RAW_ACCESS = /\$client\b|\bcreateDb\s*\(|\bdrizzle\s*\(|\bnew\s+Database\s*\(/;
const OWNER_COLUMN = /(?:^|_)(?:user|owner)_id$/;

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

// A textual check, so it follows names, not values: a handle passed through a call is not seen.
function databaseHandles(source: string): string[] {
  const handles = new Set(["db"]);
  for (const [, name] of source.matchAll(/\bdb\s+as\s+(\w+)/g)) handles.add(name);
  for (const [, name] of source.matchAll(/\bdb\s*:\s*(\w+)/g)) handles.add(name);
  for (const [, name] of source.matchAll(/\b(\w+)\s*:\s*(?:Db\b|typeof\s+db\b)/g)) {
    handles.add(name);
  }
  const assignments = [
    ...source.matchAll(
      /\b(?:const|let|var)\s+(\w+)(?:\s*:[^=]+?)?\s*=\s*\(?\s*([\w.]+)(?![\w.]|\s*[.([])/g,
    ),
  ];
  let size = 0;
  while (size !== handles.size) {
    size = handles.size;
    for (const [, name, value] of assignments) {
      if (handles.has(value.split(".").at(-1)!)) handles.add(name);
    }
  }
  return [...handles];
}

function writesDirectly(source: string): boolean {
  if (RAW_ACCESS.test(source)) return true;
  const handle = `(?:${databaseHandles(source).join("|")})`;
  const call = new RegExp(`\\b${handle}\\s*(?:\\??\\.|\\[\\s*["'\`])\\s*(?:${WRITE_METHODS})\\b`);
  const destructured = new RegExp(
    `\\{[^}]*\\b(?:${WRITE_METHODS})\\b[^}]*\\}\\s*=\\s*${handle}\\b`,
  );
  return call.test(source) || destructured.test(source);
}

// mutation.ts is the one place allowed to open the write transaction.
export function findWritesOutsideMutate(dir: string = servicesDir): string[] {
  return sourceFiles(dir)
    .filter((path) => relative(dir, path) !== "mutation.ts")
    .filter((path) => writesDirectly(readFileSync(path, "utf8")))
    .map((path) => relative(dir, path));
}

function namesAccountOwner(table: SQLiteTable): boolean {
  const hasOwnerColumn = Object.values(getTableColumns(table)).some((column) =>
    OWNER_COLUMN.test(column.name),
  );
  const referencesUser = getTableConfig(table).foreignKeys.some(
    (key) => getTableName(key.reference().foreignTable) === "user",
  );
  return hasOwnerColumn || referencesUser;
}

export function findUnregisteredOwnedTables(
  schema: Record<string, unknown>,
  registered: readonly Table[],
  exceptions: readonly string[],
): string[] {
  return Object.values(schema)
    .filter((value): value is SQLiteTable => is(value, SQLiteTable))
    .filter((table) => namesAccountOwner(table) && !registered.includes(table))
    .map((table) => getTableName(table))
    .filter((name) => !exceptions.includes(name));
}
