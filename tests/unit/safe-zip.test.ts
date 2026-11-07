import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TEXTS } from "@/lib/texts";
import { describe, expect, test, vi } from "vitest";
import { Inflate } from "fflate";
import { boundedInflate } from "@/lib/safe-input/inflate";
import { InputRejected, ZIP_LIMITS, type ZipLimits } from "@/lib/safe-input/limits";
import { readZipEntries, type ZipEntry } from "@/lib/safe-input/zip";
import { deflateRawSync, deflateSync } from "node:zlib";
import { hostile, isdocXml, noise, rawZip } from "../helpers/hostile-files";

const MiB = 1024 * 1024;

async function collect(
  source: Uint8Array | AsyncIterable<Uint8Array>,
  limits: ZipLimits = ZIP_LIMITS,
) {
  const seen: ZipEntry[] = [];
  const summary = await readZipEntries(source, limits, (entry) => {
    seen.push(entry);
    return entry.name;
  });
  return { seen, summary };
}

async function rejection(promise: Promise<unknown>): Promise<InputRejected> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(InputRejected);
  return error as InputRejected;
}

describe("bezpečné čtení ZIP", () => {
  test("[SEC-005] ZIP s lživou velikostí v hlavičce skončí na skutečném výstupu", async () => {
    const noisy = await rejection(collect(hostile.lyingHeaderNoise()));
    expect(noisy.code).toBe("zip_entry_too_large");
    expect(noisy.entry).toBe("velky.isdoc");

    const seen: string[] = [];
    const bomb = await rejection(
      readZipEntries(hostile.lyingHeaderBomb(), ZIP_LIMITS, (entry) => {
        seen.push(entry.name);
      }),
    );
    expect(["zip_ratio", "zip_entry_too_large"]).toContain(bomb.code);
    expect(seen).toEqual([]);
  });

  test("[SEC-005] bomba s pravou hlavičkou je odmítnutá podle hlavičky", async () => {
    const error = await rejection(collect(hostile.trueHeaderBomb()));
    expect(error.code).toBe("zip_entry_too_large");
    expect(error.entry).toBe("bomba.isdoc");
  });

  test("[SEC-005] poměr rozbalení nad 200:1 je odmítnutý a archiv nedá žádný výsledek", async () => {
    const results: unknown[] = [];
    const error = await rejection(
      readZipEntries(hostile.ratioBomb(), ZIP_LIMITS, (entry) => entry.name).then((s) =>
        results.push(s),
      ),
    );
    expect(error.code).toBe("zip_ratio");
    expect(error.entry).toBe("nuly.csv");
    expect(results).toEqual([]);
  });

  test("[SEC-005] malý soubor s velkým poměrem projde, poměr se měří až od 1 MiB výstupu", async () => {
    const zip = rawZip([{ name: "nuly.csv", data: new Uint8Array(512 * 1024) }]);
    const { summary } = await collect(zip);
    expect(summary.results).toEqual(["nuly.csv"]);
  });

  test("[SEC-005] položka ../evil.isdoc je jen popisek a nic se nezapíše", async () => {
    for (const [zip, name] of [
      [hostile.pathEscape(), "../evil.isdoc"],
      [hostile.absolutePath(), "/etc/evil.isdoc"],
    ] as const) {
      const { seen, summary } = await collect(zip);
      expect(seen.map((e) => e.name)).toEqual([name]);
      expect(new TextDecoder().decode(seen[0]!.bytes)).toContain("<Invoice");
      expect(summary.entries).toEqual([{ name, size: seen[0]!.bytes.length }]);
    }
    const dir = join("src", "lib", "safe-input");
    for (const file of [
      "zip.ts",
      "inflate.ts",
      "xml.ts",
      "csv.ts",
      "xlsx-reader.ts",
      "pdf-embedded.ts",
      "decimal.ts",
      "limits.ts",
    ]) {
      const source = readFileSync(join(dir, file), "utf8");
      expect(source, file).not.toMatch(/node:fs|from "fs"|server-only|from "@\//);
    }
  });

  test("[SEC-005] vnořený ZIP se nerozbalí a je v upozorněních", async () => {
    const { seen, summary } = await collect(hostile.nestedZip());
    expect(seen.map((e) => e.name)).toEqual(["faktura.isdoc"]);
    expect(summary.warnings).toEqual([
      { code: "nested_archive", entry: "vnitrni.zip" },
      { code: "nested_archive", entry: "faktury.isdocx" },
      { code: "nested_archive", entry: "prevlek.xml" },
    ]);
  });

  test("[SEC-005] uložený vnořený ZIP s datovým popisovačem neprojde do kořene", async () => {
    const error = await rejection(collect(hostile.nestedStoredDescriptor()));
    expect(error.code).toBe("zip_stored_descriptor");
    expect(error.entry).toBe("vnitrni.zip");
  });

  test("[SEC-005] uložená položka s descriptorem radí uložit archiv s kompresí", async () => {
    const zip = rawZip([{ name: "a.isdoc", data: isdocXml(100), method: 0, descriptor: true }]);
    const error = await rejection(collect(zip));
    expect(error.code).toBe("zip_stored_descriptor");
    expect(error.entry).toBe("a.isdoc");
    expect(TEXTS.importing.rejected.zip_stored_descriptor).toMatch(/s kompresí/);
    expect(TEXTS.importing.rejected.zip_corrupt).not.toMatch(/kompres/);
  });

  test("[SEC-005] limit PDF se pozná i z obsahu rozděleného do drobných bloků", async () => {
    const pdf = new Uint8Array(500).fill(0x20);
    pdf.set(new TextEncoder().encode("%PDF-1.7\n"));
    // 30 B header + 7 B name: with 3 B blocks the first data block carries only "%P".
    const zip = rawZip([{ name: "a12.pdf", data: pdf, method: 0 }]);
    const limits = { ...ZIP_LIMITS, chunkBytes: 3, maxEntryBytes: 100, maxPdfEntryBytes: 10_000 };
    const { seen } = await collect(zip, limits);
    expect(seen.map((e) => [e.name, e.kind, e.bytes.length])).toEqual([["a12.pdf", "pdf", 500]]);
  });

  test("[SEC-005] 6 000 položek je odmítnuto, 5 000 projde", async () => {
    const error = await rejection(collect(hostile.manyEntries(6000)));
    expect(error.code).toBe("zip_too_many_entries");
    const { summary } = await collect(hostile.manyEntries(5000));
    expect(summary.results).toHaveLength(5000);
  });

  test("[SEC-005] šifrovaná položka a neznámá komprese jsou chyba", async () => {
    const encrypted = await rejection(collect(hostile.encryptedFlag()));
    expect(encrypted.code).toBe("zip_encrypted");
    expect(encrypted.entry).toBe("tajna.isdoc");
    const unknown = await rejection(collect(hostile.unknownCompression()));
    expect(unknown.code).toBe("zip_compression");
  });

  test("[SEC-005] součet výstupu nad limit odmítne archiv", async () => {
    const zip = rawZip([
      { name: "a.csv", data: noise(600 * 1024, 1) },
      { name: "b.csv", data: noise(600 * 1024, 2) },
    ]);
    const error = await rejection(collect(zip, { ...ZIP_LIMITS, maxTotalBytes: MiB }));
    expect(error.code).toBe("zip_total_too_large");
    expect(error.entry).toBe("b.csv");
  });

  test("položky s datovým popisovačem a uložené položky se přečtou celé", async () => {
    const xml = isdocXml(10_000);
    const zip = rawZip([
      { name: "adresar/", data: new Uint8Array(0), method: 0 },
      { name: "a.isdoc", data: xml, descriptor: true },
      { name: "b.isdoc", data: xml, method: 0 },
      { name: "c.isdoc", data: xml },
    ]);
    const { seen, summary } = await collect(zip);
    expect(seen.map((e) => e.name)).toEqual(["a.isdoc", "b.isdoc", "c.isdoc"]);
    for (const entry of seen) expect(entry.bytes).toEqual(xml);
    expect(summary.totalBytes).toBe(3 * xml.length);
  });

  test("vstup po kouscích dává stejný výsledek jako celý soubor", async () => {
    const zip = rawZip([
      { name: "a.isdoc", data: isdocXml(50_000), descriptor: true },
      { name: "b.isdoc", data: isdocXml(3) },
    ]);
    async function* pieces() {
      for (let i = 0; i < zip.length; i += 1000) yield zip.subarray(i, i + 1000);
    }
    const whole = await collect(zip);
    const streamed = await collect(pieces());
    expect(streamed.seen).toEqual(whole.seen);
  });

  test("čtení po blocích pouští mezi bloky jiné úlohy", async () => {
    const zip = rawZip([{ name: "a.csv", data: noise(MiB), method: 0 }]);
    let ticks = 0;
    let running = true;
    const tick = () => {
      ticks++;
      if (running) setImmediate(tick);
    };
    setImmediate(tick);
    await collect(zip);
    running = false;
    expect(ticks).toBeGreaterThan(100);
  });

  test("výběr položek přeskočí ostatní bez bufferu", async () => {
    const zip = rawZip([
      { name: "a.isdoc", data: isdocXml() },
      { name: "b.pdf", data: isdocXml() },
    ]);
    const names: string[] = [];
    await readZipEntries(zip, { ...ZIP_LIMITS, select: (name) => name.endsWith(".isdoc") }, (e) => {
      names.push(e.name);
    });
    expect(names).toEqual(["a.isdoc"]);
  });

  test("soubor, který není ZIP, nebo useknutý archiv je chyba", async () => {
    expect((await rejection(collect(isdocXml()))).code).toBe("zip_corrupt");
    const zip = rawZip([{ name: "a.isdoc", data: isdocXml(20_000) }]);
    expect((await rejection(collect(zip.subarray(0, 200)))).code).toBe("zip_corrupt");
    const broken = rawZip([{ name: "a.isdoc", data: noise(100), method: 8 }]);
    broken.fill(0xff, 40, 60);
    expect((await rejection(collect(broken))).code).toBe("zip_corrupt");
  });

  test("prázdný archiv nemá položky", async () => {
    const { summary } = await collect(rawZip([]));
    expect(summary).toEqual({ entries: [], results: [], warnings: [], totalBytes: 0 });
  });

  test("obsah se pozná podle bajtů, ne podle přípony", async () => {
    const zip = rawZip([
      { name: "faktura.txt", data: isdocXml() },
      { name: "doklad.isdoc", data: new TextEncoder().encode("%PDF-1.7\n") },
    ]);
    const { seen } = await collect(zip);
    expect(seen.map((e) => e.kind)).toEqual(["xml", "pdf"]);
  });
});

describe("bezpečné čtení ZIP: hlavičky, bloky a meze", () => {
  const localHeader = (name: string, flags: number) => {
    const bytes = new TextEncoder().encode(name);
    const header = new Uint8Array(30 + bytes.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(6, flags, true);
    view.setUint16(26, bytes.length, true);
    header.set(bytes, 30);
    return header;
  };

  test("[SEC-005] hlavička se hledá tam, kde podle velikostí začíná, ne podvrh v datech", async () => {
    const decoy = new Uint8Array([...noise(40), ...localHeader("b.isdoc", 0x801), ...noise(40)]);
    const zip = rawZip([
      { name: "a.bin", data: decoy, method: 0 },
      { name: "b.isdoc", data: isdocXml() },
    ]);
    const { seen } = await collect(zip);
    expect(seen.map((e) => e.name)).toEqual(["a.bin", "b.isdoc"]);
  });

  test("[SEC-005] hlavička se najde i za další položkou, kde začátek nepadne na nulu", async () => {
    const decoy = new Uint8Array([...noise(40), ...localHeader("b.isdoc", 0x801), ...noise(40)]);
    const zip = rawZip([
      { name: "z.bin", data: noise(17), method: 0 },
      { name: "a.bin", data: decoy, method: 0 },
      { name: "b.isdoc", data: isdocXml() },
    ]);
    const { seen } = await collect(zip);
    expect(seen.map((e) => e.name)).toEqual(["z.bin", "a.bin", "b.isdoc"]);
  });

  test("[SEC-005] hlavička rozdělená mezi bloky za velkou položkou se najde", async () => {
    // a.bin's 35 B header plus its data put b.isdoc's header 10 B before a 4 KiB boundary.
    const zip = rawZip([
      { name: "a.bin", data: noise(50 * 4096 - 45), method: 0 },
      { name: "b.isdoc", data: isdocXml(), method: 0 },
    ]);
    const { seen } = await collect(zip, { ...ZIP_LIMITS, chunkBytes: 4096 });
    expect(seen.map((e) => e.name)).toEqual(["a.bin", "b.isdoc"]);
  });

  test("[SEC-005] jméno bez příznaku UTF-8 se čte jako CP437/latin1 stejně jako ve fflate", async () => {
    const zip = rawZip([{ name: "č.isdoc", data: isdocXml() }]);
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    view.setUint16(6, view.getUint16(6, true) & ~0x800, true);
    for (let i = 0; i + 4 <= zip.length; i++) {
      if (view.getUint32(i, true) === 0x02014b50) {
        view.setUint16(i + 8, view.getUint16(i + 8, true) & ~0x800, true);
      }
    }
    const { seen } = await collect(zip);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.name).not.toBe("č.isdoc");
  });

  test("[SEC-005] archiv přesně na limitu součtu a poměru projde", async () => {
    const data = new Uint8Array(300 * 1024);
    const zip = rawZip([{ name: "a.csv", data }]);
    const exact = { ...ZIP_LIMITS, maxTotalBytes: data.length, ratioGraceBytes: 0 };
    const ratio = Math.ceil(data.length / zip.length);
    const { summary } = await collect(zip, {
      ...exact,
      maxRatio: ratio,
      maxEntryBytes: data.length,
    });
    expect(summary.totalBytes).toBe(data.length);
    const over = await rejection(collect(zip, { ...exact, maxTotalBytes: data.length - 1 }));
    expect(over.code).toBe("zip_total_too_large");
    const ratioOver = await rejection(
      collect(zip, { ...exact, maxRatio: ratio - 1, maxEntryBytes: data.length }),
    );
    expect(ratioOver.code).toBe("zip_ratio");
    const grace = await collect(zip, {
      ...exact,
      maxRatio: 1,
      ratioGraceBytes: data.length,
      maxEntryBytes: data.length,
    });
    expect(grace.summary.totalBytes).toBe(data.length);
  });

  test("[SEC-005] položka přesně na limitu projde, o bajt větší ne", async () => {
    const data = noise(2000);
    const zip = rawZip([{ name: "a.csv", data }]);
    const limits = { ...ZIP_LIMITS, maxEntryBytes: 2000, maxPdfEntryBytes: 2000 };
    expect((await collect(zip, limits)).seen).toHaveLength(1);
    const error = await rejection(
      collect(zip, { ...limits, maxEntryBytes: 1999, maxPdfEntryBytes: 1999 }),
    );
    expect(error.code).toBe("zip_entry_too_large");
    expect(error.entry).toBe("a.csv");
  });

  test("[SEC-005] limit podle jména nahradí odhad podle obsahu", async () => {
    const data = noise(3000);
    const zip = rawZip([{ name: "data/a.jsonl", data }]);
    const limits = { ...ZIP_LIMITS, maxEntryBytes: 100, maxPdfEntryBytes: 100 };
    const named = await collect(zip, { ...limits, maxBytesFor: () => 3000 });
    expect(named.seen.map((e) => e.bytes.length)).toEqual([3000]);
    const error = await rejection(collect(zip, { ...limits, maxBytesFor: () => 2999 }));
    expect(error.code).toBe("zip_entry_too_large");
  });

  test("[SEC-005] přeskočená položka se lživou velikostí v hlavičce archiv neshodí", async () => {
    const zip = rawZip([
      { name: "velka.zip", data: noise(100), claimedSize: 10 * MiB },
      { name: "a.isdoc", data: isdocXml() },
    ]);
    const { seen, summary } = await collect(zip, {
      ...ZIP_LIMITS,
      maxEntryBytes: MiB,
      maxPdfEntryBytes: MiB,
    });
    expect(seen.map((e) => e.name)).toEqual(["a.isdoc"]);
    expect(summary.warnings).toEqual([{ code: "nested_archive", entry: "velka.zip" }]);
    const claimed = rawZip([{ name: "a.isdoc", data: noise(100), claimedSize: 2001 }]);
    const limits = { ...ZIP_LIMITS, maxEntryBytes: 2000, maxPdfEntryBytes: 2000 };
    expect((await rejection(collect(claimed, limits))).code).toBe("zip_entry_too_large");
    const fits = rawZip([{ name: "a.isdoc", data: noise(100), claimedSize: 2000 }]);
    expect((await collect(fits, limits)).seen).toHaveLength(1);
  });

  test("[IMP-010] keepAll předá i složky a vnořené archivy, bez upozornění", async () => {
    const inner = rawZip([{ name: "x.txt", data: noise(10) }]);
    const zip = rawZip([
      { name: "files/", data: new Uint8Array(0), method: 0 },
      { name: "files/vnitrni.zip", data: inner },
    ]);
    const { seen, summary } = await collect(zip, { ...ZIP_LIMITS, keepAll: true });
    expect(seen.map((e) => [e.name, e.kind])).toEqual([
      ["files/", "text"],
      ["files/vnitrni.zip", "zip"],
    ]);
    expect(summary.warnings).toEqual([]);
  });

  test("[SEC-005] začátek, který není ZIP, se pozná i po blocích kratších než 4 bajty", async () => {
    const text = new TextEncoder().encode("toto není archiv, jen text");
    for (const chunkBytes of [1, 2, 3]) {
      const error = await rejection(collect(text, { ...ZIP_LIMITS, chunkBytes }));
      expect(error.code, `${chunkBytes}`).toBe("zip_corrupt");
    }
    const zip = rawZip([{ name: "a.isdoc", data: isdocXml() }]);
    expect((await collect(zip, { ...ZIP_LIMITS, chunkBytes: 3 })).seen).toHaveLength(1);
    expect((await rejection(collect(new Uint8Array(0)))).code).toBe("zip_corrupt");
    expect((await rejection(collect(new Uint8Array([0x50, 0x4b])))).code).toBe("zip_corrupt");
  });

  test("[SEC-005] za vnořený archiv se považuje jen jméno končící .zip nebo .isdocx", async () => {
    const zip = rawZip([{ name: "faktura.zip.isdoc", data: isdocXml() }]);
    const { seen, summary } = await collect(zip);
    expect(seen.map((e) => e.name)).toEqual(["faktura.zip.isdoc"]);
    expect(summary.warnings).toEqual([]);
  });

  test("[SEC-005] poškozená komprimovaná data položky nesou jméno položky", async () => {
    const zip = rawZip([{ name: "a.isdoc", data: noise(5000) }]);
    zip[30 + "a.isdoc".length] = 0xff;
    const error = await rejection(collect(zip));
    expect(error.code).toBe("zip_corrupt");
    expect(error.entry).toBe("a.isdoc");
  });

  test("[SEC-005] archiv useknutý uprostřed komprimované položky je poškozený", async () => {
    const zip = rawZip([{ name: "a.bin", data: noise(50_000) }]);
    const error = await rejection(collect(zip.subarray(0, 20_000)));
    expect(error.code).toBe("zip_corrupt");
  });

  test("[SEC-005] archiv useknutý uprostřed položky je poškozený", async () => {
    const zip = rawZip([{ name: "a.bin", data: noise(5000), method: 0 }]);
    const error = await rejection(collect(zip.subarray(0, 2000)));
    expect(error.code).toBe("zip_corrupt");
  });
});

describe("omezený inflate", () => {
  test("[SEC-005] zlib i raw deflate se rozbalí a nad limit je chyba", () => {
    const data = noise(100_000);
    expect(boundedInflate(new Uint8Array(deflateSync(data)), 100_000)).toEqual(data);
    expect(boundedInflate(new Uint8Array(deflateRawSync(data)), 100_000)).toEqual(data);
    const bomb = new Uint8Array(deflateSync(new Uint8Array(64 * MiB)));
    const error = (() => {
      try {
        boundedInflate(bomb, 5 * MiB);
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(InputRejected);
    expect((error as InputRejected).code).toBe("inflate_too_large");
  });

  test("poškozená data jsou chyba", () => {
    expect(() => boundedInflate(new Uint8Array([0x78, 0x9c, 0xff, 0xff, 0xff]), 100)).toThrow(
      InputRejected,
    );
  });

  test("[SEC-005] raw deflate, jehož první bajty připomínají zlib, se nerozbalí jako zlib", () => {
    // Stored blocks whose two first bytes break exactly one rule of a zlib header.
    const stored = (first: number, length: number) => [
      first,
      length & 0xff,
      length >> 8,
      ~length & 0xff,
      (~length >> 8) & 0xff,
      ...Array.from({ length }, (_, i) => 0x41 + (i % 26)),
    ];
    const last = [0x01, 0x00, 0x00, 0xff, 0xff];
    for (const [first, length] of [
      [0x01, 23],
      [0x88, 28],
      [0x08, 5],
      [0x08, 60],
    ] as const) {
      const block = stored(first, length);
      const data = new Uint8Array(first === 0x01 ? block : [...block, ...last]);
      expect(boundedInflate(data, 1000), `${first}/${length}`).toEqual(
        new Uint8Array(block.slice(5)),
      );
    }
  });

  test("[SEC-005] useknutý proud je poškozený, ne zkrácený výsledek", () => {
    const whole = new Uint8Array(deflateRawSync(noise(50_000)));
    let error: unknown;
    try {
      boundedInflate(whole.subarray(0, whole.length >> 1), 100_000);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(InputRejected);
    expect((error as InputRejected).code).toBe("inflate_corrupt");
    expect((error as InputRejected).message).toMatch(/^inflate_corrupt: \S/);
  });

  test("[SEC-005] bomba se čte po 4 KiB a čtení skončí hned za limitem", () => {
    const push = vi.spyOn(Inflate.prototype, "push");
    const bomb = new Uint8Array(deflateRawSync(new Uint8Array(64 * MiB)));
    try {
      expect(() => boundedInflate(bomb, 5 * MiB)).toThrow("inflate_too_large");
      expect(bomb.length).toBeGreaterThan(8 * 4096);
      expect(push.mock.calls.length).toBeLessThanOrEqual(3);
      for (const [chunk] of push.mock.calls) expect(chunk.length).toBeLessThanOrEqual(4096);
    } finally {
      push.mockRestore();
    }
  });

  test("[SEC-005] prázdný vstup je prázdný, useknutá hlavička je poškozená", () => {
    expect(boundedInflate(new Uint8Array(0), 100)).toEqual(new Uint8Array(0));
    expect(boundedInflate(new Uint8Array([0x78, 0x9c]), 100)).toEqual(new Uint8Array(0));
    expect(() => boundedInflate(new Uint8Array([0x78]), 100)).toThrow("inflate_corrupt");
  });
});
