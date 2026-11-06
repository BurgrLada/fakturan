import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
  FLAT_TAX_LIMIT_MINOR,
  LIMIT_HIGH_PERCENT,
  LIMIT_WARN_PERCENT,
  VAT_REGISTRATION_LIMIT_MINOR,
} from "@/lib/turnover-limits";
import { setClockForTests } from "@/server/clock";
import { invoice } from "@/server/db/schema";
import { limitStates, turnover, type LimitState } from "@/server/reports/turnover";
import { cancelInvoice } from "@/server/services/invoice-lifecycle";
import "@/server/services/limit-alerts";
import { derivedAlerts, unreadCount } from "@/server/services/notifications";
import { getPreferences, savePreferences } from "@/server/services/preferences";
import {
  at,
  creditNote,
  draftDocument,
  issuedDocument,
  namedCustomer,
  pay,
  REPORT_TODAY,
  reportOwner,
} from "../fixtures/report-scenario";
import { createTestDb } from "../helpers/db";
import { webActor } from "../helpers/fixtures-mail";

vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-turnover-")));

const db = createTestDb();

beforeAll(() => setClockForTests(null));
afterAll(() => setClockForTests(null));

function account() {
  const owner = reportOwner(db);
  return { owner, customer: namedCustomer(owner, "Alfa s.r.o.") };
}

function withTurnover(totalMinor: number) {
  const { owner, customer } = account();
  issuedDocument(owner, customer, { issueDate: "2026-03-01", totalMinor });
  at(REPORT_TODAY);
  return owner;
}

const vat = (owner: string) =>
  limitStates(db, owner, 2026).find((s) => s.key === "vat")! as LimitState & { level?: string };

describe("obrat", () => {
  test("[REP-005] obrat za rok jde podle DUZP a bez něj podle data vystavení", () => {
    const { owner, customer } = account();
    issuedDocument(owner, customer, {
      issueDate: "2026-12-30",
      totalMinor: 100_000,
      over: { taxableDate: "2027-01-02" },
    });
    issuedDocument(owner, customer, { issueDate: "2026-05-01", totalMinor: 30_000 });
    issuedDocument(owner, customer, {
      issueDate: "2026-06-01",
      totalMinor: 7_000,
      over: { taxableDate: "2026-05-31" },
    });

    expect(turnover(db, owner, 2026, "taxable").minor).toBe(37_000);
    expect(turnover(db, owner, 2027, "taxable").minor).toBe(100_000);
  });

  test("[REP-005] faktura z 3. 1. 2027 s DUZP 31. 12. 2026 patří do roku 2026", () => {
    const { owner, customer } = account();
    issuedDocument(owner, customer, {
      issueDate: "2027-01-03",
      totalMinor: 250_000,
      over: { taxableDate: "2026-12-31" },
    });

    expect(turnover(db, owner, 2026, "taxable").minor).toBe(250_000);
    expect(turnover(db, owner, 2027, "taxable").minor).toBe(0);
  });

  test("[REP-005] oprava obrat snižuje a záloha do něj nevstupuje", () => {
    const { owner, customer } = account();
    const first = issuedDocument(owner, customer, { issueDate: "2026-03-01", totalMinor: 100_000 });
    creditNote(owner, first, "2026-04-01", -30_000);
    issuedDocument(owner, customer, {
      issueDate: "2026-05-01",
      totalMinor: 900_000,
      type: "advance",
    });

    expect(turnover(db, owner, 2026, "taxable").minor).toBe(70_000);
  });

  test("[REP-005] storno a koncept se do obratu nepočítají", () => {
    const { owner, customer } = account();
    const cancelled = issuedDocument(owner, customer, {
      issueDate: "2026-03-01",
      totalMinor: 5_000,
    });
    cancelInvoice(webActor(owner), cancelled);
    const draft = draftDocument(owner, customer, { issueDate: "2026-03-03", totalMinor: 9_000 });
    issuedDocument(owner, customer, { issueDate: "2026-03-02", totalMinor: 1_000 });

    expect(db.select().from(invoice).where(eq(invoice.id, draft)).get()!.status).toBe("draft");
    expect(turnover(db, owner, 2026, "taxable").minor).toBe(1_000);
  });

  test("[REP-005] přepnutí na datum úhrady započte uhrazenou zálohu k datu platby", () => {
    const { owner, customer } = account();
    const advance = issuedDocument(owner, customer, {
      issueDate: "2026-12-20",
      totalMinor: 200_000,
      type: "advance",
    });
    pay(owner, advance, "2027-01-05", 200_000);
    const regular = issuedDocument(owner, customer, {
      issueDate: "2026-06-01",
      totalMinor: 50_000,
    });
    pay(owner, regular, "2026-06-10", 50_000);

    savePreferences(webActor(owner), { turnoverBasis: "paid" });

    expect(turnover(db, owner, 2026, "paid").minor).toBe(50_000);
    expect(turnover(db, owner, 2027, "paid").minor).toBe(200_000);
    expect(turnover(db, owner, 2026, "taxable").minor).toBe(50_000);
    expect(limitStates(db, owner, 2027)[0]!.turnoverMinor).toBe(200_000);
  });

  test("[REP-005] doklad v EUR vstupuje kurzem faktury", () => {
    const { owner, customer } = account();
    issuedDocument(owner, customer, {
      issueDate: "2026-03-01",
      totalMinor: 100_000,
      currency: "EUR",
      rateMicros: 25_000_000,
    });

    expect(turnover(db, owner, 2026, "taxable")).toEqual({
      minor: 2_500_000,
      unconverted: { count: 0, byCurrency: [] },
    });
  });

  test("[REP-005] doklad v EUR bez kurzu je v unconverted a obrat ho nezapočte", () => {
    const { owner, customer } = account();
    const id = issuedDocument(owner, customer, {
      issueDate: "2026-03-01",
      totalMinor: 100_000,
      currency: "EUR",
      rateMicros: 25_000_000,
    });
    db.update(invoice).set({ exchangeRateMicros: null }).where(eq(invoice.id, id)).run();

    expect(turnover(db, owner, 2026, "taxable")).toEqual({
      minor: 0,
      unconverted: { count: 1, byCurrency: [{ currency: "EUR", amountMinor: 100_000 }] },
    });
  });

  test("předpověď ani limity nevidí data cizího účtu", () => {
    const mine = withTurnover(150_000_000);
    const other = account().owner;

    expect(turnover(db, other, 2026, "taxable").minor).toBe(0);
    expect(vat(other).turnoverMinor).toBe(0);
    expect(vat(mine).turnoverMinor).toBe(150_000_000);
  });
});

