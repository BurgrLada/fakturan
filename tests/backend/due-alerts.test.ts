import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { setClockForTests } from "@/server/clock";
import { auditLog, automationSettings, emailLog, invoice, job, user } from "@/server/db/schema";
import { claimNext } from "@/server/jobs/queue";
import { registerJob } from "@/server/jobs/registry";
import { drainJobs, recoverInterrupted } from "@/server/jobs/worker";
import { setDailyDigest, setPaused } from "@/server/services/automation";
import {
  deliverDigest,
  digestJob,
  dueAlerts,
  DUE_SOON_DAYS,
  planDigests,
} from "@/server/services/due-alerts";
import { derivedAlerts } from "@/server/services/notifications";
import { createTestDb } from "../helpers/db";
import {
  issuedInvoice,
  ownSmtp,
  seedCustomer,
  seedOwner,
  webActor,
} from "../helpers/fixtures-mail";
import { startSmtp, type TestSmtp } from "../helpers/smtp";

vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-due-alerts-")));
vi.stubEnv("ALLOW_PRIVATE_MAIL_HOSTS", "true");
vi.stubEnv("SENTRY_DSN", "http://public@localhost/1");
vi.stubEnv("SMTP_HOST", "");
vi.stubEnv("SMTP_PORT", "");
vi.stubEnv("SMTP_FROM", "");

const db = createTestDb();
const NOW = new Date("2026-03-10T09:30:00Z");
const TODAY = "2026-03-10";

let smtp: TestSmtp;

beforeAll(async () => {
  smtp = await startSmtp();
});
afterAll(() => smtp.stop());

beforeEach(() => {
  smtp.reset();
  db.delete(job).run();
  db.delete(automationSettings).run();
  setClockForTests({ now: () => NOW });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  registerJob("user.digest", { run: deliverDigest });
});
afterEach(() => {
  setClockForTests(null);
  vi.restoreAllMocks();
});

function account(cc: string[] = []) {
  const owner = seedOwner(db, NOW);
  ownSmtp(db, owner, smtp.port, { cc, bcc: ["skryta@novak.cz"] });
  return { owner, customerId: seedCustomer(owner) };
}

function due(owner: string, customerId: string, dueDate: string, status = "sent" as const) {
  const id = issuedInvoice(owner, customerId);
  db.update(invoice).set({ status, dueDate }).where(eq(invoice.id, id)).run();
  return id;
}

describe("dueAlerts", () => {
  test("[UI-011] rozdělí faktury po splatnosti a do 3 dnů, zbytek ne", () => {
    const { owner, customerId } = account();
    const late = due(owner, customerId, "2026-03-09");
    const today = due(owner, customerId, TODAY);
    const edge = due(owner, customerId, "2026-03-13");
    due(owner, customerId, "2026-03-14");
    const paid = due(owner, customerId, "2026-03-01");
    db.update(invoice)
      .set({ status: "paid", paidMinor: 300_000 })
      .where(eq(invoice.id, paid))
      .run();

    const alerts = dueAlerts(owner, TODAY);

    expect(DUE_SOON_DAYS).toBe(3);
    expect(alerts.overdue.map((row) => row.id)).toEqual([late]);
    expect(alerts.dueSoon.map((row) => row.id)).toEqual([today, edge]);
    expect(alerts.overdue[0]!.amountDueMinor).toBe(300_000);
  });

  test("po úhradě zmizí sám a cizí účet nic nevidí", () => {
    const { owner, customerId } = account();
    const { owner: stranger } = account();
    const id = due(owner, customerId, "2026-03-01");

    expect(dueAlerts(stranger, TODAY).overdue).toEqual([]);
    expect(derivedAlerts(owner).map((alert) => alert.kind)).toEqual(["invoices_overdue"]);
    expect(derivedAlerts(owner)[0]!.dedupeKey).toContain(TODAY);

    db.update(invoice).set({ status: "paid", paidMinor: 300_000 }).where(eq(invoice.id, id)).run();
    expect(derivedAlerts(owner)).toEqual([]);
  });
});

describe("denní přehled", () => {
  test("[REM-009] denní e-mail je vypnutý a jde jen uživateli, nikdy klientovi", async () => {
    const { owner, customerId } = account(["ucetni@novak.cz"]);
    due(owner, customerId, "2026-03-01");

    planDigests(NOW);
    expect(db.select().from(job).where(eq(job.userId, owner)).all()).toEqual([]);

    setDailyDigest(webActor(owner), true);
    planDigests(NOW);
    planDigests(NOW);
    await drainJobs("w");

    expect(smtp.messages).toHaveLength(1);
    const [{ email }] = db.select({ email: user.email }).from(user).where(eq(user.id, owner)).all();
    expect(smtp.messages[0]!.to).toEqual([email]);
    expect(smtp.messages[0]!.attachments).toEqual([]);
    expect(db.select().from(emailLog).where(eq(emailLog.userId, owner)).all()).toEqual([]);
    const rows = db.select().from(job).where(eq(job.userId, owner)).all();
    expect(rows[0]).toMatchObject({
      key: `digest:${owner}:${TODAY}`,
      payload: { date: TODAY },
    });
    const audits = db.select().from(auditLog).where(eq(auditLog.ownerId, owner)).all();
    expect(audits.map((row) => row.action)).toContain("mail.digest");
  });

  test("[REM-009] pád po odeslání a zotavení po restartu nepošle druhý přehled", async () => {
    registerJob("user.digest", digestJob);
    const { owner, customerId } = account();
    due(owner, customerId, "2026-03-01");
    setDailyDigest(webActor(owner), true);
    planDigests(NOW);

    const claimed = claimNext("pred-padem", "light")!;
    await digestJob.run(claimed);
    recoverInterrupted("w");
    await drainJobs("w");
    planDigests(NOW);
    await drainJobs("w");

    expect(smtp.messages).toHaveLength(1);
    expect(db.select().from(job).where(eq(job.userId, owner)).all()).toEqual([
      expect.objectContaining({ status: "dead" }),
    ]);
  });

  test("prázdný den nic neodešle a vypnutí před během zprávu zastaví", async () => {
    const empty = account();
    setDailyDigest(webActor(empty.owner), true);
    const off = account();
    due(off.owner, off.customerId, "2026-03-01");
    setDailyDigest(webActor(off.owner), true);

    planDigests(NOW);
    setDailyDigest(webActor(off.owner), false);
    await drainJobs("w");

    expect(smtp.messages).toEqual([]);
  });

  test("neběží před nastaveným časem, ale běží pod hlavním vypínačem", async () => {
    const { owner, customerId } = account();
    due(owner, customerId, "2026-03-01");
    setDailyDigest(webActor(owner), true);
    setPaused(webActor(owner), true, { confirmed: false });

    planDigests(new Date("2026-03-10T07:59:00Z"));
    expect(db.select().from(job).where(eq(job.userId, owner)).all()).toEqual([]);

    planDigests(NOW);
    await drainJobs("w");
    expect(smtp.messages).toHaveLength(1);
  });
});
