import { describe, expect, test } from "vitest";
import { parseCsv, restoreNeutralized, sampleCsv } from "@/lib/safe-input/csv";
import { InputRejected, TABULAR_LIMITS } from "@/lib/safe-input/limits";

const encoder = new TextEncoder();

// "Číslo;Příjmení\r\n1;Žluťoučký kůň\r\n" in windows-1250, written out byte by byte.
const CP1250 = new Uint8Array([
  0xc8, 0xed, 0x73, 0x6c, 0x6f, 0x3b, 0x50, 0xf8, 0xed, 0x6a, 0x6d, 0x65, 0x6e, 0xed, 0x0d, 0x0a,
  0x31, 0x3b, 0x8e, 0x6c, 0x75, 0x9d, 0x6f, 0x75, 0xe8, 0x6b, 0xfd, 0x20, 0x6b, 0xf9, 0xf2, 0x0d,
  0x0a,
]);

async function rejected(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(InputRejected);
  return (error as InputRejected).code;
}

describe("čtení CSV", () => {
  test("windows-1250 s diakritikou a středníkem se přečte správně", async () => {
    const csv = await parseCsv(CP1250, {});
    expect(csv).toEqual({
      headers: ["Číslo", "Příjmení"],
      rows: [["1", "Žluťoučký kůň"]],
      encoding: "windows-1250",
      delimiter: ";",
    });
  });

  test("UTF-8 s BOM, čárkou a uvozovkami podle RFC 4180", async () => {
    const text = '﻿a,b,c\n"x, y","řádek\r\ndruhý","uvozovka ""uvnitř"""\n1,,3\n\n';
    const csv = await parseCsv(encoder.encode(text), {});
    expect(csv.encoding).toBe("utf-8");
    expect(csv.delimiter).toBe(",");
    expect(csv.headers).toEqual(["a", "b", "c"]);
    expect(csv.rows).toEqual([
      ["x, y", "řádek\r\ndruhý", 'uvozovka "uvnitř"'],
      ["1", "", "3"],
    ]);
  });

  test("tabulátor se pozná a zadaný oddělovač i kódování mají přednost", async () => {
    const tab = await parseCsv(encoder.encode("a\tb\n1\t2"), {});
    expect(tab.delimiter).toBe("\t");
    expect(tab.rows).toEqual([["1", "2"]]);
    const forced = await parseCsv(encoder.encode("a;b,c\n1;2,3"), { delimiter: "," });
    expect(forced.headers).toEqual(["a;b", "c"]);
    const cp = await parseCsv(encoder.encode("Č;x"), { encoding: "windows-1250" });
    expect(cp.headers).toEqual(["ÄŚ", "x"]);
  });

  test("[SEC-005] limit řádků a sloupců, UTF-16 a neuzavřená uvozovka", async () => {
    const rows = "a\n" + "1\n".repeat(11);
    expect(
      await rejected(
        parseCsv(encoder.encode(rows), { limits: { ...TABULAR_LIMITS, maxRows: 11 } }),
      ),
    ).toBe("tabular_too_many_rows");
    expect(
      (await parseCsv(encoder.encode(rows), { limits: { ...TABULAR_LIMITS, maxRows: 12 } })).rows,
    ).toHaveLength(11);
    const wide = Array.from({ length: 201 }, (_, i) => `s${i}`).join(";");
    expect(await rejected(parseCsv(encoder.encode(wide), {}))).toBe("tabular_too_many_columns");
    expect(await rejected(parseCsv(new Uint8Array([0xff, 0xfe, 0x61, 0x00]), {}))).toBe(
      "csv_encoding",
    );
    expect(await rejected(parseCsv(encoder.encode('a\n"neuzavřeno'), {}))).toBe("csv_malformed");
  });

  test("apostrof z vlastního exportu zmizí jen před znakem spouštěče", async () => {
    const csv = await parseCsv(encoder.encode("a;b;c\n'=SUM(A1);'-5;'jinak"), {});
    expect(csv.rows).toEqual([["=SUM(A1)", "-5", "'jinak"]]);
    expect(restoreNeutralized("'@x")).toBe("@x");
    expect(restoreNeutralized("x'=")).toBe("x'=");
  });

  test("prázdný soubor nemá hlavičky ani řádky", async () => {
    expect(await parseCsv(new Uint8Array(0), {})).toEqual({
      headers: [],
      rows: [],
      encoding: "utf-8",
      delimiter: ";",
    });
  });
});

describe("čtení CSV po blocích", () => {
  test("[IMP-001] uvozovky, CRLF a dvoubajtové znaky na hranici bloku 1 MiB se přečtou celé", async () => {
    const MiB = 1024 * 1024;
    const tail = '"a""b";č\r\n';
    const row = `${"x".repeat(100)};${tail}`;
    const rowBytes = encoder.encode(row).length;
    const tailBytes = encoder.encode(tail).length;
    const rest = encoder.encode(";druhý;třetí\r\n").length;
    // The header length puts the block edge right before each byte of the tail in turn.
    for (let at = 0; at <= tailBytes; at++) {
      const into = rowBytes - tailBytes + at;
      const length = (((MiB - into - rest) % rowBytes) + rowBytes) % rowBytes || rowBytes;
      const header = "h".repeat(length);
      const count = Math.ceil(MiB / rowBytes) + 2;
      const csv = await parseCsv(
        encoder.encode(`${header};druhý;třetí\r\n${row.repeat(count)}`),
        {},
      );
      expect(csv.headers).toEqual([header, "druhý", "třetí"]);
      expect(csv.rows).toHaveLength(count);
      expect(csv.rows.every((cells) => cells[1] === 'a"b' && cells[2] === "č")).toBe(true);
    }
  });

  test("[IMP-001] výběr sloupců a vzorek dají totéž co celé čtení", async () => {
    const bytes = encoder.encode('A;B;C\n1;x;"q;"\n\n;;\n2;y;z\n');
    const whole = await parseCsv(bytes, {});
    const picked = await parseCsv(bytes, { pick: () => [2, 0] });
    expect(picked).toMatchObject({
      headers: ["C", "A"],
      columns: [
        ["q;", "", "z"],
        ["1", "", "2"],
      ],
      rows: whole.rows.length,
    });
    expect(await sampleCsv(bytes, 2)).toEqual({
      headers: ["A", "B", "C"],
      rows: whole.rows.slice(0, 2),
      total: 2,
    });
  });
});
