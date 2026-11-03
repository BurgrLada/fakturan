import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
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
});
