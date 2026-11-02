import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { setClockForTests } from "@/server/clock";
import { invoice, recurringInvoice, recurringRun } from "@/server/db/schema";
import { forecast, type ForecastSeries } from "@/server/reports/forecast";
import { pauseRecurring } from "@/server/services/recurring-run";
import {
  at,
  draftDocument,
  issuedDocument,
  namedCustomer,
  pay,
  REPORT_TODAY,
  reportOwner,
} from "../fixtures/report-scenario";
import { createTestDb } from "../helpers/db";
import { webActor } from "../helpers/fixtures-mail";
import { planDocument, savePlan } from "../helpers/fixtures-recurring";

vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-forecast-")));

const db = createTestDb();
const MONTHS = ["2026-11", "2026-12", "2027-01", "2027-02", "2027-03", "2027-04"];

beforeAll(() => setClockForTests(null));
afterAll(() => setClockForTests(null));

function account() {
  const owner = reportOwner(db);
  const customer = namedCustomer(owner, "Alfa s.r.o.");
  return { owner, customer };
}

const plan = (owner: string, customer: string, over: Parameters<typeof savePlan>[2] = {}) => {
  at(REPORT_TODAY);
  return savePlan(owner, customer, { startsOn: "2026-11-01", ...over });
};

const series = (owner: string, name: ForecastSeries) =>
  forecast(db, owner, REPORT_TODAY).map((month) => month[name]);

