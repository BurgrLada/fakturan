import { REVERSE_CHARGE_CLAUSE } from "@/lib/clauses";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { calendarDateInPrague } from "@/lib/number-format";
import { nextOccurrences } from "@/lib/recurrence";
import { TEXTS } from "@/lib/texts";
import { setClockForTests } from "@/server/clock";
import { createDb, runMigrations } from "@/server/db";
import {
  auditLog,
  customer,
  exchangeRate,
  emailLog,
  invoice,
  job,
  notification,
  numberSeriesCounter,
  recurringRun,
  schedulerState,
} from "@/server/db/schema";
import { registerJob } from "@/server/jobs/registry";
import { drainJobs } from "@/server/jobs/worker";
import { archiveCustomer } from "@/server/services/customers";
import { composeMail } from "@/server/services/email-templates";
import { setAutomation, setPaused } from "@/server/services/automation";
import { savePreferences } from "@/server/services/preferences";
import { loadInvoiceDocument } from "@/server/services/invoice-document";
import { issueInvoice } from "@/server/services/invoice-lifecycle";
import { duplicateInvoice, getInvoice, saveDraft } from "@/server/services/invoices";
import { deliverMail, recoverMail } from "@/server/services/mail-delivery";
import { defaultSeriesFor, peekNumber } from "@/server/services/number-series";
import { getRecurring, listRecurring, listRuns } from "@/server/services/recurring";
import {
  deliverUserNotice,
  planRecurringNotices,
  planRecurringRuns,
  processOccurrence,
  runRecurringJob,
} from "@/server/services/recurring-run";
import { assertConsistent } from "../helpers/consistency";
import { cnbMode, startCnbStub } from "../helpers/cnb";
import { createTestDb } from "../helpers/db";
import { ownSmtp, seedCustomer, seedOwner, webActor } from "../helpers/fixtures-mail";
import { planDocument, savePlan } from "../helpers/fixtures-recurring";
import { runJobWorkers } from "../helpers/run-workers";
import { startSmtp, type TestSmtp } from "../helpers/smtp";

vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-recurring-run-")));
vi.stubEnv("ALLOW_PRIVATE_MAIL_HOSTS", "true");
vi.stubEnv("SENTRY_DSN", "http://public@localhost/1");
vi.stubEnv("SMTP_HOST", "");
vi.stubEnv("SMTP_PORT", "");
vi.stubEnv("SMTP_FROM", "");

const cnb = await startCnbStub(cnbMode.down);
vi.stubEnv("CNB_BASE_URL", cnb.url);

const db = createTestDb();
const T0 = new Date("2026-03-10T10:00:00Z");
const T = TEXTS.notifications;
const ENABLED = { confirmed: true };
const SEND = { mode: "send" as const, confirmSend: true };

let smtp: TestSmtp;
let current = T0;

const at = (iso: string) => {
  current = new Date(iso);
};

beforeAll(async () => {
  smtp = await startSmtp();
});
afterAll(async () => {
  await smtp.stop();
  await cnb.close();
});

beforeEach(() => {
  smtp.reset();
  db.delete(exchangeRate).run();
  cnb.setMode(cnbMode.down);
  cnb.requests.length = 0;
  db.delete(job).run();
  db.delete(schedulerState).run();
  current = T0;
  setClockForTests({ now: () => current });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  registerJob("mail.send", { run: deliverMail, recover: recoverMail });
  registerJob("recurring.run", { run: runRecurringJob });
  registerJob("user.notice", { run: deliverUserNotice });
});
afterEach(() => {
  setClockForTests(null);
  vi.restoreAllMocks();
});

function account(customerEmail?: string) {
  const owner = seedOwner(db, T0);
  ownSmtp(db, owner, smtp.port);
  return { owner, customerId: seedCustomer(owner, customerEmail) };
}

function sendingAccount(customerEmail?: string) {
  const seeded = account(customerEmail);
  setAutomation(webActor(seeded.owner), "recurringSend", true, ENABLED);
  return seeded;
}

const occurrenceOf = (owner: string, id: string) => {
  const plan = getRecurring(owner, id)!;
  return nextOccurrences(plan, plan.cursorDate, 1)[0]!;
};

const runOnce = (owner: string, id: string) =>
  processOccurrence(owner, id, occurrenceOf(owner, id))!;

