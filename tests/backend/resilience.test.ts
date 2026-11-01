import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { TEXTS } from "@/lib/texts";
import { setClockForTests } from "@/server/clock";
import {
  bankMailbox,
  bankNotification,
  emailLog,
  invoice,
  job,
  mailSettings,
  notification,
  numberSeriesCounter,
  payment,
  recurringRun,
  schedulerState,
  user,
} from "@/server/db/schema";
import { registerJob } from "@/server/jobs/registry";
import { backupTask, listBackups } from "@/server/scheduler/backup";
import { bankPollTask, deadMailTask, recurringPlanTask } from "@/server/scheduler/start";
import { registerTickTask, resetTickTasksForTests, tick } from "@/server/scheduler/tick";
import { pollMailbox } from "@/server/services/bank-poll";
import { archiveSentPdf } from "@/server/services/files";
import { queueMail } from "@/server/services/invoice-mail";
import { getInvoice } from "@/server/services/invoices";
import { deliverMail, recoverMail } from "@/server/services/mail-delivery";
import { mutate } from "@/server/services/mutation";
import { runRecurringJob } from "@/server/services/recurring-run";
import { deactivateUser, reactivateUser } from "@/server/services/users";
import { assertConsistent } from "../helpers/consistency";
import { createTestDb } from "../helpers/db";
import {
  issuedInvoice,
  ownSmtp,
  seedCustomer,
  seedOwner,
  webActor,
} from "../helpers/fixtures-mail";
import {
  INVOICE_TOTAL,
  noticeText,
  rawMail,
  seedMailbox,
  seedPayable,
} from "../helpers/fixtures-bank";
import { savePlan } from "../helpers/fixtures-recurring";
import { startImap, type TestImap } from "../helpers/imap";
import { runCrashWorker, type CrashPoint } from "../helpers/run-workers";
import { startSmtp, type TestSmtp } from "../helpers/smtp";

