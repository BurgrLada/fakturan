import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { setClockForTests } from "@/server/clock";
import { auditLog, exchangeRate, invoice, job } from "@/server/db/schema";
import { claimNext, completeJob, purgeFinishedJobs } from "@/server/jobs/queue";
import {
  cnbRate,
  creditPreview,
  ensureRate,
  loadRate,
  planRateFetch,
  resolveRate,
  runRateFetch,
} from "@/server/services/exchange-rates";
import {
  checkIssuable,
  issueInvoice,
  NotIssuableError,
  previewIssue,
} from "@/server/services/invoice-lifecycle";
import { getInvoice, type DraftInput } from "@/server/services/invoices";
import { createCreditNote } from "@/server/services/credit-notes";
import { markSent } from "@/server/services/invoice-lifecycle";
import { addPayment } from "@/server/services/payments";
import { savePreferences } from "@/server/services/preferences";
import { assertConsistent } from "../helpers/consistency";
import { cnbMode, startCnbStub } from "../helpers/cnb";
import { createTestDb } from "../helpers/db";
import { draftFor, seedCustomer, seedOwner, webActor } from "../helpers/fixtures-mail";

vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-rates-")));

const failures = vi.hoisted(() => ({ reportFailure: vi.fn() }));
vi.mock("@/server/scheduler/report", () => failures);

const stub = await startCnbStub();
vi.stubEnv("CNB_BASE_URL", stub.url);
afterAll(() => stub.close());

const db = createTestDb();
// Monday 2 Nov 2026, 17:00 in Prague: the list of the day is out.
const EVENING = new Date("2026-11-02T16:00:00Z");
const MORNING = new Date("2026-11-02T09:00:00Z");

let at = EVENING;
let seen = 0;
const fetchAudits = () =>
  db.select().from(auditLog).where(eq(auditLog.action, "exchange_rate.fetch")).all();
const newAudits = () => fetchAudits().slice(seen);
beforeEach(() => {
  db.delete(exchangeRate).run();
  db.delete(job).run();
  seen = fetchAudits().length;
  stub.setMode(cnbMode.ok);
  stub.requests.length = 0;
  failures.reportFailure.mockClear();
  at = EVENING;
  setClockForTests({ now: () => at });
});
afterEach(() => {
  vi.unstubAllGlobals();
  setClockForTests(null);
});

function seedRate(currency: "EUR" | "USD" | "GBP", listDate: string, rateMicros: number) {
  db.insert(exchangeRate).values({ currency, listDate, rateMicros, fetchedAt: EVENING }).run();
}

function eurDraft(owner: string, over: Partial<DraftInput> = {}) {
  return draftFor(owner, seedCustomer(owner), {
    currency: "EUR",
    paymentMethod: "cash",
    bankAccountId: null,
    issueDate: "2026-10-29",
    dueDate: "2026-11-12",
    ...over,
  });
}

function issued(owner: string, over: Partial<DraftInput> = {}) {
  const draft = eurDraft(owner, over);
  issueInvoice(webActor(owner), draft.id, { revision: draft.revision });
  return getInvoice(owner, draft.id)!;
}

