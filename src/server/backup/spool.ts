import "server-only";
import { closeSync, existsSync, fstatSync, openSync, readSync, writeSync } from "node:fs";
import { join } from "node:path";
import { jsonNodesOfBytes } from "@/lib/backup-format";
import { lineCost } from "./memory-guard";
import type { ArchiveRow } from "./restore-read";

const BLOCK = 1024 * 1024;
const NEWLINE = 0x0a;

// R-1: a restore keeps no table in memory; each checked and remapped row goes to the file of its
// table and the commit reads it back line by line.
const spoolPath = (dir: string, table: string) => join(dir, `${table}.jsonl`);

export type SpoolWriter = { append(row: ArchiveRow): void; close(): number };

function writeAll(fd: number, text: string): void {
  const bytes = Buffer.from(text);
  for (let offset = 0; offset < bytes.length;) {
    offset += writeSync(fd, bytes, offset, bytes.length - offset);
  }
}

export function spoolWriter(dir: string, table: string): SpoolWriter {
  const fd = openSync(spoolPath(dir, table), "wx");
  let pending: string[] = [];
  let pendingLength = 0;
  let count = 0;
  let open = true;
  const flush = () => {
    if (pending.length === 0) return;
    const text = pending.join("");
    pending = [];
    pendingLength = 0;
    writeAll(fd, text);
  };
  return {
    append(row) {
      const line = `${JSON.stringify(row)}\n`;
      pending.push(line);
      pendingLength += line.length;
      count += 1;
      if (pendingLength >= BLOCK) flush();
    },
    // Safe to call again from a finally block after a failure.
    close() {
      if (!open) return count;
      open = false;
      try {
        flush();
      } finally {
        closeSync(fd);
      }
      return count;
    },
  };
}

// What a writer holds at most: a block of pending text and one line of 2 MiB, two bytes a char.
export const SPOOL_HELD = 2 * (BLOCK + 2 * BLOCK);

// Synchronous on purpose: the commit is one better-sqlite3 transaction and cannot await. `cost`
// is what the parsed row holds by the memory guard's measure.
export function eachSpooled(
  dir: string,
  table: string,
  take: (row: ArchiveRow, bytes: number, cost: number) => void,
): number {
  const path = spoolPath(dir, table);
  if (!existsSync(path)) return 0;
  const fd = openSync(path, "r");
  let count = 0;
  try {
    // Most tables are small; a full block for each would be garbage the memory guard counts.
    const block = Buffer.allocUnsafe(Math.max(1, Math.min(BLOCK, fstatSync(fd).size)));
    let carry: Buffer[] = [];
    for (;;) {
      const read = readSync(fd, block, 0, block.length, null);
      if (read === 0) break;
      const view = block.subarray(0, read);
      let start = 0;
      for (;;) {
        const end = view.indexOf(NEWLINE, start);
        if (end < 0) {
          // The block is reused by the next read, so the unfinished line is copied out.
          if (start < read) carry.push(Buffer.from(view.subarray(start)));
          break;
        }
        const piece = view.subarray(start, end);
        const line = carry.length > 0 ? Buffer.concat([...carry, piece]) : piece;
        carry = [];
        const cost = lineCost(line.length, jsonNodesOfBytes(line, 0, line.length));
        take(JSON.parse(line.toString("utf8")) as ArchiveRow, line.length, cost);
        count += 1;
        start = end + 1;
      }
    }
    if (carry.length > 0) throw new Error("Mezisoubor obnovy nekončí celým řádkem");
  } finally {
    closeSync(fd);
  }
  return count;
}
