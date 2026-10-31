import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { TEXTS } from "@/lib/texts";
import { setClockForTests } from "@/server/clock";
import {
  emailLog,
  invoice,
  job,
  mailSettings,
  numberSeriesCounter,
  recurringRun,
  schedulerState,
} from "@/server/db/schema";
import { registerJob } from "@/server/jobs/registry";
import { backupTask, listBackups } from "@/server/scheduler/backup";
import { deadMailTask, recurringPlanTask } from "@/server/scheduler/start";
import { registerTickTask, resetTickTasksForTests, tick } from "@/server/scheduler/tick";
import { archiveSentPdf } from "@/server/services/files";
import { queueMail } from "@/server/services/invoice-mail";
import { getInvoice } from "@/server/services/invoices";
import { deliverMail, recoverMail } from "@/server/services/mail-delivery";
import { mutate } from "@/server/services/mutation";
import { runRecurringJob } from "@/server/services/recurring-run";
import { assertConsistent } from "../helpers/consistency";
import { createTestDb } from "../helpers/db";
import {
  issuedInvoice,
  ownSmtp,
  seedCustomer,
  seedOwner,
  webActor,
} from "../helpers/fixtures-mail";
import { savePlan } from "../helpers/fixtures-recurring";
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
let current = T0;
let owner = "";
let checked = 0;
let scenarios = 0;

const later = (ms: number) => {
  current = new Date(current.getTime() + ms);
};

beforeAll(async () => {
  smtp = await startSmtp();
});
afterAll(async () => {
  await smtp.stop();
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
  registerTickTask(deadMailTask);
  registerTickTask(recurringPlanTask);
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
    expect(scenarios).toBeGreaterThanOrEqual(6);
    expect(checked).toBe(scenarios);
  });
});
