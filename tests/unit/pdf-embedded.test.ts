import { describe, expect, test } from "vitest";
import { InputRejected, PDF_LIMITS } from "@/lib/safe-input/limits";
import { extractEmbeddedXml } from "@/lib/safe-input/pdf-embedded";
import { deflateSync } from "node:zlib";
import {
  ISDOC_NS,
  isdocXml,
  pdfWithEmbedded,
  pdfWithoutAttachment,
} from "../helpers/hostile-files";

const MiB = 1024 * 1024;
const encoder = new TextEncoder();

function message(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(InputRejected);
    return (error as InputRejected).message;
  }
  return "prošlo";
}

type Part = string | Uint8Array;
const bytesOf = (part: Part) => (typeof part === "string" ? encoder.encode(part) : part);
function pdfOf(...parts: Part[]): Uint8Array {
  const all = ["%PDF-1.7\n", ...parts, "trailer\n<< /Root 1 0 R >>\n%%EOF\n"].map(bytesOf);
  return new Uint8Array(all.flatMap((part) => [...part]));
}
// One attachment object; the dictionary text is written as given.
const attached = (dict: string, body: Uint8Array, eol = "\n", gap = "\n") => [
  `3 0 obj\n${dict}${gap}stream${eol}`,
  body,
  "\nendstream\nendobj\n",
];
// An ISDOC whose note holds the word endstream, so only /Length finds where the stream ends.
const tricky = encoder.encode(
  `<?xml version="1.0" encoding="UTF-8"?>\n<Invoice xmlns="${ISDOC_NS}"><Note>a endstream b</Note></Invoice>`,
);
const read = (pdf: Uint8Array) => extractEmbeddedXml(pdf, PDF_LIMITS);

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

  test("[SEC-005] proud končí podle /Length, i když data obsahují slovo endstream", () => {
    const length = tricky.length;
    expect(read(pdfOf(...attached(`<< /Type /EmbeddedFile /Length ${length} >>`, tricky)))).toEqual(
      tricky,
    );
    const indirect = pdfOf(
      ...attached("<< /Type /EmbeddedFile /Length 9 0 R >>", tricky),
      "19 0 obj\n5\nendobj\n",
      `9 0 obj\n${length}\nendobj\n`,
    );
    expect(read(indirect)).toEqual(tricky);
    const missing = pdfOf(...attached("<< /Type /EmbeddedFile /Length 8 0 R >>", tricky));
    const cut = new TextDecoder().decode(tricky).indexOf("endstream");
    expect(read(missing)).toEqual(tricky.subarray(0, cut));
  });

  test("[SEC-005] délka a filtr se čtou jen z vnějšího slovníku", () => {
    const xml = isdocXml();
    const dict = `<< /Type /EmbeddedFile /Params << /Length 3 /Filter /ASCIIHexDecode >> /Length ${tricky.length} >>`;
    expect(read(pdfOf(...attached(dict, tricky)))).toEqual(tricky);
    const nestedFirst = `<< /Params << /Size 1 >> /Type/EmbeddedFile /Length ${xml.length} >>`;
    expect(read(pdfOf(...attached(nestedFirst, xml)))).toEqual(xml);
  });

  test("[SEC-005] FlateDecode v poli projde, dva filtry, DecodeParms a nejasný filtr ne", () => {
    const xml = isdocXml();
    const packed = new Uint8Array(deflateSync(xml));
    const withFilter = (filter: string) =>
      pdfOf(...attached(`<< /Type /EmbeddedFile ${filter} /Length ${packed.length} >>`, packed));
    expect(read(withFilter("/Filter [/FlateDecode]"))).toEqual(xml);
    expect(read(withFilter("/Filter/FlateDecode"))).toEqual(xml);
    for (const filter of [
      "/Filter [/FlateDecode /FlateDecode]",
      "/Filter /FlateDecode /DecodeParms << /Predictor 12 >>",
      "/Filter 5 0 R",
      "/Filter [/ASCII85Decode]",
    ]) {
      expect(
        message(() => read(withFilter(filter))),
        filter,
      ).toBe("pdf_unreadable: nepodporovaný filtr");
    }
  });

  test("[SEC-005] klíčové slovo stream smí mít CRLF, CR i mezery, chybějící konec je poškozený proud", () => {
    const xml = isdocXml();
    const dict = `<< /Type /EmbeddedFile /Length ${xml.length} >>`;
    expect(read(pdfOf(...attached(dict, xml, "\r\n", " \r\n ")))).toEqual(xml);
    expect(read(pdfOf(...attached(dict, xml, "\r")))).toEqual(xml);
    const wrong = `<< /Type /EmbeddedFile /Length ${xml.length + 9} >>`;
    expect(read(pdfOf(`3 0 obj\n${wrong}\nstream\r\n`, xml, "\r\nendstream\nendobj\n"))).toEqual(
      xml,
    );
    expect(read(pdfOf(`3 0 obj\n${wrong}\nstream\n`, xml, "endstream\nendobj\n"))).toEqual(xml);
    expect(message(() => read(pdfOf(`3 0 obj\n${wrong}\nstream\n`, xml)))).toBe(
      "pdf_unreadable: poškozený proud",
    );
    expect(message(() => read(pdfOf(`3 0 obj\n${dict}\nxstream\n`, xml, "\nendstream\n")))).toBe(
      "pdf_unreadable: poškozený proud",
    );
  });

  test("[SEC-005] příloha přesně na limitu projde, o bajt větší ne", () => {
    const xml = isdocXml();
    const pdf = pdfOf(...attached(`<< /Type /EmbeddedFile /Length ${xml.length} >>`, xml));
    expect(extractEmbeddedXml(pdf, { ...PDF_LIMITS, maxAttachmentBytes: xml.length })).toEqual(xml);
    expect(
      code(() => extractEmbeddedXml(pdf, { ...PDF_LIMITS, maxAttachmentBytes: xml.length - 1 })),
    ).toBe("pdf_attachment_too_large");
    expect(extractEmbeddedXml(pdf, { ...PDF_LIMITS, maxBytes: pdf.length })).toEqual(xml);
    const broken = pdfOf(
      ...attached(
        `<< /Type /EmbeddedFile /Filter /FlateDecode /Length 4 >>`,
        encoder.encode("abcd"),
      ),
    );
    expect(message(() => read(broken))).toBe("pdf_unreadable: inflate_corrupt");
  });

  test("[TST-015] jen kořen Invoice ve jmenném prostoru ISDOC je faktura", () => {
    const one = (text: string) => {
      const body = encoder.encode(text);
      return read(pdfOf(...attached(`<< /Type /EmbeddedFile /Length ${body.length} >>`, body)));
    };
    expect(one(`<Invoice xmlns="urn:jiny"/>`)).toBeNull();
    expect(one(`<Faktura xmlns="${ISDOC_NS}"/>`)).toBeNull();
    expect(one("není XML")).toBeNull();
    expect(one(`<Invoice xmlns="${ISDOC_NS}"/>`)).not.toBeNull();
  });

  test("[SEC-005] hledání příloh má strop 100 kandidátů a /EncryptMetadata šifrování není", () => {
    const xml = isdocXml();
    const decoy = (i: number) =>
      `${10 + i} 0 obj\n<< /Type /EmbeddedFile /Length 3 >>\nstream\nabc\nendstream\nendobj\n`;
    const real = attached(`<< /Type /EmbeddedFile /Length ${xml.length} >>`, xml);
    const withDecoys = (count: number) =>
      pdfOf(...Array.from({ length: count }, (_, i) => decoy(i)), ...real);
    expect(read(withDecoys(99))).toEqual(xml);
    expect(read(withDecoys(100))).toBeNull();
    const meta = pdfOf("5 0 obj\n<< /EncryptMetadata false >>\nendobj\n", ...real);
    expect(read(meta)).toEqual(xml);
    expect(read(pdfOf("<< /Type /EmbeddedFiles >>\n"))).toBeNull();
  });

  test("[SEC-005] hexadecimální řetězce ve slovníku nemění jeho hranice", () => {
    const length = tricky.length;
    const dict = `<< /Desc <4142> /Type /EmbeddedFile /ID <43> /Length ${length} /Note <44> >>`;
    expect(read(pdfOf(...attached(dict, tricky)))).toEqual(tricky);
  });

  test("[SEC-005] /Length se bere z vlastního slovníku přílohy, ne z dřívějšího objektu", () => {
    const length = tricky.length;
    const pdf = pdfOf(
      "5 0 obj\n<< /Length 7 >>\nendobj\n",
      "/Type /EmbeddedFile mimo slovník\n",
      ...attached(`<< /Type /EmbeddedFile /Length ${length} >>`, tricky),
    );
    expect(read(pdf)).toEqual(tricky);
  });

  test("[SEC-005] zápisy /Length s více mezerami a generací nad 9 se přečtou", () => {
    const length = tricky.length;
    for (const [reference, object] of [
      [`${length}`, ""],
      [`  ${length}`, ""],
      ["9  0 R", `9 0 obj\n${length}\nendobj\n`],
      ["9 0  R", `9 0 obj\n${length}\nendobj\n`],
      ["9 12 R", `9 12 obj\n${length}\nendobj\n`],
    ]) {
      const pdf = pdfOf(
        ...attached(
          `<< /Type /EmbeddedFile /Length${reference.startsWith(" ") ? "" : " "}${reference} >>`,
          tricky,
        ),
        object,
      );
      expect(read(pdf), reference).toEqual(tricky);
    }
  });

  test("[SEC-005] bez /Length nebo s lživou délkou rozhodne první endstream", () => {
    const cut = tricky.subarray(0, new TextDecoder().decode(tricky).indexOf("endstream"));
    expect(read(pdfOf(...attached("<< /Type /EmbeddedFile >>", tricky)))).toEqual(cut);
    const short = `<< /Type /EmbeddedFile /Length ${tricky.length - 5} >>`;
    expect(read(pdfOf(...attached(short, tricky)))).toEqual(cut);
    const exact = `<< /Type /EmbeddedFile /Length ${tricky.length} >>`;
    expect(read(pdfOf(`3 0 obj\n${exact}\nstream\n`, tricky, "\r\n endstream\nendobj\n"))).toEqual(
      tricky,
    );
  });

  test("[SEC-005] značka mimo slovník ani neuzavřený slovník nejsou příloha", () => {
    expect(
      read(pdfOf("5 0 obj\n<< /Length 7 >>\nendobj\n", "/Type /EmbeddedFile mimo slovník\n")),
    ).toBeNull();
    expect(read(pdfOf("5 0 obj\n<< /Type /EmbeddedFile /Length 3\nendobj\n"))).toBeNull();
  });
});
