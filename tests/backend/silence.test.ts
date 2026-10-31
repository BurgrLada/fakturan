import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, ne } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { AUTOMATIONS, type AutomationKey } from "@/lib/automation";
import { setClockForTests } from "@/server/clock";
import { invoice, job, schedulerState, user } from "@/server/db/schema";
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
import { deliverDigest } from "@/server/services/due-alerts";
import { deliverMail, recoverMail } from "@/server/services/mail-delivery";
import { deliverUserNotice, runRecurringJob } from "@/server/services/recurring-run";
import { saveReminderRule, snoozeReminders } from "@/server/services/reminders";
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

// A single term and a single stage: nothing later exists that could legitimately go out.
function armed(key: AutomationKey) {
  const owner = seedOwner(db, T0);
  ownSmtp(db, owner, smtp.port);
  const customerId = seedCustomer(owner, CLIENT);
  setAutomation(webActor(owner), key, true, ENABLED);
  if (key === "recurringSend") {
    savePlan(owner, customerId, { mode: "send", confirmSend: true, maxCount: 1 });
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

// TST-016 stays pending: two automations arrive in plans 5 and 6, so these names carry no ID.
describe("matice ticha", () => {
  test.each(MATRIX)(
    "automatika %s při %s nepošle klientovi nic",
    async (key, _name, situation) => {
      const owner = armed(key);
      situation.prepare(owner, key);

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
