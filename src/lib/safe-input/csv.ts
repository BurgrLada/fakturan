import { InputRejected, TABULAR_LIMITS, type TabularLimits } from "./limits";

export type CsvDelimiter = ";" | "," | "\t";
export type CsvEncoding = "utf-8" | "windows-1250";
export type CsvOptions = {
  delimiter?: CsvDelimiter;
  encoding?: CsvEncoding;
  limits?: TabularLimits;
};
export type CsvData = {
  headers: string[];
  rows: string[][];
  encoding: CsvEncoding;
  delimiter: CsvDelimiter;
};

const DELIMITERS: CsvDelimiter[] = [";", ",", "\t"];
const YIELD_EVERY = 64 * 1024;

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

// Fakturan's own exports prefix formula triggers with an apostrophe (EXP-008); only that is undone.
export function restoreNeutralized(value: string): string {
  return /^'[=+\-@\t\r]/.test(value) ? value.slice(1) : value;
}

const DECODE_CHUNK = 1024 * 1024;

// Decoded a block at a time, so the file never becomes one string: UTF-16 doubles every byte.
function encodingOf(bytes: Uint8Array, forced: CsvEncoding | undefined): CsvEncoding {
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) {
    throw new InputRejected("csv_encoding", undefined, "UTF-16");
  }
  if (forced) return forced;
  const probe = new TextDecoder("utf-8", { fatal: true });
  try {
    for (let at = 0; at < bytes.length; at += DECODE_CHUNK) {
      probe.decode(bytes.subarray(at, at + DECODE_CHUNK), { stream: true });
    }
    probe.decode();
    return "utf-8";
  } catch {
    return "windows-1250";
  }
}

function* decodedBlocks(bytes: Uint8Array, encoding: CsvEncoding): Generator<string> {
  const decoder = new TextDecoder(encoding);
  for (let at = 0; at < bytes.length; at += DECODE_CHUNK) {
    const block = decoder.decode(bytes.subarray(at, at + DECODE_CHUNK), { stream: true });
    if (block) yield block;
  }
  const tail = decoder.decode();
  if (tail) yield tail;
}

function firstLine(text: string): string {
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') quoted = !quoted;
    else if (!quoted && (char === "\n" || char === "\r")) return text.slice(0, i);
  }
  return text;
}

function detectDelimiter(text: string): CsvDelimiter {
  const line = firstLine(text).replace(/"[^"]*"/g, "");
  let best: CsvDelimiter = ";";
  let bestCount = 0;
  for (const delimiter of DELIMITERS) {
    const count = line.split(delimiter).length - 1;
    if (count > bestCount) {
      best = delimiter;
      bestCount = count;
    }
  }
  return best;
}

type Scanned = { encoding: CsvEncoding; delimiter: CsvDelimiter };