describe("stažení kurzů", () => {
  test("[FOR-004] lístek se stáhne, uloží pro všechny měny aplikace a dotaz nese datum dne", async () => {
    await ensureRate("EUR", "2026-10-30");

    const rows = db.select().from(exchangeRate).all();
    expect(rows.map((row) => row.currency).sort()).toEqual(["CHF", "EUR", "GBP", "PLN", "USD"]);
    expect(
      rows.every(
        (row) => row.listDate === "2026-10-30" && row.fetchedAt.getTime() === EVENING.getTime(),
      ),
    ).toBe(true);
    expect(stub.requests).toEqual(["/denni_kurz.txt?date=30.10.2026"]);
  });

  test("[FOR-004] uložený lístek se znovu nestahuje a CZK se nestahuje vůbec", async () => {
    await ensureRate("EUR", "2026-10-30");
    await ensureRate("USD", "2026-10-30");
    await ensureRate("CZK", "2026-10-30");

    expect(stub.requests).toHaveLength(1);
    expect(newAudits()).toHaveLength(1);
  });

  test("[AUD-002] stažení kurzů je v auditu instance bez údajů účtu", async () => {
    await ensureRate("EUR", "2026-10-30");

    const rows = newAudits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      scope: "instance",
      entity: "exchange_rate",
      entityId: null,
      ownerId: null,
      actorId: null,
      source: "system",
      after: { listDate: "2026-10-30", currencies: 5 },
    });
  });

  test("[FOR-004] souběžné stažení téhož lístku nic nezdvojí a nezapíše audit navíc", async () => {
    await Promise.all([ensureRate("EUR", "2026-10-30"), ensureRate("EUR", "2026-10-30")]);

    expect(db.select().from(exchangeRate).all()).toHaveLength(5);
    expect(newAudits()).toHaveLength(1);
  });

  test("[FOR-004] nedostupná ČNB, nesmysl i výjimka nic neuloží a nevyhodí", async () => {
    stub.setMode(cnbMode.down);
    await expect(ensureRate("EUR", "2026-10-30")).resolves.toBeUndefined();
    stub.setMode(cnbMode.garbage);
    await expect(ensureRate("EUR", "2026-10-30")).resolves.toBeUndefined();
    stub.setMode(cnbMode.big);
    await expect(ensureRate("EUR", "2026-10-30")).resolves.toBeUndefined();
    await expect(
      ensureRate("EUR", "2026-10-30", async () => {
        throw new Error("síť");
      }),
    ).resolves.toBeUndefined();

    expect(db.select().from(exchangeRate).all()).toEqual([]);
    expect(newAudits()).toEqual([]);
  });

  test("[FOR-004] nedostupný lístek se nehlásí jako chyba", async () => {
    stub.setMode(cnbMode.down);
    await ensureRate("EUR", "2026-10-30");
    stub.setMode(cnbMode.garbage);
    await ensureRate("EUR", "2026-10-30");

    expect(failures.reportFailure).not.toHaveBeenCalled();
  });

  test("[FOR-004] selhání zápisu lístku se nahlásí a nevyhodí", async () => {
    db.$client.exec(
      "CREATE TRIGGER fail_rate_insert BEFORE INSERT ON exchange_rate BEGIN SELECT RAISE(ABORT, 'disk plný'); END",
    );
    try {
      await expect(ensureRate("EUR", "2026-10-30")).resolves.toBeUndefined();
    } finally {
      db.$client.exec("DROP TRIGGER fail_rate_insert");
    }

    expect(failures.reportFailure).toHaveBeenCalledTimes(1);
    expect(failures.reportFailure).toHaveBeenCalledWith(expect.any(Error), { task: "fx" });
    expect(db.select().from(exchangeRate).all()).toEqual([]);
    expect(newAudits()).toEqual([]);
  });

  test("[FOR-003] lístek z dřívějšího dne se uloží pod svým datem", async () => {
    stub.setMode(cnbMode.date("2026-10-30"));
    await ensureRate("EUR", "2026-10-31");

    expect(
      db
        .select()
        .from(exchangeRate)
        .all()
        .every((row) => row.listDate === "2026-10-30"),
    ).toBe(true);
    expect(stub.requests).toEqual(["/denni_kurz.txt?date=30.10.2026"]);
  });

  test("testy kurzů nevolají globální fetch", async () => {
    const forbidden = vi.fn(() => {
      throw new Error("síť");
    });
    vi.stubGlobal("fetch", forbidden);
    const fetcher = vi.fn(
      async () =>
        new Response("30.10.2026 #211\nzemě|měna|množství|kód|kurz\nEMU|euro|1|EUR|24,380\n"),
    );

    const owner = seedOwner(db, EVENING);

    await ensureRate("EUR", "2026-10-30", fetcher);
    const loaded = await loadRate(
      webActor(owner),
      { currency: "EUR", date: "2026-10-30" },
      fetcher,
    );
    await creditPreview(
      webActor(owner),
      {
        invoiceId: issued(owner, { exchangeRateMicros: 24_000_000 }).id,
        currency: "USD",
        amountMinor: 100,
        paidOn: "2026-10-30",
      },
      fetcher,
    );

    expect(loaded).toMatchObject({ source: "cnb" });
    expect(fetcher).toHaveBeenCalled();
    expect(forbidden).not.toHaveBeenCalled();
  });
});