describe("předpověď příjmů", () => {
  test("[REP-003] plán 1 000,00 Kč měsíčně, dnes 2. 11. 2026, dá šest měsíčních částek", () => {
    const { owner, customer } = account();
    plan(owner, customer);

    const months = forecast(db, owner, REPORT_TODAY);

    expect(months.map((month) => month.month)).toEqual(MONTHS);
    expect(months.map((month) => month.planned)).toEqual(Array(6).fill(100_000));
    expect(months.every((month) => month.open === 0 && month.overdue === 0)).toBe(true);
  });

  test("[REP-003] týdenní plán má v měsíci víc částek", () => {
    const { owner, customer } = account();
    plan(owner, customer, { frequency: "weekly", issueDay: 1, issueRule: "day" });

    const [november] = forecast(db, owner, REPORT_TODAY);

    expect(november!.planned).toBeGreaterThan(100_000);
    expect(november!.planned % 100_000).toBe(0);
  });

  test("[REP-003] po splatnosti 2 000,00 spadne do listopadu ve vlastní sérii", () => {
    const { owner, customer } = account();
    issuedDocument(owner, customer, {
      issueDate: "2026-09-01",
      dueDate: "2026-10-15",
      totalMinor: 200_000,
    });
    issuedDocument(owner, customer, {
      issueDate: "2026-11-01",
      dueDate: "2026-12-20",
      totalMinor: 40_000,
    });
    issuedDocument(owner, customer, {
      issueDate: "2026-11-01",
      dueDate: "2027-09-01",
      totalMinor: 9_000,
    });
    at(REPORT_TODAY);

    expect(series(owner, "overdue")).toEqual([200_000, 0, 0, 0, 0, 0]);
    expect(series(owner, "open")).toEqual([0, 40_000, 0, 0, 0, 0]);
  });

  test("[REP-003] částečně uhrazená faktura se počítá zbytkem a doplacená vůbec", () => {
    const { owner, customer } = account();
    const partial = issuedDocument(owner, customer, {
      issueDate: "2026-10-20",
      dueDate: "2026-11-20",
      totalMinor: 100_000,
    });
    pay(owner, partial, "2026-10-25", 30_000);
    const paid = issuedDocument(owner, customer, {
      issueDate: "2026-10-20",
      dueDate: "2026-11-20",
      totalMinor: 50_000,
    });
    pay(owner, paid, "2026-10-25", 50_000);
    at(REPORT_TODAY);

    expect(series(owner, "open")[0]).toBe(70_000);
  });

  test("[REP-003] pozastavený plán, plán po konci a plán s vyčerpaným maxCount nic nepřidají", () => {
    const { owner, customer } = account();
    const paused = plan(owner, customer, { name: "Pozastavený" });
    pauseRecurring(webActor(owner), paused);
    plan(owner, customer, { name: "Skončil", startsOn: "2026-03-01", endsOn: "2026-10-31" });
    const exhausted = plan(owner, customer, { name: "Vyčerpaný", maxCount: 1 });
    db.insert(recurringRun)
      .values({
        id: randomUUID(),
        userId: owner,
        recurringId: exhausted,
        periodKey: "2026-11-01",
        plannedDate: "2026-11-10",
        periodFrom: "2026-11-01",
        periodTo: "2026-11-30",
        status: "created",
        createdAt: new Date(),
      })
      .run();
    db.update(recurringInvoice)
      .set({ cursorDate: "2026-11-10" })
      .where(eq(recurringInvoice.id, exhausted))
      .run();

    expect(series(owner, "planned")).toEqual([0, 0, 0, 0, 0, 0]);
  });

  test("[REP-003] vystavený výskyt se nezapočte dvakrát", () => {
    const { owner, customer } = account();
    const id = plan(owner, customer);
    const issued = issuedDocument(owner, customer, {
      issueDate: "2026-11-01",
      dueDate: "2026-11-24",
      totalMinor: 100_000,
    });
    db.update(invoice).set({ recurringId: id }).where(eq(invoice.id, issued)).run();
    db.update(recurringInvoice)
      .set({ cursorDate: "2026-11-10" })
      .where(eq(recurringInvoice.id, id))
      .run();
    at(REPORT_TODAY);

    const months = forecast(db, owner, REPORT_TODAY);

    expect(months.map((month) => month.planned)).toEqual([
      0, 100_000, 100_000, 100_000, 100_000, 100_000,
    ]);
    expect(months[0]!.open).toBe(100_000);
  });

  test("[REP-003] koncept z plánu je vlastní série a ruční koncept se nepočítá", () => {
    const { owner, customer } = account();
    const id = plan(owner, customer, { startsOn: "2027-06-01" });
    const fromPlan = draftDocument(owner, customer, {
      issueDate: "2026-11-01",
      dueDate: "2026-12-10",
      totalMinor: 60_000,
    });
    db.update(invoice).set({ recurringId: id }).where(eq(invoice.id, fromPlan)).run();
    draftDocument(owner, customer, {
      issueDate: "2026-11-01",
      dueDate: "2026-12-10",
      totalMinor: 8_000,
    });
    at(REPORT_TODAY);

    expect(series(owner, "plannedDrafts")).toEqual([0, 60_000, 0, 0, 0, 0]);
    expect(series(owner, "open")).toEqual([0, 0, 0, 0, 0, 0]);
  });

  test("[REP-003] plán v EUR bez kurzu je v unconverted", () => {
    const { owner, customer } = account();
    plan(owner, customer, { document: planDocument({ currency: "EUR", paymentMethod: "cash" }) });

    const [november] = forecast(db, owner, REPORT_TODAY);

    expect(november!.planned).toBe(0);
    expect(november!.unconverted.planned).toEqual({
      count: 1,
      byCurrency: [{ currency: "EUR", amountMinor: 100_000 }],
    });
  });

  test("[REP-003] konečná faktura po záloze se počítá jen doplatkem a záloha je ve své sérii", () => {
    const { owner, customer } = account();
    const final = issuedDocument(owner, customer, {
      issueDate: "2026-10-20",
      dueDate: "2026-12-05",
      totalMinor: 500_000,
    });
    // The advance is settled on the final invoice, which then asks only for the rest.
    db.update(invoice).set({ advanceMinor: 200_000 }).where(eq(invoice.id, final)).run();
    issuedDocument(owner, customer, {
      type: "advance",
      issueDate: "2026-10-25",
      dueDate: "2026-11-30",
      totalMinor: 70_000,
    });
    at(REPORT_TODAY);

    expect(series(owner, "open")).toEqual([0, 300_000, 0, 0, 0, 0]);
    expect(series(owner, "advances")).toEqual([70_000, 0, 0, 0, 0, 0]);
  });

  test("předpověď ani limity nevidí data cizího účtu", () => {
    const mine = account();
    issuedDocument(mine.owner, mine.customer, {
      issueDate: "2026-10-20",
      dueDate: "2026-11-20",
      totalMinor: 100_000,
    });
    plan(mine.owner, mine.customer);
    const other = account();
    at(REPORT_TODAY);

    expect(
      forecast(db, other.owner, REPORT_TODAY).flatMap((month) => [month.open, month.planned]),
    ).toEqual(Array(12).fill(0));
    expect(series(mine.owner, "open")[0]).toBe(100_000);
  });

  test("[REP-003] předpověď nic nezapisuje", () => {
    const { owner, customer } = account();
    plan(owner, customer);
    const before = db.select().from(recurringInvoice).all();
    const drafts = db.select().from(invoice).all().length;

    forecast(db, owner, REPORT_TODAY);

    expect(db.select().from(recurringInvoice).all()).toEqual(before);
    expect(db.select().from(invoice).all()).toHaveLength(drafts);
  });
});

describe("meze předpovědi", () => {
  test("neplatné datum a počet měsíců jsou chyba", () => {
    const { owner } = account();

    expect(() => forecast(db, owner, "2026-13-40")).toThrow(RangeError);
    expect(() => forecast(db, owner, REPORT_TODAY, 0)).toThrow(RangeError);
  });
});