// RFC 4180 with any of CRLF, LF or CR as a record break; quoted fields keep their line breaks.
// Each record goes to `take` as soon as it ends, so a caller decides what of it to keep.
async function scanCsv(
  bytes: Uint8Array,
  options: CsvOptions,
  take: (record: string[]) => void,
  // Once it answers false for a column, that column's text is never built (it reads as "").
  wanted: (column: number) => boolean = () => true,
): Promise<Scanned> {
  const limits = options.limits ?? TABULAR_LIMITS;
  const encoding = encodingOf(bytes, options.encoding);
  const blocks = decodedBlocks(bytes, encoding);
  let next = blocks.next();
  // A header longer than one block is not a sheet anyone exports; its start decides the delimiter.
  const delimiter = options.delimiter ?? detectDelimiter(next.done ? "" : next.value);
  let records = 0;
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let fieldStarted = false;
  // Whether the field holds any character, kept or not: an empty line is told by this alone.
  let filled = false;
  let keep = wanted(0);
  let sinceYield = 0;

  const endField = () => {
    record.push(keep ? restoreNeutralized(field) : "");
    if (record.length > limits.maxColumns) throw new InputRejected("tabular_too_many_columns");
    field = "";
    fieldStarted = false;
    filled = false;
    keep = wanted(record.length);
  };
  const endRecord = () => {
    const empty = record.length === 0 && !filled;
    endField();
    if (empty) {
      record = [];
      keep = wanted(0);
      return;
    }
    records += 1;
    if (records > limits.maxRows) throw new InputRejected("tabular_too_many_rows");
    take(record);
    record = [];
    keep = wanted(0);
  };

  let carry = "";
  while (!next.done || carry) {
    const following = next.done ? next : blocks.next();
    const text = carry + (next.done ? "" : next.value);
    // A quote or a CR needs the character after it, so a block never ends on one: the trailing run
    // waits for the next block, which keeps a quote pair together.
    let end = text.length;
    if (!following.done) {
      while (end > 0 && (text[end - 1] === '"' || text[end - 1] === "\r")) end--;
    }
    carry = text.slice(end);
    for (let i = 0; i < end; i++) {
      if (++sinceYield >= YIELD_EVERY) {
        sinceYield = 0;
        await yieldToLoop();
      }
      const char = text[i]!;
      if (quoted) {
        if (char !== '"') {
          filled = true;
          if (keep) field += char;
        } else if (text[i + 1] === '"') {
          filled = true;
          if (keep) field += '"';
          i++;
        } else quoted = false;
        continue;
      }
      if (char === '"' && !fieldStarted) {
        quoted = true;
        fieldStarted = true;
      } else if (char === delimiter) endField();
      else if (char === "\r" || char === "\n") {
        if (char === "\r" && text[i + 1] === "\n") i++;
        endRecord();
      } else {
        filled = true;
        if (keep) field += char;
        fieldStarted = true;
      }
    }
    next = following;
  }
  if (quoted) throw new InputRejected("csv_malformed", undefined, "neuzavřená uvozovka");
  if (fieldStarted || record.length > 0) endRecord();
  return { encoding, delimiter };
}

export type CsvColumns = {
  headers: string[];
  columns: string[][];
  rows: number;
  encoding: CsvEncoding;
  delimiter: CsvDelimiter;
};
type Pick = (headers: string[]) => number[];

// With `pick` only the chosen columns stay, one array each, so a sheet of many columns is never
// held as rows; `headers` are then the picked ones.
export async function parseCsv(bytes: Uint8Array, options: CsvOptions): Promise<CsvData>;
export async function parseCsv(
  bytes: Uint8Array,
  options: CsvOptions & { pick: Pick },
): Promise<CsvColumns>;
export async function parseCsv(
  bytes: Uint8Array,
  options: CsvOptions & { pick?: Pick },
): Promise<CsvData | CsvColumns> {
  const { pick } = options;
  if (!pick) {
    const records: string[][] = [];
    const scanned = await scanCsv(bytes, options, (record) => records.push(record));
    const [headers = [], ...rows] = records;
    return { headers: headers.map((header) => header.trim()), rows, ...scanned };
  }
  let headers: string[] | null = null;
  let picked: number[] = [];
  let kept: Set<number> | null = null;
  let columns: string[][] = [];
  let rows = 0;
  const scanned = await scanCsv(
    bytes,
    options,
    (record) => {
      if (headers === null) {
        headers = record.map((header) => header.trim());
        picked = pick(headers);
        kept = new Set(picked);
        columns = picked.map(() => []);
        return;
      }
      picked.forEach((at, index) => columns[index]!.push(record[at] ?? ""));
      rows += 1;
    },
    (column) => kept === null || kept.has(column),
  );
  const all: string[] = headers ?? [];
  return { headers: picked.map((at) => all[at]!), columns, rows, ...scanned };
}

export type CsvSample = { headers: string[]; rows: string[][]; total: number };

const isBlank = (cells: string[]) => cells.every((cell) => cell.trim() === "");

// The mapping step needs the header, the first rows and how many rows there are, not the sheet.
export async function sampleCsv(
  bytes: Uint8Array,
  rows: number,
  options: CsvOptions = {},
): Promise<CsvSample> {
  let headers: string[] | null = null;
  const kept: string[][] = [];
  let total = 0;
  await scanCsv(bytes, options, (record) => {
    if (headers === null) {
      headers = record.map((header) => header.trim());
      return;
    }
    if (kept.length < rows) kept.push(record);
    if (!isBlank(record)) total += 1;
  });
  return { headers: headers ?? [], rows: kept, total };
}