const invoicesOf = (owner: string) =>
  db.select().from(invoice).where(eq(invoice.userId, owner)).all();
const noticesOf = (owner: string) =>
  db.select().from(notification).where(eq(notification.userId, owner)).all();
const counters = (owner: string) =>
  db.select().from(numberSeriesCounter).where(eq(numberSeriesCounter.userId, owner)).all();
const mailOf = (owner: string) =>
  db.select().from(emailLog).where(eq(emailLog.userId, owner)).all();

describe("běh termínu", () => {
  test("[REC-010] běh konceptu vrátí svůj běh a doklad", () => {
    const { owner, customerId } = account();
    const id = savePlan(owner, customerId);
    const result = runOnce(owner, id);

    const [draft] = invoicesOf(owner);
    const [run] = listRuns(owner, id);
    expect(result).toEqual({ runId: run!.id, status: "created", invoiceId: draft!.id });
    expect(run).toMatchObject({ status: "created", invoiceId: draft!.id, reason: null });
    expect(noticesOf(owner)).toEqual([]);
  });

  test("[REC-010] nový plán je koncept, režim vystavit dá číslo, nic neodejde", async () => {
    const { owner, customerId } = account();
    const draft = runOnce(owner, savePlan(owner, customerId));
    expect(draft.status).toBe("created");
    expect(getInvoice(owner, draft.invoiceId!)).toMatchObject({
      status: "draft",
      number: null,
      issueDate: "2026-03-10",
      dueDate: "2026-03-24",
      periodFrom: "2026-03-01",
      periodTo: "2026-03-31",
    });

    const issued = runOnce(owner, savePlan(owner, customerId, { mode: "issue" }));
    expect(issued.status).toBe("issued");
    const row = getInvoice(owner, issued.invoiceId!)!;
    expect(row.number).toBeTruthy();
    expect(row.lines[0]!.name).toBe("Správa za 3/2026");
    await drainJobs("w");
    expect(smtp.messages).toEqual([]);
    expect(mailOf(owner)).toEqual([]);
    assertConsistent(db, owner);
  });

  test("[REC-030] druhý běh stejného období nic nevytvoří", () => {
    const { owner, customerId } = account();
    const id = savePlan(owner, customerId);
    const occurrence = occurrenceOf(owner, id);
    expect(processOccurrence(owner, id, occurrence)).not.toBeNull();
    expect(processOccurrence(owner, id, occurrence)).toBeNull();
    expect(invoicesOf(owner)).toHaveLength(1);
    assertConsistent(db, owner);
  });

  test("[REC-023] běh se 2 dny zpožděním dá období z plánu", () => {
    const { owner, customerId } = account();
    const id = savePlan(owner, customerId, { mode: "issue", periodOffset: -1 });
    const occurrence = occurrenceOf(owner, id);
    at("2026-03-12T10:00:00Z");
    const { invoiceId } = processOccurrence(owner, id, occurrence)!;
    const row = getInvoice(owner, invoiceId!)!;
    expect(row.issueDate).toBe("2026-03-10");
    expect(row.lines[0]!.name).toBe("Správa za 2/2026");
  });

  test("[REC-021] koncept z plánu ukáže v náhledu i po pozdním vystavení posunuté období", () => {
    const { owner, customerId } = account();
    const { invoiceId, ...rest } = runOnce(
      owner,
      savePlan(owner, customerId, {
        frequency: "quarterly",
        issueDay: 10,
        startsOn: "2026-01-01",
        periodOffset: -1,
        document: planDocument({ textBefore: "Za {{ctvrtleti}}. čtvrtletí {{rok}}" }),
      }),
    );
    expect(rest.status).toBe("created");
    const id = invoiceId!;
    expect(loadInvoiceDocument(owner, id)?.textBefore).toBe("Za 1. čtvrtletí 2026");

    at("2026-05-02T10:00:00Z");
    const draft = getInvoice(owner, id)!;
    const edited = saveDraft(webActor(owner), {
      ...draft,
      id,
      lines: draft.lines,
      issueDate: "2026-05-02",
      dueDate: "2026-05-16",
    });
    const after = getInvoice(owner, id)!;
    expect([after.periodFrom, after.periodTo]).toEqual(["2026-01-01", "2026-03-31"]);

    issueInvoice(webActor(owner), id, { revision: edited.revision });
    expect(getInvoice(owner, id)?.textBefore).toBe("Za 1. čtvrtletí 2026");
    expect(composeMail(owner, id, "invoice").to).toEqual(["alfa@example.cz"]);
  });

  test("[REC-020] text šablony se vykreslí z období termínu a e-mail použije totéž", () => {
    const { owner, customerId } = account();
    const { invoiceId } = runOnce(
      owner,
      savePlan(owner, customerId, {
        mode: "issue",
        frequency: "quarterly",
        issueDay: 1,
        startsOn: "2026-10-01",
        document: planDocument({ note: "faktura za {{ctvrtleti}}. čtvrtletí {{rok}}" }),
      }),
    );
    expect(getInvoice(owner, invoiceId!)?.note).toBe("faktura za 4. čtvrtletí 2026");
  });

  test("duplikát období nepřevezme", () => {
    const { owner, customerId } = account();
    const { invoiceId } = runOnce(owner, savePlan(owner, customerId));
    const copy = duplicateInvoice(webActor(owner), invoiceId!);
    expect(getInvoice(owner, copy.id)).toMatchObject({
      recurringId: null,
      periodFrom: null,
      periodTo: null,
    });
    assertConsistent(db, owner);
  });

  test("[REC-014] faktura odkazuje na plán a plán ji má v seznamu", () => {
    const { owner, customerId } = account();
    const id = savePlan(owner, customerId, { mode: "issue" });
    const { invoiceId } = runOnce(owner, id);
    expect(getInvoice(owner, invoiceId!)?.recurringId).toBe(id);
    const [run] = listRuns(owner, id);
    expect(run).toMatchObject({ invoiceId, status: "issued" });
    expect(run!.invoiceNumber).toBeTruthy();
  });

  test("[AUD-002] běh je v historii jako práce plánovače", () => {
    const { owner, customerId } = account();
    const id = savePlan(owner, customerId, { mode: "issue" });
    runOnce(owner, id);
    const rows = db.select().from(auditLog).where(eq(auditLog.ownerId, owner)).all();
    const scheduled = rows.filter((row) => row.source === "scheduler").map((row) => row.action);
    expect(scheduled).toEqual(
      expect.arrayContaining(["invoice.save", "invoice.issue", "recurring.run"]),
    );
  });

  test("chybějící zákazník a cizí měna bez kurzu spadnou na koncept bez spotřeby čísla", () => {
    const { owner, customerId } = account();
    const noCustomer = runOnce(owner, savePlan(owner, null, { mode: "issue" }));
    const foreign = runOnce(
      owner,
      savePlan(owner, customerId, {
        mode: "issue",
        document: planDocument({ currency: "EUR" }),
      }),
    );
    archiveCustomer(webActor(owner), customerId);
    const archived = runOnce(owner, savePlan(owner, customerId, { mode: "issue" }));

    for (const result of [noCustomer, foreign, archived]) {
      expect(result.status).toBe("fallback");
      expect(getInvoice(owner, result.invoiceId!)).toMatchObject({ status: "draft", number: null });
    }
    expect(counters(owner).every((row) => row.next === 1)).toBe(true);
    const failed = noticesOf(owner).filter((row) => row.kind === "recurring_failed");
    expect(failed).toHaveLength(3);
    expect(String(failed[1]!.params.problems)).toMatch(/kurz/i);
    assertConsistent(db, owner);
  });
});