describe("limity", () => {
  test.each([
    [159_999_999, 79, "ok"],
    [160_000_000, 80, "warn"],
    [189_999_999, 94, "warn"],
    [190_000_000, 95, "high"],
    [200_000_000, 100, "high"],
    [200_000_001, 100, "over"],
  ])("[REP-005] obrat %i haléřů je %i %% a úroveň %s", (minor, percent, level) => {
    expect(vat(withTurnover(minor))).toMatchObject({
      limitMinor: 200_000_000,
      turnoverMinor: minor,
      percent,
      level,
    });
  });

  test("[REP-005] 1 599 999,99 je ok, 1 600 000,00 je 80 %, 1 899 999,99 je 80 %, 1 900 000,00 je 95 %, 2 000 000,01 je přes limit", () => {
    const levels = [159_999_999, 160_000_000, 189_999_999, 190_000_000, 200_000_001].map(
      (minor) => vat(withTurnover(minor)).level,
    );

    expect(levels).toEqual(["ok", "warn", "warn", "high", "over"]);
  });

  test("[REP-005] vlastní limit 1 000 000,00 posune práh na 800 000,00", () => {
    const below = withTurnover(79_999_999);
    const at80 = withTurnover(80_000_000);
    for (const owner of [below, at80]) {
      savePreferences(webActor(owner), { turnoverVatLimitMinor: 100_000_000 });
    }

    expect(vat(below)).toMatchObject({ limitMinor: 100_000_000, level: "ok" });
    expect(vat(at80)).toMatchObject({ limitMinor: 100_000_000, percent: 80, level: "warn" });
    expect(limitStates(db, at80, 2026).find((s) => s.key === "flat")!.limitMinor).toBe(
      FLAT_TAX_LIMIT_MINOR,
    );
  });

  test("[REP-005] účet bez vlastní hodnoty dostane zákonnou konstantu", () => {
    const { owner } = account();

    expect(getPreferences(owner)).toMatchObject({
      turnoverVatLimitMinor: null,
      turnoverFlatLimitMinor: null,
      turnoverBasis: "taxable",
      turnoverVatWatch: true,
      turnoverFlatWatch: true,
    });
    expect(limitStates(db, owner, 2026).map((s) => [s.key, s.limitMinor])).toEqual([
      ["vat", VAT_REGISTRATION_LIMIT_MINOR],
      ["flat", FLAT_TAX_LIMIT_MINOR],
    ]);
    expect([VAT_REGISTRATION_LIMIT_MINOR, FLAT_TAX_LIMIT_MINOR]).toEqual([
      200_000_000, 200_000_000,
    ]);
    expect([LIMIT_WARN_PERCENT, LIMIT_HIGH_PERCENT]).toEqual([80, 95]);
  });

  test("[REP-005] vyprázdnění vlastního limitu vrátí zákonnou konstantu", () => {
    const { owner } = account();
    savePreferences(webActor(owner), { turnoverFlatLimitMinor: 50_000_000 });
    expect(limitStates(db, owner, 2026)[1]!.limitMinor).toBe(50_000_000);

    savePreferences(webActor(owner), { turnoverFlatLimitMinor: null });
    expect(limitStates(db, owner, 2026)[1]!.limitMinor).toBe(FLAT_TAX_LIMIT_MINOR);
  });

  test("[REP-005] limit musí být kladná celá částka", () => {
    const { owner } = account();

    expect(() => savePreferences(webActor(owner), { turnoverVatLimitMinor: 0 })).toThrow();
    expect(() => savePreferences(webActor(owner), { turnoverVatLimitMinor: 1.5 })).toThrow();
  });
});

