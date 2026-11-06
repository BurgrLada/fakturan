import "server-only";
import type { InvoiceDocument } from "@/lib/invoice-document";
import { XML_LIMITS } from "@/lib/safe-input/limits";
import { parseXml } from "@/lib/safe-input/xml";
import { db } from "../db";
import { fileNameFor } from "../pdf/file-name";
import { buildIsdoc, IsdocBuildError, type IsdocContext } from "../isdoc/build";
import { isdocRules } from "../isdoc/rules";
import { validateIsdoc } from "../isdoc/validate";
import type { Reader } from "./access";
import { loadInvoiceDocument } from "./invoice-document";
import { readOwned, type Invoice } from "./invoices";
import { getPreferences } from "./preferences";

// Raised for a document the client must not receive: the caller stops the whole export or message.
export class IsdocRejected extends Error {
  number: string;
  problem: string;
  built: boolean;

  constructor(number: string, problem: string, built: boolean) {
    super(`ISDOC dokladu ${number}: ${problem}`);
    this.name = "IsdocRejected";
    this.number = number;
    this.problem = problem;
    this.built = built;
  }
}

export type IsdocFile = { invoiceId: string; number: string; fileName: string; xml: Uint8Array };

const encoder = new TextEncoder();

const uuidOf = (row: Pick<Invoice, "id" | "importUuid">) => row.importUuid ?? row.id;

function contextOf(q: Reader, ownerId: string, row: Invoice): IsdocContext {
  const related = row.relatedInvoiceId ? readOwned(q, ownerId, row.relatedInvoiceId) : undefined;
  return {
    uuid: uuidOf(row),
    relatedUuid: related && row.type === "credit_note" ? uuidOf(related) : null,
    deposits:
      related?.type === "advance" && row.type === "invoice" && row.advanceMinor > 0
        ? [
            {
              number: related.number ?? "",
              variableSymbol: related.variableSymbol ?? "",
              amountMinor: row.advanceMinor,
            },
          ]
        : undefined,
  };
}

// The PDF name template decides the stem, so the PDF and the ISDOC of one document pair up.
export function isdocFileFor(
  ownerId: string,
  invoiceId: string,
  loaded?: InvoiceDocument,
): IsdocFile {
  const row = readOwned(db, ownerId, invoiceId);
  const doc = loaded ?? loadInvoiceDocument(ownerId, invoiceId);
  if (!row || !doc) throw new IsdocRejected("", "doklad neexistuje", false);
  const number = row.number ?? "";
  let xml: string;
  try {
    xml = buildIsdoc(doc, contextOf(db, ownerId, row));
  } catch (error) {
    if (error instanceof IsdocBuildError) throw new IsdocRejected(number, error.message, false);
    throw error;
  }
  const pdfName = fileNameFor(getPreferences(ownerId).pdfFileName, doc);
  return {
    invoiceId,
    number,
    fileName: pdfName.replace(/\.pdf$/i, ".isdoc"),
    xml: encoder.encode(xml),
  };
}

// Schema first, then the hand-written rules (R-3): either failing keeps the file from the client.
export async function assertValidIsdoc(files: IsdocFile[]): Promise<void> {
  const results = await validateIsdoc(files.map((item) => ({ name: item.number, xml: item.xml })));
  results.forEach((result, index) => {
    const item = files[index]!;
    if (result.errors.length > 0) throw new IsdocRejected(item.number, result.errors[0]!, true);
    const broken = isdocRules(parseXml(item.xml, XML_LIMITS));
    if (broken.length > 0) throw new IsdocRejected(item.number, broken[0]!, true);
  });
}
