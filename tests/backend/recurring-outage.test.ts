import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { TEXTS } from "@/lib/texts";
import { setClockForTests } from "@/server/clock";
import {
  invoice,
  job,
  notification,
  recurringInvoice,
  schedulerState,
  user,
} from "@/server/db/schema";
import { registerJob } from "@/server/jobs/registry";
import { drainJobs } from "@/server/jobs/worker";
import { setAutomation, setSendTime } from "@/server/services/automation";
import { getInvoice } from "@/server/services/invoices";
import { getRecurring, listRecurring, listRuns, saveRecurring } from "@/server/services/recurring";
import {
  pauseRecurring,
  planRecurringRuns,
  processOccurrence,
  resolveMissed,
  resumeRecurring,
  runRecurringJob,
  settleDeadRuns,
} from "@/server/services/recurring-run";
import { deactivateUser, reactivateUser } from "@/server/services/users";
import { assertConsistent } from "../helpers/consistency";
import { createTestDb } from "../helpers/db";
import { seedCustomer, seedOwner, webActor } from "../helpers/fixtures-mail";
import { planDocument, planInput, savePlan } from "../helpers/fixtures-recurring";

vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-recurring-outage-")));

const db = createTestDb();
const T0 = new Date("2026-03-01T10:00:00Z");
let current = T0;

const at = (iso: string) => {
  current = new Date(iso);
};

async function tickAt(iso: string) {
  at(iso);
  planRecurringRuns(current);
  await drainJobs("w");
}

beforeEach(() => {
  db.delete(job).run();
  db.delete(schedulerState).run();
  current = T0;
  setClockForTests({ now: () => current });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  registerJob("recurring.run", { run: runRecurringJob });
});
afterEach(() => {
  setClockForTests(null);
  vi.restoreAllMocks();
});

function admin() {
  const id = seedOwner(db, T0);
  db.update(user).set({ role: "admin" }).where(eq(user.id, id)).run();
  return webActor(id);
}

function account() {
  const owner = seedOwner(db, T0);
  return { owner, customerId: seedCustomer(owner) };
}

const invoicesOf = (owner: string) =>
  db.select().from(invoice).where(eq(invoice.userId, owner)).all();
const statuses = (owner: string, id: string) =>
  listRuns(owner, id)
    .map((run) => [run.plannedDate, run.status])
    .reverse();
const missedNotices = (owner: string) =>
  db
    .select()
    .from(notification)
    .where(eq(notification.userId, owner))
    .all()
    .filter((row) => row.kind === "recurring_missed");

describe("výpadek", () => {
  test("[REC-031] 3 dny starý termín doběhne, 4 dny starý je missed a nabídne se", async () => {
    const { owner, customerId } = account();
    const late = savePlan(owner, customerId, { issueDay: 10 });
    const old = savePlan(owner, customerId, { issueDay: 9 });
    await tickAt("2026-03-13T10:00:00Z");

    expect(statuses(owner, late)).toEqual([["2026-03-10", "created"]]);
    expect(statuses(owner, old)).toEqual([["2026-03-09", "missed"]]);
    expect(invoicesOf(owner)).toHaveLength(1);
    expect(missedNotices(owner)).toHaveLength(1);
    expect(getRecurring(owner, old)?.cursorDate).toBe("2026-03-13");

    const run = listRuns(owner, old)[0]!;
    const { invoiceId } = resolveMissed(webActor(owner), run.id, "draft");
    expect(getInvoice(owner, invoiceId!)).toMatchObject({
      status: "draft",
      recurringId: old,
      issueDate: "2026-03-09",
      periodFrom: "2026-03-01",
    });
    expect(listRuns(owner, old)[0]).toMatchObject({ id: run.id, status: "created", invoiceId });
    expect(missedNotices(owner)[0]?.resolvedAt).not.toBeNull();
    expect(() => resolveMissed(webActor(owner), run.id, "draft")).toThrow(/vyřízený/);
    assertConsistent(db, owner);
  });

  test("[REC-031] přeskočený termín nic nevytvoří a znovu nevznikne", async () => {
    const { owner, customerId } = account();
    const id = savePlan(owner, customerId);
    await tickAt("2026-03-20T10:00:00Z");
    const run = listRuns(owner, id)[0]!;
    expect(resolveMissed(webActor(owner), run.id, "skip")).toEqual({ invoiceId: null });
    await tickAt("2026-03-21T10:00:00Z");
    expect(statuses(owner, id)).toEqual([["2026-03-10", "skipped"]]);
    expect(invoicesOf(owner)).toEqual([]);
  });

  test("[REC-032] zmeškaný termín v režimu odeslat nic nepošle", async () => {
    const { owner, customerId } = account();
    setAutomation(webActor(owner), "recurringSend", true, { confirmed: true });
    const id = savePlan(owner, customerId, { mode: "send", confirmSend: true });
    await tickAt("2026-03-14T10:00:00Z");
    expect(statuses(owner, id)).toEqual([["2026-03-10", "missed"]]);
    const { invoiceId } = resolveMissed(webActor(owner), listRuns(owner, id)[0]!.id, "draft");
    expect(getInvoice(owner, invoiceId!)?.status).toBe("draft");
    expect(db.select().from(job).where(eq(job.kind, "mail.send")).all()).toEqual([]);
  });

  test("[REC-032] úloha, která čekala přes hranici 3 dnů, termín jen zapíše jako zmeškaný", () => {
    const { owner, customerId } = account();
    const id = savePlan(owner, customerId, { mode: "issue" });
    at("2026-03-14T10:00:00Z");
    const result = processOccurrence(owner, id, {
      periodKey: "2026-03-01",
      issueDate: "2026-03-10",
      billedPeriod: { from: "2026-03-01", to: "2026-03-31" },
    });
    expect(result).toMatchObject({ status: "missed", invoiceId: null });
    expect(invoicesOf(owner)).toEqual([]);
  });

  test("[REC-003] plán po posledním termínu skončí a běh se stejně dokončí", async () => {
    const { owner, customerId } = account();
    const id = savePlan(owner, customerId, { maxCount: 1 });
    await tickAt("2026-03-10T10:00:00Z");
    expect(getRecurring(owner, id)?.status).toBe("finished");
    expect(statuses(owner, id)).toEqual([["2026-03-10", "created"]]);
    expect(listRecurring(owner)[0]?.nextIssueDate).toBeNull();
  });
});