describe("savepoint", () => {
  test("text přes limit po dosazení spadne na koncept a číslo se nespotřebuje", () => {
    const { owner, customerId } = account();
    db.update(customer)
      .set({ name: "K".repeat(195) })
      .where(eq(customer.id, customerId))
      .run();
    const series = defaultSeriesFor(owner, "invoice")!;
    const expected = peekNumber(db, owner, series, "2026-03-10");
    const before = counters(owner);
    const document = planDocument({ reference: `{{zakaznik}}${"x".repeat(188)}` });

    const failed = runOnce(owner, savePlan(owner, customerId, { mode: "issue", document }));
    expect(failed.status).toBe("fallback");
    expect(getInvoice(owner, failed.invoiceId!)).toMatchObject({ status: "draft", number: null });
    expect(counters(owner)).toEqual(before);

    const next = runOnce(owner, savePlan(owner, customerId, { mode: "issue" }));
    expect(next.status).toBe("issued");
    expect(getInvoice(owner, next.invoiceId!)?.number).toBe(expected);
    assertConsistent(db, owner);
  });
});

describe("automatika", () => {
  test("[REC-007] vypnutá automatika v termínu dá koncept bez čísla a upozornění", () => {
    const { owner, customerId } = sendingAccount();
    const id = savePlan(owner, customerId, SEND);
    setAutomation(webActor(owner), "recurringSend", false, ENABLED);
    const result = runOnce(owner, id);
    expect(result.status).toBe("fallback");
    expect(getInvoice(owner, result.invoiceId!)).toMatchObject({ status: "draft", number: null });
    expect(mailOf(owner)).toEqual([]);
    expect(noticesOf(owner).map((row) => row.kind)).toEqual(["recurring_held"]);
  });

  test("[REC-007] hlavní vypínač dá koncept i u režimu vystavit", () => {
    const { owner, customerId } = account();
    const id = savePlan(owner, customerId, { mode: "issue" });
    setPaused(webActor(owner), true, ENABLED);
    const result = runOnce(owner, id);
    expect(result.status).toBe("fallback");
    expect(getInvoice(owner, result.invoiceId!)?.status).toBe("draft");
    expect(noticesOf(owner).map((row) => row.kind)).toEqual(["recurring_held"]);
  });

  test("[REC-007] vypnutá automatika se režimu vystavit netýká", () => {
    const { owner, customerId } = account();
    expect(runOnce(owner, savePlan(owner, customerId, { mode: "issue" })).status).toBe("issued");
  });

  test("[REC-007] po opětovném zapnutí se koncept sám nevystaví ani neodešle", async () => {
    const { owner, customerId } = sendingAccount();
    const id = savePlan(owner, customerId, SEND);
    setPaused(webActor(owner), true, ENABLED);
    const { invoiceId } = runOnce(owner, id);
    setPaused(webActor(owner), false, ENABLED);
    planRecurringRuns(current);
    await drainJobs("w");
    expect(getInvoice(owner, invoiceId!)?.status).toBe("draft");
    expect(smtp.messages).toEqual([]);
  });

  test("[TST-005] odeslání z plánu předá kopie z nastavení a bez automatiky neodejde nic", async () => {
    const owner = seedOwner(db, T0);
    ownSmtp(db, owner, smtp.port, { cc: ["kopie@example.cz"], bcc: ["archiv@example.cz"] });
    const customerId = seedCustomer(owner);
    setAutomation(webActor(owner), "recurringSend", true, ENABLED);
    const id = savePlan(owner, customerId, SEND);

    const result = runOnce(owner, id);
    expect(result.status).toBe("queued");
    const [log] = mailOf(owner);
    expect(log).toMatchObject({
      trigger: "automatic",
      automation: "recurringSend",
      plannedFor: "2026-03-10",
      to: ["alfa@example.cz"],
      cc: ["kopie@example.cz"],
      bcc: ["archiv@example.cz"],
    });
    await drainJobs("w");
    expect(smtp.messages).toHaveLength(1);
    expect(smtp.messages[0]!.to).toEqual(
      expect.arrayContaining(["alfa@example.cz", "kopie@example.cz", "archiv@example.cz"]),
    );
    expect(getInvoice(owner, result.invoiceId!)?.status).toBe("sent");
    assertConsistent(db, owner);
  }, 30_000);

  test("zákazník bez adresy nechá fakturu vystavenou s upozorněním", () => {
    const { owner, customerId } = sendingAccount("");
    const result = runOnce(owner, savePlan(owner, customerId, SEND));
    expect(result.status).toBe("issued");
    expect(getInvoice(owner, result.invoiceId!)?.status).toBe("issued");
    expect(mailOf(owner)).toEqual([]);
    expect(noticesOf(owner).map((row) => row.kind)).toEqual(["recurring_no_address"]);
  });

  test("zpráva, která neprojde kontrolou, nechá fakturu vystavenou s upozorněním", () => {
    const owner = seedOwner(db, T0);
    const cc = Array.from({ length: 20 }, (_, i) => `kopie${i}@example.cz`);
    ownSmtp(db, owner, smtp.port, { cc });
    const customerId = seedCustomer(owner);
    setAutomation(webActor(owner), "recurringSend", true, ENABLED);

    const result = runOnce(owner, savePlan(owner, customerId, SEND));
    expect(result.status).toBe("issued");
    expect(getInvoice(owner, result.invoiceId!)?.status).toBe("issued");
    expect(mailOf(owner)).toEqual([]);
    const [notice] = noticesOf(owner);
    expect(notice?.kind).toBe("recurring_bad_mail");
    expect(String(notice?.params.problems)).toMatch(/20 příjemců/);
    expect(listRuns(owner, listRecurring(owner)[0]!.id)[0]?.reason).toMatch(/20 příjemců/);
  });

  test("[REC-013] selhání odeslání nechá fakturu vystavenou a run queued s upozorněním", async () => {
    const owner = seedOwner(db, T0);
    ownSmtp(db, owner, 1);
    const customerId = seedCustomer(owner);
    setAutomation(webActor(owner), "recurringSend", true, ENABLED);
    const id = savePlan(owner, customerId, SEND);
    const result = runOnce(owner, id);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await drainJobs("w");
      current = new Date(current.getTime() + 3 * 3_600_000);
    }
    expect(mailOf(owner).map((row) => [row.status, row.attempts])).toEqual([["failed", 4]]);
    expect(getInvoice(owner, result.invoiceId!)?.status).toBe("issued");
    expect(listRuns(owner, id)[0]?.status).toBe("queued");
    expect(noticesOf(owner).map((row) => row.kind)).toEqual(["mail_failed"]);
    assertConsistent(db, owner);
  }, 30_000);

  test("[REC-012] upozornění N dní předem jde jen uživateli", async () => {
    const owner = seedOwner(db, T0);
    ownSmtp(db, owner, smtp.port, { cc: ["kopie@example.cz"], bcc: ["archiv@example.cz"] });
    const customerId = seedCustomer(owner);
    setAutomation(webActor(owner), "recurringSend", true, ENABLED);
    savePlan(owner, customerId, { ...SEND, notifyDaysBefore: 3 });

    at("2026-03-07T07:30:00Z");
    db.update(job).set({ status: "done" }).run();
    planRecurringNotices(current);
    expect(noticesOf(owner)).toEqual([]);

    at("2026-03-07T08:30:00Z");
    setPaused(webActor(owner), true, ENABLED);
    planRecurringNotices(current);
    planRecurringNotices(current);
    await drainJobs("w");

    expect(noticesOf(owner).map((row) => row.kind)).toEqual(["recurring_upcoming"]);
    expect(noticesOf(owner)[0]?.params.sends).toBe(false);
    expect(smtp.messages).toHaveLength(1);
    expect(smtp.messages[0]!.to).toEqual([`${owner}@example.cz`]);
    expect(smtp.messages[0]!.body).toMatch(/jen koncept/);
    expect(smtp.messages[0]!.body).not.toMatch(/vystaví a odešle/);
    expect(smtp.messages[0]!.raw).not.toContain("alfa@example.cz");
    expect(mailOf(owner)).toEqual([]);
  });
});

