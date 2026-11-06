import { describe, expect, test } from "vitest";
import {
  applyMapping,
  defaultMapping,
  guessColumns,
  type Mapping,
  mappingSchema,
  missingColumns,
  readDate,
  readDecimal,
  rowsLabel,
} from "@/lib/import-mapping";
import { BUILTIN_PRESETS, fittingPreset } from "@/lib/import-presets";
import { TEXTS } from "@/lib/texts";

const M = TEXTS.importing.mapping;

const invoices = (columns: Record<string, string>, extra: Partial<Mapping> = {}): Mapping => ({
  target: "invoices",
  columns,
  dateFormat: "dmy",
  decimal: ",",
  currency: "CZK",
  source: "Tabulka",
  ...extra,
});

describe("mapování sloupců", () => {
  test("[IMP-001] schéma mapování chce povinné sloupce cíle a nezná cizí klíče", () => {
    expect(
      mappingSchema.safeParse({ ...defaultMapping("customers", []), columns: { name: "Název" } })
        .success,
    ).toBe(true);
    const missing = mappingSchema.safeParse(defaultMapping("customers", []));
    expect(missing.error?.issues[0]?.message).toBe(M.errors.required("Název"));
    const unknown = mappingSchema.safeParse({
      ...defaultMapping("catalog", []),
      columns: { name: "a", price: "b", password: "c" },
    });
    expect(unknown.error?.issues.map((issue) => issue.message)).toContain(M.errors.unknownField);
    const extraKey = mappingSchema.safeParse({ ...defaultMapping("catalog", []), rows: [] });
    expect(extraKey.success).toBe(false);
    const noPrice = mappingSchema.safeParse(
      invoices({ number: "Číslo", issueDate: "Datum", lineName: "Položka" }),
    );
    expect(noPrice.error?.issues.map((issue) => issue.message)).toContain(M.errors.linePrice);
    const noSource = mappingSchema.safeParse(
      invoices(
        { number: "Číslo", issueDate: "Datum", lineName: "Položka", lineTotal: "Cena" },
        { source: " " },
      ),
    );
    expect(noSource.error?.issues.map((issue) => issue.message)).toContain(M.errors.source);
  });

  test("[IMP-001] částky se čtou podle zvoleného oddělovače, nikdy přes float", () => {
    expect(readDecimal("1 234,50", 2, ",", "csv")).toBe(123_450);
    expect(readDecimal("1.234,50", 2, ",", "csv")).toBe(123_450);
    expect(readDecimal("1,234.50", 2, ".", "csv")).toBe(123_450);
    expect(readDecimal("-0,005", 2, ",", "csv")).toBe(-1);
    expect(readDecimal("0.30000000000000004", 2, ",", "xlsx")).toBe(30);
    expect(readDecimal("25,125", 6, ",", "csv")).toBe(25_125_000);
    expect(() => readDecimal("1.5", 2, ",", "csv")).toThrow();
    expect(() => readDecimal("12,34,5", 2, ",", "csv")).toThrow();
    expect(() => readDecimal("1e3", 2, ".", "csv")).toThrow();
  });

  test("[IMP-001] data podle formátu, z Excelu i jako pořadové číslo dne", () => {
    expect(readDate("5. 1. 2026", "dmy", "csv")).toBe("2026-01-05");
    expect(readDate("2026-02-16", "ymd", "csv")).toBe("2026-02-16");
    expect(readDate("2026-02-16T10:00:00", "ymd", "csv")).toBe("2026-02-16");
    expect(readDate("2/16/2026", "mdy", "csv")).toBe("2026-02-16");
    expect(readDate("46069", "dmy", "xlsx")).toBe("2026-02-16");
    expect(() => readDate("46069", "dmy", "csv")).toThrow();
    expect(() => readDate("31.2.2026", "dmy", "csv")).toThrow();
    expect(() => readDate("2026-02-16", "dmy", "csv")).toThrow();
  });

  test("[IMP-009] chybné datum uvede řádek, sloupec a hodnotu", () => {
    const sheet = {
      format: "csv" as const,
      headers: ["Číslo", "Vystaveno", "Položka", "Cena"],
      rows: [
        ["2026-1", "1.2.2026", "Konzultace", "100"],
        ["", "", "", ""],
        ["2026-2", "32.13.2026", "Konzultace", "1,5,0"],
        ["", "1.2.2026", "Konzultace", "10"],
      ],
    };
    const rows = applyMapping(
      sheet,
      invoices({ number: "Číslo", issueDate: "Vystaveno", lineName: "Položka", lineTotal: "Cena" }),
    );
    expect(rows.map((row) => row.line)).toEqual([2, 4, 5]);
    expect(rows[0]).toEqual({
      line: 2,
      values: {
        number: "2026-1",
        issueDate: "2026-02-01",
        lineName: "Konzultace",
        lineTotal: 10_000,
      },
      errors: [],
    });
    expect(rows[1]!.errors).toEqual([
      "Řádek 4, sloupec „Vystaveno“: neplatné datum „32.13.2026“",
      "Řádek 4, sloupec „Cena“: neplatné číslo „1,5,0“",
    ]);
    expect(rows[2]!.errors).toEqual([M.errors.missingValue(5, "Číslo")]);
  });

  test("[IMP-001] chybějící sloupec souboru se pozná a prázdný text zůstane prázdný", () => {
    const mapping = { ...defaultMapping("customers", []), columns: { name: "Název", ico: "IČ" } };
    expect(missingColumns(["Název", "Město"], mapping)).toEqual(["IČ"]);
    const rows = applyMapping({ format: "csv", headers: ["Název"], rows: [["Alfa"]] }, mapping);
    expect(rows[0]!.values).toEqual({ name: "Alfa", ico: "" });
  });

  test("[IMP-001] odhad sloupců podle záhlaví", () => {
    expect(guessColumns("customers", ["Název", "IČO", "E-mail", "Město", "Nic"])).toEqual({
      name: "Název",
      ico: "IČO",
      email: "E-mail",
      city: "Město",
    });
    expect(guessColumns("catalog", ["nazev", "Cena", "Jednotka"])).toEqual({
      name: "nazev",
      price: "Cena",
      unit: "Jednotka",
    });
  });

  test("[IMP-002] vestavěná předloha Fakturoidu sedí na záhlaví jeho exportu kontaktů", () => {
    const header =
      "name,street,city,zip,country,registration_no,vat_no,bank_account,iban,web,variable_symbol,full_name,phone,email,email_copy,private_note,type,due,currency,language".split(
        ",",
      );
    const preset = fittingPreset(header, BUILTIN_PRESETS);
    expect(preset?.id).toBe("builtin:fakturoid-kontakty");
    expect(mappingSchema.parse(preset!.mapping)).toEqual(preset!.mapping);
    expect(fittingPreset(["Název"], BUILTIN_PRESETS)).toBeNull();
  });

  test("popis řádků zkrátí dlouhý výčet", () => {
    expect(rowsLabel([3])).toBe("Řádek 3");
    expect(rowsLabel([3, 4])).toBe("Řádky 3, 4");
    expect(rowsLabel([1, 2, 3, 4, 5, 6])).toBe("Řádky 1, 2, 3, 4, 5, …");
  });
});
