import { strFromU8, Unzip, UnzipInflate, UnzipPassThrough, type UnzipFile } from "fflate";
import { type ContentKind, InputRejected, sniffContent, type ZipLimits } from "./limits";

export type ZipEntry = { name: string; bytes: Uint8Array; kind: ContentKind };
export type ZipWarning = { code: "nested_archive"; entry: string };
export type ZipSummary<T> = {
  entries: { name: string; size: number }[];
  results: T[];
  warnings: ZipWarning[];
  totalBytes: number;
};

const LOCAL_HEADER = 0x04034b50;
const FLAG_ENCRYPTED = 0x1;
const FLAG_DESCRIPTOR = 0x8;
const FLAG_UTF8 = 0x800;
const SUPPORTED_METHODS = new Set([0, 8]);
const SNIFF_BYTES = 1024;
const NESTED_NAME = /\.(zip|isdocx)$/i;
// fflate needs the whole local header in one buffer: 30 bytes plus a name and extra field of up to 64 KiB each.
const HEADER_WINDOW = 30 + 2 * 65_535;

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

async function* chunked(
  source: Uint8Array | AsyncIterable<Uint8Array>,
  size: number,
): AsyncGenerator<Uint8Array> {
  if (source instanceof Uint8Array) {
    for (let offset = 0; offset < source.length; offset += size) {
      yield source.subarray(offset, offset + size);
    }
    return;
  }
  for await (const piece of source) {
    for (let offset = 0; offset < piece.length; offset += size) {
      yield piece.subarray(offset, offset + size);
    }
  }
}

function u16(bytes: Uint8Array, at: number): number {
  return bytes[at]! | (bytes[at + 1]! << 8);
}

function u32(bytes: Uint8Array, at: number): number {
  return (u16(bytes, at) | (u16(bytes, at + 2) << 16)) >>> 0;
}

// fflate hides the general-purpose flags, so the header fflate has just parsed is found again in
// the recent input: first where the previous entry's sizes say it starts, else by signature and
// decoded name, the same way fflate locates it.
class HeaderTracker {
  private chunks: Uint8Array[] = [];
  private start = 0;
  private length = 0;
  private view: Uint8Array | null = null;
  private cursor = 0;
  private expected = -1;

  append(chunk: Uint8Array): void {
    this.chunks.push(chunk);
    this.length += chunk.length;
    this.view = null;
    while (this.chunks.length > 1) {
      const head = this.chunks[0]!;
      const spare = this.length - head.length >= HEADER_WINDOW + chunk.length;
      if (!spare && this.start + head.length > this.cursor) break;
      this.chunks.shift();
      this.start += head.length;
      this.length -= head.length;
    }
  }

  private bytes(): Uint8Array {
    if (this.view) return this.view;
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    this.view = out;
    return out;
  }

  private headerAt(bytes: Uint8Array, i: number, name: string): number | null {
    if (i < 0 || i + 30 > bytes.length || u32(bytes, i) !== LOCAL_HEADER) return null;
    const flags = u16(bytes, i + 6);
    const nameLength = u16(bytes, i + 26);
    if (i + 30 + nameLength > bytes.length) return null;
    const decoded = strFromU8(bytes.subarray(i + 30, i + 30 + nameLength), !(flags & FLAG_UTF8));
    if (decoded !== name) return null;
    const compressed = u32(bytes, i + 18);
    const dataStart = this.start + i + 30 + nameLength + u16(bytes, i + 28);
    this.cursor = this.start + i + 30 + nameLength;
    this.expected =
      flags & FLAG_DESCRIPTOR || compressed === 0xffffffff ? -1 : dataStart + compressed;
    return flags;
  }

  flagsFor(name: string): number | null {
    const bytes = this.bytes();
    if (this.expected >= this.start) {
      const flags = this.headerAt(bytes, this.expected - this.start, name);
      if (flags !== null) return flags;
    }
    for (let i = Math.max(0, this.cursor - this.start); ; i++) {
      i = bytes.indexOf(0x50, i);
      if (i < 0) return null;
      const flags = this.headerAt(bytes, i, name);
      if (flags !== null) return flags;
    }
  }
}

type Pending = { name: string; bytes: Uint8Array };