describe("hotový plán", () => {
  test("[REC-003] hotový plán po prodloužení jde znovu aktivovat a minulé termíny jsou ke kontrole", async () => {
    const { owner, customerId } = account();
    const id = savePlan(owner, customerId, { maxCount: 1 });
    await tickAt("2026-03-10T10:00:00Z");
    expect(getRecurring(owner, id)?.status).toBe("finished");
    expect(() => resumeRecurring(webActor(owner), id)).toThrow(/nemá další termín/);

    saveRecurring(webActor(owner), planInput(customerId, { id, maxCount: 4 }));
    at("2026-04-12T10:00:00Z");
    resumeRecurring(webActor(owner), id);

    expect(getRecurring(owner, id)?.status).toBe("active");
    expect(statuses(owner, id)).toEqual([
      ["2026-03-10", "created"],
      ["2026-04-10", "missed"],
    ]);
  });
});

describe("termín se neztratí", () => {
  const SIX_HOURS = 6 * 3_600_000;

  async function exhaustAttempts() {
    registerJob("recurring.run", {
      run: async () => {
        throw new Error("spadlo");
      },
    });
    await tickAt("2026-03-10T10:00:00Z");
    for (let attempt = 1; attempt < 3; attempt += 1) {
      current = new Date(current.getTime() + SIX_HOURS);
      await drainJobs("w");
    }
    registerJob("recurring.run", { run: runRecurringJob });
    expect(
      db
        .select()
        .from(job)
        .all()
        .map((row) => row.status),
    ).toEqual(["dead"]);
  }

  test("[REC-031] vyčerpané pokusy zapíšou termín jako zmeškaný a uvolní klíč", async () => {
    const { owner, customerId } = account();
    const id = savePlan(owner, customerId);
    await exhaustAttempts();
    settleDeadRuns();
    expect(statuses(owner, id)).toEqual([["2026-03-10", "missed"]]);
    expect(listRuns(owner, id)[0]?.reason).toBe(TEXTS.recurring.reasons.failed);
    expect(missedNotices(owner)).toHaveLength(1);
    expect(db.select().from(job).all()).toEqual([]);
    settleDeadRuns();
    expect(missedNotices(owner)).toHaveLength(1);

    const { invoiceId } = resolveMissed(webActor(owner), listRuns(owner, id)[0]!.id, "draft");
    expect(getInvoice(owner, invoiceId!)?.issueDate).toBe("2026-03-10");
  });

  test("[REC-030] změna dne se stejným period_key nedá druhou fakturu", async () => {
    const { owner, customerId } = account();
    const id = savePlan(owner, customerId);
    await exhaustAttempts();
    settleDeadRuns();
    saveRecurring(webActor(owner), planInput(customerId, { id, issueDay: 20 }));
    await tickAt("2026-03-20T10:00:00Z");
    expect(statuses(owner, id)).toEqual([["2026-03-10", "missed"]]);
    expect(invoicesOf(owner)).toEqual([]);
    expect(missedNotices(owner)).toHaveLength(1);
    await tickAt("2026-04-20T10:00:00Z");
    expect(statuses(owner, id)).toEqual([
      ["2026-03-10", "missed"],
      ["2026-04-20", "created"],
    ]);
  });

  test("[REC-031] koncept, který nejde založit, je zmeškaný termín a úloha se neopakuje", async () => {
    const { owner, customerId } = account();
    const id = savePlan(owner, customerId);
    const document = planDocument({ textBefore: "x".repeat(3000) });
    db.update(recurringInvoice).set({ document }).where(eq(recurringInvoice.id, id)).run();
    await tickAt("2026-03-10T10:00:00Z");
    const [run] = listRuns(owner, id);
    expect(run).toMatchObject({ status: "missed", invoiceId: null });
    expect(run!.reason).toBeTruthy();
    expect(missedNotices(owner)).toHaveLength(1);
    expect(invoicesOf(owner)).toEqual([]);
    expect(
      db
        .select()
        .from(job)
        .all()
        .map((row) => row.status),
    ).toEqual(["done"]);
  });

  test("[ADM-005] poslední termín hotového plánu po deaktivaci je zmeškaný", async () => {
    const boss = admin();
    const { owner, customerId } = account();
    const id = savePlan(owner, customerId, { maxCount: 1 });
    at("2026-03-10T10:00:00Z");
    planRecurringRuns(current);
    expect(getRecurring(owner, id)?.status).toBe("finished");
    deactivateUser(boss, owner);
    at("2026-03-12T10:00:00Z");
    reactivateUser(boss, owner);
    expect(statuses(owner, id)).toEqual([["2026-03-10", "missed"]]);
    expect(getRecurring(owner, id)?.status).toBe("finished");
  });

  test("[ADM-005] dnešní poslední termín hotového plánu po reaktivaci doběhne", async () => {
    const boss = admin();
    const { owner, customerId } = account();
    const id = savePlan(owner, customerId, { maxCount: 1 });
    at("2026-03-10T10:00:00Z");
    planRecurringRuns(current);
    deactivateUser(boss, owner);
    reactivateUser(boss, owner);
    expect(getRecurring(owner, id)?.status).toBe("active");
    await tickAt("2026-03-10T10:01:00Z");
    expect(statuses(owner, id)).toEqual([["2026-03-10", "created"]]);
    expect(getRecurring(owner, id)?.status).toBe("finished");
  });

  test("[ADM-005] reaktivace se hotového plánu bez čekající úlohy nedotkne", async () => {
    const boss = admin();
    const { owner, customerId } = account();
    const id = savePlan(owner, customerId, { maxCount: 1 });
    await tickAt("2026-03-10T10:00:00Z");
    const before = getRecurring(owner, id);
    deactivateUser(boss, owner);
    at("2026-05-01T10:00:00Z");
    reactivateUser(boss, owner);
    expect(getRecurring(owner, id)).toEqual(before);
  });
});

