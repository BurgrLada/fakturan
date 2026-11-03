import { crc32, deflateRawSync, deflateSync } from "node:zlib";

const encoder = new TextEncoder();
export const ISDOC_NS = "http://isdoc.cz/namespace/2013";

export type RawEntry = {
  name: string;
  data: Uint8Array;
  method?: number;
  flags?: number;
  claimedSize?: number;
  descriptor?: boolean;
};

const UTF8_NAMES = 0x800;

function u16(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff];
}

function u32(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// A hand-rolled writer, so every header field (sizes, flags, method) can lie on purpose.
export function rawZip(entries: RawEntry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const method = entry.method ?? 8;
    const body = method === 8 ? new Uint8Array(deflateRawSync(entry.data)) : entry.data;
    const name = encoder.encode(entry.name);
    const flags = (entry.flags ?? 0) | UTF8_NAMES | (entry.descriptor ? 0x8 : 0);
    const crc = crc32(entry.data);
    const size = entry.claimedSize ?? entry.data.length;
    const sizes = entry.descriptor ? [0, 0, 0] : [crc, body.length, size];
    const local = new Uint8Array([
      ...u32(0x04034b50),
      ...u16(20),
      ...u16(flags),
      ...u16(method),
      ...u16(0),
      ...u16(0x21),
      ...sizes.flatMap(u32),
      ...u16(name.length),
      ...u16(0),
    ]);
    const descriptor = entry.descriptor
      ? new Uint8Array([...u32(0x08074b50), ...u32(crc), ...u32(body.length), ...u32(size)])
      : new Uint8Array(0);
    parts.push(local, name, body, descriptor);
    central.push(
      new Uint8Array([
        ...u32(0x02014b50),
        ...u16(20),
        ...u16(20),
        ...u16(flags),
        ...u16(method),
        ...u16(0),
        ...u16(0x21),
        ...u32(crc),
        ...u32(body.length),
        ...u32(size),
        ...u16(name.length),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u32(0),
        ...u32(offset),
      ]),
      name,
    );
    offset += local.length + name.length + body.length + descriptor.length;
  }
  const directory = concat(central);
  const end = new Uint8Array([
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(entries.length),
    ...u16(entries.length),
    ...u32(directory.length),
    ...u32(offset),
    ...u16(0),
  ]);
  return concat([...parts, directory, end]);
}

export function isdocXml(padding = 0): Uint8Array {
  const pad = padding > 0 ? `<!--${"x".repeat(padding)}-->` : "";
  return encoder.encode(
    `<?xml version="1.0" encoding="UTF-8"?>\n<Invoice xmlns="${ISDOC_NS}" version="6.0.2">${pad}<ID>2026-001</ID></Invoice>`,
  );
}

// Letters from a linear congruential generator: deflate gets them only to about 1.6:1.
export function noise(bytes: number, seed = 1): Uint8Array {
  const out = new Uint8Array(bytes);
  let state = seed;
  for (let i = 0; i < bytes; i++) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    out[i] = 97 + ((state >>> 16) % 26);
  }
  return out;
}

const MiB = 1024 * 1024;

export const hostile = {
  lyingHeaderBomb: () =>
    rawZip([{ name: "bomba.isdoc", data: new Uint8Array(64 * MiB), claimedSize: 100 }]),
  lyingHeaderNoise: () => rawZip([{ name: "velky.isdoc", data: noise(8 * MiB), claimedSize: 100 }]),
  trueHeaderBomb: () => rawZip([{ name: "bomba.isdoc", data: new Uint8Array(64 * MiB) }]),
  ratioBomb: () =>
    rawZip([
      { name: "dobra.isdoc", data: isdocXml() },
      { name: "nuly.csv", data: new Uint8Array(3 * MiB) },
    ]),
  pathEscape: () => rawZip([{ name: "../evil.isdoc", data: isdocXml() }]),
  absolutePath: () => rawZip([{ name: "/etc/evil.isdoc", data: isdocXml() }]),
  manyEntries: (count = 6000) =>
    rawZip(
      Array.from({ length: count }, (_, i) => ({
        name: `f${i}.isdoc`,
        data: encoder.encode("x"),
        method: 0,
      })),
    ),
  nestedZip: () =>
    rawZip([
      { name: "vnitrni.zip", data: rawZip([{ name: "a.isdoc", data: isdocXml() }]) },
      { name: "faktury.isdocx", data: rawZip([{ name: "b.isdoc", data: isdocXml() }]) },
      { name: "prevlek.xml", data: rawZip([{ name: "c.isdoc", data: isdocXml() }]), method: 0 },
      { name: "faktura.isdoc", data: isdocXml() },
    ]),
  encryptedFlag: () => rawZip([{ name: "tajna.isdoc", data: isdocXml(), method: 0, flags: 0x1 }]),
  unknownCompression: () => rawZip([{ name: "lzma.isdoc", data: isdocXml(), method: 14 }]),
};

