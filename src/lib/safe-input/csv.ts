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

function decode(
  bytes: Uint8Array,
  forced: CsvEncoding | undefined,
): { text: string; encoding: CsvEncoding } {
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) {
    throw new InputRejected("csv_encoding", undefined, "UTF-16");
  }
  if (forced) return { text: new TextDecoder(forced).decode(bytes), encoding: forced };
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf-8" };
  } catch {
    return { text: new TextDecoder("windows-1250").decode(bytes), encoding: "windows-1250" };
  }
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

// RFC 4180 with any of CRLF, LF or CR as a record break; quoted fields keep their line breaks.
export async function parseCsv(bytes: Uint8Array, options: CsvOptions): Promise<CsvData> {
  const limits = options.limits ?? TABULAR_LIMITS;
  const { text, encoding } = decode(bytes, options.encoding);
  const delimiter = options.delimiter ?? detectDelimiter(text);
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let fieldStarted = false;
  let nextYield = YIELD_EVERY;

  const endField = () => {
    record.push(restoreNeutralized(field));
    if (record.length > limits.maxColumns) throw new InputRejected("tabular_too_many_columns");
    field = "";
    fieldStarted = false;
  };
  const endRecord = () => {
    endField();
    if (record.length === 1 && record[0] === "") {
      record = [];
      return;
    }
    records.push(record);
    if (records.length > limits.maxRows) throw new InputRejected("tabular_too_many_rows");
    record = [];
  };

  for (let i = 0; i < text.length; i++) {
    if (i >= nextYield) {
      nextYield += YIELD_EVERY;
      await yieldToLoop();
    }
    const char = text[i]!;
    if (quoted) {
      if (char !== '"') field += char;
      else if (text[i + 1] === '"') {
        field += '"';
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
      field += char;
      fieldStarted = true;
    }
  }
  if (quoted) throw new InputRejected("csv_malformed", undefined, "neuzavřená uvozovka");
  if (fieldStarted || record.length > 0) endRecord();

  const [headers = [], ...rows] = records;
  return { headers: headers.map((header) => header.trim()), rows, encoding, delimiter };
}