describe("pauza", () => {
  test("[REC-005] obnovení ukáže zmeškané ke kontrole a nic nevytvoří", async () => {
    const { owner, customerId } = account();
    const id = savePlan(owner, customerId);
    pauseRecurring(webActor(owner), id);
    await tickAt("2026-03-10T10:00:00Z");
    expect(statuses(owner, id)).toEqual([]);

    at("2026-05-12T10:00:00Z");
    resumeRecurring(webActor(owner), id);
    expect(statuses(owner, id)).toEqual([
      ["2026-03-10", "missed"],
      ["2026-04-10", "missed"],
      ["2026-05-10", "missed"],
    ]);
    expect(getRecurring(owner, id)).toMatchObject({ status: "active", cursorDate: "2026-05-11" });
    expect(invoicesOf(owner)).toEqual([]);
    const notices = missedNotices(owner);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.params.count).toBe(3);
    await tickAt("2026-05-12T11:00:00Z");
    expect(invoicesOf(owner)).toEqual([]);
  });

  test("[REC-005] dnešní termín po obnovení běží", async () => {
    const { owner, customerId } = account();
    const id = savePlan(owner, customerId);
    pauseRecurring(webActor(owner), id);
    at("2026-03-10T07:00:00Z");
    resumeRecurring(webActor(owner), id);
    await tickAt("2026-03-10T10:00:00Z");
    expect(statuses(owner, id)).toEqual([["2026-03-10", "created"]]);
  });

  test("[REC-005] úloha zařazená před pauzou fakturu nevytvoří", async () => {
    const { owner, customerId } = account();
    const id = savePlan(owner, customerId);
    at("2026-03-10T10:00:00Z");
    planRecurringRuns(current);
    pauseRecurring(webActor(owner), id);
    await drainJobs("w");
    expect(statuses(owner, id)).toEqual([["2026-03-10", "missed"]]);
    expect(invoicesOf(owner)).toEqual([]);
  });

  test("[REC-005] čekající úlohu přebere obnovení, ať stará neběží sama", async () => {
    const { owner, customerId } = account();
    const id = savePlan(owner, customerId);
    at("2026-03-10T10:00:00Z");
    planRecurringRuns(current);
    pauseRecurring(webActor(owner), id);
    at("2026-03-11T10:00:00Z");
    resumeRecurring(webActor(owner), id);
    await drainJobs("w");
    expect(statuses(owner, id)).toEqual([["2026-03-10", "missed"]]);
    expect(invoicesOf(owner)).toEqual([]);
  });
});

