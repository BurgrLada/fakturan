import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { fxCzk } from "@/lib/sql-functions";
import { resolvePeriod } from "@/lib/report-period";
import type { QueryWidgetConfig, SystemWidgetConfig } from "@/lib/widget-config";
import { setClockForTests } from "@/server/clock";
import { invoice } from "@/server/db/schema";

type Invoice = typeof invoice.$inferSelect;
import {
  incomeTotal,
  invoicedSeries,
  paymentDays,
  reportSummary,
  topItems,
} from "@/server/reports/queries";
import { runWidget, type WidgetContext } from "@/server/reports/widget-query";
import { alignPrevious } from "@/server/reports/align";
import { reportBundle } from "@/server/reports/bundle";
import { parseReportFilter } from "@/lib/report-filter";
import { ServiceError } from "@/server/services/access";
import {
  issuedDocument,
  namedCustomer,
  REPORT_TODAY,
  reportOwner,
  seedReportScenario,
  type ReportScenario,
} from "../fixtures/report-scenario";
import { externalInvoice } from "../fixtures/external-invoice";
import { createTestDb } from "../helpers/db";

vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-widgets-")));

const db = createTestDb();
const TODAY = REPORT_TODAY;
const YEAR = { from: "2026-01-01", to: "2026-12-31" };
const context: WidgetContext = { today: TODAY };

let s: ReportScenario;
let other: { owner: string; customers: string[] };

beforeAll(() => {
  s = seedReportScenario(db);
  const owner = reportOwner(db);
  const customers = ["Delta", "Epsilon", "Zeta", "Eta", "Theta"].map((name, index) => {
    const id = namedCustomer(owner, `${name} s.r.o.`);
    issuedDocument(owner, id, { issueDate: "2026-02-02", totalMinor: (index + 1) * 10_000 });
    return id;
  });
  other = { owner, customers };
  setClockForTests(null);
});
afterAll(() => setClockForTests(null));

// Balances are the state as of today and take no period.
const widget = (over: Partial<QueryWidgetConfig> = {}): QueryWidgetConfig => {
  const balance = over.measure === "outstanding" || over.measure === "overdue";
  return {
    v: 1,
    kind: "query",
    title: "",
    color: "chart-1",
    format: "auto",
    source: "invoices",
    metric: "sum",
    measure: "invoiced",
    ...(balance ? {} : { period: YEAR }),
    display: "number",
    ...over,
  };
};
const run = (over: Partial<QueryWidgetConfig> = {}, owner = s.owner, ctx = context) =>
  runWidget(db, owner, widget(over), ctx);
const total = (over: Partial<QueryWidgetConfig> = {}, owner = s.owner) => run(over, owner).total;
const table = (over: Partial<QueryWidgetConfig>) =>
  run({ display: "table", ...over }).rows.reduce((sum, row) => sum + (row.value ?? 0), 0);

// Independent of the compiler: plain rows of the account, converted one by one in JS.
function invoicedByHand(keep: (row: Invoice) => boolean, owner = s.owner, range = YEAR): number {
  return db
    .select()
    .from(invoice)
    .where(eq(invoice.userId, owner))
    .all()
    .filter(
      (row) =>
        row.status !== "draft" &&
        row.status !== "cancelled" &&
        row.type !== "advance" &&
        row.issueDate !== null &&
        row.issueDate >= range.from &&
        row.issueDate <= range.to &&
        keep(row),
    )
    .reduce(
      (sum, row) => sum + Number(fxCzk(row.currency, row.totalMinor, row.exchangeRateMicros)),
      0,
    );
}

function capturedSql(action: () => void): string[] {
  const statements: string[] = [];
  const spy = vi.spyOn(db.$client, "prepare");
  try {
    action();
    for (const call of spy.mock.calls) statements.push(String(call[0]));
  } finally {
    spy.mockRestore();
  }
  return statements;
}

