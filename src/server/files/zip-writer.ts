import "server-only";
import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { Zip, ZipDeflate, ZipPassThrough, strToU8 } from "fflate";

// fflate writes no ZIP64, so an archive must stay far below 4 GiB; the backup limit applies (R-35).
export const MAX_EXPORT_BYTES = 1024 ** 3;

export class ExportTooLarge extends Error {
  constructor() {
    super("Export překročil 1 GiB");
    this.name = "ExportTooLarge";
  }
}

export type AtomicFile = {
  write(chunk: Uint8Array | string): void;
  // Flushes to disk before the rename, so a crash leaves either nothing or the whole file.
  close(): number;
  abort(): void;
};

// Written beside the target under a temporary name; only close() makes the file appear.
export function atomicFileWriter(path: string, limit = MAX_EXPORT_BYTES): AtomicFile {
  const temporary = `${path}.part`;
  let fd: number | null = openSync(temporary, "wx");
  let size = 0;
  const open = () => {
    if (fd === null) throw new Error("Soubor exportu je už uzavřený");
    return fd;
  };
  return {
    write(chunk) {
      const bytes = typeof chunk === "string" ? strToU8(chunk) : chunk;
      size += bytes.length;
      if (size > limit) throw new ExportTooLarge();
      let offset = 0;
      while (offset < bytes.length) offset += writeSync(open(), bytes, offset);
    },
    close() {
      const handle = open();
      fsyncSync(handle);
      closeSync(handle);
      fd = null;
      renameSync(temporary, path);
      return size;
    },
    abort() {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // Already closed by a failed write; removing the file is what matters.
        }
        fd = null;
      }
      rmSync(temporary, { force: true });
    },
  };
}

// An entry name is a label, never a path: a slash, a backslash or `..` would let an unpacker
// write outside its folder. Czech diacritics stay as they are.
// oxlint-disable-next-line no-control-regex
const UNSAFE_ENTRY = /[\\/]|\.\.|[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const MAX_ENTRY_CHARS = 255;

// For a name built from document data, such as a number: one segment, never a folder.
export function assertEntryName(name: string): string {
  if (!name || name.length > MAX_ENTRY_CHARS || UNSAFE_ENTRY.test(name) || /^[\s.]/.test(name)) {
    throw new Error("Neplatné jméno položky archivu");
  }
  return name;
}

// Fixed parts of a format, such as xl/worksheets/sheet1.xml, may have folders of safe segments.
function assertEntryPath(path: string): string {
  if (path.length > MAX_ENTRY_CHARS) throw new Error("Neplatné jméno položky archivu");
  for (const segment of path.split("/")) {
    if (!segment || UNSAFE_ENTRY.test(segment)) throw new Error("Neplatné jméno položky archivu");
  }
  return path;
}

const END_RECORD = 22;
const MAX_PLAIN_ENTRIES = 0xffff;

// fflate writes the entry count into 16-bit fields of the end record, so past 65 535 entries the
// count would silently wrap. Sizes and offsets stay below 4 GiB (MAX_EXPORT_BYTES), so only the
// ZIP64 end record and its locator are added, as APPNOTE 4.3.14 to 4.3.16 lay them out.
export function withZip64End(tail: Uint8Array, entries: number): Uint8Array {
  if (entries <= MAX_PLAIN_ENTRIES) return tail;
  const at = tail.length - END_RECORD;
  const end = new DataView(tail.buffer, tail.byteOffset + at, END_RECORD);
  if (end.getUint32(0, true) !== 0x06054b50) throw new Error("Konec archivu nemá záznam EOCD");
  const directorySize = end.getUint32(12, true);
  const directoryOffset = end.getUint32(16, true);
  const out = new Uint8Array(tail.length + 56 + 20);
  out.set(tail.subarray(0, at));
  const view = new DataView(out.buffer);
  view.setUint32(at, 0x06064b50, true);
  view.setBigUint64(at + 4, BigInt(44), true);
  view.setUint16(at + 12, 45, true);
  view.setUint16(at + 14, 45, true);
  view.setBigUint64(at + 24, BigInt(entries), true);
  view.setBigUint64(at + 32, BigInt(entries), true);
  view.setBigUint64(at + 40, BigInt(directorySize), true);
  view.setBigUint64(at + 48, BigInt(directoryOffset), true);
  const locator = at + 56;
  view.setUint32(locator, 0x07064b50, true);
  view.setBigUint64(locator + 8, BigInt(directoryOffset + directorySize), true);
  view.setUint32(locator + 16, 1, true);
  const record = locator + 20;
  out.set(tail.subarray(at), record);
  view.setUint16(record + 8, MAX_PLAIN_ENTRIES, true);
  view.setUint16(record + 10, MAX_PLAIN_ENTRIES, true);
  return out;
}

export type EntryStream = { push(chunk: Uint8Array | string): void; end(): void };

export type ZipFileWriter = {
  addStored(name: string, data: Uint8Array): void;
  addDeflated(name: string, data: Uint8Array | string): void;
  // Level 0 keeps the bytes as they are but, unlike a stored entry, ends itself: a streaming
  // reader rejects a stored entry with a data descriptor.
  deflatedEntry(name: string, level?: 0 | 6): EntryStream;
  close(): number;
  abort(): void;
};

// Synchronous end to end: fflate hands every compressed block straight to the open file, so
// nothing larger than one entry block is held in memory.
export function zipFileWriter(
  path: string,
  options: { mtime?: Date; limit?: number } = {},
): ZipFileWriter {
  const file = atomicFileWriter(path, options.limit);
  let failure: unknown = null;
  let entries = 0;
  const zip = new Zip((error, chunk, final) => {
    if (error) {
      failure = error;
      return;
    }
    file.write(final ? withZip64End(chunk, entries) : chunk);
  });
  const check = () => {
    if (failure) throw failure;
  };
  const stamp = <T extends ZipPassThrough | ZipDeflate>(entry: T): T => {
    if (options.mtime) entry.mtime = options.mtime;
    return entry;
  };
  const deflatedEntry = (name: string, level: 0 | 6 = 6): EntryStream => {
    const entry = stamp(new ZipDeflate(assertEntryPath(name), { level }));
    zip.add(entry);
    entries += 1;
    return {
      push(chunk) {
        entry.push(typeof chunk === "string" ? strToU8(chunk) : chunk, false);
        check();
      },
      end() {
        entry.push(new Uint8Array(0), true);
        check();
      },
    };
  };
  return {
    addStored(name, data) {
      const entry = stamp(new ZipPassThrough(assertEntryPath(name)));
      zip.add(entry);
      entries += 1;
      entry.push(data, true);
      check();
    },
    addDeflated(name, data) {
      const entry = deflatedEntry(name);
      entry.push(data);
      entry.end();
    },
    deflatedEntry,
    close() {
      zip.end();
      check();
      return file.close();
    },
    abort() {
      try {
        zip.terminate();
      } finally {
        file.abort();
      }
    },
  };
}
