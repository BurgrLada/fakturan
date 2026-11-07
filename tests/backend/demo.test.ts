import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, inArray, min } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { auth } from "@/server/auth";
import { setClockForTests } from "@/server/clock";
import {
  auditLog,
  customer,
  dashboard,
  emailLog,
  invoice,
  job,
  payment,
  recurringInvoice,
  reminderRule,
  supplier,
  user,
} from "@/server/db/schema";
import { DEMO_ICOS, seedDemo } from "@/server/demo/seed";
import { demoUserId, isDemoAccount } from "@/server/demo/mode";
import { parseEnv } from "@/server/env";
import { demoResetTask } from "@/server/scheduler/demo-reset";
import { saveBankMailbox } from "@/server/services/bank-mailbox";
import { planDigests } from "@/server/services/due-alerts";
import {
  mailAvailability,
  resolveTransport,
  saveMailSettings,
} from "@/server/services/mail-settings";
import { planOwnerReports } from "@/server/services/owner-reports";
import { planRecurringNotices, planRecurringRuns } from "@/server/services/recurring-run";
import { planReminders } from "@/server/services/reminders";
import { deleteOwnAccount, deleteUser } from "@/server/services/users";
import { Browser, BASE, type Auth } from "../helpers/auth-browser";
import { assertConsistent } from "../helpers/consistency";
import { createTestDb } from "../helpers/db";
import { issuedInvoice, seedOwner } from "../helpers/fixtures-mail";

const DEMO_EMAIL = "ukazka@fakturan.example";
const DEMO_PASSWORD = "ukazka-fakturan-heslo";
const dataDir = mkdtempSync(join(tmpdir(), "fakturan-demo-"));
const base = {
  DATA_DIR: dataDir,
  BETTER_AUTH_URL: BASE,
  BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
};
for (const [key, value] of Object.entries(base)) vi.stubEnv(key, value);
vi.stubEnv("DEMO_MODE", "1");
vi.stubEnv("DEMO_EMAIL", DEMO_EMAIL);
vi.stubEnv("DEMO_PASSWORD", DEMO_PASSWORD);

const db = createTestDb();
const NOW = new Date("2026-11-04T10:00:00Z");
const NEXT_NIGHT = new Date("2026-11-05T02:31:00Z");
const MAIL_KINDS = ["mail.send", "user.notice", "user.digest", "user.report"] as const;

let current = NOW;

beforeEach(() => {
  current = NOW;
  setClockForTests({ now: () => current });
});

afterEach(() => {
  setClockForTests(null);
});

function invoicesOf(userId: string) {
  return db.select().from(invoice).where(eq(invoice.userId, userId)).all();
}

function mailJobs() {
  return db
    .select()
    .from(job)
    .where(inArray(job.kind, [...MAIL_KINDS]))
    .all();
}

async function seeded() {
  return demoUserId() ? { userId: demoUserId()!, invoices: 0 } : seedDemo(NOW);
}