describe("výběr kurzu", () => {
  test("[FOR-004] lístek k rozhodnému dni je cnb a nese své datum", () => {
    const owner = seedOwner(db, EVENING);
    seedRate("EUR", "2026-10-30", 24_380_000);

    expect(resolveRate(db, owner, "EUR", "2026-10-30", EVENING)).toEqual({
      rateMicros: 24_380_000,
      source: "cnb",
      listDate: "2026-10-30",
      reference: 24_380_000,
    });
  });

  test("[FOR-003] sobota má lístek z pátku a svátek lístek z předchozího pracovního dne", () => {
    const owner = seedOwner(db, EVENING);
    seedRate("EUR", "2026-10-30", 24_380_000);
    seedRate("EUR", "2026-10-27", 24_000_000);

    expect(resolveRate(db, owner, "EUR", "2026-10-31", EVENING)).toMatchObject({
      source: "cnb",
      listDate: "2026-10-30",
    });
    expect(resolveRate(db, owner, "EUR", "2026-10-28", EVENING)).toMatchObject({
      source: "cnb",
      listDate: "2026-10-27",
      rateMicros: 24_000_000,
    });
  });

  test("[FOR-003] dnešek před 14:30 používá včerejší lístek a po něm čeká na dnešní", () => {
    const owner = seedOwner(db, EVENING);
    seedRate("EUR", "2026-10-30", 24_380_000);

    expect(resolveRate(db, owner, "EUR", "2026-11-02", MORNING)).toMatchObject({
      source: "cnb",
      listDate: "2026-10-30",
    });
    expect(resolveRate(db, owner, "EUR", "2026-11-02", EVENING)).toMatchObject({
      source: "last_known",
      listDate: "2026-10-30",
    });
  });

  test("[FOR-004] nedostupná ČNB použije poslední známý lístek se zdrojem last_known", () => {
    const owner = seedOwner(db, EVENING);
    seedRate("EUR", "2026-10-26", 24_100_000);
    seedRate("EUR", "2026-10-30", 24_380_000);

    expect(resolveRate(db, owner, "EUR", "2026-10-29", EVENING)).toEqual({
      rateMicros: 24_100_000,
      source: "last_known",
      listDate: "2026-10-26",
      reference: 24_100_000,
    });
  });

  test("[FOR-004] novější lístek než očekávaný se nepoužije", () => {
    const owner = seedOwner(db, EVENING);
    seedRate("EUR", "2026-10-30", 24_380_000);

    expect(resolveRate(db, owner, "EUR", "2026-10-29", EVENING)).toBeNull();
  });

  test("[FOR-004] prázdná tabulka a CZK vrátí null", () => {
    const owner = seedOwner(db, EVENING);

    expect(resolveRate(db, owner, "EUR", "2026-10-30", EVENING)).toBeNull();
    seedRate("EUR", "2026-10-30", 24_380_000);
    expect(resolveRate(db, owner, "CZK", "2026-10-30", EVENING)).toBeNull();
  });

  test("[FOR-004] kurz jedné měny nezamění za jinou", () => {
    const owner = seedOwner(db, EVENING);
    seedRate("USD", "2026-10-30", 22_311_000);

    expect(resolveRate(db, owner, "EUR", "2026-10-30", EVENING)).toBeNull();
    expect(cnbRate(db, "EUR", "2026-10-30")).toBeNull();
    expect(cnbRate(db, "USD", "2026-10-30")).toBe(22_311_000);
    expect(cnbRate(db, "CZK", "2026-10-30")).toBe(1_000_000);
  });

  test("[FOR-010] pevný kurz má přednost před ČNB a nese kurz ČNB jako referenci", () => {
    const owner = seedOwner(db, EVENING);
    seedRate("EUR", "2026-10-30", 24_380_000);
    savePreferences(webActor(owner), { fixedRates: { EUR: 25_000_000 } });

    expect(resolveRate(db, owner, "EUR", "2026-10-30", EVENING)).toEqual({
      rateMicros: 25_000_000,
      source: "fixed",
      listDate: null,
      reference: 24_380_000,
    });
    expect(cnbRate(db, "EUR", "2026-10-30")).toBe(24_380_000);
  });

  test("[FOR-010] pevný kurz platí i bez lístku, jen bez reference, a cizí účet ho nevidí", () => {
    const owner = seedOwner(db, EVENING);
    const other = seedOwner(db, EVENING);
    savePreferences(webActor(owner), { fixedRates: { EUR: 25_000_000 } });

    expect(resolveRate(db, owner, "EUR", "2026-10-30", EVENING)).toMatchObject({
      source: "fixed",
      reference: null,
    });
    expect(resolveRate(db, other, "EUR", "2026-10-30", EVENING)).toBeNull();
    seedRate("EUR", "2026-10-26", 24_100_000);
    expect(resolveRate(db, owner, "EUR", "2026-10-30", EVENING)).toMatchObject({
      source: "fixed",
      reference: null,
    });
  });

  test.each([
    [{ CZK: 1_000_000 }],
    [{ XYZ: 1_000_000 }],
    [{ EUR: 0 }],
    [{ EUR: -5 }],
    [{ EUR: 1.5 }],
    [{ EUR: 1_000_000_000_001 }],
  ])("[FOR-010] neplatný pevný kurz %j se neuloží", (fixedRates) => {
    const owner = seedOwner(db, EVENING);
    expect(() => savePreferences(webActor(owner), { fixedRates })).toThrow("Pevný kurz");
  });
});

