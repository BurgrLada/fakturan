const KiB = 1024;
const MiB = 1024 * KiB;

export type InputRejectedCode =
  | "zip_corrupt"
  | "zip_stored_descriptor"
  | "zip_too_many_entries"
  | "zip_entry_too_large"
  | "zip_total_too_large"
  | "zip_ratio"
  | "zip_encrypted"
  | "zip_compression"
  | "inflate_too_large"
  | "inflate_corrupt"
  | "xml_size"
  | "xml_encoding"
  | "xml_doctype"
  | "xml_entity"
  | "xml_depth"
  | "xml_nodes"
  | "xml_text"
  | "xml_malformed"
  | "csv_encoding"
  | "csv_malformed"
  | "tabular_too_many_rows"
  | "tabular_too_many_columns"
  | "xlsx_no_sheet"
  | "pdf_not_pdf"
  | "pdf_too_large"
  | "pdf_attachment_too_large"
  | "pdf_unreadable"
  | "decimal_invalid"
  | "decimal_overflow";

export class InputRejected extends Error {
  code: InputRejectedCode;
  // A label from the file itself, never a path: it may be "../x" or "/etc/x".
  entry: string | undefined;

  constructor(code: InputRejectedCode, entry?: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "InputRejected";
    this.code = code;
    this.entry = entry;
  }
}

export type ZipLimits = {
  maxEntries: number;
  maxEntryBytes: number;
  maxPdfEntryBytes: number;
  maxTotalBytes: number;
  maxRatio: number;
  ratioGraceBytes: number;
  chunkBytes: number;
  select?: (name: string) => boolean;
  // A limit by entry name; it replaces the PDF sniffing for archives whose layout is known.
  maxBytesFor?: (name: string) => number;
  // Hands every entry over, folders and nested archives included, for a reader that refuses any
  // entry it does not expect instead of skipping it.
  keepAll?: boolean;
};

export const ZIP_LIMITS: ZipLimits = {
  maxEntries: 5000,
  maxEntryBytes: 5 * MiB,
  maxPdfEntryBytes: 25 * MiB,
  maxTotalBytes: 200 * MiB,
  maxRatio: 200,
  ratioGraceBytes: 1 * MiB,
  chunkBytes: 4 * KiB,
};

export type XmlLimits = {
  maxBytes: number;
  maxDepth: number;
  maxNodes: number;
  maxTextBytes: number;
};

export const XML_LIMITS: XmlLimits = {
  maxBytes: 5 * MiB,
  maxDepth: 32,
  maxNodes: 200_000,
  maxTextBytes: 64 * KiB,
};

export type TabularLimits = {
  maxRows: number;
  maxColumns: number;
};

// maxRows counts every row a sheet or file carries, the header included.
export const TABULAR_LIMITS: TabularLimits = {
  maxRows: 50_000,
  maxColumns: 200,
};

export type PdfLimits = {
  maxBytes: number;
  maxAttachmentBytes: number;
};

export const PDF_LIMITS: PdfLimits = {
  maxBytes: 25 * MiB,
  maxAttachmentBytes: 5 * MiB,
};

export type ContentKind = "zip" | "pdf" | "xml" | "text" | "binary";

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d];

function startsWith(bytes: Uint8Array, prefix: number[], offset = 0): boolean {
  return prefix.every((byte, i) => bytes[offset + i] === byte);
}

// The type comes from the bytes; a file name is only a hint for the user.
export function sniffContent(bytes: Uint8Array): ContentKind {
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06])) {
    return "zip";
  }
  const head = bytes.subarray(0, 1024);
  for (let i = 0; i + PDF_MAGIC.length <= head.length; i++) {
    if (startsWith(head, PDF_MAGIC, i)) return "pdf";
  }
  let start = startsWith(bytes, [0xef, 0xbb, 0xbf]) ? 3 : 0;
  while (start < head.length && [0x09, 0x0a, 0x0d, 0x20].includes(head[start]!)) start++;
  if (head[start] === 0x3c) return "xml";
  if (startsWith(bytes, [0xff, 0xfe]) || startsWith(bytes, [0xfe, 0xff])) return "text";
  return head.includes(0) ? "binary" : "text";
}
