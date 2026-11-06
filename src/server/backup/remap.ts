import "server-only";
import { randomUUID } from "node:crypto";
import { TEXTS } from "@/lib/texts";
import { RestoreRejected, type ArchiveRow } from "./restore-read";
import type { BackupTable } from "./tables";

const E = TEXTS.restore.errors;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export type IdMap = { tables: Map<string, Map<string, string>>; all: Map<string, string> };

// Every id of the archive gets a new UUID before anything is written, so no row of the restored
// account can carry an id that exists elsewhere (R-33).
export function buildIdMap(ids: Map<string, string[]>): IdMap {
  const map: IdMap = { tables: new Map(), all: new Map() };
  for (const [table, list] of ids) {
    const own = new Map<string, string>();
    for (const id of list) {
      if (own.has(id) || map.all.has(id)) throw new RestoreRejected(E.row(table));
      const fresh = randomUUID();
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
// before the backup, stays as it was.
function replaceIds(value: unknown, all: Map<string, string>): unknown {
  if (typeof value === "string") return replaced(value, all);
  if (Array.isArray(value)) return value.map((item) => replaceIds(item, all));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replaceIds(item, all)]),
    );
  }
  return value;
}

// Owner columns are dropped: the account comes from the session, never from the archive (R-32).
export function remapIds(row: ArchiveRow, table: BackupTable, idMap: IdMap): ArchiveRow {
  const out: ArchiveRow = {};
  for (const [column, rule] of Object.entries(table.columns)) {
    if (rule === "owner" || rule === "omit" || !(column in row)) continue;
    const value = row[column];
    if (rule === "id") {
      out[column] = idMap.tables.get(table.name)?.get(value as string);
      if (!out[column]) throw new RestoreRejected(E.row(table.name));
    } else if (rule.startsWith("ref:")) {
      if (value === null) {
        out[column] = null;
        continue;
      }
      const target = idMap.tables.get(rule.slice(4))?.get(value as string);
      if (!target) throw new RestoreRejected(E.reference(table.name));
      out[column] = target;
    } else if (rule === "json-ids") {
      out[column] = replaceIds(value, idMap.all);
    } else {
      out[column] = value;
    }
  }
  return out;
}
