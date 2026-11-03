import { boundedInflate } from "./inflate";
import { InputRejected, type PdfLimits, sniffContent, XML_LIMITS } from "./limits";
import { xmlRoot } from "./xml";

export const ISDOC_NAMESPACE = "http://isdoc.cz/namespace/2013";

const EMBEDDED_FILE = /\/Type\s*\/EmbeddedFile(?![A-Za-z0-9#])/g;
const MAX_CANDIDATES = 100;
const DICT_SCAN = 64 * 1024;

function enclosingDictStart(text: string, from: number): number {
  let depth = 0;
  for (let i = from - 1; i > 0 && i > from - DICT_SCAN; i--) {
    if (text[i] === "<" && text[i - 1] === "<") {
      if (depth === 0) return i - 1;
      depth--;
      i--;
    } else if (text[i] === ">" && text[i - 1] === ">") {
      depth++;
      i--;
    }
  }
  return -1;
}

function dictEnd(text: string, start: number): number {
  let depth = 0;
  for (let i = start; i < text.length - 1 && i < start + DICT_SCAN; i++) {
    if (text[i] === "<" && text[i + 1] === "<") {
      depth++;
      i++;
    } else if (text[i] === ">" && text[i + 1] === ">") {
      depth--;
      i++;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

// Keeps the outer level only, so /Length or /Filter of a nested /Params dictionary never count.
function topLevel(dict: string): string {
  let out = "";
  let depth = 0;
  for (let i = 0; i < dict.length; i++) {
    if (dict.startsWith("<<", i)) {
      depth++;
      i++;
      if (depth === 1) out += " ";
      continue;
    }
    if (dict.startsWith(">>", i)) {
      depth--;
      i++;
      continue;
    }
    if (depth === 1) out += dict[i];
  }
  return out;
}

function filters(dict: string): string[] | null {
  const match = /\/Filter\s*(\/[A-Za-z0-9]+|\[[^\]]*\])/.exec(dict);
  if (!match) return /\/Filter\b/.test(dict) ? null : [];
  return [...match[1]!.matchAll(/\/([A-Za-z0-9]+)/g)].map((m) => m[1]!);
}

function resolveLength(text: string, dict: string): number | null {
  const match = /\/Length\s+(\d+)(?:\s+(\d+)\s+R)?/.exec(dict);
  if (!match) return null;
  if (match[2] === undefined) return Number(match[1]);
  const object = new RegExp(
    `(?:^|[^0-9])${match[1]}\\s+${match[2]}\\s+obj\\s*(\\d+)\\s*endobj`,
  ).exec(text);
  return object ? Number(object[1]) : null;
}

function streamBody(
  text: string,
  bytes: Uint8Array,
  afterDict: number,
  length: number | null,
): Uint8Array | null {
  const keyword = /^[\0\t\n\f\r ]*stream(\r\n|\n|\r)/.exec(text.slice(afterDict, afterDict + 64));
  if (!keyword) return null;
  const start = afterDict + keyword[0].length;
  if (
    length !== null &&
    /^[\0\t\n\f\r ]*endstream/.test(text.slice(start + length, start + length + 64))
  ) {
    return bytes.subarray(start, start + length);
  }
  const end = text.indexOf("endstream", start);
  if (end < 0) return null;
  let stop = end;
  if (text[stop - 1] === "\n") stop--;
  if (text[stop - 1] === "\r") stop--;
  return bytes.subarray(start, stop);
}

function isIsdoc(content: Uint8Array): boolean {
  if (sniffContent(content) !== "xml") return false;
  const root = xmlRoot(content, XML_LIMITS);
  return root.name === "Invoice" && root.ns === ISDOC_NAMESPACE;
}

// The stream of an embedded file cannot live inside an object stream, so its dictionary is plain
// text in the file and a scan finds it without a PDF library that would inflate without limits.
export function extractEmbeddedXml(bytes: Uint8Array, limits: PdfLimits): Uint8Array | null {
  if (bytes.length > limits.maxBytes) throw new InputRejected("pdf_too_large");
  if (sniffContent(bytes) !== "pdf") throw new InputRejected("pdf_not_pdf");
  const text = new TextDecoder("latin1").decode(bytes);
  if (/\/Encrypt(?![A-Za-z0-9])/.test(text))
    throw new InputRejected("pdf_unreadable", undefined, "šifrované PDF");

  let problem: InputRejected | null = null;
  let candidates = 0;
  for (const match of text.matchAll(EMBEDDED_FILE)) {
    if (++candidates > MAX_CANDIDATES) break;
    const start = enclosingDictStart(text, match.index);
    const end = start < 0 ? -1 : dictEnd(text, start);
    if (end < 0) continue;
    const dict = topLevel(text.slice(start, end));
    const chain = filters(dict);
    if (
      chain === null ||
      chain.some((f) => f !== "FlateDecode") ||
      chain.length > 1 ||
      /\/DecodeParms/.test(dict)
    ) {
      problem ??= new InputRejected("pdf_unreadable", undefined, "nepodporovaný filtr");
      continue;
    }
    const body = streamBody(text, bytes, end, resolveLength(text, dict));
    if (!body) {
      problem ??= new InputRejected("pdf_unreadable", undefined, "poškozený proud");
      continue;
    }
    let content: Uint8Array;
    try {
      if (body.length > limits.maxAttachmentBytes) throw new InputRejected("inflate_too_large");
      content = chain.length === 0 ? body : boundedInflate(body, limits.maxAttachmentBytes);
    } catch (error) {
      if (!(error instanceof InputRejected)) throw error;
      problem ??=
        error.code === "inflate_too_large"
          ? new InputRejected("pdf_attachment_too_large")
          : new InputRejected("pdf_unreadable", undefined, error.code);
      continue;
    }
    if (isIsdoc(content)) return content;
  }
  if (problem) throw problem;
  return null;
}
