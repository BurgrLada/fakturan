import type Database from "better-sqlite3";

function literal(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (Buffer.isBuffer(value)) return `X'${value.toString("hex")}'`;
  return `'${String(value).replaceAll("'", "''")}'`;
}

// A plain SQL dump: tables first, then rows, then indexes and triggers, so a reader loads it with
// foreign keys off and the audit triggers do not block its own rows.
export function dumpDatabase(sqlite: Database.Database): string {
  const objects = sqlite
    .prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid")
    .all() as { type: string; name: string; sql: string }[];
  const tables = objects.filter((row) => row.type === "table" && !row.name.startsWith("sqlite_"));
  const out: string[] = ["PRAGMA foreign_keys = OFF;", "BEGIN;"];
  for (const table of tables) out.push(`${table.sql};`);
  for (const table of [...tables, { name: "sqlite_sequence" }]) {
    const exists = sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(table.name);
    if (!exists) continue;
    for (const row of sqlite.prepare(`SELECT * FROM "${table.name}"`).all() as Record<
      string,
      unknown
    >[]) {
      const columns = Object.keys(row).map((name) => `"${name}"`);
      const values = Object.values(row).map(literal);
      out.push(
        `INSERT INTO "${table.name}" (${columns.join(", ")}) VALUES (${values.join(", ")});`,
      );
    }
  }
  for (const other of objects.filter((row) => row.type !== "table")) out.push(`${other.sql};`);
  out.push("COMMIT;", "");
  return out.join("\n");
}
