import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { setClockForTests } from "@/server/clock";
import { exchangeRate, invoice, recurringInvoice, recurringRun } from "@/server/db/schema";
import { forecast, type ForecastSeries } from "@/server/reports/forecast";
import { TEXTS } from "@/lib/texts";
import { convertAdvance } from "@/server/services/advances";
import { getInvoice, saveDraft } from "@/server/services/invoices";
import { resolveRate } from "@/server/services/exchange-rates";
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

vi.mock("@/server/services/exchange-rates", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/services/exchange-rates")>();
  return { ...actual, resolveRate: vi.fn(actual.resolveRate) };
});

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

  test("[REP-003] koncept konečné faktury po záloze přidá doplatek k připraveným konceptům", () => {
    const { owner, customer } = account();
    const advance = issuedDocument(owner, customer, {
      type: "advance",
      issueDate: "2026-10-25",
      dueDate: "2026-11-30",
      totalMinor: 70_000,
    });
    pay(owner, advance, REPORT_TODAY, 70_000);
    const final = db.select().from(invoice).where(eq(invoice.relatedInvoiceId, advance)).get()!;
    expect(final).toMatchObject({ status: "draft", type: "invoice", advanceMinor: 70_000 });
    db.update(invoice).set({ totalMinor: 100_000 }).where(eq(invoice.id, final.id)).run();
    at(REPORT_TODAY);

    expect(series(owner, "plannedDrafts")).toEqual([0, 30_000, 0, 0, 0, 0]);
    expect(series(owner, "advances")).toEqual([0, 0, 0, 0, 0, 0]);
  });

  test("[REP-003] kurz výskytu se odvodí z dnešního data, ne z hodin", () => {
    const { owner, customer } = account();
    for (const [listDate, rateMicros] of [
      ["2026-10-30", 30_000_000],
      ["2026-11-02", 31_000_000],
    ] as const) {
      db.insert(exchangeRate)
        .values({
          currency: "GBP",
          listDate,
          rateMicros,
          fetchedAt: new Date(`${listDate}T13:00:00Z`),
        })
        .onConflictDoNothing()
        .run();
    }
    // The first occurrence is today, the only day whose rate depends on the hour of publication.
    plan(owner, customer, {
      issueDay: 2,
      document: planDocument({ currency: "GBP", paymentMethod: "cash" }),
    });
    const at = (iso: string) => {
      setClockForTests({ now: () => new Date(iso) });
      return forecast(db, owner, REPORT_TODAY).map((month) => month.planned);
    };

    const morning = at(`${REPORT_TODAY}T08:00:00Z`);
    const afternoon = at(`${REPORT_TODAY}T15:00:00Z`);
    const later = at("2027-03-01T08:00:00Z");

    expect(morning).toEqual(afternoon);
    expect(later).toEqual(afternoon);
    expect(morning[0]).toBeGreaterThan(0);
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

describe("převedená záloha v předpovědi", () => {
  const sum = (owner: string, name: ForecastSeries) =>
    series(owner, name).reduce((total, value) => total + value, 0);
  const expected = (owner: string) => sum(owner, "advances") + sum(owner, "plannedDrafts");

  function converted(owner: string, customer: string) {
    const advance = issuedDocument(owner, customer, {
      type: "advance",
      issueDate: "2026-10-25",
      dueDate: "2026-11-30",
      totalMinor: 7_000_000,
    });
    at(REPORT_TODAY);
    const final = convertAdvance(webActor(owner), advance).id;
    return { advance, final };
  }

  test("[REP-003] neuhrazená záloha 70 000,00 a její koncept dají 70 000,00, ne 140 000,00", () => {
    const { owner, customer } = account();
    converted(owner, customer);
    at(REPORT_TODAY);

    expect(expected(owner)).toBe(7_000_000);
    expect(sum(owner, "advances")).toBe(7_000_000);
    expect(sum(owner, "plannedDrafts")).toBe(0);
  });

  test("[REP-003] záloha uhrazená 30 000,00 dá 40 000,00 a koncept 0", () => {
    const { owner, customer } = account();
    const { advance } = converted(owner, customer);
    pay(owner, advance, REPORT_TODAY, 3_000_000);
    at(REPORT_TODAY);

    expect(expected(owner)).toBe(4_000_000);
    expect(sum(owner, "advances")).toBe(4_000_000);
    expect(sum(owner, "plannedDrafts")).toBe(0);
  });

  test("[REP-003] koncept 100 000,00 po neuhrazené záloze 70 000,00 dá 70 000,00 + 30 000,00", () => {
    const { owner, customer } = account();
    const { final } = converted(owner, customer);
    db.update(invoice).set({ totalMinor: 10_000_000 }).where(eq(invoice.id, final)).run();
    at(REPORT_TODAY);

    expect(sum(owner, "advances")).toBe(7_000_000);
    expect(sum(owner, "plannedDrafts")).toBe(3_000_000);
  });

  test("[REP-003] po úhradě celé zálohy zůstane jen doplatek 30 000,00 v plannedDrafts", () => {
    const { owner, customer } = account();
    const { advance, final } = converted(owner, customer);
    db.update(invoice).set({ totalMinor: 10_000_000 }).where(eq(invoice.id, final)).run();
    pay(owner, advance, REPORT_TODAY, 7_000_000);
    at(REPORT_TODAY);

    expect(sum(owner, "advances")).toBe(0);
    expect(sum(owner, "plannedDrafts")).toBe(3_000_000);
  });

  test("[REP-003] koncept nevidí zálohu cizího účtu se stejným ID vazby", () => {
    const mine = account();
    const { final } = converted(mine.owner, mine.customer);
    const other = account();
    const foreign = issuedDocument(other.owner, other.customer, {
      type: "advance",
      issueDate: "2026-10-25",
      dueDate: "2026-11-30",
      totalMinor: 9_000_000,
    });
    db.update(invoice)
      .set({ relatedInvoiceId: foreign, totalMinor: 10_000_000 })
      .where(eq(invoice.id, final))
      .run();
    at(REPORT_TODAY);

    expect(sum(mine.owner, "plannedDrafts")).toBe(10_000_000);
  });
});

describe("převedená záloha, okrajové stavy", () => {
  function converted(owner: string, customer: string) {
    const advance = issuedDocument(owner, customer, {
      type: "advance",
      issueDate: "2026-10-25",
      dueDate: "2026-11-30",
      totalMinor: 7_000_000,
    });
    at(REPORT_TODAY);
    return { advance, final: convertAdvance(webActor(owner), advance).id };
  }
  const total = (owner: string, name: ForecastSeries) =>
    series(owner, name).reduce((sum, value) => sum + value, 0);

  test("[REP-003] zrušená záloha se od konceptu neodečte", () => {
    const { owner, customer } = account();
    const { advance, final } = converted(owner, customer);
    db.update(invoice).set({ totalMinor: 10_000_000 }).where(eq(invoice.id, final)).run();
    // cancelInvoice refuses an advance with a final invoice, so the state is written directly.
    db.update(invoice).set({ status: "cancelled" }).where(eq(invoice.id, advance)).run();
    at(REPORT_TODAY);

    expect(total(owner, "advances")).toBe(0);
    expect(total(owner, "plannedDrafts")).toBe(10_000_000);
  });

  test("[REP-003] koncept po záloze nejde převést do jiné měny, odečet je vždy v téže měně", () => {
    const { owner, customer } = account();
    const { final } = converted(owner, customer);
    const { lines, ...doc } = getInvoice(owner, final)!;

    expect(() =>
      saveDraft(webActor(owner), {
        ...doc,
        currency: "EUR",
        exchangeRateMicros: 25_000_000,
        paymentMethod: "cash",
        bankAccountId: null,
        lines: lines.map((item) => ({
          catalogItemId: item.catalogItemId,
          name: item.name,
          description: item.description,
          quantityMilli: item.quantityMilli,
          unit: item.unit,
          unitPriceMinor: item.unitPriceMinor,
          discountKind: item.discountKind,
          discountValue: item.discountValue,
        })),
      }),
    ).toThrow(TEXTS.invoices.validation.linkedLocked);
    expect(getInvoice(owner, final)!.currency).toBe("CZK");
  });
});

describe("kurzy v předpovědi", () => {
  test("[REP-003] 200 konceptů v EUR se stejným datem zavolá resolveRate jednou", () => {
    const { owner, customer } = account();
    db.insert(exchangeRate)
      .values({
        currency: "EUR",
        listDate: "2026-10-30",
        rateMicros: 25_000_000,
        fetchedAt: new Date("2026-10-30T13:00:00Z"),
      })
      .onConflictDoNothing()
      .run();
    const id = plan(owner, customer, { startsOn: "2027-06-01" });
    for (let index = 0; index < 200; index++) {
      draftDocument(owner, customer, {
        issueDate: "2026-11-01",
        dueDate: "2026-12-10",
        currency: "EUR",
        totalMinor: 1_000,
      });
    }
    db.update(invoice).set({ recurringId: id }).where(eq(invoice.userId, owner)).run();
    at(REPORT_TODAY);
    vi.mocked(resolveRate).mockClear();

    const [, december] = forecast(db, owner, REPORT_TODAY);

    expect(vi.mocked(resolveRate)).toHaveBeenCalledTimes(1);
    expect(december!.unconverted.plannedDrafts.count).toBe(0);
    expect(december!.plannedDrafts).toBeGreaterThan(0);
  });
});

describe("meze předpovědi", () => {
  test("neplatné datum a počet měsíců jsou chyba", () => {
    const { owner } = account();

    expect(() => forecast(db, owner, "2026-13-40")).toThrow(RangeError);
    expect(() => forecast(db, owner, REPORT_TODAY, 0)).toThrow(RangeError);
  });
});