describe("načtení kurzu pro formulář", () => {
  test("[FOR-004] uložený lístek se vrátí bez sítě", async () => {
    const owner = seedOwner(db, EVENING);
    seedRate("EUR", "2026-10-30", 24_380_000);

    const rate = await loadRate(webActor(owner), { currency: "EUR", date: "2026-10-30" });

    expect(rate).toMatchObject({ source: "cnb", rateMicros: 24_380_000 });
    expect(stub.requests).toEqual([]);
  });

  test("[FOR-004] chybějící lístek se stáhne a vrátí se znovu přečtený výsledek", async () => {
    const owner = seedOwner(db, EVENING);

    const rate = await loadRate(webActor(owner), { currency: "USD", date: "2026-10-30" });

    expect(rate).toMatchObject({ source: "cnb", rateMicros: 22_311_000, listDate: "2026-10-30" });
    expect(stub.requests).toHaveLength(1);
  });

  test("[FOR-004] při výpadku vrátí poslední známý kurz a nevyhodí", async () => {
    const owner = seedOwner(db, EVENING);
    seedRate("EUR", "2026-10-26", 24_100_000);
    stub.setMode(cnbMode.down);

    const rate = await loadRate(webActor(owner), { currency: "EUR", date: "2026-10-30" });

    expect(rate).toMatchObject({ source: "last_known", rateMicros: 24_100_000 });
    expect(stub.requests).toHaveLength(1);
  });

  test("[FOR-004] po vyčerpání limitu dotazů vrátí poslední známý výsledek bez sítě", async () => {
    const owner = seedOwner(db, EVENING);
    seedRate("EUR", "2026-10-26", 24_100_000);
    stub.setMode(cnbMode.down);

    for (let i = 0; i < 60; i += 1) {
      await loadRate(webActor(owner), { currency: "EUR", date: "2026-10-30" });
    }
    const limited = await loadRate(webActor(owner), { currency: "EUR", date: "2026-10-30" });

    expect(limited).toMatchObject({ source: "last_known", rateMicros: 24_100_000 });
    expect(stub.requests).toHaveLength(60);
  });

  test("[FOR-010] pevný kurz se vrátí bez dotazu na síť", async () => {
    const owner = seedOwner(db, EVENING);
    savePreferences(webActor(owner), { fixedRates: { EUR: 25_000_000 } });

    expect(await loadRate(webActor(owner), { currency: "EUR", date: "2026-10-30" })).toMatchObject({
      source: "fixed",
    });
    expect(stub.requests).toEqual([]);
  });

  test("[FOR-004] neplatná měna nebo datum a anonymní aktér skončí chybou", async () => {
    const owner = seedOwner(db, EVENING);

    await expect(
      loadRate(webActor(owner), { currency: "XXX", date: "2026-10-30" }),
    ).rejects.toThrow("Neplatný dotaz");
    await expect(
      loadRate(webActor(owner), { currency: "EUR", date: "2026-02-30" }),
    ).rejects.toThrow("Neplatný dotaz");
    await expect(
      loadRate({ userId: null, source: "system" }, { currency: "EUR", date: "2026-10-30" }),
    ).rejects.toThrow();
  });
});