describe("zdroje a metriky", () => {
  test("[DSH-010] každý zdroj dává výsledek nad scénářem z Task 1", () => {
    const filter = { range: YEAR, includeExternal: true };
    expect(total()).toBe(4_410_000);
    expect(total({ source: "payments", measure: undefined })).toBe(
      incomeTotal(db, s.owner, filter).amountMinor,
    );
    expect(total({ source: "payments", measure: undefined })).toBe(4_165_000);
    const items = topItems(db, s.owner, filter).rows.reduce((sum, row) => sum + row.amountMinor, 0);
    expect(table({ source: "lines", measure: undefined, groupBy: "item" })).toBe(items);
    expect(total({ source: "lines", measure: undefined, metric: "count" })).toBe(6);
    expect(total({ source: "customers", measure: undefined, metric: "count" })).toBe(3);
    expect(
      total({ source: "customers", measure: undefined, metric: "count", period: "last_year" }),
    ).toBe(0);
  });

  test("[DSH-011] součet 44 100,00, počet 6, medián, minimum, maximum a dny do úhrady souhlasí", () => {
    expect(total({ metric: "sum" })).toBe(4_410_000);
    expect(total({ metric: "count" })).toBe(6);
    expect(total({ metric: "avg" })).toBe(735_000);
    expect(total({ metric: "median" })).toBe(400_000);
    expect(total({ metric: "min" })).toBe(-250_000);
    expect(total({ metric: "max" })).toBe(2_500_000);
    const days = paymentDays(db, s.owner, { range: YEAR, includeExternal: true });
    expect(days.averageDays).not.toBeNull();
    expect(total({ metric: "days_to_pay", measure: undefined })).toBe(days.averageDays);

    const summary = reportSummary(db, s.owner, { range: YEAR, includeExternal: true }, TODAY);
    expect(total({ measure: "outstanding" })).toBe(summary.outstandingMinor);
    expect(total({ measure: "overdue" })).toBe(summary.overdueMinor);
    const asOfToday = run({ measure: "overdue" }, s.owner, {
      today: TODAY,
      globalFilter: { period: "last_year" },
    });
    expect(asOfToday).toMatchObject({ total: 200_000, range: { from: TODAY, to: TODAY } });
    expect(total({ measure: "outstanding", metric: "count" })).toBe(1);
  });

  test("[DSH-012] seskupení podle měsíce má 12 košů včetně prázdných a součet 44 100,00", () => {
    const result = run({ display: "bar", groupBy: "month" });
    expect(result.kind).toBe("series");
    const points = result.series[0]!.points;
    expect(points).toHaveLength(12);
    expect(points.filter((p) => p.value === 0).length).toBeGreaterThan(0);
    expect(points.reduce((sum, p) => sum + (p.value ?? 0), 0)).toBe(4_410_000);
    const core = invoicedSeries(db, s.owner, { range: YEAR, includeExternal: true }, "month");
    expect(points.map((p) => [p.key, p.value])).toEqual(
      core.points.map((p) => [p.key, p.amountMinor]),
    );
    const cumulative = run({ display: "area", groupBy: "month", cumulative: true });
    expect(cumulative.series[0]!.points.at(-1)!.value).toBe(4_410_000);
    const quarters = run({ display: "bar", groupBy: "quarter" }).series[0]!.points;
    expect(quarters.map((p) => p.key)).toEqual(["2026-Q1", "2026-Q2", "2026-Q3", "2026-Q4"]);
    const medians = run({ display: "bar", groupBy: "month", metric: "median" }).series[0]!.points;
    expect(medians.find((p) => p.key === "2026-08")!.value).toBeNull();
  });

  test("[DSH-012] seskupení podle zákazníka, položky, měny, stavu a typu dává stejný součet", () => {
    for (const groupBy of ["customer", "currency", "status", "type"] as const) {
      expect(table({ groupBy }), groupBy).toBe(4_410_000);
    }
    expect(table({ source: "lines", measure: undefined, groupBy: "item" })).toBe(4_410_000);
    expect(table({ source: "payments", measure: undefined, groupBy: "customer" })).toBe(4_165_000);
    const customers = run({ display: "table", groupBy: "customer" }).rows;
    expect(customers.map((row) => [row.name, row.value])).toEqual([
      ["Beta GmbH", 2_250_000],
      ["Alfa s.r.o.", 1_360_000],
      ["Gama a.s.", 800_000],
    ]);
    const split = run({ display: "stacked_bar", groupBy: "month", splitBy: "currency" });
    expect(split.series.map((series) => series.key).sort()).toEqual(["CZK", "EUR"]);
    const splitSum = split.series.flatMap((series) => series.points);
    expect(splitSum.reduce((sum, p) => sum + (p.value ?? 0), 0)).toBe(4_410_000);
  });
});