describe("upozornění na limity", () => {
  const keys = (owner: string) =>
    derivedAlerts(owner)
      .filter((alert) => alert.kind === "turnover_limit")
      .map((alert) => alert.dedupeKey)
      .sort();

  test("[UI-011] blížící se limit je v centru upozornění a storno dokladu ho stáhne", () => {
    const { owner, customer } = account();
    const id = issuedDocument(owner, customer, {
      issueDate: "2026-03-01",
      totalMinor: 170_000_000,
    });
    at(REPORT_TODAY);

    expect(keys(owner)).toEqual(["limit:flat:2026:80", "limit:vat:2026:80"]);

    cancelInvoice(webActor(owner), id);
    expect(keys(owner)).toEqual([]);
  });

  test("[UI-011] přechod z 80 na 95 % vytvoří nové upozornění", () => {
    const { owner, customer } = account();
    issuedDocument(owner, customer, { issueDate: "2026-03-01", totalMinor: 170_000_000 });
    at(REPORT_TODAY);
    const before = keys(owner);

    issuedDocument(owner, customer, { issueDate: "2026-04-01", totalMinor: 25_000_000 });
    at(REPORT_TODAY);

    expect(before).toEqual(["limit:flat:2026:80", "limit:vat:2026:80"]);
    expect(keys(owner)).toEqual(["limit:flat:2026:95", "limit:vat:2026:95"]);
  });

  test("[UI-011] vypnutý limit nevytvoří upozornění a zvonek ho nepočítá", () => {
    const owner = withTurnover(195_000_000);
    const before = unreadCount(owner);

    savePreferences(webActor(owner), { turnoverVatWatch: false });

    expect(keys(owner)).toEqual(["limit:flat:2026:95"]);
    expect(unreadCount(owner)).toBe(before - 1);
    expect(vat(owner)).toEqual({
      key: "vat",
      watched: false,
      limitMinor: VAT_REGISTRATION_LIMIT_MINOR,
      turnoverMinor: 195_000_000,
      unconverted: { count: 0, byCurrency: [] },
    });

    savePreferences(webActor(owner), { turnoverFlatWatch: false });
    expect(keys(owner)).toEqual([]);
    expect(unreadCount(owner)).toBe(before - 2);

    savePreferences(webActor(owner), { turnoverVatWatch: true });
    expect(keys(owner)).toEqual(["limit:vat:2026:95"]);
  });

  test("[UI-011] upozornění čte jen aktuální rok a cizí účet ho nevidí", () => {
    const mine = withTurnover(195_000_000);
    const other = account().owner;

    at(REPORT_TODAY);
    expect(keys(mine)).toContain("limit:vat:2026:95");
    expect(keys(other)).toEqual([]);
  });
});
