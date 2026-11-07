import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { finishedPeriod, taxReminderDue } from "@/lib/owner-reports";
import { TEXTS } from "@/lib/texts";
import { setClockForTests } from "@/server/clock";
import { auditLog, emailLog, invoice, job, user } from "@/server/db/schema";
import { purgeFinishedJobs } from "@/server/jobs/queue";
import { limitStates } from "@/server/reports/turnover";
import { registerJob } from "@/server/jobs/registry";
import { drainJobs } from "@/server/jobs/worker";
import { ownerReportPlanTask } from "@/server/scheduler/start";
import { recoverBackupJob, runBackup } from "@/server/services/account-backup";
import { recoverRestore, runRestore } from "@/server/services/account-restore";
import {
  getAutomation,
  setLimitMail,
  setPaused,
  setPeriodSummary,
  setTaxReminder,
} from "@/server/services/automation";
import { savePreferences } from "@/server/services/preferences";
import { getMailLook, saveMailLook, setMailLogo } from "@/server/services/mail-look";
import { blobPath } from "@/server/files/store";
import { FIXTURE_LOGO_SVG } from "../fixtures/invoices";
import { reportSummary } from "@/server/services/reports";
import {
  deliverOwnerReport,
  periodSummary,
  planOwnerReports,
  summaryText,
  taxReminderText,
} from "@/server/services/owner-reports";
import { issuedDocument, line, pay } from "../fixtures/report-scenario";
import { backupArchive, restoreArchive } from "../helpers/backup-compare";
import { createTestDb } from "../helpers/db";
import { ownSmtp, seedCustomer, seedOwner, webActor } from "../helpers/fixtures-mail";
import { planDocument, savePlan } from "../helpers/fixtures-recurring";
import { startSmtp, type TestSmtp } from "../helpers/smtp";

vi.mock("@/server/reports/turnover", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/reports/turnover")>();
  return { ...actual, limitStates: vi.fn(actual.limitStates) };
});

vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-owner-reports-")));
vi.stubEnv("ALLOW_PRIVATE_MAIL_HOSTS", "true");
vi.stubEnv("SENTRY_DSN", "http://public@localhost/1");
vi.stubEnv("SMTP_HOST", "");
vi.stubEnv("SMTP_PORT", "");
vi.stubEnv("SMTP_FROM", "");

const db = createTestDb();
const TODAY = "2026-12-01";
// 9:30 in Prague (CET), just past the default send time of 9:00.
const NOW = new Date("2026-12-01T08:30:00Z");
const CLIENT = "alfa@example.cz";

let smtp: TestSmtp;
let current = NOW;

beforeAll(async () => {
  smtp = await startSmtp();
});
afterAll(() => smtp.stop());

beforeEach(() => {
  smtp.reset();
  db.delete(job).run();
  db.update(user).set({ banned: true }).run();
  current = NOW;
  setClockForTests({ now: () => current });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  registerJob("user.report", { run: deliverOwnerReport });
});
afterEach(() => {
  setClockForTests(null);
  vi.restoreAllMocks();
});

// The report fixtures move the clock themselves; this hands it back to the test.
function resume(at: Date = NOW) {
  current = at;
  setClockForTests({ now: () => current });
}

const plain = (text: string) => text.replace(/[  ]/g, " ");

// The fixture of the brief: A paid in November, B overdue since 19 November, a 2 000 plan on the 15th.
function november(): { owner: string; email: string } {
  const owner = seedOwner(db, new Date("2026-10-01T10:00:00Z"));
  ownSmtp(db, owner, smtp.port, { cc: ["ucetni@novak.cz"], bcc: ["skryta@novak.cz"] });
  const customer = seedCustomer(owner, CLIENT);
  const a = issuedDocument(owner, customer, {
    issueDate: "2026-11-03",
    dueDate: "2026-11-17",
    totalMinor: 1_210_000,
  });
  pay(owner, a, "2026-11-10", 1_210_000);
  issuedDocument(owner, customer, {
    issueDate: "2026-11-05",
    dueDate: "2026-11-19",
    totalMinor: 500_000,
  });
  resume();
  savePlan(owner, customer, {
    startsOn: TODAY,
    issueDay: 15,
    document: planDocument({ lines: [line(200_000)] }),
  });
  const { email } = db.select({ email: user.email }).from(user).where(eq(user.id, owner)).get()!;
  return { owner, email };
}