const disk = vi.hoisted(() => ({
  full: false,
  free: null as null | { bsize: number; bavail: number },
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const noSpace = () => Object.assign(new Error("ENOSPC: no space left"), { code: "ENOSPC" });
  return {
    ...actual,
    writeFileSync: ((...args: Parameters<typeof actual.writeFileSync>) => {
      if (disk.full) throw noSpace();
      actual.writeFileSync(...args);
    }) as typeof actual.writeFileSync,
    statfsSync: ((path: string) =>
      disk.free
        ? { ...actual.statfsSync(path), ...disk.free }
        : actual.statfsSync(path)) as typeof actual.statfsSync,
  };
});

const dataDir = mkdtempSync(join(tmpdir(), "fakturan-resilience-"));
vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", dataDir);
vi.stubEnv("ALLOW_PRIVATE_MAIL_HOSTS", "true");
vi.stubEnv("SMTP_HOST", "");
vi.stubEnv("SMTP_PORT", "");
vi.stubEnv("SMTP_FROM", "");

const db = createTestDb();
const databasePath = db.$client.name;
const T0 = new Date("2026-03-10T10:00:00Z");
const MINUTE = 60_000;
// Past the 120 s lease a dead holder leaves behind.
const LEASE_GONE = 3 * MINUTE;
const CLOSED_PORT = 1;

let smtp: TestSmtp;
let imap: TestImap;
let current = T0;
let owner = "";
let checked = 0;
let scenarios = 0;

const later = (ms: number) => {
  current = new Date(current.getTime() + ms);
};

beforeAll(async () => {
  smtp = await startSmtp();
  imap = await startImap();
});
afterAll(async () => {
  await smtp.stop();
  await imap.close();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  smtp.reset();
  db.delete(job).run();
  db.delete(schedulerState).run();
  db.insert(schedulerState).values({ id: 1 }).run();
  current = T0;
  disk.full = false;
  disk.free = null;
  setClockForTests({ now: () => current });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  resetTickTasksForTests();
  registerJob("mail.send", { run: deliverMail, recover: recoverMail });
  registerJob("recurring.run", { run: runRecurringJob });
  registerJob("bank.poll", { run: pollMailbox });
  registerTickTask(deadMailTask);
  registerTickTask(recurringPlanTask);
  registerTickTask(bankPollTask);
  // The poll task reads every mailbox in the shared database, also those of earlier scenarios.
  db.delete(bankMailbox).run();
  imap.messages.length = 0;
  imap.commands.length = 0;
  owner = seedOwner(db, T0);
  ownSmtp(db, owner, smtp.port);
});

afterEach(() => {
  disk.full = false;
  // Named here, so no scenario below can forget it (TST-018).
  assertConsistent(db, owner);
  checked += 1;
  setClockForTests(null);
  vi.restoreAllMocks();
});

function queuedInvoice() {
  const invoiceId = issuedInvoice(owner, seedCustomer(owner));
  const key = `mail:test:${randomUUID()}`;
  const queued = mutate(webActor(owner), "invoice.send", (tx, audit) =>
    queueMail(tx, audit, {
      userId: owner,
      invoiceId,
      kind: "invoice",
      trigger: "manual",
      key,
      message: {
        to: ["alfa@example.cz"],
        cc: [],
        bcc: [],
        subject: "Faktura",
        body: "Dobrý den",
      },
    }),
  );
  return { invoiceId, logId: queued!.logId };
}

// The stub design cannot render in the child, so the archive is ready before it starts.
function archivedInvoice() {
  const queued = queuedInvoice();
  archiveSentPdf(webActor(owner), queued.logId, Buffer.from("%PDF-1.7 test"), "faktura.pdf");
  return queued;
}

const YESTERDAY = "03/09/2026 14:05";
const imapPort = (port: number) =>
  db.update(bankMailbox).set({ port }).where(eq(bankMailbox.userId, owner)).run();
const mailboxRow = () => db.select().from(bankMailbox).where(eq(bankMailbox.userId, owner)).get()!;
const paymentsOf = () => db.select().from(payment).where(eq(payment.userId, owner)).all();
const noticesOf = () =>
  db.select().from(bankNotification).where(eq(bankNotification.userId, owner)).all();
const alerts = () => db.select().from(notification).where(eq(notification.userId, owner)).all();

function incomingNotice(id = "10000000001") {
  const { invoiceId } = seedPayable(db, owner, T0);
  seedMailbox(db, owner, imap.port, T0);
  const uid = imap.addMessage(
    rawMail({ body: noticeText({ date: YESTERDAY, id }) }),
    new Date(T0.getTime() - MINUTE),
  );
  return { invoiceId, uid };
}

async function pollTick() {
  later(5 * MINUTE);
  await tick("h");
}

const logOf = (id: string) => db.select().from(emailLog).where(eq(emailLog.id, id)).get()!;
const invoices = () => db.select().from(invoice).where(eq(invoice.userId, owner)).all();
const crash = (killAt: CrashPoint) =>
  runCrashWorker({ databasePath, dataDir, now: current, killAt });

async function tickAfterLease() {
  later(LEASE_GONE);
  await tick("novy-drzitel");
}

describe("ukončení procesu", () => {
  test("[TST-017] SIGKILL po zápisu sending: žádná zpráva, stav unknown, žádné opakování", async () => {
    scenarios += 1;
    const { logId, invoiceId } = archivedInvoice();

    await crash("after_sending");
    expect(logOf(logId).status).toBe("sending");
    expect(smtp.connections()).toBe(0);

    await tickAfterLease();
    await tickAfterLease();

    expect(logOf(logId).status).toBe("unknown");
    expect(smtp.messages).toHaveLength(0);
    expect(getInvoice(owner, invoiceId)?.status).toBe("issued");
  }, 30_000);

  test("[TST-017] SIGKILL po přijetí SMTP: právě jedna zpráva, stav unknown, doklad nevystaven dvakrát", async () => {
    scenarios += 1;
    const { logId, invoiceId } = archivedInvoice();

    await crash("after_smtp");
    expect(smtp.messages).toHaveLength(1);

    await tickAfterLease();
    await tickAfterLease();

    expect(logOf(logId).status).toBe("unknown");
    expect(smtp.messages).toHaveLength(1);
    expect(invoices()).toHaveLength(1);
    expect(getInvoice(owner, invoiceId)?.number).toBeTruthy();
  }, 30_000);

  test("[TST-017] SIGKILL v transakci běhu: žádná faktura, číslo nespotřebované, další tick ji vytvoří jednou", async () => {
    scenarios += 1;
    const customerId = seedCustomer(owner);
    savePlan(owner, customerId, { mode: "issue" });
    await recurringPlanTask.run(current);

    await crash("in_run_tx");
    expect(invoices()).toHaveLength(0);
    expect(db.select().from(recurringRun).where(eq(recurringRun.userId, owner)).all()).toEqual([]);
    expect(
      db.select().from(numberSeriesCounter).where(eq(numberSeriesCounter.userId, owner)).all(),
    ).toEqual([]);

    await tickAfterLease();
    await tickAfterLease();

    expect(invoices()).toHaveLength(1);
    expect(invoices()[0]).toMatchObject({ status: "issued" });
    expect(invoices()[0]!.number).toMatch(/0*1$/);
    expect(db.select().from(recurringRun).where(eq(recurringRun.userId, owner)).all()).toHaveLength(
      1,
    );
  }, 30_000);
});

describe("čtení avíz", () => {
  test("[TST-017] SIGKILL v transakci avíza: po restartu jedna platba", async () => {
    scenarios += 1;
    const { invoiceId, uid } = incomingNotice();
    await bankPollTask.run(current);

    await crash("in_notice_tx");
    expect(noticesOf()).toEqual([]);
    expect(paymentsOf()).toEqual([]);
    expect(mailboxRow().lastUid).toBeNull();

    await tickAfterLease();
    await tickAfterLease();

    expect(paymentsOf()).toHaveLength(1);
    expect(noticesOf()).toMatchObject([{ status: "matched" }]);
    expect(mailboxRow().lastUid).toBe(uid);
    expect(getInvoice(owner, invoiceId)?.status).toBe("paid");
  }, 30_000);

  test("[TST-017] SIGKILL po transakci před kurzorem: žádná druhá platba", async () => {
    scenarios += 1;
    const { invoiceId, uid } = incomingNotice();
    await bankPollTask.run(current);

    await crash("after_notice_tx");
    expect(paymentsOf()).toHaveLength(1);
    expect(mailboxRow().lastUid).toBeNull();

    imap.commands.length = 0;
    await tickAfterLease();
    await tickAfterLease();

    expect(imap.commands.some((command) => command.includes("BODY"))).toBe(true);
    expect(paymentsOf()).toHaveLength(1);
    expect(noticesOf()).toHaveLength(1);
    expect(mailboxRow().lastUid).toBe(uid);
    expect(getInvoice(owner, invoiceId)?.paidMinor).toBe(INVOICE_TOTAL);
  }, 30_000);

  test("[TST-017] nedostupná schránka: po obnovení se vše doplní jednou", async () => {
    scenarios += 1;
    const { invoiceId, uid } = incomingNotice();
    imapPort(CLOSED_PORT);

    for (let attempt = 0; attempt < 3; attempt += 1) await pollTick();
    expect(mailboxRow()).toMatchObject({ failures: 3, lastUid: null });
    expect(alerts().filter((row) => row.resolvedAt === null)).toMatchObject([
      { kind: "bank_connection_failed" },
    ]);
    expect(paymentsOf()).toEqual([]);

    imapPort(imap.port);
    await pollTick();
    await pollTick();

    expect(mailboxRow()).toMatchObject({ failures: 0, failureCode: null, lastUid: uid });
    expect(alerts().filter((row) => row.resolvedAt === null)).toEqual([]);
    expect(paymentsOf()).toHaveLength(1);
    expect(getInvoice(owner, invoiceId)?.status).toBe("paid");
  }, 30_000);

  test("[TST-017] plný disk při zápisu avíza: kurzor stojí a nic se neztratí", async () => {
    scenarios += 1;
    const { invoiceId, uid } = incomingNotice();
    db.$client.function("disk_full", () => {
      throw Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" });
    });
    db.$client.exec(`CREATE TEMP TRIGGER no_space BEFORE INSERT ON main.bank_notification
      BEGIN SELECT disk_full(); END`);
    try {
      await pollTick();
      await pollTick();
    } finally {
      db.$client.exec("DROP TRIGGER no_space");
    }
    expect(noticesOf()).toEqual([]);
    expect(paymentsOf()).toEqual([]);
    expect(mailboxRow()).toMatchObject({ lastUid: null, failureCode: "other", failures: 2 });

    await pollTick();

    expect(noticesOf()).toHaveLength(1);
    expect(paymentsOf()).toHaveLength(1);
    expect(mailboxRow()).toMatchObject({ lastUid: uid, failures: 0 });
    expect(getInvoice(owner, invoiceId)?.status).toBe("paid");
  }, 30_000);

  test("[ADM-005] deaktivace zruší běhy čtení, po reaktivaci se pokračuje od kurzoru", async () => {
    scenarios += 1;
    const { uid } = incomingNotice();
    await pollTick();
    expect(mailboxRow().lastUid).toBe(uid);
    expect(paymentsOf()).toHaveLength(1);

    const admin = seedOwner(db, T0);
    db.update(user).set({ role: "admin" }).where(eq(user.id, admin)).run();
    await bankPollTask.run(new Date(current.getTime() + 5 * MINUTE));
    deactivateUser(webActor(admin), owner);
    const nextUid = imap.addMessage(
      rawMail({ body: noticeText({ date: YESTERDAY, id: "10000000002", vs: "1" }) }),
      new Date(T0.getTime() - MINUTE),
    );
    const before = imap.connections();

    await pollTick();
    await pollTick();
    expect(imap.connections()).toBe(before);
    expect(mailboxRow().lastUid).toBe(uid);
    expect(noticesOf()).toHaveLength(1);

    reactivateUser(webActor(admin), owner);
    imap.commands.length = 0;
    await pollTick();
    await pollTick();

    expect(imap.commands.some((command) => command.startsWith(`UID SEARCH UID ${uid + 1}:*`))).toBe(
      true,
    );
    expect(mailboxRow().lastUid).toBe(nextUid);
    expect(noticesOf()).toHaveLength(2);
    expect(paymentsOf()).toHaveLength(1);
  }, 30_000);
});

describe("nedostupné služby", () => {
  test("[TST-017] nedostupné SMTP: doklad zůstane, po obnovení se doručí jednou", async () => {
    scenarios += 1;
    const server = (port: number) =>
      db.update(mailSettings).set({ smtpPort: port }).where(eq(mailSettings.userId, owner)).run();
    server(CLOSED_PORT);
    const { logId, invoiceId } = queuedInvoice();

    await tick("h");
    expect(logOf(logId).status).toBe("queued");
    expect(getInvoice(owner, invoiceId)?.status).toBe("issued");

    server(smtp.port);
    later(5 * MINUTE);
    await tick("h");
    later(5 * MINUTE);
    await tick("h");

    expect(logOf(logId).status).toBe("sent");
    expect(smtp.messages).toHaveLength(1);
    expect(getInvoice(owner, invoiceId)?.status).toBe("sent");
  }, 30_000);

  test("[TST-017] plný disk při archivu: ENOSPC, nic neodejde, doklad zůstane", async () => {
    scenarios += 1;
    const { logId, invoiceId } = queuedInvoice();
    disk.full = true;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await tick("h");
      later(10 * MINUTE);
    }

    expect(logOf(logId)).toMatchObject({
      status: "failed",
      reason: TEXTS.invoiceMail.reasons.archive,
      fileId: null,
    });
    expect(smtp.connections()).toBe(0);
    expect(getInvoice(owner, invoiceId)?.status).toBe("issued");
  }, 30_000);

  test("[TST-017] plný disk při záloze: stará kopie zůstane", async () => {
    scenarios += 1;
    await backupTask.run(new Date("2026-03-09T10:00:00Z"));
    const before = listBackups();
    expect(before).toHaveLength(1);
    disk.free = { bsize: 4096, bavail: 0 };

    await backupTask.run(T0);

    expect(listBackups()).toEqual(before);
  });

  test("[TST-018] po každém scénáři proběhla kontrola souladu", () => {
    expect(scenarios).toBeGreaterThanOrEqual(11);
    expect(checked).toBe(scenarios);
  });
});
