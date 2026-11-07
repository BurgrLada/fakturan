import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { defaultTaxYear, parseTaxFilter } from "@/lib/report-filter";
import { setClockForTests } from "@/server/clock";
import { taxOverview, unpaidAsOf } from "@/server/reports/tax";
import { getInvoice } from "@/server/services/invoices";
import { REPORT_TODAY } from "../fixtures/report-scenario";
import { seedTaxScenario, TAX_TODAY, type TaxScenario } from "../fixtures/tax-scenario";
import { assertConsistent } from "../helpers/consistency";
import { createTestDb } from "../helpers/db";
import { recordStatements } from "../helpers/statements";

vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-tax-")));

const db = createTestDb();
let s: TaxScenario;

beforeAll(() => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  s = seedTaxScenario(db);
});
afterAll(() => setClockForTests(null));

const paid = (owner: string, year: number, today = TAX_TODAY) =>
  taxOverview(db, owner, { year, basis: "paid" }, today);
const issued = (owner: string, year: number, today = TAX_TODAY) =>
  taxOverview(db, owner, { year, basis: "issued" }, today);
const numberOf = (owner: string, id: string) => getInvoice(owner, id)!.number!;
const ids = (lines: { invoiceId: string }[]) => lines.map((line) => line.invoiceId);

