import { describe, expect, test } from "vitest";
import { InputRejected, XML_LIMITS } from "@/lib/safe-input/limits";
import { childText, children, firstChild, parseXml, xmlRoot } from "@/lib/safe-input/xml";
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
});
