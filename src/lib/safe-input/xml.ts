import { SaxesParser } from "saxes";
import { InputRejected, type XmlLimits } from "./limits";

export type XmlNode = {
  name: string;
  ns: string;
  attributes: Record<string, string>;
  children: XmlNode[];
  text: string;
};

export type XmlVisitor = {
  open?: (name: string, ns: string, attributes: Record<string, string>) => void;
  close?: (name: string, ns: string) => void;
  text?: (text: string) => void;
};

const XMLNS = "http://www.w3.org/2000/xmlns/";

function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code >= 0xd800 && code <= 0xdfff ? 2 : 3;
  }
  return bytes;
}

function decode(bytes: Uint8Array, limits: XmlLimits): string {
  if (bytes.length > limits.maxBytes) throw new InputRejected("xml_size");
  const utf16 =
    (bytes[0] === 0xff && bytes[1] === 0xfe) ||
    (bytes[0] === 0xfe && bytes[1] === 0xff) ||
    bytes[0] === 0 ||
    bytes[1] === 0;
  if (utf16 && bytes.length > 1) throw new InputRejected("xml_encoding", undefined, "UTF-16");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new InputRejected("xml_encoding", undefined, "neplatné UTF-8");
  }
  // Rejected before parsing: an internal subset is never read, so nothing can be expanded.
  if (text.includes("<!DOCTYPE") || text.includes("<!ENTITY")) {
    throw new InputRejected("xml_doctype");
  }
  return text;
}

class StopWalk extends Error {}

export function walkXml(bytes: Uint8Array, limits: XmlLimits, visitor: XmlVisitor): void {
  const text = decode(bytes, limits);
  const parser = new SaxesParser({ xmlns: true, position: false });
  const textBytes: number[] = [];
  let nodes = 0;

  parser.on("xmldecl", (decl) => {
    const encoding = decl.encoding?.toLowerCase();
    if (encoding !== undefined && encoding !== "utf-8" && encoding !== "utf8") {
      throw new InputRejected("xml_encoding", undefined, decl.encoding);
    }
  });
  parser.on("doctype", () => {
    throw new InputRejected("xml_doctype");
  });
  parser.on("error", (error) => {
    const entity = /entity/.test(error.message);
    throw new InputRejected(entity ? "xml_entity" : "xml_malformed", undefined, error.message);
  });
  parser.on("opentag", (tag) => {
    nodes++;
    if (nodes > limits.maxNodes) throw new InputRejected("xml_nodes");
    if (textBytes.length + 1 > limits.maxDepth) throw new InputRejected("xml_depth");
    textBytes.push(0);
    const attributes: Record<string, string> = {};
    for (const attribute of Object.values(tag.attributes)) {
      if (attribute.uri === XMLNS || attribute.name === "xmlns") continue;
      // Prefixes are the file's choice, so namespaced attributes are keyed as {uri}local.
      attributes[attribute.uri ? `{${attribute.uri}}${attribute.local}` : attribute.local] =
        attribute.value;
    }
    visitor.open?.(tag.local, tag.uri, attributes);
  });
  const onText = (value: string) => {
    const depth = textBytes.length;
    if (depth === 0) return;
    textBytes[depth - 1]! += utf8Length(value);
    if (textBytes[depth - 1]! > limits.maxTextBytes) throw new InputRejected("xml_text");
    visitor.text?.(value);
  };
  parser.on("text", onText);
  parser.on("cdata", onText);
  parser.on("closetag", (tag) => {
    textBytes.pop();
    visitor.close?.(tag.local, tag.uri);
  });

  try {
    parser.write(text).close();
  } catch (error) {
    if (error instanceof StopWalk) return;
    if (error instanceof InputRejected) throw error;
    throw new InputRejected("xml_malformed", undefined, String(error));
  }
}

export function parseXml(bytes: Uint8Array, limits: XmlLimits): XmlNode {
  const stack: XmlNode[] = [];
  let root: XmlNode | undefined;
  walkXml(bytes, limits, {
    open(name, ns, attributes) {
      const node: XmlNode = { name, ns, attributes, children: [], text: "" };
      const parent = stack.at(-1);
      if (parent) parent.children.push(node);
      else root = node;
      stack.push(node);
    },
    text(value) {
      stack.at(-1)!.text += value;
    },
    close() {
      stack.pop();
    },
  });
  if (!root) throw new InputRejected("xml_malformed");
  return root;
}

export type XmlRoot = { name: string; ns: string; attributes: Record<string, string> };

// Only the root element is needed to tell an ISDOC from other XML, but the whole input is still
// decoded and screened for DOCTYPE first.
export function xmlRoot(bytes: Uint8Array, limits: XmlLimits): XmlRoot {
  let root: XmlRoot | undefined;
  walkXml(bytes, limits, {
    open(name, ns, attributes) {
      root = { name, ns, attributes };
      throw new StopWalk();
    },
  });
  if (!root) throw new InputRejected("xml_malformed");
  return root;
}

export function children(node: XmlNode, name: string, ns: string = node.ns): XmlNode[] {
  return node.children.filter((child) => child.name === name && child.ns === ns);
}

export function firstChild(node: XmlNode, name: string, ns: string = node.ns): XmlNode | undefined {
  return node.children.find((child) => child.name === name && child.ns === ns);
}

export function childText(node: XmlNode, name: string, ns: string = node.ns): string | undefined {
  return firstChild(node, name, ns)?.text;
}