describe("filtry a období", () => {
  test("[DSH-013] letos, posledních 12 měsíců, absolutní období, stav, měna a typ filtrují správně", () => {
    const at = { today: "2026-11-02" };
    expect(run({ period: "this_year" }, s.owner, at).total).toBe(invoicedByHand(() => true));
    const last12 = resolvePeriod("last_12_months", TODAY);
    expect(run({ period: "last_12_months" }, s.owner, at).range).toEqual(last12);
    expect(run({ period: "last_12_months" }, s.owner, at).total).toBe(
      invoicedByHand(() => true, s.owner, last12),
    );
    const spring = { from: "2026-03-01", to: "2026-04-30" };
    expect(total({ period: spring })).toBe(invoicedByHand(() => true, s.owner, spring));
    expect(total({ period: spring })).toBe(2_250_000);
    expect(total({ filters: { status: ["paid"] } })).toBe(
      invoicedByHand((row) => row.status === "paid"),
    );
    expect(total({ filters: { status: ["partially_paid"] } })).toBe(300_000);
    expect(total({ filters: { currency: "EUR" } })).toBe(90_000);
    expect(total({ filters: { type: ["credit_note"] } })).toBe(-250_000);
    expect(total({ filters: { type: ["advance"] } })).toBe(0);
    expect(total({ filters: { customerIds: [s.customers.alfa] } })).toBe(1_360_000);
    expect(total({ source: "payments", measure: undefined, filters: { type: ["advance"] } })).toBe(
      500_000,
    );
  });

  test("[DSH-013] vyloučení importovaných dá 42 600,00", () => {
    expect(total({ filters: { includeExternal: false } })).toBe(4_260_000);
    expect(total({ filters: { includeExternal: true } })).toBe(4_410_000);
  });

  test("globální filtr přebije období a měnu protne", () => {
    const spring = { from: "2026-03-01", to: "2026-04-30" };
    const global = (globalFilter: WidgetContext["globalFilter"]) => ({
      today: TODAY,
      globalFilter,
    });
    expect(run({}, s.owner, global({ period: spring })).total).toBe(2_250_000);
    expect(run({}, s.owner, global({ currency: "EUR" })).total).toBe(90_000);
    const excluded = run({ filters: { currency: "CZK" } }, s.owner, global({ currency: "EUR" }));
    expect(excluded).toMatchObject({ total: null, rows: [], series: [] });
  });

  test("[DSH-015] porovnání vrátí hodnotu předchozího období a rozdíl", () => {
    const april = { from: "2026-04-01", to: "2026-04-30" };
    const result = run({ period: april, compare: "previous", display: "number_compare" });
    expect(result.total).toBe(-250_000);
    expect(result.compare).toEqual({
      range: { from: "2026-03-01", to: "2026-03-31" },
      total: 2_500_000,
      delta: -2_750_000,
    });
  });

  test("[DSH-015] meziroční porovnání jde po měsících", () => {
    const result = run({
      period: { from: "2027-01-01", to: "2027-12-31" },
      display: "bar",
      groupBy: "month",
      compare: "year",
    });
    const core = invoicedSeries(db, s.owner, { range: YEAR, includeExternal: true }, "month");
    expect(result.compare!.range).toEqual(YEAR);
    expect(result.compare!.points).toEqual(core.points.map((p) => p.amountMinor));
    expect(result.compare!.total).toBe(4_410_000);
    expect(result.compare!.delta).toBe(-4_410_000);
  });

  test("[DSH-015] letošek se porovná s loňskem do stejného dne a koše sedí po měsících", () => {
    const owner = reportOwner(db);
    const customer = namedCustomer(owner, "Loni s.r.o.");
    issuedDocument(owner, customer, { issueDate: "2025-03-10", totalMinor: 30_000 });
    issuedDocument(owner, customer, { issueDate: "2025-11-02", totalMinor: 11_000 });
    issuedDocument(owner, customer, { issueDate: "2025-11-03", totalMinor: 70_000 });
    issuedDocument(owner, customer, { issueDate: "2026-03-05", totalMinor: 5_000 });

    for (const compare of ["year", "previous"] as const) {
      const result = run({ period: "this_year", display: "bar", groupBy: "month", compare }, owner);
      expect(result.compare!.range).toEqual({ from: "2025-01-01", to: "2025-11-02" });
      expect(result.compare!.total).toBe(41_000);
      expect(result.compare!.points).toEqual([0, 0, 30_000, 0, 0, 0, 0, 0, 0, 0, 11_000, 0]);
    }

    const bundle = reportBundle(
      db,
      owner,
      { ...parseReportFilter({ obdobi: "rok", porovnani: "rok" }, TODAY) },
      TODAY,
    );
    expect(bundle.previousRange).toEqual({ from: "2025-01-01", to: "2025-11-02" });
    expect(bundle.previous.invoicedMinor).toBe(41_000);
    expect(alignPrevious(bundle.invoiced, bundle.previousInvoiced)).toEqual([
      0, 0, 30_000, 0, 0, 0, 0, 0, 0, 0, 11_000, 0,
    ]);
  });

  test("[DSH-015] běžící listopad 1.–6. se denně páruje s 1.–6. října", () => {
    const today = "2026-11-06";
    const owner = reportOwner(db);
    const customer = namedCustomer(owner, "Den s.r.o.");
    for (let day = 1; day <= 6; day++) {
      issuedDocument(owner, customer, { issueDate: `2026-11-0${day}`, totalMinor: day * 100 });
      issuedDocument(owner, customer, { issueDate: `2026-10-0${day}`, totalMinor: day * 1_000 });
    }
    issuedDocument(owner, customer, { issueDate: "2026-10-07", totalMinor: 99_900 });
    const zeros = (count: number) => Array<number>(count).fill(0);

    const result = run(
      { period: "this_month", display: "bar", groupBy: "day", compare: "previous" },
      owner,
      { today },
    );
    expect(result.compare!.range).toEqual({ from: "2026-10-01", to: "2026-10-06" });
    expect(result.compare!.points).toEqual([
      1_000,
      2_000,
      3_000,
      4_000,
      5_000,
      6_000,
      ...zeros(24),
    ]);
    expect(result.compare!.total).toBe(21_000);

    const bundle = reportBundle(db, owner, parseReportFilter({ obdobi: "mesic" }, today), today);
    expect(bundle.unit).toBe("day");
    expect(bundle.invoiced.points.slice(0, 6).map((p) => p.amountMinor)).toEqual([
      100, 200, 300, 400, 500, 600,
    ]);
    expect(alignPrevious(bundle.invoiced, bundle.previousInvoiced, bundle.anchor)).toEqual(
      result.compare!.points,
    );
  });

  test("[DSH-015] konec měsíce po kratším měsíci páruje dny dál od začátku", () => {
    for (const [today, previous] of [
      ["2026-03-30", "2026-02"],
      ["2026-10-31", "2026-09"],
    ] as const) {
      const owner = reportOwner(db);
      const customer = namedCustomer(owner, "Konec měsíce s.r.o.");
      const month = today.slice(0, 7);
      for (let day = 1; day <= 3; day++) {
        issuedDocument(owner, customer, { issueDate: `${month}-0${day}`, totalMinor: day * 100 });
        issuedDocument(owner, customer, {
          issueDate: `${previous}-0${day}`,
          totalMinor: day * 1_000,
        });
      }

      const result = run(
        { period: "this_month", display: "bar", groupBy: "day", compare: "previous" },
        owner,
        { today },
      );
      expect(result.compare!.points!.slice(0, 4), today).toEqual([1_000, 2_000, 3_000, 0]);

      const bundle = reportBundle(db, owner, parseReportFilter({ obdobi: "mesic" }, today), today);
      expect(bundle.anchor, today).toBe("start");
      expect(
        alignPrevious(bundle.invoiced, bundle.previousInvoiced, bundle.anchor).slice(0, 4),
        today,
      ).toEqual([1_000, 2_000, 3_000, 0]);
    }
  });

  test("[DSH-015] ukončený měsíc se dál páruje od konce a součet sedí se souhrnem", () => {
    const owner = reportOwner(db);
    const customer = namedCustomer(owner, "Konec s.r.o.");
    issuedDocument(owner, customer, { issueDate: "2026-08-01", totalMinor: 100 });
    issuedDocument(owner, customer, { issueDate: "2026-08-02", totalMinor: 200 });
    issuedDocument(owner, customer, { issueDate: "2026-08-31", totalMinor: 300 });
    issuedDocument(owner, customer, { issueDate: "2026-09-01", totalMinor: 50 });
    const september = { from: "2026-09-01", to: "2026-09-30" };

    const result = run(
      { period: september, display: "bar", groupBy: "day", compare: "previous" },
      owner,
    );
    const points = result.compare!.points!;
    expect(result.compare!.range).toEqual({ from: "2026-08-01", to: "2026-08-31" });
    expect(points).toHaveLength(30);
    expect(points[0]).toBe(300);
    expect(points[29]).toBe(300);
    expect(points.reduce((sum, value) => sum + value, 0)).toBe(result.compare!.total);

    const bundle = reportBundle(
      db,
      owner,
      parseReportFilter({ obdobi: "vlastni", od: september.from, do: september.to }, TODAY),
      TODAY,
    );
    expect(bundle.anchor).toBe("end");
    expect(alignPrevious(bundle.invoiced, bundle.previousInvoiced, bundle.anchor)).toEqual(points);
    expect(bundle.previous.invoicedMinor).toBe(600);
  });

  test("[DSH-015] alignPrevious od začátku páruje den se dnem a přebytek dá do posledního", () => {
    const series = (values: number[]) => ({
      points: values.map((amountMinor, index) => ({ key: `d${index + 1}`, amountMinor })),
      unconverted: { count: 0, byCurrency: [] },
    });
    const october = series(
      Array.from({ length: 31 }, (_, index) => (index < 6 ? 10 * (index + 1) : 0)),
    );
    expect(alignPrevious(series([1, 2, 3, 4, 5, 6]), october, "start")).toEqual([
      10, 20, 30, 40, 50, 60,
    ]);
    expect(alignPrevious(series([1, 2]), series([1, 2, 3, 4]), "start")).toEqual([1, 9]);
    expect(alignPrevious(series([1, 2, 3]), series([5, 7]), "start")).toEqual([5, 7, 0]);
    expect(alignPrevious(series([1, 2, 3]), series([5, 7]))).toEqual([0, 5, 7]);
  });

  test("widget s období 11 let nebo denními koši nad 400 je odmítnutý", () => {
    const eleven = { from: "2015-01-01", to: "2025-12-31" };
    expect(() => run({ period: eleven })).toThrow(ServiceError);
    const global = { today: TODAY, globalFilter: { period: eleven } };
    expect(() => run({}, s.owner, global)).toThrow("nejvýš 10 let");
    const days = {
      today: TODAY,
      globalFilter: { period: { from: "2025-01-01", to: "2026-02-05" } },
    };
    expect(() => run({ display: "bar", groupBy: "day" }, s.owner, days)).toThrow("400");
    expect(
      run({ display: "heatmap", groupBy: "day", period: "last_12_months" }).series[0]!.points,
    ).toHaveLength(365);
  });

  test("[REP-008] doklady bez zákazníka se seskupí podle jména", () => {
    const owner = reportOwner(db);
    for (const [customerName, totalMinor] of [
      ["Import A s.r.o.", 30_000],
      ["Import B s.r.o.", 20_000],
    ] as const) {
      externalInvoice(db, owner, { customerName, totalMinor, issueDate: "2026-03-01" });
    }
    setClockForTests(null);
    const rows = run({ display: "table", groupBy: "customer" }, owner).rows;
    expect(rows.map((row) => [row.name, row.value])).toEqual([
      ["Import A s.r.o.", 30_000],
      ["Import B s.r.o.", 20_000],
    ]);
  });

  test("topN 3 má řádek Ostatní a součet se nezmění", () => {
    const all = run({ display: "table", groupBy: "customer" }, other.owner);
    expect(all.rows).toHaveLength(5);
    const top = run({ display: "table", groupBy: "customer", topN: 3 }, other.owner);
    expect(top.rows.map((row) => [row.kind, row.value])).toEqual([
      ["row", 50_000],
      ["row", 40_000],
      ["row", 30_000],
      ["others", 30_000],
    ]);
    const sum = (rows: { value: number | null }[]) => rows.reduce((t, r) => t + (r.value ?? 0), 0);
    expect(sum(top.rows)).toBe(sum(all.rows));
    expect(top.total).toBe(150_000);
  });

  test("nesčítatelná metrika přes 50 kategorií má příznak truncated", () => {
    const owner = reportOwner(db);
    for (let index = 0; index < 51; index++) {
      const id = namedCustomer(owner, `Zákazník ${index}`);
      issuedDocument(owner, id, { issueDate: "2026-03-03", totalMinor: (index + 1) * 1_000 });
    }
    setClockForTests(null);
    const median = run({ display: "table", groupBy: "customer", metric: "median" }, owner);
    expect(median.rows).toHaveLength(50);
    expect(median.truncated).toBe(true);
    const sum = run({ display: "table", groupBy: "customer" }, owner);
    expect(sum.rows.at(-1)).toMatchObject({ kind: "others", value: 1_000 });
    expect(sum.truncated).toBeUndefined();
    expect(
      run({ display: "table", groupBy: "customer", metric: "median" }).truncated,
    ).toBeUndefined();
  });

  test("systémový widget bez registrace skončí chybou služby", () => {
    const config: SystemWidgetConfig = {
      v: 1,
      kind: "system",
      systemId: "forecast",
      title: "",
      color: "chart-1",
      format: "auto",
    };
    expect(() => runWidget(db, s.owner, config, context)).toThrow(ServiceError);
  });
});

