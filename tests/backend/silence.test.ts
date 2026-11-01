import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, ne } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { AUTOMATIONS, type AutomationKey } from "@/lib/automation";
import { TEXTS } from "@/lib/texts";
import { setClockForTests } from "@/server/clock";
import { auditLog, emailLog, invoice, job, schedulerState, user } from "@/server/db/schema";
import { registerJob } from "@/server/jobs/registry";
import {
  deadMailTask,
  deadRecurringTask,
  digestPlanTask,
  recurringNoticeTask,
  recurringPlanTask,
  reminderPlanTask,
} from "@/server/scheduler/start";
import { registerTickTask, resetTickTasksForTests, tick } from "@/server/scheduler/tick";
import { setAutomation, setPaused } from "@/server/services/automation";
import { ingestNotice } from "@/server/services/bank-notices";
import { deliverDigest } from "@/server/services/due-alerts";
import { deliverMail, recoverMail } from "@/server/services/mail-delivery";
import { savePreferences } from "@/server/services/preferences";
import { deliverUserNotice, runRecurringJob } from "@/server/services/recurring-run";
import { saveReminderRule, snoozeReminders } from "@/server/services/reminders";
import { deactivateUser, reactivateUser } from "@/server/services/users";
import { assertConsistent } from "../helpers/consistency";
import { createTestDb } from "../helpers/db";
import { seedBankAccount, TARGET, VS } from "../helpers/fixtures-bank";
import {
  issuedAdvance,
  issuedInvoice,
  ownSmtp,
  seedCustomer,
  seedOwner,
  webActor,
} from "../helpers/fixtures-mail";
import { savePlan } from "../helpers/fixtures-recurring";
import { startSmtp, type TestSmtp } from "../helpers/smtp";

vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-silence-")));
vi.stubEnv("ALLOW_PRIVATE_MAIL_HOSTS", "true");
vi.stubEnv("SMTP_HOST", "");
vi.stubEnv("SMTP_PORT", "");
vi.stubEnv("SMTP_FROM", "");

const db = createTestDb();
const T0 = new Date("2026-03-01T10:00:00Z");
const DAY = 86_400_000;
const DAYS = 41;
const CLIENT = "alfa@example.cz";
const ENABLED = { confirmed: true };

const available = AUTOMATIONS.filter((item) => item.available).map((item) => item.key);

let smtp: TestSmtp;
let current = T0;
let admin = "";

beforeAll(async () => {
  smtp = await startSmtp();
  setClockForTests({ now: () => T0 });
  admin = seedOwner(db, T0);
  db.update(user).set({ role: "admin" }).where(eq(user.id, admin)).run();
});
afterAll(() => smtp.stop());

beforeEach(() => {
  smtp.reset();
  db.delete(job).run();
  db.delete(schedulerState).run();
  // Accounts left by earlier tests would otherwise send into this test's mailbox.
  db.update(user).set({ banned: true }).where(ne(user.id, admin)).run();
  current = T0;
  setClockForTests({ now: () => current });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  resetTickTasksForTests();
  registerJob("mail.send", { run: deliverMail, recover: recoverMail });
  registerJob("recurring.run", { run: runRecurringJob });
  registerJob("user.notice", { run: deliverUserNotice });
  registerJob("user.digest", { run: deliverDigest });
  for (const task of [
    deadMailTask,
    deadRecurringTask,
    recurringPlanTask,
    recurringNoticeTask,
    reminderPlanTask,
    digestPlanTask,
  ]) {
    registerTickTask(task);
  }
});
afterEach(() => {
  setClockForTests(null);
  vi.restoreAllMocks();
});

async function tickAt(at: Date) {
  current = at;
  await tick("silence");
}

async function everyDay() {
  for (let day = 1; day <= DAYS; day += 1) await tickAt(new Date(T0.getTime() + day * DAY));
}

const afterOutage = () => tickAt(new Date(T0.getTime() + DAYS * DAY));

// Both terms (10 and 12 March) are still fresh on the 13th, so only reactivation can stop them.
const REACTIVATED_ON_DAY = 12;

async function reactivatedRightAfterTerms(owner: string) {
  for (let day = 1; day <= DAYS; day += 1) {
    current = new Date(T0.getTime() + day * DAY);
    if (day === REACTIVATED_ON_DAY) reactivateUser(webActor(admin), owner);
    await tick("silence");
  }
}

