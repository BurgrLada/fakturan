import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
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