describe("ukázka", () => {
  test("[OPS-007] seedDemo založí 18 měsíců dat a assertConsistent projde", async () => {
    const { userId, invoices } = await seedDemo(NOW);
    const docs = invoicesOf(userId);

    expect(invoices).toBe(docs.length);
    expect(invoices).toBeGreaterThanOrEqual(40);
    const oldest = db
      .select({ at: min(invoice.issueDate) })
      .from(invoice)
      .where(eq(invoice.userId, userId))
      .get()!.at!;
    expect(oldest <= "2025-05-31").toBe(true);
    expect(new Set(docs.map((row) => row.currency))).toEqual(new Set(["CZK", "EUR"]));
    expect(docs.some((row) => row.type === "advance" && row.status === "paid")).toBe(true);
    expect(docs.some((row) => row.relatedInvoiceId && row.type === "invoice")).toBe(true);
    expect(docs.some((row) => row.type === "credit_note" && row.status !== "draft")).toBe(true);
    expect(docs.some((row) => row.status === "sent" && row.dueDate! < "2026-11-04")).toBe(true);
    expect(
      db.select().from(payment).where(eq(payment.userId, userId)).all().length,
    ).toBeGreaterThan(30);
    expect(
      db.select().from(reminderRule).where(eq(reminderRule.userId, userId)).all(),
    ).toHaveLength(1);
    expect(
      db.select().from(recurringInvoice).where(eq(recurringInvoice.userId, userId)).all(),
    ).toHaveLength(1);
    expect(
      db.select().from(dashboard).where(eq(dashboard.userId, userId)).all().length,
    ).toBeGreaterThan(0);

    const icos = [
      ...db.select({ ico: customer.ico }).from(customer).where(eq(customer.userId, userId)).all(),
      ...db.select({ ico: supplier.ico }).from(supplier).where(eq(supplier.userId, userId)).all(),
    ]
      .map((row) => row.ico)
      .filter(Boolean);
    expect(icos.length).toBe(5);
    for (const ico of icos) expect(DEMO_ICOS).toContain(ico);
    const numbered = docs
      .filter((row) => row.type === "invoice")
      .sort((a, b) => a.number!.localeCompare(b.number!));
    expect(numbered.map((row) => row.issueDate)).toEqual(
      numbered.map((row) => row.issueDate).sort(),
    );
    assertConsistent(db, userId);
  });

  test("[OPS-007] druhé spuštění seedDemo nic nezdvojí", async () => {
    const first = await seeded();
    const before = invoicesOf(first.userId).length;

    const second = await seedDemo(NOW);

    expect(second.userId).toBe(first.userId);
    expect(second.invoices).toBe(before);
    expect(invoicesOf(first.userId)).toHaveLength(before);
    expect(db.select().from(user).where(eq(user.email, DEMO_EMAIL)).all()).toHaveLength(1);
  });

  test("[OPS-007] noční reset vrátí ukázku a cizí účet nechá netknutý", async () => {
    const demo = await seeded();
    const seededCount = invoicesOf(demo.userId).length;
    const other = seedOwner(db, NOW);
    issuedInvoice(other);
    const otherBefore = JSON.stringify([
      invoicesOf(other),
      db.select().from(auditLog).where(eq(auditLog.ownerId, other)).all(),
    ]);
    db.delete(payment).where(eq(payment.userId, demo.userId)).run();

    current = new Date("2026-11-05T01:00:00Z");
    await demoResetTask.run(current);
    expect(demoUserId()).toBe(demo.userId);

    current = NEXT_NIGHT;
    await demoResetTask.run(current);
    const fresh = demoUserId()!;
    expect(fresh).not.toBe(demo.userId);
    expect(invoicesOf(demo.userId)).toHaveLength(0);
    expect(invoicesOf(fresh)).toHaveLength(seededCount);
    expect(db.select().from(payment).where(eq(payment.userId, fresh)).all().length).toBeGreaterThan(
      30,
    );

    current = new Date(NEXT_NIGHT.getTime() + 3_600_000);
    await demoResetTask.run(current);
    expect(demoUserId()).toBe(fresh);

    expect(
      JSON.stringify([
        invoicesOf(other),
        db.select().from(auditLog).where(eq(auditLog.ownerId, other)).all(),
      ]),
    ).toBe(otherBefore);
    assertConsistent(db, other);
    assertConsistent(db, fresh);
  });

  test("[OPS-007] v režimu ukázky resolveTransport vrací null a nic neodejde", async () => {
    const { userId } = await seeded();
    const withSmtp = parseEnv({
      ...base,
      DEMO_MODE: "1",
      DEMO_EMAIL,
      DEMO_PASSWORD,
      SMTP_HOST: "smtp.example.cz",
      SMTP_PORT: "587",
      SMTP_FROM: "fakturan@example.cz",
    });
    const actor = { userId, source: "web" as const };

    expect(await resolveTransport(userId, withSmtp)).toBeNull();
    expect(mailAvailability(userId, withSmtp).available).toBe(false);
    await expect(
      saveMailSettings(actor, { smtpHost: "smtp.example.cz", smtpPort: 587 }, withSmtp),
    ).rejects.toThrow("V ukázce");
    await expect(
      saveBankMailbox(actor, { host: "imap.example.cz", port: 993 }, withSmtp),
    ).rejects.toThrow("V ukázce");
  });

  test("[OPS-007] registrace, změna hesla a smazání účtu ukázky jsou odmítnuté", async () => {
    const { userId } = await seeded();
    const visitor = new Browser(auth as unknown as Auth);

    const signUp = await visitor.signUp("novy@example.cz");
    expect(signUp.status).toBe(400);
    expect(db.select().from(user).where(eq(user.email, "novy@example.cz")).all()).toEqual([]);

    expect((await visitor.signIn(DEMO_EMAIL, DEMO_PASSWORD)).status).toBe(200);
    const change = await visitor.request("/change-password", {
      body: { currentPassword: DEMO_PASSWORD, newPassword: "uplne-jine-heslo-123" },
    });
    expect(change.status).toBe(403);
    expect(
      (await new Browser(auth as unknown as Auth).signIn(DEMO_EMAIL, DEMO_PASSWORD)).status,
    ).toBe(200);

    const actor = { userId, source: "web" as const };
    await expect(deleteOwnAccount(actor, { createdAt: NOW }, DEMO_PASSWORD)).rejects.toThrow(
      "V ukázce",
    );
    const admin = seedOwner(db, NOW);
    db.update(user).set({ role: "admin" }).where(eq(user.id, admin)).run();
    expect(() => deleteUser({ userId: admin, source: "web" }, userId, DEMO_EMAIL)).toThrow(
      "V ukázce",
    );
    expect(isDemoAccount(userId)).toBe(true);
    expect(isDemoAccount(admin)).toBe(false);
  });

  test("[OPS-003] DEMO_MODE bez DEMO_PASSWORD aplikaci nespustí", () => {
    expect(() => parseEnv({ ...base, DEMO_MODE: "1", DEMO_EMAIL })).toThrow(/DEMO_PASSWORD/);
    expect(() => parseEnv({ ...base, DEMO_MODE: "1", DEMO_PASSWORD })).toThrow(/DEMO_EMAIL/);
    expect(parseEnv({ ...base, DEMO_MODE: "0" }).DEMO_MODE).toBe(false);
  });

  test("[TST-016] reset ani seed nepošlou žádnou zprávu", async () => {
    await seeded();
    current = new Date("2026-11-06T02:31:00Z");
    await demoResetTask.run(current);
    const userId = demoUserId()!;

    for (const at of ["2026-11-06T07:00:00Z", "2026-11-10T07:00:00Z", "2026-12-01T07:00:00Z"]) {
      current = new Date(at);
      planReminders(current);
      planDigests(current);
      planOwnerReports(current);
      planRecurringNotices(current);
      planRecurringRuns(current);
    }

    expect(mailJobs()).toEqual([]);
    expect(db.select().from(emailLog).where(eq(emailLog.userId, userId)).all()).toEqual([]);
    expect(await resolveTransport(userId)).toBeNull();
    expect(
      db
        .select()
        .from(job)
        .where(and(eq(job.userId, userId), eq(job.status, "pending")))
        .all()
        .every((row) => !MAIL_KINDS.includes(row.kind as never)),
    ).toBe(true);
  });
});
