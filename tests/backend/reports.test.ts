import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { Currency } from "@/lib/currency";
import { resolvePeriod } from "@/lib/report-period";
import { setClockForTests } from "@/server/clock";
import { exchangeRate, invoice, payment } from "@/server/db/schema";
import {
  agingBands,
  currencyShares,
  incomeSeries,
  invoicedSeries,
  paymentDays,
  reportSummary,
  topCustomers,
  topItems,
} from "@/server/reports/queries";
import type { ReportFilter } from "@/server/reports/types";
import { convertAdvance } from "@/server/services/advances";
import { cancelInvoice } from "@/server/services/invoice-lifecycle";
import { getInvoice, invoiceSummary } from "@/server/services/invoices";
import { addRefund, averagePaymentDays, closeDifference } from "@/server/services/payments";
import * as reports from "@/server/services/reports";
import {
  at,
  draftDocument,
  issue,
  issuedDocument,
  line,
  namedCustomer,
  pay,
  REPORT_TODAY,
  reportOwner,
  seedReportScenario,
  type ReportScenario,
} from "../fixtures/report-scenario";
import { externalInvoice } from "../fixtures/external-invoice";
import { assertConsistent } from "../helpers/consistency";
import { createTestDb } from "../helpers/db";
import { webActor } from "../helpers/fixtures-mail";

vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-reports-")));

const db = createTestDb();
const TODAY = REPORT_TODAY;
const YEAR = { from: "2026-01-01", to: "2026-12-31" };
const NONE = { count: 0, byCurrency: [] };
const NONE_BY_METRIC = {
  invoiced: NONE,
  income: NONE,
  outstanding: NONE,
  overdue: NONE,
  advanceOpen: NONE,
};

let s: ReportScenario;

beforeAll(() => {
  s = seedReportScenario(db);
  setClockForTests(null);
});
afterAll(() => setClockForTests(null));

const filter = (over: Partial<ReportFilter> = {}): ReportFilter => ({
  range: YEAR,
  includeExternal: true,
  ...over,
});
const summary = (owner: string, over: Partial<ReportFilter> = {}) =>
  reportSummary(db, owner, filter(over), TODAY);
const months = (owner: string, over: Partial<ReportFilter> = {}) =>
  Object.fromEntries(
    invoicedSeries(db, owner, filter(over), "month").points.map((p) => [p.key, p.amountMinor]),
  );
const incomeMonths = (owner: string, over: Partial<ReportFilter> = {}) =>
  Object.fromEntries(
    incomeSeries(db, owner, filter(over), "month").points.map((p) => [p.key, p.amountMinor]),
  );