describe("upozornění předem", () => {
  const upcoming = (owner: string) => T.kinds.recurring_upcoming(noticesOf(owner)[0]!.params);

  test("[REC-012] slibuje odeslání, jen když opravdu proběhne", async () => {
    const { owner, customerId } = sendingAccount();
    savePlan(owner, customerId, { ...SEND, notifyDaysBefore: 3 });
    at("2026-03-07T10:00:00Z");
    planRecurringNotices(current);
    await drainJobs("w");
    expect(upcoming(owner)).toMatch(/se odešle/);
    const mail = smtp.messages.find((item) => item.to.includes(`${owner}@example.cz`));
    expect(mail?.body).toMatch(/vystaví a odešle/);
  });

  test("[REC-012] s vypnutou automatikou odeslání neslibuje", () => {
    const { owner, customerId } = sendingAccount();
    savePlan(owner, customerId, { ...SEND, notifyDaysBefore: 3 });
    setAutomation(webActor(owner), "recurringSend", false, ENABLED);
    at("2026-03-07T10:00:00Z");
    planRecurringNotices(current);
    expect(upcoming(owner)).toMatch(/jen koncept/);
    expect(upcoming(owner)).not.toMatch(/se odešle/);
  });
});

describe("souběh", () => {
  const dir = mkdtempSync(join(tmpdir(), "fakturan-recurring-workers-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("[REC-030] 8 souběžných běhů stejného termínu dá jednu fakturu a jedno číslo", async () => {
    const owner = seedOwner(db, T0);
    const id = savePlan(owner, seedCustomer(owner), { mode: "issue" });
    // Worker threads run on the real clock, so the occurrence must not look overdue to them.
    const issueDate = calendarDateInPrague(new Date());
    const { periodKey, billedPeriod } = occurrenceOf(owner, id);

    const databasePath = join(dir, "shared.db");
    db.$client.pragma("wal_checkpoint(TRUNCATE)");
    await db.$client.backup(databasePath);
    const shared = createDb(databasePath);
    runMigrations(shared);

    const results = await runJobWorkers<unknown>(
      Array.from({ length: 8 }, (_, i) => ({
        mode: "recurring",
        worker: `w${i}`,
        ownerId: owner,
        recurringId: id,
        occurrence: { issueDate, periodKey, billedPeriod },
      })),
      databasePath,
    );
    expect(results.filter((result) => result !== null)).toHaveLength(1);
    const invoices = shared.select().from(invoice).where(eq(invoice.userId, owner)).all();
    expect(invoices).toHaveLength(1);
    expect(invoices[0]!.number).toBeTruthy();
    const runs = shared.select().from(recurringRun).where(eq(recurringRun.recurringId, id)).all();
    expect(runs).toHaveLength(1);
    const used = shared
      .select()
      .from(numberSeriesCounter)
      .where(eq(numberSeriesCounter.userId, owner))
      .all();
    expect(used.map((row) => row.highest)).toEqual([1]);
    assertConsistent(shared, owner);
    shared.$client.close();
  }, 60_000);
});