async function tickAt(at: Date) {
  current = at;
  ownerReportPlanTask.run(at);
  await drainJobs("w");
}

const jobsOf = (owner: string) =>
  db
    .select()
    .from(job)
    .where(and(eq(job.userId, owner), eq(job.kind, "user.report")))
    .all();

describe("obsah souhrnu", () => {
  test("[REM-010] souhrn za listopad: fakturováno 17 100,00 Kč, přijato 12 100,00 Kč, pohledávky 5 000,00 Kč", () => {
    const { owner } = november();
    const { range, next } = finishedPeriod(TODAY, "monthly");

    const summary = periodSummary(owner, range, next, TODAY);
    const text = plain(summaryText(owner, summary));

    expect(summary.invoiced).toEqual({
      minor: 1_710_000,
      unconverted: { count: 0, byCurrency: [] },
    });
    expect(summary.income.minor).toBe(1_210_000);
    expect(summary.outstanding.minor).toBe(500_000);
    expect(text).toContain("listopad 2026");
    expect(text).toContain("Fakturováno: 17 100,00 Kč");
    expect(text).toContain("Přijato: 12 100,00 Kč");
    expect(text).toContain("Pohledávky k 1. 12. 2026: 5 000,00 Kč");
  });

  test("[REM-010] po splatnosti 1 faktura 5 000,00 Kč a výhled na prosinec 7 000,00 Kč", () => {
    const { owner } = november();
    const { range, next } = finishedPeriod(TODAY, "monthly");

    const summary = periodSummary(owner, range, next, TODAY);
    const text = plain(summaryText(owner, summary));

    expect(summary.overdue).toMatchObject({ count: 1, minor: 500_000 });
    expect(summary.outlook.minor).toBe(700_000);
    expect(text).toContain("Po splatnosti: 1 faktura, 5 000,00 Kč");
    expect(text).toContain("Výhled na prosinec 2026: 7 000,00 Kč");
    expect(text).not.toContain("bez kurzu");
  });

  test("[REM-010] po splatnosti počítá jako přehledy, bez zálohy", () => {
    const { owner } = november();
    const customer = seedCustomer(owner, CLIENT);
    issuedDocument(owner, customer, {
      issueDate: "2026-11-06",
      dueDate: "2026-11-20",
      totalMinor: 300_000,
      type: "advance",
    });
    resume();
    const { range, next } = finishedPeriod(TODAY, "monthly");

    const summary = periodSummary(owner, range, next, TODAY);
    const app = reportSummary(owner, { range, includeExternal: true }, TODAY);

    expect(summary.overdue).toMatchObject({ count: 1, minor: 500_000 });
    expect(summary.overdue.minor).toBe(app.overdueMinor);
  });

  test("[REM-010] doklad v cizí měně bez kurzu jde na samostatný řádek s počtem", () => {
    const { owner } = november();
    const customer = seedCustomer(owner, CLIENT);
    const foreign = issuedDocument(owner, customer, {
      issueDate: "2026-11-20",
      dueDate: "2026-11-25",
      totalMinor: 10_000,
      currency: "EUR",
      rateMicros: 25_000_000,
    });
    db.update(invoice).set({ exchangeRateMicros: null }).where(eq(invoice.id, foreign)).run();
    resume();
    const { range, next } = finishedPeriod(TODAY, "monthly");

    const summary = periodSummary(owner, range, next, TODAY);
    const text = plain(summaryText(owner, summary));

    expect(summary.invoiced.minor).toBe(1_710_000);
    expect(summary.overdue).toMatchObject({
      count: 2,
      minor: 500_000,
      unconverted: { count: 1, byCurrency: [{ currency: "EUR", amountMinor: 10_000 }] },
    });
    expect(text).toContain("Fakturováno: 17 100,00 Kč");
    expect(text).toMatch(/bez kurzu.*1 .*100,00 €/);
  });
});

