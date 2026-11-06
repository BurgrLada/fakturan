import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { PDF_LIMITS, sniffContent, ZIP_LIMITS } from "@/lib/safe-input/limits";
import { extractEmbeddedXml } from "@/lib/safe-input/pdf-embedded";
import { readZipEntries } from "@/lib/safe-input/zip";
import { parseIsdoc } from "@/server/isdoc/parse";

// Counts and sums per year and currency only: the output may be pasted anywhere, so it never
// names a document, a customer or an amount of a single invoice (IMP-013, R-37).
export type Totals = Map<string, { count: number; totalMinor: number; unreadable: number }>;

const key = (year: string, currency: string) => `${year} ${currency}`;

function add(totals: Totals, year: string, currency: string, totalMinor: number): void {
  const row = totals.get(key(year, currency)) ?? { count: 0, totalMinor: 0, unreadable: 0 };
  row.count += 1;
  row.totalMinor += totalMinor;
  totals.set(key(year, currency), row);
}

function documentOf(bytes: Uint8Array): Uint8Array | null {
  const kind = sniffContent(bytes);
  if (kind === "pdf") return extractEmbeddedXml(bytes, PDF_LIMITS);
  return kind === "xml" ? bytes : null;
}

function countOne(totals: Totals, bytes: Uint8Array): void {
  try {
    const xml = documentOf(bytes);
    if (!xml) throw new Error("není ISDOC");
    const doc = parseIsdoc(xml);
    if (!doc.type) throw new Error("typ mimo import");
    add(totals, doc.issueDate.slice(0, 4), doc.currency, doc.totalMinor);
  } catch {
    const row = totals.get(key("????", "???")) ?? { count: 0, totalMinor: 0, unreadable: 0 };
    row.unreadable += 1;
    totals.set(key("????", "???"), row);
  }
}

// The file goes through the same readers as an import: the safe ZIP reader, the PDF scanner and
// the ISDOC parser, so a document the import would refuse is counted as unreadable here too.
export async function sourceTotals(bytes: Uint8Array): Promise<Totals> {
  const totals: Totals = new Map();
  if (sniffContent(bytes) === "zip") {
    await readZipEntries(bytes, ZIP_LIMITS, ({ bytes: entry }) => countOne(totals, entry));
  } else {
    countOne(totals, bytes);
  }
  return totals;
}

// Loaded into memory: even a read-only open of a WAL database leaves -shm and -wal files beside
// it, and the copy must stay exactly as it was.
export function databaseTotals(path: string, ownerId?: string): Totals {
  const image = readFileSync(path);
  // Bytes 18 and 19 mark WAL mode, which an in-memory image cannot use; 1 is the rollback journal.
  image[18] = 1;
  image[19] = 1;
  const sqlite = new Database(image);
  try {
    const rows = sqlite
      .prepare(
        `SELECT substr(issue_date, 1, 4) AS year, currency, count(*) AS n, sum(total_minor) AS total
           FROM invoice
          WHERE external = 1 AND (? IS NULL OR user_id = ?)
          GROUP BY year, currency`,
      )
      .all(ownerId ?? null, ownerId ?? null) as {
      year: string;
      currency: string;
      n: number;
      total: number;
    }[];
    return new Map(
      rows.map((row) => [
        key(row.year, row.currency),
        { count: row.n, totalMinor: row.total, unreadable: 0 },
      ]),
    );
  } finally {
    sqlite.close();
  }
}

const money = (minor: number) => (minor / 100).toFixed(2);

export function formatComparison(source: Totals, stored: Totals): string {
  const keys = [...new Set([...source.keys(), ...stored.keys()])].sort();
  const lines = ["rok měna | zdroj: počet, součet | Fakturan: počet, součet | shoda"];
  for (const name of keys) {
    const a = source.get(name) ?? { count: 0, totalMinor: 0, unreadable: 0 };
    const b = stored.get(name) ?? { count: 0, totalMinor: 0, unreadable: 0 };
    if (a.unreadable > 0) {
      lines.push(`${name} | nečitelných souborů: ${a.unreadable}`);
      continue;
    }
    const same = a.count === b.count && a.totalMinor === b.totalMinor;
    lines.push(
      `${name} | ${a.count}, ${money(a.totalMinor)} | ${b.count}, ${money(b.totalMinor)} | ${same ? "ano" : "NE"}`,
    );
  }
  return lines.join("\n");
}