describe("zákazník bez kurzu", () => {
  test("[FOR-008] zákazník jen s doklady bez kurzu chybí v řádcích jako ve Statistikách", () => {
    const owner = reportOwner(db);
    const rated = namedCustomer(owner, "Kappa s.r.o.");
    const unrated = namedCustomer(owner, "Lambda GmbH");
    issuedDocument(owner, rated, { issueDate: "2026-03-02", totalMinor: 50_000 });
    const id = issuedDocument(owner, unrated, {
      issueDate: "2026-03-02",
      totalMinor: 100_000,
      currency: "EUR",
      rateMicros: 25_000_000,
    });
    db.update(invoice).set({ exchangeRateMicros: null }).where(eq(invoice.id, id)).run();

    const result = run({ display: "table", groupBy: "customer" }, owner);
    expect(result.rows).toEqual([{ kind: "row", key: rated, name: "Kappa s.r.o.", value: 50_000 }]);
    expect(result.unconverted.count).toBe(1);
    const lines = run(
      { source: "lines", measure: undefined, display: "table", groupBy: "customer" },
      owner,
    );
    expect(lines.rows.map((row) => row.key)).toEqual([rated]);
    const counted = run({ display: "table", groupBy: "customer", metric: "count" }, owner);
    expect(counted.rows.map((row) => row.key).sort()).toEqual([rated, unrated].sort());
  });
});

