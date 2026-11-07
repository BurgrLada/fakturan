import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { finishedPeriod } from "@/lib/owner-reports";
import { setClockForTests } from "@/server/clock";
import { auditLog, emailLog, invoice, job, user } from "@/server/db/schema";
import { registerJob } from "@/server/jobs/registry";
import { drainJobs } from "@/server/jobs/worker";
import { ownerReportPlanTask } from "@/server/scheduler/start";
import { recoverBackupJob, runBackup } from "@/server/services/account-backup";
import { recoverRestore, runRestore } from "@/server/services/account-restore";
import { getAutomation, setPaused, setPeriodSummary } from "@/server/services/automation";
import { reportSummary } from "@/server/services/reports";
import {
  deliverOwnerReport,
  periodSummary,
  planOwnerReports,
  summaryText,
} from "@/server/services/owner-reports";
import { issuedDocument, line, pay } from "../fixtures/report-scenario";
import { backupArchive, restoreArchive } from "../helpers/backup-compare";
import { createTestDb } from "../helpers/db";
import { ownSmtp, seedCustomer, seedOwner, webActor } from "../helpers/fixtures-mail";
import { planDocument, savePlan } from "../helpers/fixtures-recurring";
import { startSmtp, type TestSmtp } from "../helpers/smtp";

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