describe("deaktivace", () => {
  test("[ADM-005] deaktivovaný účet nic nevytvoří, po reaktivaci jsou termíny missed", async () => {
    const boss = admin();
    const { owner, customerId } = account();
    const id = savePlan(owner, customerId);
    at("2026-03-05T10:00:00Z");
    deactivateUser(boss, owner);
    await tickAt("2026-03-10T10:00:00Z");
    await tickAt("2026-04-11T10:00:00Z");
    expect(statuses(owner, id)).toEqual([]);

    reactivateUser(boss, owner);
    expect(statuses(owner, id)).toEqual([
      ["2026-03-10", "missed"],
      ["2026-04-10", "missed"],
    ]);
    expect(missedNotices(owner)).toHaveLength(1);
    expect(invoicesOf(owner)).toEqual([]);
    await tickAt("2026-04-11T11:00:00Z");
    expect(invoicesOf(owner)).toEqual([]);
    assertConsistent(db, owner);
  });

  test("[ADM-005] úloha zrušená deaktivací se neztratí a dnešní po reaktivaci běží", async () => {
    const boss = admin();
    const { owner, customerId } = account();
    const id = savePlan(owner, customerId, { issueRule: "day", issueDay: 10 });
    const second = savePlan(owner, customerId, {
      frequency: "weekly",
      issueDay: 2,
      startsOn: "2026-03-09",
    });
    at("2026-03-10T10:00:00Z");
    planRecurringRuns(current);
    deactivateUser(boss, owner);
    reactivateUser(boss, owner);
    await tickAt("2026-03-10T10:01:00Z");
    expect(statuses(owner, id)).toEqual([["2026-03-10", "created"]]);
    expect(statuses(owner, second)).toEqual([["2026-03-10", "created"]]);

    const other = savePlan(owner, customerId, { issueDay: 11 });
    at("2026-03-11T10:00:00Z");
    planRecurringRuns(current);
    deactivateUser(boss, owner);
    at("2026-03-12T10:00:00Z");
    reactivateUser(boss, owner);
    expect(statuses(owner, other)).toEqual([["2026-03-11", "missed"]]);
  });
});

describe("čas odeslání", () => {
  test("[REC-006] plán se řídí časem v Europe/Prague, ne UTC", async () => {
    const { owner, customerId } = account();
    const id = savePlan(owner, customerId);
    await tickAt("2026-03-10T07:59:00Z");
    expect(statuses(owner, id)).toEqual([]);
    await tickAt("2026-03-10T08:01:00Z");
    expect(statuses(owner, id)).toEqual([["2026-03-10", "created"]]);
  });

  test("[TST-007] tick těsně před a po send_time v den přechodu času", async () => {
    const { owner, customerId } = account();
    setSendTime(webActor(owner), "02:30");
    const fall = savePlan(owner, customerId, {
      issueDay: 25,
      startsOn: "2026-10-25",
      frequency: "yearly",
    });
    await tickAt("2026-10-25T00:29:00Z");
    expect(statuses(owner, fall)).toEqual([]);
    await tickAt("2026-10-25T00:31:00Z");
    expect(statuses(owner, fall)).toEqual([["2026-10-25", "created"]]);
    await tickAt("2026-10-25T01:31:00Z");
    expect(invoicesOf(owner)).toHaveLength(1);
  });

  test("[TST-007] čas, který na jaře neexistuje, se dožene prvním tickem po něm", async () => {
    const { owner, customerId } = account();
    setSendTime(webActor(owner), "02:30");
    const spring = savePlan(owner, customerId, {
      issueDay: 29,
      startsOn: "2026-03-29",
      frequency: "yearly",
    });
    await tickAt("2026-03-29T00:59:00Z");
    expect(statuses(owner, spring)).toEqual([]);
    await tickAt("2026-03-29T01:00:00Z");
    expect(statuses(owner, spring)).toEqual([["2026-03-29", "created"]]);
  });

  test("[TST-007] 31. den v kratším měsíci a přelom roku", async () => {
    const { owner, customerId } = account();
    const id = savePlan(owner, customerId, { issueDay: 31, startsOn: "2026-03-01" });
    await tickAt("2026-03-31T10:00:00Z");
    await tickAt("2026-04-30T10:00:00Z");
    expect(statuses(owner, id)).toEqual([
      ["2026-03-31", "created"],
      ["2026-04-30", "created"],
    ]);
  });
});