describe("odeslání souhrnu", () => {
  test("[REM-010] souhrn přijde i jako HTML ve zvoleném vzhledu, se stejným textem a bez QR", async () => {
    const { owner } = november();
    setPeriodSummary(webActor(owner), "monthly");
    saveMailLook(webActor(owner), {
      layout: "b2",
      intro: "Úvod pro klienty",
      signature: "",
      logoMode: "supplier",
    });

    await tickAt(NOW);

    const [mail] = smtp.messages;
    expect(mail!.raw).toMatch(/multipart\/alternative/i);
    expect(plain(mail!.html!)).toContain("Fakturováno: 17 100,00 Kč");
    expect(mail!.html).not.toContain("Úvod pro klienty");
    expect(mail!.html).not.toContain("cid:qr@invoice");
    expect(mail!.attachments).toEqual([]);
  });

  test("[REM-010] chyba při skládání HTML nic neodešle a souhrn se zopakuje později", async () => {
    const { owner } = november();
    setPeriodSummary(webActor(owner), "monthly");
    setMailLogo(webActor(owner), FIXTURE_LOGO_SVG, "logo.svg");
    const blob = blobPath(owner, getMailLook(owner).logoFileId!);
    rmSync(blob);
    mkdirSync(blob);

    await tickAt(NOW);

    expect(smtp.messages).toEqual([]);
    expect(jobsOf(owner)).toMatchObject([
      { status: "pending", attempts: 1, reason: "E-mail pro vlastníka se zopakuje" },
    ]);
  });

  test("[REM-010] zpráva jde jen na e-mail účtu, bez stálých kopií a bez přílohy", async () => {
    const { owner, email } = november();
    setPeriodSummary(webActor(owner), "monthly");

    await tickAt(NOW);

    expect(smtp.messages).toHaveLength(1);
    expect(smtp.messages[0]!.to).toEqual([email]);
    expect(smtp.messages[0]!.attachments).toEqual([]);
    expect(smtp.messages[0]!.subject).toBe("Fakturan: souhrn za listopad 2026");
    expect(plain(smtp.messages[0]!.body)).toContain("Fakturováno: 17 100,00 Kč");
    expect(db.select().from(emailLog).where(eq(emailLog.userId, owner)).all()).toEqual([]);
    expect(jobsOf(owner)).toMatchObject([
      {
        kind: "user.report",
        key: `summary:${owner}:2026-11`,
        payload: { report: "summary", period: "2026-11" },
      },
    ]);
    const audits = db
      .select()
      .from(auditLog)
      .where(eq(auditLog.ownerId, owner))
      .all()
      .filter((row) => row.action.startsWith("mail.owner_report"));
    expect(audits.map((row) => [row.action, row.source])).toEqual([
      ["mail.owner_report_plan", "scheduler"],
      ["mail.owner_report", "scheduler"],
    ]);
    for (const row of audits) {
      expect(row.after).toEqual({ report: "summary", period: "2026-11" });
    }
  });

  test("[REM-010] druhý tick téhož dne ani restart nepošle druhý souhrn", async () => {
    const { owner } = november();
    setPeriodSummary(webActor(owner), "monthly");

    await tickAt(NOW);
    await tickAt(new Date("2026-12-01T09:00:00Z"));
    // A new process keeps nothing in memory: only the job row stands between it and a repeat.
    await tickAt(new Date("2026-12-02T10:00:00Z"));
    await tickAt(new Date("2026-12-03T22:00:00Z"));

    expect(smtp.messages).toHaveLength(1);
    expect(jobsOf(owner)).toHaveLength(1);
  });

  test("[REM-010] neběží před časem odeslání, ale běží pod hlavním vypínačem", async () => {
    const { owner } = november();
    setPeriodSummary(webActor(owner), "monthly");
    setPaused(webActor(owner), true, { confirmed: false });

    await tickAt(new Date("2026-12-01T07:59:00Z"));
    expect(smtp.messages).toEqual([]);

    await tickAt(NOW);
    expect(smtp.messages).toHaveLength(1);
  });

  test("[REM-010] zapnutí 2. 12. ještě pošle listopad, 4. 12. už ne", async () => {
    const late = november();
    const late2 = november();

    current = new Date("2026-12-02T10:00:00Z");
    setPeriodSummary(webActor(late.owner), "monthly");
    await tickAt(current);
    expect(smtp.messages.map((message) => message.to)).toEqual([[late.email]]);

    current = new Date("2026-12-04T10:00:00Z");
    setPeriodSummary(webActor(late2.owner), "monthly");
    await tickAt(current);
    await tickAt(new Date("2026-12-31T22:00:00Z"));
    expect(smtp.messages).toHaveLength(1);
    expect(jobsOf(late2.owner)).toEqual([]);
  });

  test("[REM-010] čtvrtletní souhrn v listopadu nic nepošle", async () => {
    const { owner, email } = november();
    current = new Date("2026-11-01T10:00:00Z");
    setPeriodSummary(webActor(owner), "quarterly");

    for (const day of ["01", "02", "03", "15", "30"]) {
      await tickAt(new Date(`2026-11-${day}T10:00:00Z`));
    }
    await tickAt(NOW);
    expect(smtp.messages).toEqual([]);

    await tickAt(new Date("2027-01-01T10:00:00Z"));
    expect(smtp.messages.map((message) => message.to)).toEqual([[email]]);
    expect(jobsOf(owner).map((row) => row.key)).toEqual([`summary:${owner}:2026-Q4`]);
  });

  test("[REM-010] vypnutí nebo změna druhu před odesláním zprávu zastaví", async () => {
    const off = november();
    const changed = november();
    setPeriodSummary(webActor(off.owner), "monthly");
    setPeriodSummary(webActor(changed.owner), "monthly");

    planOwnerReports(NOW);
    setPeriodSummary(webActor(off.owner), "off");
    setPeriodSummary(webActor(changed.owner), "quarterly");
    await drainJobs("w");

    expect(smtp.messages).toEqual([]);
    expect(smtp.connections()).toBe(0);
  });

  test("[REM-010] období skončené před založením účtu se nepošle", async () => {
    const owner = seedOwner(db, NOW);
    ownSmtp(db, owner, smtp.port);
    issuedDocument(owner, seedCustomer(owner, CLIENT), {
      issueDate: TODAY,
      dueDate: "2026-12-15",
      totalMinor: 100_000,
    });
    resume();
    setPeriodSummary(webActor(owner), "monthly");

    await tickAt(NOW);
    await tickAt(new Date("2026-12-02T10:00:00Z"));

    expect(smtp.messages).toEqual([]);
    expect(jobsOf(owner)).toEqual([]);
  });

  test("[REM-010] první doběh hned po zapnutí se samými nulami se nepošle", async () => {
    const empty = () => {
      const owner = seedOwner(db, new Date("2026-10-01T10:00:00Z"));
      ownSmtp(db, owner, smtp.port);
      const { email } = db
        .select({ email: user.email })
        .from(user)
        .where(eq(user.id, owner))
        .get()!;
      return { owner, email };
    };
    const lateOn = empty();
    const earlyOn = empty();
    resume(new Date("2026-11-15T10:00:00Z"));
    setPeriodSummary(webActor(earlyOn.owner), "monthly");
    resume(new Date("2026-12-02T08:00:00Z"));
    setPeriodSummary(webActor(lateOn.owner), "monthly");

    await tickAt(new Date("2026-12-02T10:00:00Z"));

    // Turned on before November ended, the zero summary is what the owner asked for.
    expect(smtp.messages.map((message) => message.to)).toEqual([[earlyOn.email]]);
    expect(jobsOf(lateOn.owner)).toHaveLength(1);

    await tickAt(new Date("2026-12-03T10:00:00Z"));
    expect(smtp.messages).toHaveLength(1);
  });

  test("[REM-010] souhrn doručovaný až v dalším období se zahodí", async () => {
    const { owner } = november();
    setPeriodSummary(webActor(owner), "monthly");
    planOwnerReports(NOW);

    current = new Date("2027-01-02T10:00:00Z");
    await drainJobs("w");

    expect(smtp.messages).toEqual([]);
    expect(jobsOf(owner)).toMatchObject([{ status: "done" }]);
  });

  test("[REM-010] deaktivovaný účet nic nedostane", async () => {
    const { owner } = november();
    setPeriodSummary(webActor(owner), "monthly");
    db.update(user).set({ banned: true }).where(eq(user.id, owner)).run();

    await tickAt(NOW);

    expect(smtp.messages).toEqual([]);
    expect(jobsOf(owner)).toEqual([]);
  });
});