describe("vystavení s kurzem", () => {
  test("[FOR-003] vystavení vezme kurz k rozhodnému dni a pozdější lístek ho nezmění", () => {
    const owner = seedOwner(db, EVENING);
    seedRate("EUR", "2026-10-29", 24_900_000);
    seedRate("EUR", "2026-10-30", 24_380_000);

    const row = issued(owner);

    expect(row).toMatchObject({
      exchangeRateMicros: 24_900_000,
      exchangeRateSource: "cnb",
      exchangeRateDate: "2026-10-29",
    });
    // A corrected list and a newer one both appear, then everything that touches the document runs.
    db.update(exchangeRate)
      .set({ rateMicros: 30_000_000 })
      .where(eq(exchangeRate.listDate, "2026-10-29"))
      .run();
    seedRate("EUR", "2026-11-02", 31_000_000);
    markSent(webActor(owner), row.id);
    addPayment(webActor(owner), row.id, {
      revision: getInvoice(owner, row.id)!.revision,
      paidOn: "2026-11-02",
      amountMinor: 1_000,
      currency: "EUR",
      method: "cash",
      note: "",
    });
    createCreditNote(webActor(owner), row.id);

    expect(resolveRate(db, owner, "EUR", "2026-10-29", EVENING)?.rateMicros).toBe(30_000_000);
    expect(getInvoice(owner, row.id)).toMatchObject({
      exchangeRateMicros: 24_900_000,
      exchangeRateSource: "cnb",
      exchangeRateDate: "2026-10-29",
    });
    assertConsistent(db, owner);
  });

  test("[FOR-009] základ DUZP použije DUZP a bez něj datum vystavení", () => {
    const owner = seedOwner(db, EVENING);
    seedRate("EUR", "2026-10-22", 24_000_000);
    seedRate("EUR", "2026-10-29", 24_900_000);
    savePreferences(webActor(owner), { fxBasis: "taxable_date" });

    expect(issued(owner, { taxableDate: "2026-10-22" })).toMatchObject({
      exchangeRateMicros: 24_000_000,
      exchangeRateDate: "2026-10-22",
    });
    expect(issued(owner)).toMatchObject({
      exchangeRateMicros: 24_900_000,
      exchangeRateDate: "2026-10-29",
    });
  });

  test("[FOR-009] základ datum vystavení ignoruje DUZP", () => {
    const owner = seedOwner(db, EVENING);
    seedRate("EUR", "2026-10-22", 24_000_000);
    seedRate("EUR", "2026-10-29", 24_900_000);

    expect(issued(owner, { taxableDate: "2026-10-22" })).toMatchObject({
      exchangeRateMicros: 24_900_000,
    });
  });

  test("[FOR-004] chybějící lístek k dni dá poslední známý kurz se zdrojem last_known", () => {
    const owner = seedOwner(db, EVENING);
    seedRate("EUR", "2026-10-26", 24_100_000);

    expect(issued(owner)).toMatchObject({
      exchangeRateMicros: 24_100_000,
      exchangeRateSource: "last_known",
      exchangeRateDate: "2026-10-26",
    });
  });

  test("[FOR-010] pevný kurz se při vystavení použije se zdrojem fixed bez data lístku", () => {
    const owner = seedOwner(db, EVENING);
    seedRate("EUR", "2026-10-29", 24_900_000);
    savePreferences(webActor(owner), { fixedRates: { EUR: 25_500_000 } });

    expect(issued(owner)).toMatchObject({
      exchangeRateMicros: 25_500_000,
      exchangeRateSource: "fixed",
      exchangeRateDate: null,
    });
  });

  test("[FOR-003] ruční kurz přežije vystavení beze změny", () => {
    const owner = seedOwner(db, EVENING);
    seedRate("EUR", "2026-10-29", 24_900_000);
    const typed = eurDraft(owner, { exchangeRateMicros: 23_456_000 });
    db.update(invoice).set({ exchangeRateSource: "manual" }).where(eq(invoice.id, typed.id)).run();
    const untyped = eurDraft(owner, { exchangeRateMicros: 22_222_000 });

    issueInvoice(webActor(owner), typed.id, { revision: typed.revision });
    issueInvoice(webActor(owner), untyped.id, { revision: untyped.revision });

    expect(getInvoice(owner, typed.id)).toMatchObject({
      exchangeRateMicros: 23_456_000,
      exchangeRateSource: "manual",
    });
    expect(getInvoice(owner, untyped.id)).toMatchObject({ exchangeRateMicros: 22_222_000 });
  });

  test("[FOR-004] prázdná tabulka a výpadek: bez ručního kurzu nejde vystavit, s ručním ano", () => {
    const owner = seedOwner(db, EVENING);
    const bare = eurDraft(owner);

    expect(() => issueInvoice(webActor(owner), bare.id, { revision: bare.revision })).toThrow(
      NotIssuableError,
    );
    const typed = eurDraft(owner, { exchangeRateMicros: 24_000_000 });
    issueInvoice(webActor(owner), typed.id, { revision: typed.revision });
    expect(getInvoice(owner, typed.id)).toMatchObject({
      status: "issued",
      exchangeRateMicros: 24_000_000,
    });
  });

  test("[FOR-004] koruny a zálohy bez cizí měny kurz nedostanou", () => {
    const owner = seedOwner(db, EVENING);
    seedRate("EUR", "2026-10-29", 24_900_000);
    const draft = draftFor(owner, seedCustomer(owner), {
      issueDate: "2026-10-29",
      dueDate: "2026-11-12",
    });
    issueInvoice(webActor(owner), draft.id, { revision: draft.revision });

    expect(getInvoice(owner, draft.id)).toMatchObject({
      exchangeRateMicros: null,
      exchangeRateSource: null,
      exchangeRateDate: null,
    });
  });

  test("[FOR-010] náhled upozorní na odchylku nad 5 % a na poslední známý kurz", () => {
    const owner = seedOwner(db, EVENING);
    seedRate("EUR", "2026-10-26", 25_000_000);
    const far = eurDraft(owner, { exchangeRateMicros: 26_250_001 });
    const edge = eurDraft(owner, { exchangeRateMicros: 26_250_000 });

    expect(previewIssue(owner, far.id).rateNotes.join(" ")).toContain("liší o více než 5 %");
    expect(previewIssue(owner, edge.id).rateNotes.join(" ")).not.toContain("5 %");
    expect(previewIssue(owner, edge.id).rateNotes.join(" ")).not.toContain("liší");
  });

  test("[FOR-010] náhled bez reference řekne, že odchylku nešlo ověřit, a pro koruny je prázdný", () => {
    const owner = seedOwner(db, EVENING);
    const typed = eurDraft(owner, { exchangeRateMicros: 24_000_000 });
    const czk = draftFor(owner, seedCustomer(owner));

    expect(previewIssue(owner, typed.id).rateNotes).toEqual([
      expect.stringContaining("nešlo ověřit"),
    ]);
    expect(previewIssue(owner, czk.id).rateNotes).toEqual([]);
  });

  test("[FOR-004] koncept bez kurzu je vystavitelný, když kurz dodá tabulka", () => {
    const owner = seedOwner(db, EVENING);
    const draft = eurDraft(owner);

    expect(checkIssuable(owner, draft.id).map((item) => item.field)).toContain(
      "exchangeRateMicros",
    );
    seedRate("EUR", "2026-10-29", 24_900_000);
    expect(checkIssuable(owner, draft.id)).toEqual([]);
    expect(previewIssue(owner, draft.id).problems).toEqual([]);
  });

  test("[CRN-001] náhled opravné faktury žádné poznámky ke kurzu nemá", () => {
    const owner = seedOwner(db, EVENING);
    const original = issued(owner, { exchangeRateMicros: 20_000_000 });
    seedRate("EUR", "2026-10-29", 24_900_000);
    const note = createCreditNote(webActor(owner), original.id);

    expect(previewIssue(owner, note.id).rateNotes).toEqual([]);
  });

  test("[FOR-004] náhled ukáže, že se použije poslední známý kurz", () => {
    const owner = seedOwner(db, EVENING);
    seedRate("EUR", "2026-10-26", 24_100_000);
    const draft = eurDraft(owner);

    expect(previewIssue(owner, draft.id).rateNotes).toEqual([
      expect.stringContaining("poslední známý"),
    ]);
    expect(getInvoice(owner, draft.id)).toMatchObject({
      status: "draft",
      exchangeRateMicros: null,
    });
  });
});