describe("scénář 2026", () => {
  test("[REP-008] scénář 2026: fakturováno 44 100,00 Kč", () => {
    expect(summary(s.owner)).toEqual({
      invoicedMinor: 4_410_000,
      incomeMinor: 4_165_000,
      outstandingMinor: 200_000,
      overdueMinor: 200_000,
      advanceOpenMinor: 200_000,
      unconverted: NONE_BY_METRIC,
    });
    assertConsistent(db, s.owner);
  });

  test("[REP-006] bez importovaných je fakturováno 42 600,00 a příjmy 40 150,00 Kč", () => {
    expect(summary(s.owner, { includeExternal: false })).toMatchObject({
      invoicedMinor: 4_260_000,
      incomeMinor: 4_015_000,
    });
  });

  test("[REP-009] příjmy 41 650,00 Kč", () => {
    expect(summary(s.owner).incomeMinor).toBe(4_165_000);
    expect(incomeMonths(s.owner)).toMatchObject({
      "2026-02": 1_210_000,
      "2026-04": 2_205_000,
      "2026-05": 500_000,
      "2026-06": 150_000,
      "2026-09": 100_000,
    });
  });

  test("[REP-007] storno 7 777,00 a koncept 8 888,00 se nikde nepočítají", () => {
    expect(months(s.owner)["2026-07"]).toBe(0);
    const gama = topCustomers(db, s.owner, filter({ customerIds: [s.customers.gama] }));
    expect(gama.rows).toEqual([
      { kind: "row", key: s.customers.gama, name: "Gama a.s.", amountMinor: 800_000 },
    ]);

    const owner = reportOwner(db);
    const customerId = namedCustomer(owner, "Delta s.r.o.");
    const cancelled = issuedDocument(owner, customerId, {
      issueDate: "2026-07-01",
      totalMinor: 777_700,
    });
    at("2026-07-02");
    cancelInvoice(webActor(owner), cancelled);
    draftDocument(owner, customerId, { issueDate: "2026-07-01", totalMinor: 888_800 });

    expect(summary(owner)).toEqual({
      invoicedMinor: 0,
      incomeMinor: 0,
      outstandingMinor: 0,
      overdueMinor: 0,
      advanceOpenMinor: 0,
      unconverted: NONE_BY_METRIC,
    });
    expect(Object.values(months(owner)).every((value) => value === 0)).toBe(true);
    expect(topCustomers(db, owner, filter()).rows).toEqual([]);
    expect(topItems(db, owner, filter()).rows).toEqual([]);
    expect(currencyShares(db, owner, filter()).rows).toEqual([]);
    expect(Object.values(agingBands(db, owner, filter(), TODAY).bands)).toEqual([0, 0, 0, 0, 0]);
    assertConsistent(db, owner);
  });

  test("[CRN-003] oprava -100,00 EUR sníží duben o 2 500,00 Kč a březen zůstane 25 000,00", () => {
    expect(months(s.owner)).toMatchObject({ "2026-03": 2_500_000, "2026-04": -250_000 });
    expect(months(s.owner, { currency: "EUR" })).toMatchObject({
      "2026-03": 100_000,
      "2026-04": -10_000,
    });
  });

  test("[ADV-005] úhrada zálohy je příjem v květnu jednou a konečná faktura ho nezvýší", () => {
    expect(incomeMonths(s.owner)["2026-05"]).toBe(500_000);
    expect(months(s.owner)["2026-05"]).toBe(500_000);
    expect(summary(s.owner, { range: { from: "2026-05-01", to: "2026-05-31" } })).toMatchObject({
      invoicedMinor: 500_000,
      incomeMinor: 500_000,
    });
  });

  test("[ADV-007] neuhrazená záloha 2 000,00 má vlastní řádek a není v pohledávkách ani po splatnosti", () => {
    const october = summary(s.owner, { range: { from: "2026-10-01", to: "2026-10-31" } });
    expect(october).toMatchObject({
      invoicedMinor: 0,
      outstandingMinor: 200_000,
      overdueMinor: 200_000,
      advanceOpenMinor: 200_000,
    });
    const aging = agingBands(db, s.owner, filter(), TODAY);
    expect(Object.values(aging.bands).reduce((sum, value) => sum + value, 0)).toBe(200_000);
  });

  test("[REP-009] v EUR je fakturováno 900,00 a příjmy 900,00 bez převodu", () => {
    expect(summary(s.owner, { currency: "EUR" })).toEqual({
      invoicedMinor: 90_000,
      incomeMinor: 90_000,
      outstandingMinor: 0,
      overdueMinor: 0,
      advanceOpenMinor: 0,
      unconverted: NONE_BY_METRIC,
    });
    expect(summary(s.owner, { currency: "CZK" })).toMatchObject({
      invoicedMinor: 2_160_000,
      incomeMinor: 1_960_000,
    });
  });

  test("[REP-002] scénář: 2 000,00 v pásmu 31–60 po 48 dnech", () => {
    expect(agingBands(db, s.owner, filter(), TODAY)).toEqual({
      bands: { current: 0, days0to30: 0, days31to60: 200_000, days61to90: 0, days90plus: 0 },
      unconverted: NONE,
    });
  });

  test("pohledávky, po splatnosti, zálohy a stárnutí jsou stav k dnešku bez ohledu na období", () => {
    const range = { from: "2025-01-01", to: "2025-12-31" };
    expect(summary(s.owner, { range })).toEqual({
      invoicedMinor: 0,
      incomeMinor: 0,
      outstandingMinor: 200_000,
      overdueMinor: 200_000,
      advanceOpenMinor: 200_000,
      unconverted: NONE_BY_METRIC,
    });
    expect(agingBands(db, s.owner, filter({ range }), TODAY).bands.days31to60).toBe(200_000);
    expect(summary(s.owner, { range, customerIds: [s.customers.alfa] })).toMatchObject({
      outstandingMinor: 0,
      advanceOpenMinor: 0,
    });
    expect(summary(s.owner, { range, currency: "EUR" }).outstandingMinor).toBe(0);
  });

  test("souhrn čte součty i chybějící kurzy v jedné čtecí transakci", () => {
    const spy = vi.spyOn(db, "transaction");
    try {
      summary(s.owner);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]![1]).toEqual({ behavior: "deferred" });
    } finally {
      spy.mockRestore();
    }
  });

  test("přehled souhlasí s invoiceSummary pro každou měnu a období", () => {
    at(TODAY);
    const ranges = [
      YEAR,
      { from: "2025-01-01", to: "2025-12-31" },
      resolvePeriod("last_12_months", TODAY),
      { from: "2026-01-01", to: "2026-03-31" },
      { from: "2026-04-01", to: "2026-04-30" },
      { from: "2026-05-01", to: "2026-05-31" },
      { from: "2026-09-01", to: "2026-10-31" },
    ];
    try {
      for (const currency of ["CZK", "EUR"] as Currency[]) {
        const state = invoiceSummary(s.owner, { currency })[0];
        for (const range of ranges) {
          const listed = invoiceSummary(s.owner, { currency, from: range.from, to: range.to })[0];
          expect(summary(s.owner, { range, currency }), `${currency} ${range.from}`).toMatchObject({
            invoicedMinor: listed?.invoicedMinor ?? 0,
            overdueMinor: state?.overdueMinor ?? 0,
            advanceOpenMinor: state?.advanceOpenMinor ?? 0,
          });
        }
      }
    } finally {
      setClockForTests(null);
    }
  });

  test("dny do úhrady: 17 a 9 dní dají průměr 13", () => {
    const alfa = filter({ customerIds: [s.customers.alfa] });
    expect(paymentDays(db, s.owner, alfa)).toEqual({ averageDays: 13, count: 2 });
    expect(paymentDays(db, s.owner, { ...alfa, includeExternal: false })).toEqual({
      averageDays: 17,
      count: 1,
    });
    expect(averagePaymentDays(s.owner, s.customers.alfa)).toBe(13);
  });

  test("žebříčky zákazníků, položek a měn dají dohromady fakturaci", () => {
    const customers = topCustomers(db, s.owner, filter());
    expect(customers.rows.map((row) => [row.name, row.amountMinor])).toEqual([
      ["Beta GmbH", 2_250_000],
      ["Alfa s.r.o.", 1_360_000],
      ["Gama a.s.", 800_000],
    ]);
    const top = topCustomers(db, s.owner, filter(), 1).rows;
    expect(top.map((row) => [row.kind, row.amountMinor])).toEqual([
      ["row", 2_250_000],
      ["others", 2_160_000],
    ]);

    const items = topItems(db, s.owner, filter());
    expect(items.rows).toEqual([
      { kind: "row", key: "name:Konzultace", name: "Konzultace", amountMinor: 4_410_000 },
    ]);

    expect(currencyShares(db, s.owner, filter()).rows).toEqual([
      { currency: "CZK", amountMinor: 2_160_000, czkMinor: 2_160_000 },
      { currency: "EUR", amountMinor: 90_000, czkMinor: 2_250_000 },
    ]);
    expect(reports.reportSummary(s.owner, filter(), TODAY).invoicedMinor).toBe(4_410_000);
  });
});