describe("obnova", () => {
  test("[IMP-010] obnova nastaví period_summary off", async () => {
    registerJob("backup.run", { run: runBackup, recover: recoverBackupJob });
    registerJob("restore.run", { run: runRestore, recover: recoverRestore });
    const { owner } = november();
    setPeriodSummary(webActor(owner), "quarterly");
    const bytes = await backupArchive(db, owner);
    const target = `obnova-${Date.now()}`;
    db.insert(user)
      .values({
        id: target,
        name: target,
        email: `${target}@example.cz`,
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();

    expect((await restoreArchive(db, target, bytes)).status).toBe("done");

    expect(getAutomation(owner).periodSummary).toBe("quarterly");
    expect(getAutomation(target)).toMatchObject({
      periodSummary: "off",
      taxReminder: false,
      limitMail: false,
    });
    await tickAt(new Date("2027-01-01T10:00:00Z"));
    expect(jobsOf(target)).toEqual([]);
  });
});

describe("lednová připomínka k daním", () => {
  const JAN_10 = new Date("2027-01-10T08:30:00Z");

  test("[REM-011] 10. 1. 2027 přijde přehled za 2026 s příjmy, neuhrazenými k 31. 12. a odkazem", async () => {
    const { owner, email } = november();
    setTaxReminder(webActor(owner), true);

    await tickAt(JAN_10);

    expect(smtp.messages.map((message) => message.to)).toEqual([[email]]);
    expect(smtp.messages[0]!.attachments).toEqual([]);
    expect(smtp.messages[0]!.subject).toBe("Fakturan: podklady k daním za rok 2026");
    const text = plain(smtp.messages[0]!.body);
    expect(text).toContain("Příjmy podle data úhrady za rok 2026: 12 100,00 Kč");
    expect(text).toContain("Neuhrazené k 31. 12. 2026: 1 faktura, 5 000,00 Kč");
    expect(text).toContain("http://localhost:3000/prehledy/dane?rok=2026");
    expect(plain(taxReminderText(owner, 2026))).toBe(text.trimEnd());
    expect(jobsOf(owner)).toMatchObject([
      { key: `tax:${owner}:2026`, payload: { report: "tax", period: "2026" } },
    ]);
  });

  test("[REM-011] připomínka nese upozornění TEXTS.tax.disclaimer", () => {
    const { owner } = november();
    resume(JAN_10);

    expect(taxReminderText(owner, 2026)).toContain(TEXTS.tax.disclaimer);
  });

  test("[REM-011] 9. 1. nic, 31. 1. doběh, 1. 2. nic a druhý běh v roce nic", async () => {
    expect(taxReminderDue("2027-01-09")).toBeNull();
    expect(taxReminderDue("2027-01-10")).toEqual({ year: 2026 });
    expect(taxReminderDue("2027-01-31")).toEqual({ year: 2026 });
    expect(taxReminderDue("2027-02-01")).toBeNull();
    expect(taxReminderDue("2026-12-10")).toBeNull();

    const late = november();
    const missed = november();
    setTaxReminder(webActor(late.owner), true);
    setTaxReminder(webActor(missed.owner), true);
    db.update(user).set({ banned: true }).where(eq(user.id, missed.owner)).run();

    await tickAt(new Date("2027-01-09T22:00:00Z"));
    expect(smtp.messages).toEqual([]);

    await tickAt(new Date("2027-01-31T10:00:00Z"));
    await tickAt(new Date("2027-01-31T20:00:00Z"));
    expect(smtp.messages.map((message) => message.to)).toEqual([[late.email]]);

    db.update(user).set({ banned: false }).where(eq(user.id, missed.owner)).run();
    await tickAt(new Date("2027-02-01T10:00:00Z"));
    await tickAt(new Date("2027-12-31T10:00:00Z"));
    expect(smtp.messages).toHaveLength(1);
    expect(jobsOf(missed.owner)).toEqual([]);
  });

  test("[REM-011] účet založený v lednu s doklady za loňský rok připomínku dostane, prázdný ne", async () => {
    const created = new Date("2027-01-05T10:00:00Z");
    const moved = seedOwner(db, created);
    ownSmtp(db, moved, smtp.port);
    const customer = seedCustomer(moved, CLIENT);
    issuedDocument(moved, customer, {
      issueDate: "2026-11-05",
      dueDate: "2026-11-19",
      totalMinor: 500_000,
    });
    const empty = seedOwner(db, created);
    ownSmtp(db, empty, smtp.port);
    resume(JAN_10);
    setTaxReminder(webActor(moved), true);
    setTaxReminder(webActor(empty), true);

    await tickAt(JAN_10);

    const { email } = db.select({ email: user.email }).from(user).where(eq(user.id, moved)).get()!;
    expect(smtp.messages.map((message) => message.to)).toEqual([[email]]);
    expect(plain(smtp.messages[0]!.body)).toContain("Neuhrazené k 31. 12. 2026: 1 faktura");
  });

  test("[REM-011] bez nastavené pošty připomínka počká na další pokus a neztratí se", async () => {
    const owner = seedOwner(db, new Date("2026-10-01T10:00:00Z"));
    const customer = seedCustomer(owner, CLIENT);
    issuedDocument(owner, customer, {
      issueDate: "2026-11-05",
      dueDate: "2026-11-19",
      totalMinor: 500_000,
    });
    resume(JAN_10);
    setTaxReminder(webActor(owner), true);

    await tickAt(JAN_10);
    expect(jobsOf(owner)).toMatchObject([{ status: "pending", attempts: 1 }]);

    ownSmtp(db, owner, smtp.port);
    await tickAt(new Date(JAN_10.getTime() + 31 * 60_000));
    expect(smtp.messages).toHaveLength(1);
  });

  test("[REM-011] vypnutí před odesláním zprávu zastaví", async () => {
    const { owner } = november();
    setTaxReminder(webActor(owner), true);
    current = JAN_10;
    planOwnerReports(JAN_10);
    setTaxReminder(webActor(owner), false);
    await drainJobs("w");

    expect(smtp.messages).toEqual([]);
  });
});

describe("e-mail o limitu DPH", () => {
  const JUNE = new Date("2026-06-10T08:30:00Z");

  function turnoverAccount(): { owner: string; email: string; customer: string } {
    const owner = seedOwner(db, new Date("2026-01-01T10:00:00Z"));
    ownSmtp(db, owner, smtp.port, { cc: ["ucetni@novak.cz"] });
    const customer = seedCustomer(owner, CLIENT);
    resume(JUNE);
    const { email } = db.select({ email: user.email }).from(user).where(eq(user.id, owner)).get()!;
    return { owner, email, customer };
  }

  function invoiced(owner: string, customer: string, totalMinor: number, issueDate = "2026-06-01") {
    issuedDocument(owner, customer, { issueDate, totalMinor });
    resume(current);
  }

  // Raw SQL on purpose: the record must hold whatever the service module exports.
  const sentThresholds = (owner: string) =>
    (
      db.$client
        .prepare("SELECT year, threshold FROM limit_mail_sent WHERE user_id = ?")
        .all(owner) as { year: number; threshold: string }[]
    )
      .map((row) => `${row.year}:${row.threshold}`)
      .sort();

  test("[REM-012] obrat 1 600 000,00 Kč pošle 80 %, 1 900 000,00 Kč pošle 95 %", async () => {
    const { owner, email, customer } = turnoverAccount();
    setLimitMail(webActor(owner), true);
    invoiced(owner, customer, 159_999_999);
    await tickAt(JUNE);
    expect(smtp.messages).toEqual([]);

    invoiced(owner, customer, 1);
    await tickAt(JUNE);
    await tickAt(new Date("2026-06-11T08:30:00Z"));
    expect(smtp.messages.map((message) => message.to)).toEqual([[email]]);
    expect(smtp.messages[0]!.subject).toBe(
      "Fakturan: obrat dosáhl 80 % limitu pro registraci k DPH",
    );
    expect(plain(smtp.messages[0]!.body)).toContain("1 600 000,00 Kč z 2 000 000,00 Kč");

    invoiced(owner, customer, 30_000_000);
    await tickAt(new Date("2026-06-12T08:30:00Z"));
    expect(smtp.messages).toHaveLength(2);
    expect(smtp.messages[1]!.subject).toContain("95 %");
    expect(plain(smtp.messages[1]!.body)).toContain("1 900 000,00 Kč z 2 000 000,00 Kč");
    expect(jobsOf(owner).map((row) => row.key)).toEqual([
      `limit:${owner}:2026:80`,
      `limit:${owner}:2026:95`,
    ]);
  });

  test("[REM-012] skok z 0 na 1 950 000,00 Kč pošle jen 95 %", async () => {
    const { owner, customer } = turnoverAccount();
    setLimitMail(webActor(owner), true);
    invoiced(owner, customer, 195_000_000);

    await tickAt(JUNE);
    await tickAt(new Date("2026-06-11T08:30:00Z"));

    expect(smtp.messages.map((message) => message.subject)).toEqual([
      "Fakturan: obrat dosáhl 95 % limitu pro registraci k DPH",
    ]);
    expect(sentThresholds(owner)).toEqual(["2026:80", "2026:95"]);
    expect(jobsOf(owner).map((row) => row.key)).toEqual([`limit:${owner}:2026:95`]);
  });

  test("[REM-012] skok rovnou přes 100 % pošle jen e-mail o překročení a pokles nic nevrátí", async () => {
    const { owner, email, customer } = turnoverAccount();
    setLimitMail(webActor(owner), true);
    invoiced(owner, customer, 210_000_000);

    await tickAt(JUNE);
    expect(smtp.messages.map((message) => message.to)).toEqual([[email]]);
    expect(smtp.messages[0]!.subject).toBe("Fakturan: obrat překročil limit pro registraci k DPH");
    const body = plain(smtp.messages[0]!.body);
    expect(body).toContain("Obrat za rok 2026 překročil limit pro registraci k DPH.");
    expect(body).toContain("povinnost registrovat se k DPH");
    expect(body).toContain(TEXTS.tax.reviewPending);
    expect(sentThresholds(owner)).toEqual(["2026:80", "2026:95", "2026:over"]);

    savePreferences(webActor(owner), { turnoverVatLimitMinor: 400_000_000 });
    await tickAt(new Date("2026-06-11T08:30:00Z"));
    savePreferences(webActor(owner), { turnoverVatLimitMinor: null });
    await tickAt(new Date("2026-06-12T08:30:00Z"));
    expect(smtp.messages).toHaveLength(1);
  });

  test("[REM-012] po 95 % přijde při překročení samostatný e-mail o překročení", async () => {
    const { owner, customer } = turnoverAccount();
    setLimitMail(webActor(owner), true);
    invoiced(owner, customer, 195_000_000);
    await tickAt(JUNE);

    invoiced(owner, customer, 10_000_000);
    await tickAt(new Date("2026-06-11T08:30:00Z"));

    expect(smtp.messages.map((message) => message.subject)).toEqual([
      "Fakturan: obrat dosáhl 95 % limitu pro registraci k DPH",
      "Fakturan: obrat překročil limit pro registraci k DPH",
    ]);
    expect(jobsOf(owner).map((row) => row.key.split(":").at(-1))).toEqual(["95", "over"]);
  });

  test("[REM-012] úklid hotových jobů po 91, 181 a 271 dnech nepošle druhý e-mail", async () => {
    const { owner, customer } = turnoverAccount();
    setLimitMail(webActor(owner), true);
    const FEB = new Date("2026-02-10T08:30:00Z");
    resume(FEB);
    invoiced(owner, customer, 160_000_000, "2026-02-01");
    await tickAt(FEB);
    expect(smtp.messages).toHaveLength(1);

    for (const days of [91, 181, 271]) {
      const later = new Date(FEB.getTime() + days * 86_400_000);
      purgeFinishedJobs(later);
      await tickAt(later);
    }
    await tickAt(new Date("2027-01-10T08:30:00Z"));

    expect(jobsOf(owner)).toEqual([]);
    expect(smtp.messages).toHaveLength(1);
  });

  test("[REM-012] v lednu ohlásí loňský rok: DUZP 30. 12. zadané 4. 1. pošle překročení za 2026", async () => {
    const { owner, customer } = turnoverAccount();
    setLimitMail(webActor(owner), true);
    const DEC = new Date("2026-12-21T08:30:00Z");
    resume(DEC);
    invoiced(owner, customer, 185_000_000, "2026-12-20");
    await tickAt(DEC);
    expect(smtp.messages.map((message) => message.subject)).toEqual([
      "Fakturan: obrat dosáhl 80 % limitu pro registraci k DPH",
    ]);

    const JAN_4 = new Date("2027-01-04T08:30:00Z");
    resume(JAN_4);
    issuedDocument(owner, customer, {
      issueDate: "2027-01-04",
      dueDate: "2027-01-18",
      totalMinor: 20_000_000,
      over: { taxableDate: "2026-12-30" },
    });
    resume(JAN_4);
    await tickAt(JAN_4);

    expect(smtp.messages).toHaveLength(2);
    expect(smtp.messages[1]!.subject).toBe("Fakturan: obrat překročil limit pro registraci k DPH");
    expect(plain(smtp.messages[1]!.body)).toContain("Obrat za rok 2026 překročil");
    expect(sentThresholds(owner)).toEqual(["2026:80", "2026:95", "2026:over"]);

    // From February only the running year is watched.
    resume(new Date("2027-02-01T08:30:00Z"));
    issuedDocument(owner, customer, {
      issueDate: "2027-02-01",
      dueDate: "2027-02-15",
      totalMinor: 1_000,
      over: { taxableDate: "2026-12-31" },
    });
    await tickAt(new Date("2027-02-01T08:30:00Z"));
    expect(smtp.messages).toHaveLength(2);
  });

  test("[REM-012] job 80 % doručený po růstu obratu pošle znění 80 % a 95 % přijde zvlášť", async () => {
    const { owner, customer } = turnoverAccount();
    setLimitMail(webActor(owner), true);
    invoiced(owner, customer, 160_000_000);
    planOwnerReports(JUNE);
    invoiced(owner, customer, 30_000_000);
    await drainJobs("w");
    await tickAt(new Date("2026-06-11T08:30:00Z"));

    expect(smtp.messages.map((message) => message.subject)).toEqual([
      "Fakturan: obrat dosáhl 80 % limitu pro registraci k DPH",
      "Fakturan: obrat dosáhl 95 % limitu pro registraci k DPH",
    ]);
  });

  test("[TST-009] záznam o odeslání jednoho účtu nezastaví e-mail jiného", async () => {
    const first = turnoverAccount();
    const second = turnoverAccount();
    setLimitMail(webActor(first.owner), true);
    invoiced(first.owner, first.customer, 160_000_000);
    await tickAt(JUNE);
    setLimitMail(webActor(second.owner), true);
    invoiced(second.owner, second.customer, 160_000_000);
    await tickAt(new Date("2026-06-11T08:30:00Z"));

    expect(smtp.messages.map((message) => message.to)).toEqual([[first.email], [second.email]]);
    expect(sentThresholds(first.owner)).toEqual(["2026:80"]);
    expect(sentThresholds(second.owner)).toEqual(["2026:80"]);
  });

  test("[REM-012] selhání kontroly limitu se zkusí znovu ještě týž den", async () => {
    const { owner, customer } = turnoverAccount();
    setLimitMail(webActor(owner), true);
    invoiced(owner, customer, 160_000_000);
    vi.mocked(limitStates).mockImplementationOnce(() => {
      throw new Error("databáze je zaneprázdněná");
    });

    await tickAt(JUNE);
    expect(smtp.messages).toEqual([]);

    await tickAt(new Date("2026-06-10T09:30:00Z"));
    expect(smtp.messages).toHaveLength(1);
  });

  test("[REM-012] limit se kontroluje jednou denně", async () => {
    const { owner, customer } = turnoverAccount();
    setLimitMail(webActor(owner), true);
    await tickAt(JUNE);
    invoiced(owner, customer, 160_000_000);
    await tickAt(new Date("2026-06-10T20:00:00Z"));
    expect(smtp.messages).toEqual([]);

    await tickAt(new Date("2026-06-11T08:30:00Z"));
    expect(smtp.messages).toHaveLength(1);
  });

  test("[REM-012] vypnuté hlídání limitu nebo limit_mail nepošle nic", async () => {
    const unwatched = turnoverAccount();
    setLimitMail(webActor(unwatched.owner), true);
    savePreferences(webActor(unwatched.owner), { turnoverVatWatch: false });
    invoiced(unwatched.owner, unwatched.customer, 195_000_000);
    const off = turnoverAccount();
    invoiced(off.owner, off.customer, 195_000_000);
    const offLater = turnoverAccount();
    setLimitMail(webActor(offLater.owner), true);
    invoiced(offLater.owner, offLater.customer, 195_000_000);

    planOwnerReports(JUNE);
    setLimitMail(webActor(offLater.owner), false);
    await drainJobs("w");
    await tickAt(new Date("2026-06-11T08:30:00Z"));

    expect(smtp.messages).toEqual([]);
    expect(jobsOf(unwatched.owner)).toEqual([]);
    expect(jobsOf(off.owner)).toEqual([]);
  });

  test("[REM-012] vlastní limit 1 000 000,00 Kč posune práh 80 % na 800 000,00 Kč", async () => {
    const { owner, customer } = turnoverAccount();
    setLimitMail(webActor(owner), true);
    savePreferences(webActor(owner), { turnoverVatLimitMinor: 100_000_000 });
    invoiced(owner, customer, 79_999_999);
    await tickAt(JUNE);
    expect(smtp.messages).toEqual([]);

    invoiced(owner, customer, 1);
    await tickAt(new Date("2026-06-11T08:30:00Z"));
    expect(smtp.messages.map((message) => message.subject)).toEqual([
      "Fakturan: obrat dosáhl 80 % limitu pro registraci k DPH",
    ]);
    expect(plain(smtp.messages[0]!.body)).toContain("800 000,00 Kč z 1 000 000,00 Kč");
  });
});
