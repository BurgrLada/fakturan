import { describe, expect, test } from "vitest";
import {
  exportContents,
  exportFileName,
  exportInputSchema,
  FORMATS_BY_KIND,
} from "@/lib/export-filter";
import { TEXTS } from "@/lib/texts";

const E = TEXTS.exporting.errors;

const issues = (raw: unknown) => {
  const parsed = exportInputSchema.safeParse(raw);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
};

describe("zadání exportu", () => {
  test("[EXP-002] období, typ, zákazník a stav projdou, filtr je výchozí prázdný", () => {
    expect(
      exportInputSchema.parse({
        kind: "invoices",
        format: "csv",
        filter: {
          from: "2026-01-01",
          to: "2026-03-31",
          types: ["invoice", "credit_note"],
          customerId: "c-1",
          statuses: ["issued", "paid"],
        },
      }).filter,
    ).toEqual({
      from: "2026-01-01",
      to: "2026-03-31",
      types: ["invoice", "credit_note"],
      customerId: "c-1",
      statuses: ["issued", "paid"],
    });
    expect(exportInputSchema.parse({ kind: "customers", format: "xlsx" }).filter).toEqual({});
  });

  test("[EXP-002] neznámý klíč, koncept jako stav a obrácené období neprojdou", () => {
    expect(issues({ kind: "invoices", format: "csv", filter: { owner: "x" } })).not.toEqual([]);
    expect(issues({ kind: "invoices", format: "csv", extra: 1 })).not.toEqual([]);
    expect(issues({ kind: "invoices", format: "csv", filter: { statuses: ["draft"] } })).toEqual([
      E.invalid,
    ]);
    expect(
      issues({ kind: "invoices", format: "csv", filter: { from: "2026-02-01", to: "2026-01-01" } }),
    ).toEqual([E.period]);
    expect(issues({ kind: "invoices", format: "csv", filter: { from: "2026-02-30" } })).toEqual([
      E.date,
    ]);
  });

  test("[EXP-001] formát musí sedět k datům a filtr k druhu", () => {
    for (const [kind, formats] of Object.entries(FORMATS_BY_KIND)) {
      for (const format of formats)
        expect(issues({ kind, format }), `${kind} ${format}`).toEqual([]);
    }
    expect(issues({ kind: "customers", format: "pdf_zip" })).toEqual([E.format]);
    expect(issues({ kind: "templates", format: "csv" })).toEqual([E.format]);
    expect(issues({ kind: "customers", format: "csv", filter: { from: "2026-01-01" } })).toEqual([
      E.filter,
    ]);
    expect(issues({ kind: "payments", format: "csv", filter: { from: "2026-01-01" } })).toEqual([]);
    expect(issues({ kind: "payments", format: "csv", filter: { ids: ["a"] } })).toEqual([E.filter]);
  });

  test("[INV-024] výběr z hromadné akce má strop", () => {
    const ids = Array.from({ length: 201 }, (_, i) => `id-${i}`);
    expect(issues({ kind: "invoices", format: "xlsx", filter: { ids } })).toEqual([E.tooMany(200)]);
    expect(
      issues({ kind: "invoices", format: "xlsx", filter: { ids: ids.slice(0, 200) } }),
    ).toEqual([]);
  });

  test("[EXP-001] výběr říká, co soubor obsahuje, a jméno souboru nese datum", () => {
    expect(exportContents("invoices", "csv")).toMatch(/počtem položek/);
    expect(exportContents("invoices", "xlsx")).toMatch(/Doklady a Položky/);
    expect(exportContents("templates", "json")).toMatch(/JSON/);
    expect(exportFileName("invoices", "isdoc_zip", "2026-11-06")).toBe(
      "faktury-isdoc-2026-11-06.zip",
    );
    expect(exportFileName("payments", "xlsx", "2026-11-06")).toBe("platby-2026-11-06.xlsx");
  });
});