describe("účty mimo scénář", () => {
  test("[REP-008] doklady bez zákazníka se v žebříčku nesloučí do jednoho řádku", () => {
    const owner = reportOwner(db);
    const own = namedCustomer(owner, "Alfa s.r.o.");
    issuedDocument(owner, own, { issueDate: "2026-02-02", totalMinor: 10_000 });
    for (const [customerName, totalMinor] of [
      ["Import A s.r.o.", 30_000],
      ["Import B s.r.o.", 20_000],
      ["Import A s.r.o.", 5_000],
    ] as const) {
      externalInvoice(db, owner, { customerName, totalMinor, issueDate: "2026-03-01" });
    }

    const rows = topCustomers(db, owner, filter()).rows;
    expect(rows.map((row) => [row.name, row.amountMinor])).toEqual([
      ["Import A s.r.o.", 35_000],
      ["Import B s.r.o.", 20_000],
      ["Alfa s.r.o.", 10_000],
    ]);
    expect(rows[2]!.key).toBe(own);
    assertConsistent(db, owner);
  });

  test("[ADV-005] uhrazená záloha bez konečné faktury je příjem a není fakturováno", () => {
    const owner = reportOwner(db);
    const customerId = namedCustomer(owner, "Epsilon s.r.o.");
    const advance = issuedDocument(owner, customerId, {
      type: "advance",
      issueDate: "2026-02-02",
      totalMinor: 100_000,
    });
    pay(owner, advance, "2026-02-05", 100_000);

    expect(summary(owner)).toMatchObject({
      invoicedMinor: 0,
      incomeMinor: 100_000,
      outstandingMinor: 0,
      advanceOpenMinor: 0,
    });
    assertConsistent(db, owner);
  });

  test("[REP-008] konečná faktura po částečné záloze má v pohledávkách jen doplatek", () => {
    const owner = reportOwner(db);
    const customerId = namedCustomer(owner, "Zeta s.r.o.");
    const advance = issuedDocument(owner, customerId, {
      type: "advance",
      issueDate: "2026-03-02",
      dueDate: "2026-03-16",
      totalMinor: 500_000,
    });
    pay(owner, advance, "2026-03-05", 200_000);
    at("2026-03-06");
    const { id: final } = convertAdvance(webActor(owner), advance);
    issue(owner, final);

    expect(summary(owner)).toMatchObject({
      invoicedMinor: 500_000,
      incomeMinor: 200_000,
      outstandingMinor: 300_000,
      advanceOpenMinor: 0,
    });
    assertConsistent(db, owner);
  });

  test("[REP-009] 0,01 EUR dvakrát při 24,380000 dá 0,48 Kč, zaokrouhluje se po dokladech", () => {
    const owner = reportOwner(db);
    const customerId = namedCustomer(owner, "Éta s.r.o.");
    for (const day of ["2026-03-02", "2026-03-03"]) {
      issuedDocument(owner, customerId, {
        issueDate: day,
        totalMinor: 1,
        currency: "EUR",
        rateMicros: 24_380_000,
      });
    }
    expect(summary(owner).invoicedMinor).toBe(48);
    expect(summary(owner, { currency: "EUR" }).invoicedMinor).toBe(2);
    assertConsistent(db, owner);
  });

  test("[REP-009] platba bez kurzu vezme lístek do 7 dnů zpět a jinak je v unconverted s částkou", () => {
    const owner = reportOwner(db);
    const customerId = namedCustomer(owner, "Théta GmbH");
    const id = issuedDocument(owner, customerId, {
      issueDate: "2025-06-01",
      dueDate: "2025-06-30",
      totalMinor: 100_000,
      currency: "EUR",
      rateMicros: 25_000_000,
    });
    pay(owner, id, "2025-06-10", 10_000, "EUR");
    pay(owner, id, "2025-06-11", 20_000, "EUR");
    db.insert(exchangeRate)
      .values({
        currency: "EUR",
        listDate: "2025-06-03",
        rateMicros: 24_000_000,
        fetchedAt: new Date("2025-06-03T13:00:00Z"),
      })
      .run();
    const range = { from: "2025-01-01", to: "2025-12-31" };

    expect(summary(owner, { range })).toMatchObject({
      incomeMinor: 240_000,
      unconverted: {
        ...NONE_BY_METRIC,
        income: { count: 1, byCurrency: [{ currency: "EUR", amountMinor: 20_000 }] },
      },
    });
    expect(incomeSeries(db, owner, filter({ range }), "month").unconverted).toEqual({
      count: 1,
      byCurrency: [{ currency: "EUR", amountMinor: 20_000 }],
    });
    expect(db.select().from(payment).where(eq(payment.userId, owner)).all()).toHaveLength(2);
    expect(
      db
        .select({ rate: payment.rateMicros })
        .from(payment)
        .where(eq(payment.userId, owner))
        .all()
        .every((row) => row.rate === null),
    ).toBe(true);
    assertConsistent(db, owner);
  });

  test("[FOR-008] doklad bez kurzu se nesečte mlčky a přehled uvede počet i měnu", () => {
    const owner = reportOwner(db);
    const customerId = namedCustomer(owner, "Ióta GmbH");
    const id = issuedDocument(owner, customerId, {
      issueDate: "2026-03-02",
      dueDate: "2026-03-16",
      totalMinor: 100_000,
      currency: "EUR",
      rateMicros: 25_000_000,
    });
    issuedDocument(owner, customerId, { issueDate: "2026-03-02", totalMinor: 50_000 });
    pay(owner, id, "2026-03-20", 40_000, "EUR");
    db.update(invoice).set({ exchangeRateMicros: null }).where(eq(invoice.id, id)).run();
    const eur = (amountMinor: number) => ({
      count: 1,
      byCurrency: [{ currency: "EUR", amountMinor }],
    });
    const unconverted = eur(100_000);

    expect(summary(owner)).toEqual({
      invoicedMinor: 50_000,
      incomeMinor: 0,
      outstandingMinor: 50_000,
      overdueMinor: 50_000,
      advanceOpenMinor: 0,
      unconverted: {
        invoiced: unconverted,
        income: eur(40_000),
        outstanding: eur(60_000),
        overdue: eur(60_000),
        advanceOpen: NONE,
      },
    });
    expect(summary(owner, { currency: "EUR" })).toEqual({
      invoicedMinor: 100_000,
      incomeMinor: 40_000,
      outstandingMinor: 60_000,
      overdueMinor: 60_000,
      advanceOpenMinor: 0,
      unconverted: NONE_BY_METRIC,
    });
    expect(invoicedSeries(db, owner, filter(), "year")).toEqual({
      points: [{ key: "2026", amountMinor: 50_000 }],
      unconverted,
    });
    expect(topCustomers(db, owner, filter()).unconverted).toEqual(unconverted);
    expect(topItems(db, owner, filter()).unconverted).toEqual(unconverted);
    expect(currencyShares(db, owner, filter())).toEqual({
      rows: [{ currency: "CZK", amountMinor: 50_000, czkMinor: 50_000 }],
      unconverted,
    });
    expect(agingBands(db, owner, filter(), TODAY).unconverted).toEqual(eur(60_000));
  });

  function agingAccount(dueDates: string[]) {
    const owner = reportOwner(db);
    const customerId = namedCustomer(owner, "Kappa s.r.o.");
    dueDates.forEach((dueDate, i) =>
      issuedDocument(owner, customerId, {
        issueDate: "2026-07-01",
        dueDate,
        totalMinor: 100 * 2 ** i,
      }),
    );
    return owner;
  }

  test("[REP-002] dnes 2. 11.: splatnost 3. 10. je 0–30, 2. 10. je 31–60, 3. 9. je 31–60, 2. 9. je 61–90, 4. 8. je 61–90, 3. 8. je 90+", () => {
    const owner = agingAccount([
      "2026-10-03",
      "2026-10-02",
      "2026-09-03",
      "2026-09-02",
      "2026-08-04",
      "2026-08-03",
    ]);
    expect(agingBands(db, owner, filter(), TODAY).bands).toEqual({
      current: 0,
      days0to30: 100,
      days31to60: 600,
      days61to90: 2_400,
      days90plus: 3_200,
    });
  });

  test("[REP-002] splatnost dnes je ve splatnosti a součet čtyř pásem je overdueMinor", () => {
    const owner = agingAccount(["2026-11-02", "2026-11-20", "2026-11-01", "2026-07-01"]);
    const { bands } = agingBands(db, owner, filter(), TODAY);
    expect(bands).toEqual({
      current: 300,
      days0to30: 400,
      days31to60: 0,
      days61to90: 0,
      days90plus: 800,
    });
    const overdue = bands.days0to30 + bands.days31to60 + bands.days61to90 + bands.days90plus;
    expect(summary(owner)).toMatchObject({ overdueMinor: overdue, outstandingMinor: 1_500 });
  });

  test("vrácení -1 500,00 v červnu sníží příjmy června a nezmění květen", () => {
    const owner = reportOwner(db);
    const customerId = namedCustomer(owner, "Lambda s.r.o.");
    const id = issuedDocument(owner, customerId, {
      issueDate: "2026-05-01",
      dueDate: "2026-05-15",
      totalMinor: 300_000,
    });
    pay(owner, id, "2026-05-20", 300_000);
    at("2026-06-10");
    addRefund(webActor(owner), id, {
      revision: getInvoice(owner, id)!.revision,
      paidOn: "2026-06-10",
      amountMinor: 150_000,
      currency: "CZK",
      method: "transfer",
      note: "",
    });

    expect(incomeMonths(owner)).toMatchObject({ "2026-05": 300_000, "2026-06": -150_000 });
    expect(summary(owner)).toMatchObject({ incomeMinor: 150_000, outstandingMinor: 150_000 });
    assertConsistent(db, owner);
  });

  test("řádek difference 0,40 Kč není příjem ani neposouvá dny do úhrady", () => {
    const owner = reportOwner(db);
    const customerId = namedCustomer(owner, "My s.r.o.");
    const quick = issuedDocument(owner, customerId, {
      issueDate: "2026-03-01",
      totalMinor: 50_000,
    });
    pay(owner, quick, "2026-03-05", 50_000);
    const id = issuedDocument(owner, customerId, {
      issueDate: "2026-03-01",
      dueDate: "2026-03-15",
      totalMinor: 100_040,
    });
    pay(owner, id, "2026-03-10", 100_000);
    at("2026-03-30");
    closeDifference(webActor(owner), id, {
      revision: getInvoice(owner, id)!.revision,
      confirmed: true,
    });

    expect(getInvoice(owner, id)!.status).toBe("paid");
    expect(summary(owner).incomeMinor).toBe(150_000);
    expect(incomeMonths(owner)["2026-03"]).toBe(150_000);
    expect(paymentDays(db, owner, filter())).toEqual({ averageDays: 4, count: 1 });
    assertConsistent(db, owner);
  });

  test("položky končí řádkem slevy dokladu a součet sedí s fakturací", () => {
    const owner = reportOwner(db);
    const customerId = namedCustomer(owner, "Ný s.r.o.");
    issuedDocument(owner, customerId, {
      issueDate: "2026-03-02",
      over: {
        lines: [line(60_000, "Návrh"), line(40_000, "Konzultace")],
        discountKind: "amount",
        discountValue: 10_000,
      },
    });
    issuedDocument(owner, customerId, {
      type: "advance",
      issueDate: "2026-03-02",
      totalMinor: 70_000,
    });

    expect(topItems(db, owner, filter()).rows).toEqual([
      { kind: "row", key: "name:Návrh", name: "Návrh", amountMinor: 60_000 },
      { kind: "row", key: "name:Konzultace", name: "Konzultace", amountMinor: 40_000 },
      { kind: "adjustment", key: "adjustment", name: "", amountMinor: -10_000 },
    ]);
    expect(summary(owner).invoicedMinor).toBe(90_000);
  });

  test("cizí customerId ve filtru vrátí prázdný výsledek", () => {
    const stranger = reportOwner(db);
    const foreign = namedCustomer(stranger, "Cizí s.r.o.");
    issuedDocument(stranger, foreign, { issueDate: "2026-03-02", totalMinor: 99_900 });

    const empty = summary(s.owner, { customerIds: [foreign] });
    expect(empty).toEqual({
      invoicedMinor: 0,
      incomeMinor: 0,
      outstandingMinor: 0,
      overdueMinor: 0,
      advanceOpenMinor: 0,
      unconverted: NONE_BY_METRIC,
    });
    expect(summary(s.owner, { customerIds: [] }).invoicedMinor).toBe(0);
    expect(summary(s.owner, { customerIds: [foreign, s.customers.alfa] })).toMatchObject({
      invoicedMinor: 1_360_000,
      incomeMinor: 1_360_000,
    });
    expect(topCustomers(db, s.owner, filter({ customerIds: [foreign] })).rows).toEqual([]);
    expect(topItems(db, s.owner, filter({ customerIds: [foreign] })).rows).toEqual([]);
    expect(currencyShares(db, s.owner, filter({ customerIds: [foreign] })).rows).toEqual([]);
    expect(paymentDays(db, s.owner, filter({ customerIds: [foreign] }))).toEqual({
      averageDays: null,
      count: 0,
    });
    expect(
      invoicedSeries(db, s.owner, filter({ customerIds: [foreign] }), "quarter").points,
    ).toEqual(["2026-Q1", "2026-Q2", "2026-Q3", "2026-Q4"].map((key) => ({ key, amountMinor: 0 })));
    expect(
      Object.values(agingBands(db, s.owner, filter({ customerIds: [foreign] }), TODAY).bands),
    ).toEqual([0, 0, 0, 0, 0]);
    expect(summary(stranger, { customerIds: [s.customers.alfa] }).invoicedMinor).toBe(0);
  });

  test("platba cizího účtu spojená s vlastním dokladem se nepočítá", () => {
    const owner = reportOwner(db);
    const stranger = reportOwner(db);
    const customerId = namedCustomer(owner, "Ksí s.r.o.");
    const id = issuedDocument(owner, customerId, { issueDate: "2026-03-02", totalMinor: 100_000 });
    const now = new Date("2026-03-03T10:00:00Z");
    db.insert(payment)
      .values({
        id: randomUUID(),
        userId: stranger,
        invoiceId: id,
        kind: "payment",
        paidOn: "2026-03-03",
        amountMinor: 70_000,
        currency: "CZK",
        creditedMinor: 70_000,
        method: "transfer",
        source: "manual",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    expect(summary(owner).incomeMinor).toBe(0);
    expect(summary(stranger).incomeMinor).toBe(0);
    expect(incomeMonths(owner)["2026-03"]).toBe(0);
    expect(incomeMonths(stranger)["2026-03"]).toBe(0);
    expect(paymentDays(db, owner, filter())).toEqual({ averageDays: null, count: 0 });
  });
});