let nextInstruction = 1;

// Automatic matching needs the amount due, the symbol and the target account to agree.
function pairNotice(owner: string, invoiceId: string, accountId: string, symbol: string): void {
  db.update(invoice)
    .set({ variableSymbol: symbol, bankAccountId: accountId })
    .where(eq(invoice.id, invoiceId))
    .run();
  const result = ingestNotice(owner, {
    bank: "fio",
    notice: {
      variant: "en",
      targetAccount: `${TARGET.number}/${TARGET.bankCode}`,
      amountMinor: db.select().from(invoice).where(eq(invoice.id, invoiceId)).get()!.totalMinor,
      currency: "CZK",
      occurredAt: { date: "2026-03-01", time: "09:00" },
      variableSymbol: symbol,
      constantSymbol: null,
      counterpartyAccount: null,
      counterpartyName: null,
      message: null,
      instructionId: `silence-${nextInstruction++}`,
    },
    text: "avizo",
    authResult: "pass",
    requireConfirmation: true,
    receivedAt: current,
  });
  if (result.status !== "matched") throw new Error(`nespárováno: ${result.status}`);
}

// Paired after the switch was thrown: with the one from `armed`, the matrix covers both a message
// already queued and a payment matched while sending is forbidden.
function pairSecond(owner: string, key: AutomationKey): void {
  const first = db.select().from(invoice).where(eq(invoice.variableSymbol, VS));
  const { customerId, bankAccountId } = first.all().find((row) => row.userId === owner)!;
  const document = key === "advanceInvoice" ? issuedAdvance : issuedInvoice;
  pairNotice(owner, document(owner, customerId!), bankAccountId!, "20260043");
}

// A single term and a single stage: nothing later exists that could legitimately go out.
function armed(key: AutomationKey) {
  const owner = seedOwner(db, T0);
  ownSmtp(db, owner, smtp.port);
  const customerId = seedCustomer(owner, CLIENT);
  setAutomation(webActor(owner), key, true, ENABLED);
  if (key === "recurringSend") {
    savePlan(owner, customerId, { mode: "send", confirmSend: true, maxCount: 1 });
  } else if (key === "paymentReceipt") {
    pairNotice(owner, issuedInvoice(owner, customerId), seedBankAccount(db, owner, T0), VS);
  } else if (key === "advanceInvoice") {
    savePreferences(webActor(owner), { advanceFinalMode: "issue" });
    pairNotice(owner, issuedAdvance(owner, customerId), seedBankAccount(db, owner, T0), VS);
  } else {
    current = new Date(T0.getTime() - 60 * DAY);
    saveReminderRule(webActor(owner), { offsetDays: 7, texts: null });
    current = T0;
    const invoiceId = issuedInvoice(owner, customerId);
    db.update(invoice)
      .set({ status: "sent", dueDate: "2026-03-05", sentAt: new Date("2026-02-01T10:00:00Z") })
      .where(eq(invoice.id, invoiceId))
      .run();
  }
  return owner;
}

const toClient = () => smtp.messages.filter((message) => message.to.includes(CLIENT));

type Situation = {
  name: string;
  prepare: (owner: string, key: AutomationKey) => void;
  pass: (owner: string) => Promise<void>;
};

const SITUATIONS: Situation[] = [
  {
    name: "vypnutá",
    prepare: (owner, key) => setAutomation(webActor(owner), key, false, ENABLED),
    pass: everyDay,
  },
  {
    name: "hlavní vypínač",
    prepare: (owner) => setPaused(webActor(owner), true, { confirmed: false }),
    pass: everyDay,
  },
  {
    name: "deaktivovaný účet",
    prepare: (owner) => deactivateUser(webActor(admin), owner),
    pass: everyDay,
  },
  {
    name: "doběh po výpadku",
    prepare: (owner, key) => setAutomation(webActor(owner), key, false, ENABLED),
    pass: afterOutage,
  },
  { name: "zmeškaný termín", prepare: () => {}, pass: afterOutage },
  {
    name: "po reaktivaci",
    prepare: (owner) => deactivateUser(webActor(admin), owner),
    pass: reactivatedRightAfterTerms,
  },
];

