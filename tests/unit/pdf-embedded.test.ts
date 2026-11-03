import { describe, expect, test } from "vitest";
import { InputRejected, PDF_LIMITS } from "@/lib/safe-input/limits";
import { extractEmbeddedXml } from "@/lib/safe-input/pdf-embedded";
import { isdocXml, pdfWithEmbedded, pdfWithoutAttachment } from "../helpers/hostile-files";

const MiB = 1024 * 1024;
const encoder = new TextEncoder();

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(InputRejected);
    return (error as InputRejected).code;
  }
  throw new Error("nevyhozeno");
}

describe("ISDOC vložený v PDF", () => {
  test("[SEC-005] PDF s proudem 6 MiB neprojde a ISDOC do 5 MiB ano", () => {
    const big = isdocXml(6 * MiB);
    expect(code(() => extractEmbeddedXml(pdfWithEmbedded(big), PDF_LIMITS))).toBe(
      "pdf_attachment_too_large",
    );
    const fits = isdocXml(5 * MiB - 200);
    expect(fits.length).toBeLessThanOrEqual(5 * MiB);
    const read = extractEmbeddedXml(pdfWithEmbedded(fits), PDF_LIMITS);
    // Deep equality over 5 MiB takes seconds; Buffer.equals compares natively.
    expect(read && Buffer.from(read).equals(fits)).toBe(true);
  });

  test("nekomprimovaný proud, nepřímá délka a špatná délka", () => {
    const xml = isdocXml();
    expect(extractEmbeddedXml(pdfWithEmbedded(xml, { compress: false }), PDF_LIMITS)).toEqual(xml);
    expect(extractEmbeddedXml(pdfWithEmbedded(xml, { indirectLength: true }), PDF_LIMITS)).toEqual(
      xml,
    );
    expect(
      extractEmbeddedXml(pdfWithEmbedded(xml, { compress: false, wrongLength: true }), PDF_LIMITS),
    ).toEqual(xml);
  });

  test("jiná příloha před ISDOC se přeskočí a PDF bez přílohy vrátí null", () => {
    const xml = isdocXml();
    const other = encoder.encode('<?xml version="1.0"?><Jine/>');
    expect(extractEmbeddedXml(pdfWithEmbedded(xml, { extraFile: other }), PDF_LIMITS)).toEqual(xml);
    expect(extractEmbeddedXml(pdfWithEmbedded(other), PDF_LIMITS)).toBeNull();
    expect(extractEmbeddedXml(pdfWithoutAttachment(), PDF_LIMITS)).toBeNull();
  });

  test("[SEC-005] jiná XML příloha s DOCTYPE se přeskočí a ISDOC se přečte", () => {
    const xml = isdocXml();
    const hostileXml = encoder.encode(
      '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><x>&a;</x>',
    );
    expect(extractEmbeddedXml(pdfWithEmbedded(xml, { extraFile: hostileXml }), PDF_LIMITS)).toEqual(
      xml,
    );
    expect(() => extractEmbeddedXml(pdfWithEmbedded(hostileXml), PDF_LIMITS)).toThrow(
      expect.objectContaining({ code: "pdf_unreadable" }),
    );
  });

  test("[SEC-005] šifrované PDF, jiný filtr, ne-PDF a příliš velký soubor jsou chyba", () => {
    const xml = isdocXml();
    expect(
      code(() => extractEmbeddedXml(pdfWithEmbedded(xml, { encrypt: true }), PDF_LIMITS)),
    ).toBe("pdf_unreadable");
    expect(
      code(() =>
        extractEmbeddedXml(
          pdfWithEmbedded(xml, { compress: false, filter: "/Filter /ASCIIHexDecode" }),
          PDF_LIMITS,
        ),
      ),
    ).toBe("pdf_unreadable");
    expect(code(() => extractEmbeddedXml(xml, PDF_LIMITS))).toBe("pdf_not_pdf");
    expect(
      code(() => extractEmbeddedXml(pdfWithoutAttachment(), { ...PDF_LIMITS, maxBytes: 50 })),
    ).toBe("pdf_too_large");
  });
});