describe("bezpečnost a výkon", () => {
  test("[DSH-018] každý dotaz má podmínku účtu i bez filtrů", () => {
    const configs: Partial<QueryWidgetConfig>[] = [
      {},
      { measure: "overdue" },
      { source: "lines", measure: undefined, display: "table", groupBy: "item" },
      { source: "payments", measure: undefined, display: "bar", groupBy: "month" },
      { source: "customers", measure: undefined, metric: "count" },
      { display: "table", groupBy: "customer" },
    ];
    const tables = ["invoice", "invoice_line", "payment", "customer"];
    for (const config of configs) {
      const statements = capturedSql(() => run(config));
      expect(statements.length).toBeGreaterThan(0);
      for (const statement of statements) {
        for (const table of tables) {
          const used = new RegExp(`(from|join) "${table}"`, "i").test(statement);
          if (used) expect(statement, statement).toContain(`"${table}"."user_id" = ?`);
        }
      }
    }
    expect(total({}, other.owner)).toBe(150_000);
    expect(total({ source: "customers", measure: undefined, metric: "count" }, other.owner)).toBe(
      5,
    );
    expect(total()).toBe(4_410_000);
  });

  test("[TST-009] filtr s cizím customerId nevrátí žádné částky", () => {
    const foreign = { customerIds: [other.customers[0]!] };
    expect(total({ filters: foreign })).toBe(0);
    expect(run({ display: "table", groupBy: "customer", filters: foreign }).rows).toEqual([]);
    expect(total({ source: "lines", measure: undefined, filters: foreign })).toBe(0);
    expect(total({ source: "payments", measure: undefined, filters: foreign })).toBe(0);
    expect(total({ measure: "outstanding", filters: foreign })).toBe(0);
    expect(total({ filters: { customerIds: [other.customers[0]!, s.customers.alfa] } })).toBe(
      1_360_000,
    );
  });

  test("dotazy používají indexy podle EXPLAIN QUERY PLAN", () => {
    const plans = (config: Partial<QueryWidgetConfig>) =>
      capturedSql(() => run(config)).flatMap((statement) => {
        const params = Array.from(statement.matchAll(/\?/g), () => null);
        return db.$client
          .prepare(`EXPLAIN QUERY PLAN ${statement}`)
          .all(...params)
          .map((row) => (row as { detail: string }).detail);
      });
    const invoices = plans({ display: "bar", groupBy: "month" });
    expect(invoices.join("\n")).toContain("invoice_user_issue_date_idx");
    const payments = plans({
      source: "payments",
      measure: undefined,
      display: "bar",
      groupBy: "month",
    });
    expect(payments.join("\n")).toContain("payment_user_paid_on_idx");
    for (const detail of [...invoices, ...payments]) {
      expect(detail).not.toMatch(/^SCAN (invoice|payment)\b/);
    }
  });
});