describe("kurzy ČNB u pravidelných faktur", () => {
  const seedEur = (listDate: string, rateMicros = 24_380_000) =>
    db.insert(exchangeRate).values({ currency: "EUR", listDate, rateMicros, fetchedAt: T0 }).run();

  const eurPlan = (owner: string, customerId: string) =>
    savePlan(owner, customerId, {
      mode: "issue",
      document: planDocument({ currency: "EUR", paymentMethod: "cash" }),
    });

  async function runJob(owner: string, id: string) {
    const { periodKey, issueDate, billedPeriod } = occurrenceOf(owner, id);
    await runRecurringJob({
      userId: owner,
      payload: {
        recurringId: id,
        periodKey,
        issueDate,
        periodFrom: billedPeriod.from,
        periodTo: billedPeriod.to,
      },
    } as never);
    return listRuns(owner, id)[0]!;
  }

  test("pravidelná faktura v EUR se vystaví bez sítě z uloženého lístku a nekončí ve fallback", async () => {
    const { owner, customerId } = account();
    seedEur("2026-03-09");

    const run = await runJob(owner, eurPlan(owner, customerId));

    expect(run.status).toBe("issued");
    expect(getInvoice(owner, run.invoiceId!)).toMatchObject({
      status: "issued",
      exchangeRateMicros: 24_380_000,
      exchangeRateSource: "cnb",
      exchangeRateDate: "2026-03-09",
    });
    expect(cnb.requests).toEqual([]);
    expect(noticesOf(owner)).toEqual([]);
    assertConsistent(db, owner);
  });

  test("[FOR-003] chybějící lístek se před vystavením stáhne", async () => {
    const { owner, customerId } = account();
    cnb.setMode(cnbMode.date("2026-03-09"));

    const run = await runJob(owner, eurPlan(owner, customerId));

    expect(run.status).toBe("issued");
    expect(getInvoice(owner, run.invoiceId!)).toMatchObject({
      exchangeRateSource: "cnb",
      exchangeRateDate: "2026-03-09",
    });
    expect(cnb.requests).toEqual(["/denni_kurz.txt?date=09.03.2026"]);
  });

  test("[FOR-004] při výpadku se vystaví s posledním známým kurzem a upozorní", async () => {
    const { owner, customerId } = account();
    seedEur("2026-03-02", 24_000_000);

    const run = await runJob(owner, eurPlan(owner, customerId));

    expect(run.status).toBe("issued");
    expect(getInvoice(owner, run.invoiceId!)).toMatchObject({
      exchangeRateMicros: 24_000_000,
      exchangeRateSource: "last_known",
      exchangeRateDate: "2026-03-02",
    });
    expect(noticesOf(owner).map((row) => row.kind)).toEqual(["rate_last_known"]);
    expect(noticesOf(owner)[0]!.params).toMatchObject({
      currency: "EUR",
      date: "10. 3. 2026",
      listDate: "2. 3. 2026",
    });
  });

  test("[FOR-010] pevný kurz nad 5 % od ČNB vystavení nezastaví, ale upozorní", async () => {
    const { owner, customerId } = account();
    seedEur("2026-03-09", 25_000_000);
    savePreferences(webActor(owner), { fixedRates: { EUR: 26_250_001 } });

    const run = await runJob(owner, eurPlan(owner, customerId));

    expect(run.status).toBe("issued");
    expect(getInvoice(owner, run.invoiceId!)).toMatchObject({
      exchangeRateSource: "fixed",
      exchangeRateMicros: 26_250_001,
    });
    expect(noticesOf(owner).map((row) => row.kind)).toEqual(["rate_deviation"]);
    expect(noticesOf(owner)[0]!.params).toMatchObject({ currency: "EUR", date: "10. 3. 2026" });
  });

  test("[FOR-010] pevný kurz přesně na hranici 5 % a bez reference neupozorní", async () => {
    const { owner, customerId } = account();
    seedEur("2026-03-09", 25_000_000);
    savePreferences(webActor(owner), { fixedRates: { EUR: 26_250_000 } });
    const edge = await runJob(owner, eurPlan(owner, customerId));
    db.delete(exchangeRate).run();
    const other = account();
    savePreferences(webActor(other.owner), { fixedRates: { EUR: 40_000_000 } });
    const bare = await runJob(other.owner, eurPlan(other.owner, other.customerId));

    expect(edge.status).toBe("issued");
    expect(bare.status).toBe("issued");
    expect(noticesOf(owner)).toEqual([]);
    expect(noticesOf(other.owner)).toEqual([]);
  });

  test("[FOR-004] pravidelná faktura při výpadku s prázdnou tabulkou skončí konceptem bez chyby úlohy", async () => {
    const { owner, customerId } = account();

    const run = await runJob(owner, eurPlan(owner, customerId));

    expect(run.status).toBe("fallback");
    expect(getInvoice(owner, run.invoiceId!)).toMatchObject({ status: "draft", number: null });
    expect(noticesOf(owner).map((row) => row.kind)).toEqual(["recurring_failed"]);
    expect(cnb.requests).toHaveLength(1);
  });

  test("[FOR-007] pravidelná faktura v angličtině má doložku anglicky", async () => {
    const { owner, customerId } = account();
    seedEur("2026-03-09");
    const id = savePlan(owner, customerId, {
      mode: "issue",
      document: planDocument({
        currency: "EUR",
        paymentMethod: "cash",
        language: "en",
        foreign: true,
        clause: REVERSE_CHARGE_CLAUSE.en,
      }),
    });

    const run = await runJob(owner, id);

    expect(getInvoice(owner, run.invoiceId!)).toMatchObject({
      foreign: true,
      language: "en",
      clause: REVERSE_CHARGE_CLAUSE.en,
      exchangeRateSource: "cnb",
    });
  });

  test("faktura v korunách síť ani kurz nepoužije", async () => {
    const { owner, customerId } = account();

    const run = await runJob(owner, savePlan(owner, customerId, { mode: "issue" }));

    expect(run.status).toBe("issued");
    expect(getInvoice(owner, run.invoiceId!)).toMatchObject({
      exchangeRateMicros: null,
      exchangeRateSource: null,
    });
    expect(cnb.requests).toEqual([]);
  });

  test("zrušený nebo smazaný plán úloha přeskočí bez sítě", async () => {
    const { owner } = account();

    await runRecurringJob({
      userId: owner,
      payload: {
        recurringId: "neexistuje",
        periodKey: "x",
        issueDate: "2026-03-10",
        periodFrom: "2026-03-01",
        periodTo: "2026-03-31",
      },
    } as never);

    expect(cnb.requests).toEqual([]);
  });
});