describe("předvyplnění platby", () => {
  const eurInvoice = (owner: string) => {
    seedRate("EUR", "2026-10-30", 25_000_000);
    seedRate("USD", "2026-10-30", 23_000_000);
    return issued(owner, { exchangeRateMicros: 25_000_000 }).id;
  };

  test("[PAY-006] 100,00 USD na faktuře v EUR při 23,000000 a 25,000000 předvyplní 92,00 EUR", async () => {
    const owner = seedOwner(db, EVENING);
    const id = eurInvoice(owner);

    expect(
      await creditPreview(webActor(owner), {
        invoiceId: id,
        currency: "USD",
        amountMinor: 10_000,
        paidOn: "2026-10-30",
      }),
    ).toEqual({ creditedMinor: 9_200 });
  });

  test("[PAY-006] 333,33 USD při 22,111000 a 25,320000 předvyplní 291,08 EUR", async () => {
    const owner = seedOwner(db, EVENING);
    const id = eurInvoice(owner);
    db.update(exchangeRate)
      .set({ rateMicros: 22_111_000 })
      .where(eq(exchangeRate.currency, "USD"))
      .run();
    db.update(exchangeRate)
      .set({ rateMicros: 25_320_000 })
      .where(eq(exchangeRate.currency, "EUR"))
      .run();

    expect(
      await creditPreview(webActor(owner), {
        invoiceId: id,
        currency: "USD",
        amountMinor: 33_333,
        paidOn: "2026-10-30",
      }),
    ).toEqual({ creditedMinor: 29_108 });
  });

  test("[PAY-006] koruny se přepočtou přes kurz faktury a stejná měna se nepřepočítá", async () => {
    const owner = seedOwner(db, EVENING);
    const id = eurInvoice(owner);

    expect(
      await creditPreview(webActor(owner), {
        invoiceId: id,
        currency: "CZK",
        amountMinor: 250_000,
        paidOn: "2026-10-30",
      }),
    ).toEqual({ creditedMinor: 10_000 });
    expect(
      await creditPreview(webActor(owner), {
        invoiceId: id,
        currency: "EUR",
        amountMinor: 12_345,
        paidOn: "2026-10-30",
      }),
    ).toEqual({ creditedMinor: 12_345 });
    expect(stub.requests).toEqual([]);
  });

  test("[PAY-006] bez kurzu předvyplnění nic nevrátí a síť se zkusí jen jednou za měnu", async () => {
    const owner = seedOwner(db, EVENING);
    const id = eurInvoice(owner);
    db.delete(exchangeRate).where(eq(exchangeRate.currency, "USD")).run();
    stub.setMode(cnbMode.down);

    expect(
      await creditPreview(webActor(owner), {
        invoiceId: id,
        currency: "USD",
        amountMinor: 10_000,
        paidOn: "2026-10-30",
      }),
    ).toBeNull();
    expect(stub.requests.length).toBeGreaterThan(0);
  });

  test("[PAY-006] chybějící kurz se stáhne a předvyplnění pak vyjde", async () => {
    const owner = seedOwner(db, EVENING);
    const id = eurInvoice(owner);
    db.delete(exchangeRate).where(eq(exchangeRate.currency, "USD")).run();

    const preview = await creditPreview(webActor(owner), {
      invoiceId: id,
      currency: "USD",
      amountMinor: 10_000,
      paidOn: "2026-10-30",
    });

    expect(preview).toEqual({ creditedMinor: Math.round((10_000 * 22_311_000) / 25_000_000) });
  });

  test("[PAY-006] cizí doklad a neplatný vstup se odmítnou", async () => {
    const owner = seedOwner(db, EVENING);
    const stranger = seedOwner(db, EVENING);
    const id = eurInvoice(owner);
    const base = { invoiceId: id, currency: "USD", amountMinor: 10_000, paidOn: "2026-10-30" };

    await expect(creditPreview(webActor(stranger), base)).rejects.toThrow();
    await expect(creditPreview(webActor(owner), { ...base, amountMinor: 0 })).rejects.toThrow(
      "Neplatný dotaz",
    );
    await expect(creditPreview(webActor(owner), { ...base, currency: "XXX" })).rejects.toThrow(
      "Neplatný dotaz",
    );
    await expect(creditPreview(webActor(owner), { ...base, paidOn: "2026-13-01" })).rejects.toThrow(
      "Neplatný dotaz",
    );
  });
});

