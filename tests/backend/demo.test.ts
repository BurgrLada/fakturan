import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, inArray, min } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { auth, createAuth, DEMO_LOCKED_PATHS } from "@/server/auth";
import { emailHash } from "@/server/audit/email-hash";
import { setClockForTests } from "@/server/clock";
import {
  auditLog,
  customer,
  dashboard,
  emailLog,
  instanceMeta,
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
import { saveBankMailbox, testBankMailbox } from "@/server/services/bank-mailbox";
import { checkMailboxNow, planBankPolls, pollMailbox } from "@/server/services/bank-poll";
import { planDigests } from "@/server/services/due-alerts";
import {
  mailAvailability,
  resolveTransport,
  saveMailSettings,
} from "@/server/services/mail-settings";
import { planOwnerReports } from "@/server/services/owner-reports";
import { planRecurringNotices, planRecurringRuns } from "@/server/services/recurring-run";
import { planReminders } from "@/server/services/reminders";
import { deleteOwnAccount, deleteUser, purgeDemoAccount } from "@/server/services/users";
import { Browser, BASE, fakeGithub, githubLogin, type Auth } from "../helpers/auth-browser";
import { assertConsistent } from "../helpers/consistency";
import { createTestDb } from "../helpers/db";
import { pollJob, seedMailbox } from "../helpers/fixtures-bank";
import { issuedInvoice, seedOwner } from "../helpers/fixtures-mail";
import { startImap } from "../helpers/imap";

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
const failing = vi.hoisted(() => ({ plan: false }));
vi.mock("@/server/services/recurring", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/services/recurring")>();
  return {
    ...actual,
    saveRecurring: (...args: Parameters<typeof actual.saveRecurring>) => {
      if (failing.plan) throw new Error("plán selhal");
      return actual.saveRecurring(...args);
    },
  };
});

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

  test("[OPS-007] v režimu ukázky se k uložené schránce s avízy nikdo nepřipojí", async () => {
    const imap = await startImap();
    try {
      const owner = seedOwner(db, NOW);
      seedMailbox(db, owner, imap.port, NOW);
      const demoImap = parseEnv({ ...demoEnv, ALLOW_PRIVATE_MAIL_HOSTS: "true" });
      const actor = { userId: owner, source: "web" as const };

      planBankPolls(current);
      await pollMailbox(pollJob(owner, current), { env: demoImap });
      await expect(testBankMailbox(actor, demoImap)).rejects.toThrow("V ukázce");
      expect(() => checkMailboxNow(actor, "pozadavek-1")).toThrow("V ukázce");

      expect(
        db
          .select()
          .from(job)
          .where(and(eq(job.kind, "bank.poll"), eq(job.userId, owner)))
          .all(),
      ).toEqual([]);
      expect(imap.connections()).toBe(0);
    } finally {
      await imap.close();
    }
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

const SCHEDULER = { userId: null, source: "scheduler" } as const;
const demoEnv = { ...base, DEMO_MODE: "1", DEMO_EMAIL, DEMO_PASSWORD };

function dropDemo() {
  const id = demoUserId();
  if (id) purgeDemoAccount(SCHEDULER, id);
}

function rejections() {
  return db
    .select()
    .from(auditLog)
    .all()
    .filter((row) => row.action === "auth.signup_rejected");
}

describe("ukázka nezávisle na datu a selhání", () => {
  test("[OPS-007] seed k 1. lednu má vystavený doklad z dneška, ne po now", async () => {
    dropDemo();
    current = new Date("2027-01-01T08:00:00Z");

    const { userId } = await seedDemo(current);

    const today = invoicesOf(userId).filter((row) => row.issueDate === "2027-01-01");
    expect(today).toHaveLength(1);
    expect(today[0]).toMatchObject({ type: "invoice", status: "sent" });
    expect(invoicesOf(userId).every((row) => row.createdAt <= current)).toBe(true);
    expect(invoicesOf(userId).every((row) => row.issueDate! <= "2027-01-01")).toBe(true);
    assertConsistent(db, userId);
  });

  test("[OPS-007] seed, který selže uprostřed, účet ukázky nenechá", async () => {
    dropDemo();
    failing.plan = true;
    try {
      await expect(seedDemo(NOW)).rejects.toThrow("plán selhal");
    } finally {
      failing.plan = false;
    }
    expect(demoUserId()).toBeNull();
    expect(db.select().from(user).where(eq(user.email, DEMO_EMAIL)).all()).toEqual([]);

    const { userId } = await seedDemo(NOW);
    expect(invoicesOf(userId).length).toBeGreaterThanOrEqual(40);
  });

  test("[OPS-007] zamčené cesty auth účet ukázky nezmění a ostatní relace neukončí", async () => {
    await seeded();
    const other = new Browser(auth as unknown as Auth);
    expect((await other.signIn(DEMO_EMAIL, DEMO_PASSWORD)).status).toBe(200);
    const visitor = new Browser(auth as unknown as Auth);
    expect((await visitor.signIn(DEMO_EMAIL, DEMO_PASSWORD)).status).toBe(200);
    const bodies: Record<string, unknown> = {
      "/change-password": { currentPassword: DEMO_PASSWORD, newPassword: "uplne-jine-heslo-123" },
      "/change-email": { newEmail: "jiny@example.cz" },
      "/set-password": { newPassword: "uplne-jine-heslo-123" },
      "/delete-user": { password: DEMO_PASSWORD },
      "/update-user": { name: "Někdo jiný" },
      "/link-social": { provider: "github", callbackURL: "/" },
      "/unlink-account": { providerId: "credential" },
      "/revoke-session": { token: "cizi" },
      "/revoke-sessions": {},
      "/revoke-other-sessions": {},
    };
    expect(Object.keys(bodies).sort()).toEqual([...DEMO_LOCKED_PATHS].sort());

    for (const path of DEMO_LOCKED_PATHS) {
      const res = await visitor.request(path, { body: bodies[path] });
      // set-password is server-only in Better Auth, so over HTTP it does not exist at all.
      const expected = path === "/set-password" ? [403, 404] : [403];
      expect(expected, path).toContain(res.status);
      if (res.status === 403) {
        expect(((await res.json()) as { code: string }).code, path).toBe("DEMO_LOCKED");
      }
    }

    expect((await other.sessionUser())?.email).toBe(DEMO_EMAIL);
    expect(db.select().from(user).where(eq(user.email, DEMO_EMAIL)).get()?.name).toBe("Ukázka");
    expect(
      (await new Browser(auth as unknown as Auth).signIn(DEMO_EMAIL, DEMO_PASSWORD)).status,
    ).toBe(200);
  });
});

describe("registrace v ukázce", () => {
  beforeEach(() => {
    db.delete(user).run();
    db.delete(instanceMeta).run();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("[OPS-007] ani první účet prázdné instance se v ukázce nezaregistruje", async () => {
    const before = rejections().length;

    const res = await new Browser(auth as unknown as Auth).signUp("prvni@example.cz");

    expect(res.status).toBe(400);
    expect(db.select().from(user).all()).toEqual([]);
    expect(rejections()).toHaveLength(before + 1);
  });

  test("[OPS-007] sociální registrace se v ukázce odmítne a zapíše do auditu", async () => {
    const socialAuth = createAuth(
      parseEnv({ ...demoEnv, GITHUB_CLIENT_ID: "gh-id", GITHUB_CLIENT_SECRET: "gh-secret" }),
    );
    fakeGithub("cizi@example.cz");
    const before = rejections().length;

    const res = await githubLogin(new Browser(socialAuth as unknown as Auth));

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${BASE}/prihlaseni?chyba=pozvanka`);
    expect(db.select().from(user).all()).toEqual([]);
    expect(rejections()).toHaveLength(before + 1);
    expect(rejections().at(-1)?.after).toMatchObject({
      emailHash: emailHash("cizi@example.cz", parseEnv(demoEnv)),
    });
  });
});