describe("daňový přehled", () => {
  test("[TAX-001] rok 2026 má příjmy 41 650,00 Kč a seznam plateb", () => {
    const owner = s.base.owner;
    const overview = paid(owner, 2026, REPORT_TODAY);
    expect(overview.totalCzkMinor).toBe(4_165_000);
    expect(overview.lines.map((line) => [line.date, line.czkMinor])).toEqual([
      ["2026-02-01", 1_210_000],
      ["2026-04-10", 2_205_000],
      ["2026-05-11", 500_000],
      ["2026-06-10", 150_000],
      ["2026-09-20", 100_000],
    ]);
    expect(overview.lines.reduce((sum, line) => sum + line.czkMinor!, 0)).toBe(
      overview.totalCzkMinor,
    );
    expect(overview).toMatchObject({ asOf: REPORT_TODAY, asOfToday: true });
  });

  test("[TAX-001] vrácení z roku 2026 sníží rok 2026 a rok 2025 nezmění", () => {
    const y2025 = paid(s.owner, 2025);
    expect(y2025.totalCzkMinor).toBe(300_000);
    expect(ids(y2025.lines)).toEqual([s.ids.k]);
    const y2026 = paid(s.owner, 2026);
    const refund = y2026.lines.find((line) => line.invoiceId === s.ids.k)!;
    expect(refund).toMatchObject({ date: "2026-01-15", amountMinor: -300_000, czkMinor: -300_000 });
    // H 1 000 + L 1 200 + I 5 000 - K 3 000; M has no rate.
    expect(y2026.totalCzkMinor).toBe(420_000);
  });

  test("[ADV-005] záloha uhrazená 2026 a faktura 2027 je příjem jen v 2026", () => {
    const advance = paid(s.owner, 2026).lines.find((line) => line.invoiceId === s.ids.iAdvance)!;
    expect(advance).toMatchObject({
      date: "2026-12-28",
      czkMinor: 500_000,
      related: { role: "final", number: numberOf(s.owner, s.ids.iFinal) },
    });
    const y2027 = paid(s.owner, 2027);
    expect(y2027.lines).toEqual([]);
    expect(y2027.totalCzkMinor).toBe(0);
  });

  test("[ADV-005] ve výstavním základu je jen konečná faktura v 2027", () => {
    const y2027 = issued(s.owner, 2027);
    expect(ids(y2027.lines)).toEqual([s.ids.iFinal]);
    expect(y2027.lines[0]).toMatchObject({
      czkMinor: 500_000,
      related: { role: "advance", number: numberOf(s.owner, s.ids.iAdvance) },
    });
    expect(ids(issued(s.owner, 2026).lines)).not.toContain(s.ids.iAdvance);
    // The final invoice is covered by the advance, so nothing is left to pay.
    expect(ids(y2027.unpaid)).not.toContain(s.ids.iFinal);
  });

  test("[TAX-001] H je neuhrazená k 31. 12. 2025, i když je dnes uhrazená", () => {
    const y2025 = paid(s.owner, 2025);
    expect(y2025).toMatchObject({ asOf: "2025-12-31", asOfToday: false });
    const h = y2025.unpaid.find((row) => row.invoiceId === s.ids.h)!;
    expect(h).toMatchObject({ dueMinor: 100_000, czkMinor: 100_000 });
    expect(getInvoice(s.owner, s.ids.h)!.status).toBe("paid");
    expect(ids(unpaidAsOf(db, s.owner, TAX_TODAY))).not.toContain(s.ids.h);
  });

  test("[TAX-001] J k 31. 12. 2025 dluží 2 000,00, oprava je až z ledna", () => {
    const y2025 = paid(s.owner, 2025);
    expect(y2025.unpaid.find((row) => row.invoiceId === s.ids.j)).toMatchObject({
      dueMinor: 200_000,
    });
    // K was paid in 2025 and is not owed at the end of that year, whatever happened later.
    expect(ids(y2025.unpaid).sort()).toEqual([s.ids.h, s.ids.j].sort());
    expect(y2025.unpaidCzkMinor).toBe(300_000);
    const y2026 = unpaidAsOf(db, s.owner, "2026-12-31");
    expect(y2026.find((row) => row.invoiceId === s.ids.j)).toMatchObject({ dueMinor: 150_000 });
  });

  test("[TAX-002] výchozí základ je úhrada, vystavení dá 44 100,00 Kč", () => {
    expect(parseTaxFilter({}, "2026-11-02")).toEqual({ year: 2026, basis: "paid" });
    expect(parseTaxFilter({}, "2026-03-31")).toEqual({ year: 2025, basis: "paid" });
    expect(parseTaxFilter({}, "2026-04-01").year).toBe(2026);
    expect(defaultTaxYear("2027-01-10")).toBe(2026);
    expect(parseTaxFilter({ rok: "2024", zaklad: "vystaveni" }, "2026-11-02")).toEqual({
      year: 2024,
      basis: "issued",
    });
    expect(parseTaxFilter({ rok: "2030", zaklad: "x" }, "2026-11-02")).toEqual({
      year: 2026,
      basis: "paid",
    });
    expect(issued(s.base.owner, 2026, REPORT_TODAY).totalCzkMinor).toBe(4_410_000);
    // J's correction belongs to the year it was issued in, L counts though imported.
    expect(issued(s.owner, 2026).totalCzkMinor).toBe(320_000);
    expect(issued(s.owner, 2025).totalCzkMinor).toBe(600_000);
  });

  test("[IMP-012] přehled uvede počet a částku odhadnutých dat", () => {
    const y2026 = paid(s.owner, 2026);
    expect(y2026.estimated).toEqual({ count: 1, czkMinor: 120_000 });
    expect(y2026.lines.find((line) => line.estimated)!.invoiceId).toBe(s.ids.l);
    expect(issued(s.owner, 2026).estimated).toEqual({ count: 0, czkMinor: 0 });
  });

  test("[REP-009] platba bez kurzu je v unconverted a součet ji mlčky nevynechá", () => {
    const y2026 = paid(s.owner, 2026);
    const m = y2026.lines.find((line) => line.invoiceId === s.ids.m)!;
    expect(m).toMatchObject({ currency: "EUR", amountMinor: 10_000, czkMinor: null });
    expect(y2026.unconverted).toEqual({
      count: 1,
      byCurrency: [{ currency: "EUR", amountMinor: 10_000 }],
    });
    // In the issued basis the document carries its own rate.
    const mIssued = issued(s.owner, 2026).lines.find((line) => line.invoiceId === s.ids.m)!;
    expect(mIssued.czkMinor).toBe(250_000);
  });

  test("[REP-007] storno a koncept v přehledu nejsou", () => {
    const { d, dDraft } = s.base.ids;
    for (const overview of [
      paid(s.base.owner, 2026, REPORT_TODAY),
      issued(s.base.owner, 2026, REPORT_TODAY),
    ]) {
      expect(ids(overview.lines)).not.toContain(d);
      expect(ids(overview.lines)).not.toContain(dDraft);
      expect(ids(overview.unpaid)).not.toContain(d);
      expect(ids(overview.unpaid)).not.toContain(dDraft);
    }
  });

  test("[SEC-002] rok cizího účtu vrátí jen vlastní data", () => {
    const own = new Set(Object.values(s.ids));
    for (const overview of [paid(s.owner, 2026), issued(s.owner, 2026)]) {
      for (const id of [...ids(overview.lines), ...ids(overview.unpaid)]) {
        expect(own.has(id), id).toBe(true);
      }
    }
    const baseIds = new Set(Object.values(s.base.ids));
    for (const id of ids(paid(s.base.owner, 2026, REPORT_TODAY).lines)) {
      expect(baseIds.has(id)).toBe(true);
    }
    expect(paid("neexistuje", 2026).lines).toEqual([]);
  });

  test("[TAX-001] unpaidAsOf k dnešku sedí s přehledem a data jsou konzistentní", () => {
    expect(() => assertConsistent(db, s.owner)).not.toThrow();
    expect(() => assertConsistent(db, s.base.owner)).not.toThrow();
  });
});

describe("výkon nedoplatků", () => {
  test("[ARC-005] nedoplatky k datu hledají opravy a platby dokladu po indexu, ne po datu", () => {
    const owner = s.base.owner;
    const { statements } = recordStatements(db, () => unpaidAsOf(db, owner, "2026-12-31"));
    const [source] = statements;
    const params = Array.from(source!.matchAll(/\?/g), () => null);
    const plan = db.$client
      .prepare(`EXPLAIN QUERY PLAN ${source}`)
      .all(...params)
      .map((row) => (row as { detail: string }).detail);
    expect(plan.filter((detail) => detail.includes("invoice_user_related_idx"))).toHaveLength(1);
    expect(plan.filter((detail) => detail.includes("payment_user_invoice_idx"))).toHaveLength(2);
    expect(plan.filter((detail) => detail.includes("payment_user_paid_on_idx"))).toEqual([]);
  });
});
