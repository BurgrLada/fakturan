import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { readZipEntries } from "@/lib/safe-input/zip";
import { atomicFileWriter, ExportTooLarge, zipFileWriter } from "@/server/files/zip-writer";

const folder = () => mkdtempSync(join(tmpdir(), "fakturan-zip-writer-"));

describe("zápis exportu", () => {
  test("[EXP-007] překročený strop vyhodí ExportTooLarge a po abort nic nezůstane", () => {
    const dir = folder();
    const path = join(dir, "vysledek");
    const zip = zipFileWriter(path, { limit: 2_000 });
    zip.addStored("a.bin", new Uint8Array(1_000));
    expect(() => zip.addStored("b.bin", new Uint8Array(1_500))).toThrow(ExportTooLarge);
    zip.abort();
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.part`)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);

    const plain = atomicFileWriter(join(dir, "csv"), 10);
    plain.write("12345");
    expect(() => plain.write("678901")).toThrow(ExportTooLarge);
    plain.abort();
    expect(readdirSync(dir)).toEqual([]);
  });

  test("rozepsaný soubor je jen .part a hotový se objeví až po close", () => {
    const dir = folder();
    const path = join(dir, "vysledek");
    const file = atomicFileWriter(path);
    file.write("data");
    expect(readdirSync(dir)).toEqual(["vysledek.part"]);
    expect(file.close()).toBe(4);
    expect(readdirSync(dir)).toEqual(["vysledek"]);
  });
});

describe("archiv s víc než 65 535 položkami", () => {
  test(
    "[EXP-006] konec archivu nese záznam ZIP64 s počtem položek",
    { timeout: 60_000 },
    async () => {
      const path = join(folder(), "velky.zip");
      const zip = zipFileWriter(path);
      const count = 70_000;
      // Level 0 like the blobs of a backup: the streaming reader refuses stored descriptor entries.
      for (let index = 0; index < count; index++) {
        const entry = zip.deflatedEntry(`f/${index}`, 0);
        entry.push(new Uint8Array([1]));
        entry.end();
      }
      zip.close();
      const bytes = new Uint8Array(readFileSync(path));
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
      const end = bytes.length - 22;
      expect(view.getUint32(end, true)).toBe(0x06054b50);
      expect(view.getUint16(end + 8, true)).toBe(0xffff);
      expect(view.getUint16(end + 10, true)).toBe(0xffff);
      const locator = end - 20;
      expect(view.getUint32(locator, true)).toBe(0x07064b50);
      const record = Number(view.getBigUint64(locator + 8, true));
      expect(record).toBe(end - 20 - 56);
      expect(view.getUint32(record, true)).toBe(0x06064b50);
      expect(view.getBigUint64(record + 32, true)).toBe(BigInt(count));
      const directorySize = view.getUint32(end + 12, true);
      const directoryOffset = view.getUint32(end + 16, true);
      expect(view.getBigUint64(record + 40, true)).toBe(BigInt(directorySize));
      expect(directoryOffset + directorySize).toBe(record);
      const read = await readZipEntries(
        bytes,
        {
          maxEntries: count,
          maxEntryBytes: 10,
          maxPdfEntryBytes: 10,
          maxTotalBytes: count,
          maxRatio: 200,
          ratioGraceBytes: 1024 * 1024,
          chunkBytes: 64 * 1024,
        },
        () => undefined,
      );
      expect(read.entries).toHaveLength(count);
    },
  );

  test("[EXP-006] archiv do 65 535 položek zůstává bez ZIP64", () => {
    const path = join(folder(), "maly.zip");
    const zip = zipFileWriter(path);
    zip.addStored("a", new Uint8Array([1]));
    zip.close();
    const bytes = readFileSync(path);
    expect(bytes.readUInt32LE(bytes.length - 22)).toBe(0x06054b50);
    expect(bytes.readUInt16LE(bytes.length - 22 + 10)).toBe(1);
    expect(bytes.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06]))).toBe(false);
  });
});