describe("plánování stahování", () => {
  const jobs = () => db.select().from(job).where(eq(job.kind, "fx.fetch")).all();

  test("tick založí jednu úlohu za hodinu a na prázdné instanci hned", () => {
    at = MORNING;
    planRateFetch(MORNING);
    planRateFetch(new Date(MORNING.getTime() + 60_000));
    expect(jobs()).toHaveLength(1);
    expect(jobs()[0]).toMatchObject({
      key: "fx:2026-10-30:10",
      userId: null,
      payload: { date: "2026-10-30" },
      status: "pending",
    });

    planRateFetch(new Date(MORNING.getTime() + 3_600_000));
    expect(
      jobs()
        .map((row) => row.key)
        .sort(),
    ).toEqual(["fx:2026-10-30:10", "fx:2026-10-30:11"]);
  });

  test("[FOR-003] s lístkem z posledního pracovního dne se nic neplánuje", () => {
    seedRate("EUR", "2026-10-30", 24_380_000);

    planRateFetch(MORNING);
    expect(jobs()).toEqual([]);
  });

  test("[FOR-003] před 14:45 se na dnešní lístek nečeká a od 14:45 se pro něj plánuje", () => {
    seedRate("EUR", "2026-10-30", 24_380_000);
    const before = new Date("2026-11-02T13:44:00Z");
    const after = new Date("2026-11-02T13:45:00Z");

    planRateFetch(before);
    expect(jobs()).toEqual([]);
    planRateFetch(after);
    expect(jobs()).toMatchObject([{ key: "fx:2026-11-02:14", payload: { date: "2026-11-02" } }]);
  });

  test("[FOR-003] o víkendu se plánuje jen chybějící lístek z pátku", () => {
    const saturday = new Date("2026-10-31T09:00:00Z");
    seedRate("EUR", "2026-10-29", 24_000_000);

    planRateFetch(saturday);
    expect(jobs()).toMatchObject([{ payload: { date: "2026-10-30" } }]);
  });

  test("[FOR-004] lístek, který se pět dní nedá načíst, se jednou za den nahlásí", () => {
    seedRate("EUR", "2026-10-23", 24_000_000);

    planRateFetch(new Date("2026-10-27T10:00:00Z"));
    expect(failures.reportFailure).not.toHaveBeenCalled();

    planRateFetch(new Date("2026-11-02T10:00:00Z"));
    planRateFetch(new Date("2026-11-02T11:00:00Z"));
    expect(failures.reportFailure).toHaveBeenCalledTimes(1);
    expect(failures.reportFailure).toHaveBeenCalledWith(expect.any(Error), { task: "fx" });

    planRateFetch(new Date("2026-11-03T10:00:00Z"));
    expect(failures.reportFailure).toHaveBeenCalledTimes(2);
  });

  test("[FOR-004] prázdná tabulka a čerstvý lístek se nehlásí", () => {
    planRateFetch(MORNING);
    seedRate("EUR", "2026-10-29", 24_000_000);
    planRateFetch(new Date("2026-11-02T11:00:00Z"));

    expect(failures.reportFailure).not.toHaveBeenCalled();
  });

  test("úloha stáhne lístek a při výpadku skončí bez chyby", async () => {
    at = MORNING;
    planRateFetch(MORNING);
    const row = claimNext("w")!;
    stub.setMode(cnbMode.down);

    await expect(runRateFetch(row)).resolves.toBeUndefined();
    expect(db.select().from(exchangeRate).all()).toEqual([]);

    stub.setMode(cnbMode.ok);
    await runRateFetch(row);
    expect(db.select().from(exchangeRate).all()).toHaveLength(5);
    completeJob(row.id, "w");
  });

  test("úloha s neplatným datem nic nestahuje", async () => {
    at = MORNING;
    planRateFetch(MORNING);
    const row = { ...claimNext("w")!, payload: { date: "nesmysl" } };

    await runRateFetch(row);
    expect(stub.requests).toEqual([]);
  });

  test("hotové úlohy fx.fetch zmizí po 7 dnech", () => {
    at = MORNING;
    planRateFetch(MORNING);
    const row = claimNext("w")!;
    completeJob(row.id, "w");

    purgeFinishedJobs(new Date(MORNING.getTime() + 6 * 86_400_000));
    expect(jobs()).toHaveLength(1);
    purgeFinishedJobs(new Date(MORNING.getTime() + 8 * 86_400_000));
    expect(jobs()).toEqual([]);
  });
});