const MATRIX = available.flatMap((key) =>
  SITUATIONS.map((situation) => [key, situation.name, situation] as const),
);

describe("[TST-016] matice ticha", () => {
  test.each(MATRIX)(
    "automatika %s při %s nepošle klientovi nic",
    async (key, _name, situation) => {
      const owner = armed(key);
      situation.prepare(owner, key);
      if (key === "paymentReceipt" || key === "advanceInvoice") pairSecond(owner, key);

      await situation.pass(owner);

      expect(toClient()).toEqual([]);
      expect(smtp.connections()).toBe(0);
      assertConsistent(db, owner);
    },
    30_000,
  );

  // Without this the matrix would also pass if the setup could never send at all.
  test.each(available)(
    "zapnutá automatika %s klientovi opravdu pošle",
    async (key) => {
      const owner = armed(key);

      await everyDay();

      expect(toClient()).toHaveLength(1);
      assertConsistent(db, owner);
    },
    60_000,
  );
});

describe("[SET-043] vypnutí během čekání na další pokus", () => {
  type Stop = (owner: string) => void;
  const STOPS: [string, Stop, Stop][] = [
    [
      "hlavní vypínač",
      (owner) => setPaused(webActor(owner), true, { confirmed: false }),
      (owner) => setPaused(webActor(owner), false, ENABLED),
    ],
    [
      "vypnutá automatika",
      (owner) => setAutomation(webActor(owner), "paymentReceipt", false, ENABLED),
      (owner) => setAutomation(webActor(owner), "paymentReceipt", true, ENABLED),
    ],
  ];

  const logOf = (owner: string) =>
    db.select().from(emailLog).where(eq(emailLog.userId, owner)).get()!;

  function waitingForRetry(): string {
    const owner = armed("paymentReceipt");
    db.update(emailLog).set({ attempts: 1 }).where(eq(emailLog.userId, owner)).run();
    db.update(job)
      .set({ runAt: new Date(T0.getTime() + 300_000), attempts: 1 })
      .where(and(eq(job.userId, owner), eq(job.kind, "mail.send")))
      .run();
    return owner;
  }

  test.each(STOPS)(
    "%s zadrží čekající zprávu a opětovné zapnutí ji nepustí",
    async (_name, stop, resume) => {
      const owner = waitingForRetry();

      stop(owner);
      expect(logOf(owner)).toMatchObject({
        status: "held",
        reason: TEXTS.invoiceMail.reasons.automation,
      });
      resume(owner);
      await everyDay();

      expect(toClient()).toEqual([]);
      expect(logOf(owner).status).toBe("held");
      const held = db.select().from(auditLog).where(eq(auditLog.action, "mail.held")).all();
      expect(held.filter((row) => row.ownerId === owner)).toHaveLength(1);
      assertConsistent(db, owner);
    },
    60_000,
  );

  test("vypnutí jiné automatiky zprávu nezadrží", () => {
    const owner = waitingForRetry();
    setAutomation(webActor(owner), "reminders", true, ENABLED);
    setAutomation(webActor(owner), "reminders", false, ENABLED);
    expect(logOf(owner).status).toBe("queued");
  });

  test("ruční zpráva ve frontě hlavním vypínačem nezmizí", () => {
    const owner = waitingForRetry();
    db.update(emailLog).set({ trigger: "manual" }).where(eq(emailLog.userId, owner)).run();
    setPaused(webActor(owner), true, { confirmed: false });
    expect(logOf(owner).status).toBe("queued");
  });
});

describe("bez kliknutí", () => {
  test("[MAIL-004] žádná akce bez kliknutí nebo automatiky nevede na SMTP", async () => {
    const owner = seedOwner(db, T0);
    ownSmtp(db, owner, smtp.port);
    const customerId = seedCustomer(owner, CLIENT);
    const actor = webActor(owner);
    saveReminderRule(actor, { offsetDays: 1, texts: null });
    savePlan(owner, customerId, { mode: "issue" });
    savePlan(owner, customerId);
    const invoiceId = issuedInvoice(owner, customerId);
    snoozeReminders(actor, invoiceId, "2026-03-20");

    await everyDay();

    expect(smtp.connections()).toBe(0);
    assertConsistent(db, owner);
  }, 60_000);
});