export type PdfOptions = {
  compress?: boolean;
  filter?: string;
  encrypt?: boolean;
  indirectLength?: boolean;
  wrongLength?: boolean;
  extraFile?: Uint8Array;
};

function embeddedObject(id: number, data: Uint8Array, options: PdfOptions): Uint8Array[] {
  const body = options.compress === false ? data : new Uint8Array(deflateSync(data));
  const filter = options.filter ?? (options.compress === false ? "" : "/Filter /FlateDecode");
  const length = options.wrongLength ? body.length + 7 : body.length;
  const lengthRef = options.indirectLength ? `${id + 100} 0 R` : String(length);
  const head = `${id} 0 obj\n<< /Type /EmbeddedFile /Subtype /text#2Fxml /Length ${lengthRef} ${filter} /Params << /Size ${data.length} >> >>\nstream\n`;
  const tail = "\nendstream\nendobj\n";
  const lengthObj = options.indirectLength ? `${id + 100} 0 obj\n${length}\nendobj\n` : "";
  return [encoder.encode(head), body, encoder.encode(tail + lengthObj)];
}

export function pdfWithEmbedded(xml: Uint8Array, options: PdfOptions = {}): Uint8Array {
  const parts: Uint8Array[] = [
    encoder.encode(
      "%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R /Names << /EmbeddedFiles << /Names [(faktura.isdoc) 4 0 R] >> >> >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n",
    ),
  ];
  if (options.extraFile) parts.push(...embeddedObject(5, options.extraFile, {}));
  parts.push(...embeddedObject(3, xml, options));
  parts.push(
    encoder.encode(
      `4 0 obj\n<< /Type /Filespec /F (faktura.isdoc) /UF (faktura.isdoc) /EF << /F 3 0 R >> >>\nendobj\ntrailer\n<< /Root 1 0 R${options.encrypt ? " /Encrypt 9 0 R" : ""} >>\n%%EOF\n`,
    ),
  );
  return concat(parts);
}

export function pdfWithoutAttachment(): Uint8Array {
  return encoder.encode(
    "%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n",
  );
}

const SHEET_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

export function xlsxOf(sheetData: string, sharedStrings: string[] = []): Uint8Array {
  const shared = sharedStrings.map((s) => `<si><t>${s}</t></si>`).join("");
  return rawZip([
    {
      name: "[Content_Types].xml",
      data: encoder.encode(
        '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
      ),
    },
    {
      name: "xl/workbook.xml",
      data: encoder.encode(
        `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="${SHEET_NS}" xmlns:r="${REL_NS}"><sheets><sheet name="Data" sheetId="1" r:id="rId7"/><sheet name="Druhy" sheetId="2" r:id="rId8"/></sheets></workbook>`,
      ),
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: encoder.encode(
        '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId8" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/data.xml"/></Relationships>',
      ),
    },
    {
      name: "xl/sharedStrings.xml",
      data: encoder.encode(
        `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="${SHEET_NS}">${shared}</sst>`,
      ),
    },
    {
      name: "xl/worksheets/sheet1.xml",
      data: encoder.encode(
        `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${SHEET_NS}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>druhy list</t></is></c></row></sheetData></worksheet>`,
      ),
    },
    {
      name: "xl/worksheets/data.xml",
      data: encoder.encode(
        `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${SHEET_NS}"><sheetData>${sheetData}</sheetData></worksheet>`,
      ),
    },
  ]);
}

export function xlsxWithFormula(): Uint8Array {
  return xlsxOf(
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
      '<row r="2"><c r="A2" t="str"><f>HYPERLINK("http://utocnik.example","klik")</f><v>klik</v></c><c r="B2"><f>CMD|\' /C calc\'!A0</f><v>1234.5</v></c></row>',
    ["Název", "Částka"],
  );
}
