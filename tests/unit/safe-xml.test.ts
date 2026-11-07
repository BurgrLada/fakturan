import { describe, expect, test } from "vitest";
import { InputRejected, XML_LIMITS } from "@/lib/safe-input/limits";
import { childText, children, firstChild, parseXml, walkXml, xmlRoot } from "@/lib/safe-input/xml";
import { ISDOC_NS } from "../helpers/hostile-files";

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text);

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(InputRejected);
    return (error as InputRejected).code;
  }
  throw new Error("nevyhozeno");
}

const LAUGHS =
  '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;"><!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">]><lolz>&lol3;</lolz>';

function message(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(InputRejected);
    return (error as InputRejected).message;
  }
  return "prošlo";
}

function nested(depth: number): string {
  return "<a>".repeat(depth) + "x" + "</a>".repeat(depth);
}

describe("bezpečné čtení XML", () => {
  test("[SEC-005] DOCTYPE s entitou je chyba dřív, než se cokoli rozvine", () => {
    const xxe =
      '<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><r>&x;</r>';
    expect(code(() => parseXml(bytes(xxe), XML_LIMITS))).toBe("xml_doctype");
    expect(code(() => parseXml(bytes("<!DOCTYPE html><r/>"), XML_LIMITS))).toBe("xml_doctype");
    expect(code(() => parseXml(bytes("<r><!-- <!ENTITY x 'y'> --></r>"), XML_LIMITS))).toBe(
      "xml_doctype",
    );
  });

  test("[SEC-005] miliarda smíchů i hloubka 33 jsou odmítnuté", () => {
    expect(code(() => parseXml(bytes(LAUGHS), XML_LIMITS))).toBe("xml_doctype");
    expect(code(() => parseXml(bytes("<r>&lol;</r>"), XML_LIMITS))).toBe("xml_entity");
    expect(code(() => parseXml(bytes(nested(33)), XML_LIMITS))).toBe("xml_depth");
    expect(parseXml(bytes(nested(32)), XML_LIMITS).name).toBe("a");
  });

  test("[SEC-005] XML v UTF-16 a neplatné UTF-8 jsou odmítnuté", () => {
    const utf16 = new Uint8Array([0xff, 0xfe, ...new Uint8Array(Buffer.from("<r/>", "utf16le"))]);
    expect(code(() => parseXml(utf16, XML_LIMITS))).toBe("xml_encoding");
    const noBom = new Uint8Array(Buffer.from("<r/>", "utf16le"));
    expect(code(() => parseXml(noBom, XML_LIMITS))).toBe("xml_encoding");
    expect(
      code(() =>
        parseXml(
          new Uint8Array([0x3c, 0x72, 0x3e, 0xc3, 0x28, 0x3c, 0x2f, 0x72, 0x3e]),
          XML_LIMITS,
        ),
      ),
    ).toBe("xml_encoding");
    const declared = '<?xml version="1.0" encoding="windows-1250"?><r/>';
    expect(code(() => parseXml(bytes(declared), XML_LIMITS))).toBe("xml_encoding");
    const ok = parseXml(bytes('﻿<?xml version="1.0" encoding="utf-8"?><r>Příliš</r>'), XML_LIMITS);
    expect(ok.text).toBe("Příliš");
  });

  test("[SEC-005] limity uzlů, textu a velikosti", () => {
    const many = "<r>" + "<a/>".repeat(200) + "</r>";
    expect(code(() => parseXml(bytes(many), { ...XML_LIMITS, maxNodes: 200 }))).toBe("xml_nodes");
    expect(parseXml(bytes(many), { ...XML_LIMITS, maxNodes: 201 }).children).toHaveLength(200);
    const long = `<r>${"ž".repeat(40 * 1024)}</r>`;
    expect(code(() => parseXml(bytes(long), XML_LIMITS))).toBe("xml_text");
    expect(code(() => parseXml(bytes("<r/>   "), { ...XML_LIMITS, maxBytes: 5 }))).toBe("xml_size");
  });

  test("poškozené XML je chyba", () => {
    expect(code(() => parseXml(bytes("<r><a></r>"), XML_LIMITS))).toBe("xml_malformed");
    expect(code(() => parseXml(bytes(""), XML_LIMITS))).toBe("xml_malformed");
    expect(code(() => parseXml(bytes("<r/><s/>"), XML_LIMITS))).toBe("xml_malformed");
  });

  test("strom nese jmenný prostor, atributy, text a CDATA", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="${ISDOC_NS}" version="6.0.2"><ID>1 &amp; 2</ID><Note><![CDATA[a<b]]></Note>
<Lines><Line><ID>1</ID></Line><Line><ID>2</ID></Line></Lines><x:Ext xmlns:x="urn:x">e</x:Ext></Invoice>`;
    const root = parseXml(bytes(xml), XML_LIMITS);
    expect(root).toMatchObject({ name: "Invoice", ns: ISDOC_NS, attributes: { version: "6.0.2" } });
    expect(childText(root, "ID")).toBe("1 & 2");
    expect(childText(root, "Note")).toBe("a<b");
    expect(children(firstChild(root, "Lines")!, "Line").map((l) => childText(l, "ID"))).toEqual([
      "1",
      "2",
    ]);
    expect(firstChild(root, "Ext")).toBeUndefined();
    expect(childText(root, "Chybi")).toBeUndefined();
    expect(xmlRoot(bytes(xml), XML_LIMITS)).toEqual({
      name: "Invoice",
      ns: ISDOC_NS,
      attributes: { version: "6.0.2" },
    });
  });

  test("[SEC-005] UTF-16 se pozná podle BOM i nulových bajtů, ostatní je kontrola UTF-8", () => {
    const raw = (...values: number[]) => new Uint8Array(values);
    const parse = (data: Uint8Array) => () => parseXml(data, XML_LIMITS);
    const utf16 = "xml_encoding: UTF-16";
    const utf8 = "xml_encoding: neplatné UTF-8";
    expect(message(parse(raw(0xff, 0xfe, 0x3c, 0x00)))).toBe(utf16);
    expect(message(parse(raw(0xfe, 0xff, 0x00, 0x3c)))).toBe(utf16);
    expect(message(parse(raw(0x00, 0x3c, 0x00, 0x72, 0x00, 0x2f, 0x00, 0x3e)))).toBe(utf16);
    expect(message(parse(raw(0x3c, 0x00, 0x72, 0x00, 0x2f, 0x00, 0x3e, 0x00)))).toBe(utf16);
    for (const pair of [
      [0xff, 0x3c],
      [0x3c, 0xfe],
      [0xfe, 0x3c],
      [0x3c, 0xff],
    ]) {
      expect(message(parse(raw(...pair, 0x72, 0x2f, 0x3e))), `${pair}`).toBe(utf8);
    }
    expect(code(parse(raw(0x00)))).toBe("xml_malformed");
  });

  test("[SEC-005] deklarace bez kódování i s utf8 projde, jiné kódování ne", () => {
    for (const declaration of ['version="1.0"', 'version="1.0" encoding="UTF8"']) {
      expect(parseXml(bytes(`<?xml ${declaration}?><r>a</r>`), XML_LIMITS).text).toBe("a");
    }
    expect(
      message(() => parseXml(bytes('<?xml version="1.0" encoding="latin2"?><r/>'), XML_LIMITS)),
    ).toBe("xml_encoding: latin2");
  });

  test("[SEC-005] text se měří v bajtech UTF-8 a limit platí včetně hranice", () => {
    const fits = (maxTextBytes: number, text: string) => {
      try {
        parseXml(bytes(`<r>${text}</r>`), { ...XML_LIMITS, maxTextBytes });
        return true;
      } catch {
        return false;
      }
    };
    for (const [text, size] of [
      ["abc", 3],
      ["\u0080\u0080\u0080", 6],
      ["\u07ff\u07ff", 4],
      ["\u0800\u0800", 6],
      ["€€", 6],
      ["😀😀", 8],
      ["\ufffd", 3],
      ["\ud800\udc00", 4],
      ["\udbff\udfff", 4],
    ] as const) {
      expect(fits(size, text), `${text} se vejde do ${size}`).toBe(true);
      expect(fits(size - 1, text), `${text} se nevejde do ${size - 1}`).toBe(false);
    }
    expect(parseXml(bytes("<r/>"), { ...XML_LIMITS, maxBytes: 4 }).name).toBe("r");
  });

  test("[SEC-005] atributy jmenných prostorů se vynechají, cizí atribut má klíč {uri}jméno", () => {
    const xml = `<r xmlns="${ISDOC_NS}" xmlns:x="urn:x" a="1" x:b="2"><ID>1</ID><x:ID>9</x:ID></r>`;
    const root = parseXml(bytes(xml), XML_LIMITS);
    expect(root.attributes).toEqual({ a: "1", "{urn:x}b": "2" });
    expect(children(root, "ID").map((node) => node.text)).toEqual(["1"]);
    expect(children(root, "ID", "urn:x").map((node) => node.text)).toEqual(["9"]);
    expect(children(root, "r")).toEqual([]);
  });

  test("[SEC-005] procházení snese návštěvníka bez metod a jeho chybu vrátí jako poškozené XML", () => {
    expect(() => walkXml(bytes("<r><a>x</a></r>"), XML_LIMITS, {})).not.toThrow();
    const failed = message(() =>
      walkXml(bytes("<r/>"), XML_LIMITS, {
        open: () => {
          throw new Error("návštěvník");
        },
      }),
    );
    expect(failed).toBe("xml_malformed: Error: návštěvník");
  });
});