export async function readZipEntries<T>(
  source: Uint8Array | AsyncIterable<Uint8Array>,
  limits: ZipLimits,
  onEntry: (entry: ZipEntry) => T | Promise<T>,
): Promise<ZipSummary<T>> {
  const summary: ZipSummary<T> = { entries: [], results: [], warnings: [], totalBytes: 0 };
  const tracker = new HeaderTracker();
  const ready: Pending[] = [];
  let failure: InputRejected | null = null;
  let inputBytes = 0;
  let fileCount = 0;
  let open = 0;
  let prefix: number[] = [];

  const fail = (error: InputRejected) => {
    failure ??= error;
  };

  const checkTotals = (name: string) => {
    if (summary.totalBytes > limits.maxTotalBytes)
      fail(new InputRejected("zip_total_too_large", name));
    else if (
      summary.totalBytes > limits.ratioGraceBytes &&
      summary.totalBytes > limits.maxRatio * inputBytes
    ) {
      fail(new InputRejected("zip_ratio", name));
    }
  };

  const unzip = new Unzip((file: UnzipFile) => {
    if (failure) return;
    const name = file.name;
    fileCount++;
    if (fileCount > limits.maxEntries) return fail(new InputRejected("zip_too_many_entries", name));
    const flags = tracker.flagsFor(name);
    if (flags === null) return fail(new InputRejected("zip_corrupt", name));
    if (flags & FLAG_ENCRYPTED) return fail(new InputRejected("zip_encrypted", name));
    if (!SUPPORTED_METHODS.has(file.compression))
      return fail(new InputRejected("zip_compression", name));
    // A stored entry with a data descriptor has no length: fflate ends it at the first local
    // header inside, so a stored archive would spill its entries into this one.
    if (file.compression === 0 && flags & FLAG_DESCRIPTOR) {
      return fail(new InputRejected("zip_corrupt", name, "uložená položka bez délky"));
    }

    const skip =
      name.endsWith("/") || NESTED_NAME.test(name) || (limits.select && !limits.select(name));
    const named = limits.maxBytesFor?.(name);
    const ceiling = named ?? Math.max(limits.maxEntryBytes, limits.maxPdfEntryBytes);
    // Skipped entries are never buffered; the archive total and ratio still bound them.
    if (!skip && file.originalSize !== undefined && file.originalSize > ceiling) {
      return fail(new InputRejected("zip_entry_too_large", name));
    }
    if (skip && NESTED_NAME.test(name))
      summary.warnings.push({ code: "nested_archive", entry: name });
    const parts: Uint8Array[] = [];
    let size = 0;
    // Until the first KiB says whether this is a PDF, the larger limit applies.
    let limit = ceiling;
    let decided = skip || named !== undefined;
    open++;
    file.ondata = (error, chunk, final) => {
      if (failure) return;
      if (error) return fail(new InputRejected("zip_corrupt", name, error.message));
      if (!decided && (size + chunk.length >= SNIFF_BYTES || final)) {
        decided = true;
        const head = new Uint8Array(Math.min(SNIFF_BYTES, size + chunk.length));
        let offset = 0;
        for (const part of [...parts, chunk]) {
          if (offset >= head.length) break;
          const piece = part.subarray(0, head.length - offset);
          head.set(piece, offset);
          offset += piece.length;
        }
        limit = sniffContent(head) === "pdf" ? limits.maxPdfEntryBytes : limits.maxEntryBytes;
      }
      size += chunk.length;
      summary.totalBytes += chunk.length;
      if (!skip && size > limit) return fail(new InputRejected("zip_entry_too_large", name));
      checkTotals(name);
      if (failure) return;
      if (!skip) parts.push(chunk);
      if (!final) return;
      open--;
      if (skip) return;
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const part of parts) {
        bytes.set(part, offset);
        offset += part.length;
      }
      ready.push({ name, bytes });
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  unzip.register(UnzipPassThrough);

  const drain = async () => {
    while (ready.length > 0 && !failure) {
      const { name, bytes } = ready.shift()!;
      const kind = sniffContent(bytes);
      if (kind === "zip") {
        summary.warnings.push({ code: "nested_archive", entry: name });
        continue;
      }
      summary.entries.push({ name, size: bytes.length });
      summary.results.push(await onEntry({ name, bytes, kind }));
    }
  };

  let finished = false;
  try {
    for await (const chunk of chunked(source, limits.chunkBytes)) {
      if (prefix.length < 4) {
        prefix = [...prefix, ...chunk.subarray(0, 4 - prefix.length)];
        if (prefix.length === 4 && sniffContent(new Uint8Array(prefix)) !== "zip") {
          throw new InputRejected("zip_corrupt");
        }
      }
      inputBytes += chunk.length;
      tracker.append(chunk);
      unzip.push(chunk, false);
      if (failure) throw failure;
      await drain();
      if (failure) throw failure;
      await yieldToLoop();
    }
    if (prefix.length < 4) throw new InputRejected("zip_corrupt");
    unzip.push(new Uint8Array(0), true);
    finished = true;
  } catch (error) {
    if (error instanceof InputRejected) throw error;
    throw new InputRejected("zip_corrupt", undefined, String(error));
  }
  if (failure) throw failure;
  if (finished && open > 0) throw new InputRejected("zip_corrupt");
  await drain();
  if (failure) throw failure;
  return summary;
}
