import "server-only";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { memoryPages, validateXML } from "xmllint-wasm";
import { InputRejected, XML_LIMITS } from "@/lib/safe-input/limits";
import { ISDOC_NAMESPACE } from "@/lib/safe-input/pdf-embedded";
import { walkXml, type XmlRoot } from "@/lib/safe-input/xml";
import { SUPPORTED_VERSIONS } from "./parse";

export type IsdocValidation = { name: string; version: string | null; errors: string[] };

type Version = (typeof SUPPORTED_VERSIONS)[number];

const BATCH_DOCUMENTS = 200;
const BATCH_BYTES = 32 * 1024 * 1024;
const MAX_ERRORS = 20;
// Read from process.cwd() at runtime; next.config.ts lists this folder for output tracing.
const SCHEMA_DIR = join(process.cwd(), "src/server/isdoc/schema");
const schemas = new Map<Version, string>();

function schema(version: Version): string {
  let text = schemas.get(version);
  if (!text) {
    text = readFileSync(join(SCHEMA_DIR, `isdoc-invoice-${version}.xsd`), "utf8");
    schemas.set(version, text);
  }
  return text;
}

type Pending = { index: number; bytes: Uint8Array };

function batches(items: Pending[]): Pending[][] {
  const out: Pending[][] = [];
  let current: Pending[] = [];
  let size = 0;
  for (const item of items) {
    if (
      current.length >= BATCH_DOCUMENTS ||
      (current.length > 0 && size + item.bytes.length > BATCH_BYTES)
    ) {
      out.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += item.bytes.length;
  }
  if (current.length > 0) out.push(current);
  return out;
}

// The safe parser screens every document before xmllint sees it: xmllint would try to resolve
// external entities, and only its in-memory file system stops it (R-4). Names from an archive never
// reach xmllint; each document gets a generated file name.
export async function validateIsdoc(
  docs: { name: string; xml: Uint8Array }[],
): Promise<IsdocValidation[]> {
  const results: IsdocValidation[] = docs.map((doc) => ({
    name: doc.name,
    version: null,
    errors: [],
  }));
  const byVersion = new Map<Version, Pending[]>();

  docs.forEach((doc, index) => {
    const result = results[index]!;
    let root: XmlRoot | undefined;
    try {
      // The whole document, not only its root, must pass the limits before xmllint sees it.
      walkXml(doc.xml, XML_LIMITS, {
        open(name, ns, attributes) {
          root ??= { name, ns, attributes };
        },
      });
    } catch (error) {
      if (!(error instanceof InputRejected)) throw error;
      result.errors.push(`Soubor není platné XML (${error.code})`);
      return;
    }
    if (!root) {
      result.errors.push("Soubor není platné XML (xml_malformed)");
      return;
    }
    const version = root.attributes.version ?? "";
    result.version = version || null;
    if (root.name !== "Invoice" || root.ns !== ISDOC_NAMESPACE) {
      result.errors.push("Soubor není faktura ISDOC");
    } else if (!(SUPPORTED_VERSIONS as readonly string[]).includes(version)) {
      result.errors.push(
        `Verze ISDOC ${version.slice(0, 20) || "bez označení"} není podporovaná, jen 6.0.1 a 6.0.2`,
      );
    } else {
      const list = byVersion.get(version as Version) ?? [];
      list.push({ index, bytes: doc.xml });
      byVersion.set(version as Version, list);
    }
  });

  for (const [version, pending] of byVersion) {
    for (const batch of batches(pending)) {
      const files = batch.map((item, i) => ({ fileName: `doc${i}.xml`, contents: item.bytes }));
      const size = batch.reduce((sum, item) => sum + item.bytes.length, 0);
      const outcome = await validateXML({
        xml: files,
        schema: { fileName: `isdoc-${version}.xsd`, contents: schema(version) },
        initialMemoryPages: memoryPages.defaultInitialMemoryPages,
        maxMemoryPages: Math.min(
          memoryPages.max,
          memoryPages.defaultMaxMemoryPages + Math.ceil((size * 8) / (64 * 1024)),
        ),
      });
      for (const error of outcome.errors) {
        const match = error.loc && /^doc(\d+)\.xml$/.exec(error.loc.fileName);
        const target = match ? batch[Number(match[1])] : undefined;
        if (!target) continue;
        const list = results[target.index]!.errors;
        if (list.length < MAX_ERRORS) list.push(`řádek ${error.loc!.lineNumber}: ${error.message}`);
      }
      if (!outcome.valid) {
        for (const item of batch) {
          const list = results[item.index]!.errors;
          if (
            list.length === 0 &&
            !outcome.rawOutput.includes(`doc${batch.indexOf(item)}.xml validates`)
          ) {
            list.push("Doklad neprošel schématem ISDOC");
          }
        }
      }
    }
  }
  return results;
}
