import "server-only";
import { randomUUID } from "node:crypto";
import { TEXTS } from "@/lib/texts";
import { RestoreRejected, type ArchiveRow } from "./restore-read";
import type { BackupTable } from "./tables";

const E = TEXTS.restore.errors;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export type IdMap = { tables: Map<string, Map<string, string>>; all: Map<string, string> };

// randomUUID returns a string of many small pieces, measured at about 490 bytes of heap where a
// flat copy takes 66; the map holds one per row of the archive, up to 300 000.
function flat(id: string): string {
  return Buffer.from(id, "latin1").toString("latin1");
}

// Every id of the archive gets a new UUID before anything is written, so no row of the restored
// account can carry an id that exists elsewhere (R-33).
export function buildIdMap(ids: Map<string, string[]>): IdMap {
  const map: IdMap = { tables: new Map(), all: new Map() };
  for (const [table, list] of ids) {
    const own = new Map<string, string>();
    for (const id of list) {
      if (own.has(id) || map.all.has(id)) throw new RestoreRejected(E.row(table));
      const fresh = flat(randomUUID());
      own.set(id, fresh);
      map.all.set(id, fresh);
    }
    map.tables.set(table, own);
  }
  return map;
}

function replaced(value: string, all: Map<string, string>): string {
  const whole = all.get(value);
  if (whole) return whole;
  return value.replace(UUID, (found) => all.get(found) ?? all.get(found.toLowerCase()) ?? found);
}

// Exact occurrences of known ids only: an id the archive does not hold, such as a payment removed
// before the backup, stays as it was. Arrays and objects are rewritten in place, so a row never
// exists twice in memory (R-2); only strings are assigned, and an own `__proto__` key from
// JSON.parse is a data property, so the assignment never reaches the prototype.
function replaceIds(value: unknown, all: Map<string, string>): unknown {
  if (typeof value === "string") return replaced(value, all);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const item: unknown = value[index];
      if (typeof item === "string") value[index] = replaced(item, all);
      else replaceIds(item, all);
    }
  } else if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const item = record[key];
      if (typeof item === "string") record[key] = replaced(item, all);
      else replaceIds(item, all);
    }
  }
  return value;
}

// Rewrites the row it is given and returns it. Owner and omitted columns are dropped: the account
// comes from the session, never from the archive (R-32).
export function remapIds(row: ArchiveRow, table: BackupTable, idMap: IdMap): ArchiveRow {
  for (const column of Object.keys(row)) {
    const rule = table.columns[column];
    if (!rule || rule === "owner" || rule === "omit") delete row[column];
  }
  for (const [column, rule] of Object.entries(table.columns)) {
    if (!Object.hasOwn(row, column)) continue;
    const value = row[column];
    if (rule === "id") {
      const fresh = idMap.tables.get(table.name)?.get(value as string);
      if (!fresh) throw new RestoreRejected(E.row(table.name));
      row[column] = fresh;
    } else if (rule.startsWith("ref:")) {
      if (value === null) continue;
      const target = idMap.tables.get(rule.slice(4))?.get(value as string);
      if (!target) throw new RestoreRejected(E.reference(table.name));
      row[column] = target;
    } else if (rule === "json-ids") {
      row[column] = replaceIds(value, idMap.all);
    }
  }
  return row;
}
