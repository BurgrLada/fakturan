import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { setClockForTests } from "@/server/clock";
import {
  auditLog,
  emailLog,
  file,
  invoice,
  job,
  notification,
  schedulerState,
} from "@/server/db/schema";
import { claimNext } from "@/server/jobs/queue";
import { recoverInterrupted, drainJobs } from "@/server/jobs/worker";
import { acquireLease } from "@/server/scheduler/lease";
import { registerJob } from "@/server/jobs/registry";
import { composeMail } from "@/server/services/email-templates";
import { setAutomation, setPaused } from "@/server/services/automation";
import { cancelInvoice } from "@/server/services/invoice-lifecycle";
import { archivedPdf, listEmailLog, queueMail, sendInvoice } from "@/server/services/invoice-mail";
import { getInvoice } from "@/server/services/invoices";
import {
  DELIVERY_LIMITS,
  deliverMail,
  recoverMail,
  setDeliveryLimitsForTests,
  settleDeadMail,
} from "@/server/services/mail-delivery";
import { mutate } from "@/server/services/mutation";
import { deactivateUser, reactivateUser } from "@/server/services/users";
import { assertConsistent } from "../helpers/consistency";
import { createTestDb } from "../helpers/db";
import {
  draftFor,
  issuedInvoice,
  ownSmtp,
  seedCustomer,
  seedOwner,
  webActor,
} from "../helpers/fixtures-mail";
import { startSmtp, type TestSmtp } from "../helpers/smtp";
import { SEND_TIMEOUTS } from "@/server/mail/transport";

import { deadMailTask } from "@/server/scheduler/start";
import { registerTickTask, resetTickTasksForTests, tick } from "@/server/scheduler/tick";

const mocks = vi.hoisted(() => ({
  captureException: vi.fn(),
  failRender: { on: false },
  hold: { gate: null as Promise<void> | null, entered: false },
}));

vi.mock("@sentry/nextjs", () => ({ captureException: mocks.captureException }));
vi.mock("@/server/pdf/render", async (original) => {
  const real = await original<typeof import("@/server/pdf/render")>();
  return {
    ...real,
    renderInvoicePdf: async (view: Parameters<typeof real.renderInvoicePdf>[0]) => {
      const { gate } = mocks.hold;
      if (gate) {
        mocks.hold.gate = null;
        mocks.hold.entered = true;
        await gate;
      }
      // Read after the gate: a stalled attempt must see what changed while it waited.
      if (mocks.failRender.on) throw new Error("render spadl");
      return real.renderInvoicePdf(view);
    },
  };
});

vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-mail-delivery-")));
vi.stubEnv("ALLOW_PRIVATE_MAIL_HOSTS", "true");
vi.stubEnv("SENTRY_DSN", "http://public@localhost/1");
vi.stubEnv("SMTP_HOST", "");
vi.stubEnv("SMTP_PORT", "");
vi.stubEnv("SMTP_FROM", "");

const db = createTestDb();
const T0 = new Date("2026-11-02T10:00:00Z");
const WORKER = "worker-1";
const MINUTE = 60_000;

let smtp: TestSmtp;
let current = T0;

function now(at: Date) {
  current = at;
  setClockForTests({ now: () => current });
}
const later = (ms: number) => now(new Date(current.getTime() + ms));

// A real PDF render stands before each of these states. It takes seconds on a loaded machine, past
// the 1 s default, and a wait that gives up leaves its drain running into the next test.
const RENDER_WAIT = { timeout: 30_000, interval: 20 };

beforeAll(async () => {
  smtp = await startSmtp();
});
afterAll(() => smtp.stop());

beforeEach(() => {
  smtp.reset();
  db.delete(job).run();
  db.delete(schedulerState).run();
  now(T0);
  mocks.captureException.mockClear();
  mocks.failRender.on = false;
  mocks.hold.gate = null;
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  registerJob("mail.send", { run: deliverMail, recover: recoverMail });
});
afterEach(() => {
  setClockForTests(null);
  setDeliveryLimitsForTests(null);
  vi.restoreAllMocks();
});

function account() {
  const owner = seedOwner(db, T0);
  ownSmtp(db, owner, smtp.port);
  return { owner, invoiceId: issuedInvoice(owner) };
}

const message = (over: Record<string, unknown> = {}) => ({
  to: ["alfa@example.cz"],
  cc: [] as string[],
  bcc: [] as string[],
  subject: "Faktura",
  body: "Dobrý den, posílám fakturu.",
  ...over,
});

const revisionOf = (invoiceId: string) =>
  db.select({ revision: invoice.revision }).from(invoice).where(eq(invoice.id, invoiceId)).get()!
    .revision;

const send = (owner: string, invoiceId: string, over: Record<string, unknown> = {}) =>
  sendInvoice(webActor(owner), invoiceId, {
    requestId: randomUUID(),
    revision: revisionOf(invoiceId),
    ...message(over),
  }).logId;

const logOf = (id: string) => db.select().from(emailLog).where(eq(emailLog.id, id)).get()!;
const jobOf = (id: string) =>
  db
    .select()
    .from(job)
    .where(sql`json_extract(${job.payload}, '$.logId') = ${id}`)
    .get()!;
const noticesOf = (owner: string) =>
  db.select().from(notification).where(eq(notification.userId, owner)).all();

function automatic(
  owner: string,
  invoiceId: string,
  over: { plannedFor?: string; automation?: "recurringSend" | "reminders" } = {},
) {
  const scheduler = { userId: owner, source: "scheduler" as const };
  return mutate(scheduler, "invoice.send", (tx, audit) =>
    queueMail(tx, audit, {
      userId: owner,
      invoiceId,
      kind: "invoice",
      trigger: "automatic",
      key: `mail:auto:${randomUUID()}`,
      message: message(),
      plannedFor: "2026-11-02",
      automation: "recurringSend",
      ...over,
    }),
  )!.logId;
}

function holdRender(): () => void {
  let release = () => {};
  mocks.hold.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  mocks.hold.entered = false;
  return release;
}

// The real attempt stands in the render while the action changes the world under it.
async function duringRender(action: () => void) {
  const release = holdRender();
  const drained = drainJobs(WORKER);
  await vi.waitFor(() => expect(mocks.hold.entered).toBe(true), RENDER_WAIT);
  action();
  release();
  await drained;
}

// Attempt A stalls in the render long enough to lose its lease, then B recovers the job.
async function stalledAttempt(beforeTakeover?: () => void) {
  const release = holdRender();
  acquireLease("A");
  const attempt = deliverMail(claimNext("A")!);
  await vi.waitFor(() => expect(mocks.hold.entered).toBe(true), RENDER_WAIT);
  beforeTakeover?.();
  later(121_000);
  expect(acquireLease("B")).toBe("taken_over");
  recoverInterrupted("B");
  return { attempt, release };
}

function crash(logId: string) {
  db.update(job)
    .set({ status: "running", lockedBy: "dead", attempts: 1 })
    .where(eq(job.id, jobOf(logId).id))
    .run();
}

describe("doručení", () => {
  test("[TST-005] zpráva má příjemce, kopie, předmět, text a přílohu PDF", async () => {
    const { owner, invoiceId } = account();
    const id = send(owner, invoiceId, { cc: ["kopie@example.cz"], bcc: ["skryta@example.cz"] });
    await drainJobs(WORKER);

    const mail = await smtp.waitFor("alfa@example.cz");
    expect(mail.to.toSorted()).toEqual([
      "alfa@example.cz",
      "kopie@example.cz",
      "skryta@example.cz",
    ]);
    expect(mail.raw).toMatch(/^Cc: kopie@example\.cz/m);
    expect(mail.raw).not.toContain("skryta@example.cz");
    expect(mail.raw).toMatch(/^Subject: Faktura/m);
    expect(mail.body).toContain("Dobrý den, posílám fakturu.");
    expect(mail.raw).toMatch(/^From: .*fakturace@novak\.example\.cz/m);
    expect(mail.raw).toContain(`Message-ID: <${id}@novak.example.cz>`);
    expect(mail.attachments).toHaveLength(1);
    expect(mail.attachments[0]!.filename).toMatch(/\.pdf$/);
    expect(mail.attachments[0]!.content.subarray(0, 5).toString()).toBe("%PDF-");
    expect(logOf(id)).toMatchObject({
      status: "sent",
      attempts: 1,
      messageId: `<${id}@novak.example.cz>`,
      sentAt: T0,
    });
    assertConsistent(db, owner);
  });

  test("skutečný tok doručí Cc a Bcc z transport.identity", async () => {
    const owner = seedOwner(db, T0);
    ownSmtp(db, owner, smtp.port, {
      cc: ["stala-kopie@example.cz"],
      bcc: ["skryta-kopie@example.cz"],
      replyTo: "odpovedi@novak.example.cz",
    });
    const invoiceId = issuedInvoice(owner);
    const draft = composeMail(owner, invoiceId, "invoice");
    const { logId } = sendInvoice(webActor(owner), invoiceId, {
      revision: revisionOf(invoiceId),
      requestId: randomUUID(),
      to: draft.to,
      cc: draft.cc,
      bcc: draft.bcc,
      subject: draft.subject,
      body: draft.body,
    });
    await drainJobs(WORKER);

    const mail = await smtp.waitFor("alfa@example.cz");
    expect(mail.to).toContain("stala-kopie@example.cz");
    expect(mail.to).toContain("skryta-kopie@example.cz");
    expect(mail.raw).toMatch(/^Cc: stala-kopie@example\.cz/m);
    expect(mail.raw).toMatch(/^Reply-To: odpovedi@novak\.example\.cz/m);
    expect(mail.raw).toMatch(/^From: .*fakturace@novak\.example\.cz/m);
    expect(mail.raw).not.toContain("skryta-kopie@example.cz");
    expect(logOf(logId)).toMatchObject({
      cc: ["stala-kopie@example.cz"],
      bcc: ["skryta-kopie@example.cz"],
    });
  });

  test("kopii odebranou v dialogu nepošle ani stálé nastavení", async () => {
    const owner = seedOwner(db, T0);
    ownSmtp(db, owner, smtp.port, { cc: ["stala-kopie@example.cz"] });
    send(owner, issuedInvoice(owner));
    await drainJobs(WORKER);
    expect((await smtp.waitFor("alfa@example.cz")).to).toEqual(["alfa@example.cz"]);
  });

  test("[PDF-010] archivované PDF je bajt od bajtu příloha a pozdější úprava ho nezmění", async () => {
    const { owner, invoiceId } = account();
    const id = send(owner, invoiceId);
    await drainJobs(WORKER);
    const attachment = (await smtp.waitFor("alfa@example.cz")).attachments[0]!.content;

    db.update(invoice)
      .set({ note: "Pozdější poznámka", revision: sql`${invoice.revision} + 1` })
      .where(eq(invoice.id, invoiceId))
      .run();

    expect(archivedPdf(webActor(owner), id).data.equals(attachment)).toBe(true);
    expect(
      db
        .select()
        .from(file)
        .where(eq(file.id, logOf(id).fileId!))
        .get(),
    ).toMatchObject({
      kind: "sent_pdf",
      mimeType: "application/pdf",
    });
  });

  test("[MAIL-007] zpráva je prostý text bez HTML, pixelu a Disposition-Notification-To", async () => {
    const { owner, invoiceId } = account();
    send(owner, invoiceId, { body: '<img src="http://x/p.gif"> text' });
    await drainJobs(WORKER);
    const { raw } = await smtp.waitFor("alfa@example.cz");
    expect(raw).not.toMatch(/text\/html/i);
    expect(raw).not.toMatch(/Disposition-Notification-To/i);
    expect(raw).not.toMatch(/Return-Receipt-To/i);
    expect(raw).toMatch(/text\/plain/i);
  });

  test("[INV-005] úspěšné odeslání nastaví stav odeslaná", async () => {
    const { owner, invoiceId } = account();
    const before = getInvoice(owner, invoiceId)!;
    send(owner, invoiceId);
    await drainJobs(WORKER);
    expect(getInvoice(owner, invoiceId)).toMatchObject({
      status: "sent",
      sentAt: T0,
      revision: before.revision + 1,
    });
    const actions = db.select().from(auditLog).where(eq(auditLog.ownerId, owner)).all();
    expect(actions.map((row) => row.action)).toEqual(
      expect.arrayContaining(["invoice.send", "mail.sent"]),
    );
  });

  test("upomínka na vystavený doklad jeho stav nemění", async () => {
    const { owner, invoiceId } = account();
    const logId = mutate(webActor(owner), "invoice.send", (tx, audit) =>
      queueMail(tx, audit, {
        userId: owner,
        invoiceId,
        kind: "reminder",
        trigger: "manual",
        key: `mail:${randomUUID()}`,
        message: message(),
      }),
    )!.logId;
    await drainJobs(WORKER);
    expect(logOf(logId).status).toBe("sent");
    expect(getInvoice(owner, invoiceId)!.status).toBe("issued");
    assertConsistent(db, owner);
  });

  test("částečné odmítnutí příjemců je sent s výpisem a upozorněním", async () => {
    const { owner, invoiceId } = account();
    smtp.rejectRecipient("spatny@example.cz", 550);
    const id = send(owner, invoiceId, { cc: ["spatny@example.cz"] });
    await drainJobs(WORKER);
    expect(logOf(id).status).toBe("sent");
    expect(logOf(id).reason).toContain("spatny@example.cz");
    expect(noticesOf(owner)).toMatchObject([{ kind: "mail_partial", entityId: invoiceId }]);
    expect(getInvoice(owner, invoiceId)!.status).toBe("sent");
  });
});

describe("selhání", () => {
  test("[MAIL-005] 421 se opakuje a po 3 opakováních je failed s důvodem, spojení právě 4", async () => {
    const { owner, invoiceId } = account();
    smtp.rejectEvery(421);
    const id = send(owner, invoiceId);

    await drainJobs(WORKER);
    expect(logOf(id)).toMatchObject({ status: "queued", attempts: 1 });
    expect(jobOf(id)).toMatchObject({ status: "pending", maxAttempts: 4 });
    expect(smtp.connections()).toBe(1);

    await drainJobs(WORKER);
    expect(smtp.connections()).toBe(1);

    for (const [delay, connections] of [
      [5 * MINUTE, 2],
      [30 * MINUTE, 3],
      [120 * MINUTE, 4],
    ] as const) {
      later(delay - 1);
      await drainJobs(WORKER);
      expect(smtp.connections()).toBe(connections - 1);
      later(1);
      await drainJobs(WORKER);
      expect(smtp.connections()).toBe(connections);
    }

    expect(logOf(id).status).toBe("failed");
    expect(logOf(id).attempts).toBe(4);
    expect(logOf(id).reason).toContain("421");
    expect(jobOf(id).status).toBe("done");
    expect(noticesOf(owner)).toMatchObject([{ kind: "mail_failed", entityId: invoiceId }]);
    later(600 * MINUTE);
    await drainJobs(WORKER);
    expect(smtp.connections()).toBe(4);
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  test("[MAIL-005] 550 je trvalé selhání bez opakování", async () => {
    const { owner, invoiceId } = account();
    smtp.rejectNext(550);
    const id = send(owner, invoiceId);
    await drainJobs(WORKER);
    later(600 * MINUTE);
    await drainJobs(WORKER);
    expect(logOf(id)).toMatchObject({ status: "failed", attempts: 1 });
    expect(logOf(id).reason).toContain("550");
    expect(smtp.connections()).toBe(1);
  });

  test("[REC-013] selhání nechá doklad vystavený a založí upozornění", async () => {
    const { owner, invoiceId } = account();
    smtp.rejectNext(550);
    send(owner, invoiceId);
    await drainJobs(WORKER);
    expect(getInvoice(owner, invoiceId)!.status).toBe("issued");
    expect(noticesOf(owner)).toHaveLength(1);
    assertConsistent(db, owner);
  });

  test("další úspěch vyřeší upozornění z dřívějšího selhání", async () => {
    const { owner, invoiceId } = account();
    smtp.rejectNext(550);
    send(owner, invoiceId);
    await drainJobs(WORKER);
    send(owner, invoiceId);
    await drainJobs(WORKER);
    expect(noticesOf(owner)[0]!.resolvedAt).toEqual(T0);
  });

  test("přerušení při DATA je unknown a druhé spojení nenastane", async () => {
    const { owner, invoiceId } = account();
    smtp.dropDuringData();
    const id = send(owner, invoiceId);
    await drainJobs(WORKER);
    later(600 * MINUTE);
    await drainJobs(WORKER);
    expect(logOf(id).status).toBe("unknown");
    expect(jobOf(id).status).toBe("done");
    expect(smtp.connections()).toBe(1);
    expect(noticesOf(owner)).toMatchObject([{ kind: "mail_unknown" }]);
    expect(getInvoice(owner, invoiceId)!.status).toBe("issued");
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  test("selhání zápisu výsledku po SMTP je unknown a druhá zpráva neodejde", async () => {
    const { owner, invoiceId } = account();
    db.run(sql`CREATE TRIGGER fail_sent BEFORE UPDATE ON email_log WHEN NEW.status = 'sent'
      BEGIN SELECT RAISE(ABORT, 'zápis selhal'); END`);
    try {
      const id = send(owner, invoiceId);
      await drainJobs(WORKER);
      expect(smtp.messages).toHaveLength(1);
      expect(logOf(id).status).toBe("unknown");
      expect(jobOf(id).status).toBe("done");
      later(600 * MINUTE);
      await drainJobs(WORKER);
      expect(smtp.messages).toHaveLength(1);
      expect(mocks.captureException).toHaveBeenCalledOnce();
    } finally {
      db.run(sql`DROP TRIGGER fail_sent`);
    }
  });

  test("záznam nalezený ve stavu sending se neodesílá a je unknown", async () => {
    const { owner, invoiceId } = account();
    const id = send(owner, invoiceId);
    db.update(emailLog).set({ status: "sending" }).where(eq(emailLog.id, id)).run();
    await drainJobs(WORKER);
    expect(logOf(id).status).toBe("unknown");
    expect(smtp.connections()).toBe(0);
  });

  test("[MON-003] pád při skládání PDF je hlášený, selhání SMTP klienta ne", async () => {
    const { owner, invoiceId } = account();
    mocks.failRender.on = true;
    const crashed = send(owner, invoiceId);
    await drainJobs(WORKER);
    expect(mocks.captureException).toHaveBeenCalledOnce();
    expect(logOf(crashed).status).toBe("queued");
    expect(smtp.connections()).toBe(0);

    mocks.failRender.on = false;
    later(5 * MINUTE);
    await drainJobs(WORKER);
    expect(logOf(crashed).status).toBe("sent");
    mocks.captureException.mockClear();

    const other = account();
    smtp.rejectNext(550);
    send(other.owner, other.invoiceId);
    await drainJobs(WORKER);
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  test("PDF, které nejde složit ani na poslední pokus, je failed s upozorněním", async () => {
    const { owner, invoiceId } = account();
    mocks.failRender.on = true;
    const id = send(owner, invoiceId);
    await drainJobs(WORKER);
    for (const delay of [5, 5, 5]) {
      later(delay * MINUTE);
      await drainJobs(WORKER);
    }
    expect(logOf(id).status).toBe("failed");
    expect(jobOf(id).status).toBe("dead");
    expect(smtp.connections()).toBe(0);
    expect(noticesOf(owner)).toMatchObject([{ kind: "mail_failed" }]);
  });

  test("opakovaný pokus PDF znovu neskládá a odešle stejný archiv", async () => {
    const { owner, invoiceId } = account();
    smtp.rejectNext(421);
    const id = send(owner, invoiceId);
    await drainJobs(WORKER);
    const archived = logOf(id).fileId;
    expect(archived).toBeTruthy();
    mocks.failRender.on = true;
    later(5 * MINUTE);
    await drainJobs(WORKER);
    expect(logOf(id)).toMatchObject({ status: "sent", fileId: archived, attempts: 2 });
    expect(db.select().from(file).where(eq(file.userId, owner)).all()).toHaveLength(1);
  });

  test("bez dostupného SMTP je failed a nic neodchází", async () => {
    const owner = seedOwner(db, T0);
    ownSmtp(db, owner, smtp.port);
    const id = send(owner, issuedInvoice(owner));
    db.run(sql`UPDATE mail_settings SET smtp_host = NULL WHERE user_id = ${owner}`);
    await drainJobs(WORKER);
    expect(logOf(id).status).toBe("failed");
    expect(smtp.connections()).toBe(0);
  });
});

describe("svolení těsně před SMTP", () => {
  test("zrušený doklad, změněná revize a vypnutá automatika ve frontě dají held a SMTP nic nedostane", async () => {
    const cancelled = account();
    const a = send(cancelled.owner, cancelled.invoiceId);
    cancelInvoice(webActor(cancelled.owner), cancelled.invoiceId);

    const edited = account();
    const b = send(edited.owner, edited.invoiceId);
    db.update(invoice)
      .set({ revision: sql`${invoice.revision} + 1` })
      .where(eq(invoice.id, edited.invoiceId))
      .run();

    const off = account();
    const c = automatic(off.owner, off.invoiceId);

    const paused = account();
    setAutomation(webActor(paused.owner), "recurringSend", true, { confirmed: true });
    const d = automatic(paused.owner, paused.invoiceId);
    setPaused(webActor(paused.owner), true, { confirmed: true });

    await drainJobs(WORKER);
    for (const id of [a, b, c, d]) expect(logOf(id).status).toBe("held");
    expect(smtp.connections()).toBe(0);
    expect(noticesOf(off.owner)).toMatchObject([{ kind: "mail_held" }]);
    expect(jobOf(a).status).toBe("done");

    setPaused(webActor(paused.owner), false, { confirmed: true });
    later(600 * MINUTE);
    await drainJobs(WORKER);
    expect(logOf(d).status).toBe("held");
    expect(smtp.connections()).toBe(0);
  });

  test("změna dokladu během skládání PDF zadrží zprávu před SMTP", async () => {
    const { owner, invoiceId } = account();
    const id = send(owner, invoiceId);
    await duringRender(() => cancelInvoice(webActor(owner), invoiceId));
    expect(logOf(id).status).toBe("held");
    expect(smtp.connections()).toBe(0);
  });

  test("změna revize během skládání PDF zadrží zprávu před SMTP", async () => {
    const { owner, invoiceId } = account();
    const id = send(owner, invoiceId);
    await duringRender(() =>
      db
        .update(invoice)
        .set({ revision: sql`${invoice.revision} + 1` })
        .where(eq(invoice.id, invoiceId))
        .run(),
    );
    expect(logOf(id).status).toBe("held");
    expect(smtp.connections()).toBe(0);
  });

  test("vypnutí automatiky i hlavní vypínač během skládání PDF zadrží zprávu", async () => {
    for (const change of [
      (owner: string) =>
        setAutomation(webActor(owner), "recurringSend", false, { confirmed: true }),
      (owner: string) => setPaused(webActor(owner), true, { confirmed: true }),
    ]) {
      const { owner, invoiceId } = account();
      setAutomation(webActor(owner), "recurringSend", true, { confirmed: true });
      const id = automatic(owner, invoiceId);
      await duringRender(() => change(owner));
      expect(logOf(id).status).toBe("held");
    }
    expect(smtp.connections()).toBe(0);
  });

  test("změna revize mezi pokusy zadrží opakování", async () => {
    const { owner, invoiceId } = account();
    smtp.rejectNext(421);
    const id = send(owner, invoiceId);
    await drainJobs(WORKER);
    db.update(invoice)
      .set({ revision: sql`${invoice.revision} + 1` })
      .where(eq(invoice.id, invoiceId))
      .run();
    later(5 * MINUTE);
    await drainJobs(WORKER);
    expect(logOf(id).status).toBe("held");
    expect(smtp.connections()).toBe(1);
  });

  test("[REC-032] automatické odeslání starší 3 dnů se zadrží", async () => {
    const fresh = account();
    setAutomation(webActor(fresh.owner), "recurringSend", true, { confirmed: true });
    const edge = automatic(fresh.owner, fresh.invoiceId, { plannedFor: "2026-10-30" });
    const stale = account();
    setAutomation(webActor(stale.owner), "recurringSend", true, { confirmed: true });
    const old = automatic(stale.owner, stale.invoiceId, { plannedFor: "2026-10-29" });

    await drainJobs(WORKER);
    expect(logOf(edge).status).toBe("sent");
    expect(logOf(old).status).toBe("held");
    expect(smtp.messages).toHaveLength(1);
  });

  test("hlavní vypínač ruční odeslání neblokuje", async () => {
    const { owner, invoiceId } = account();
    setPaused(webActor(owner), true, { confirmed: true });
    const id = send(owner, invoiceId);
    await drainJobs(WORKER);
    expect(logOf(id).status).toBe("sent");
  });

  test("deaktivace převede frontu na cancelled a reaktivace nic neuvolní", async () => {
    const { owner, invoiceId } = account();
    const admin = seedOwner(db, T0);
    db.run(sql`UPDATE user SET role = 'admin' WHERE id = ${admin}`);
    const id = send(owner, invoiceId);
    deactivateUser(webActor(admin), owner);
    expect(logOf(id).status).toBe("cancelled");
    expect(noticesOf(owner)).toMatchObject([{ kind: "mail_held", entityId: invoiceId }]);
    reactivateUser(webActor(admin), owner);
    later(600 * MINUTE);
    await drainJobs(WORKER);
    expect(logOf(id).status).toBe("cancelled");
    expect(smtp.connections()).toBe(0);
  });

  test("po dalším úspěchu se vyřeší i upozornění ze zrušeného záznamu", async () => {
    const { owner, invoiceId } = account();
    const admin = seedOwner(db, T0);
    db.run(sql`UPDATE user SET role = 'admin' WHERE id = ${admin}`);
    send(owner, invoiceId);
    deactivateUser(webActor(admin), owner);
    reactivateUser(webActor(admin), owner);
    send(owner, invoiceId);
    await drainJobs(WORKER);
    expect(noticesOf(owner)[0]!.resolvedAt).toEqual(T0);
  });

  test("deaktivace během skládání PDF zastaví zprávu před SMTP", async () => {
    const { owner, invoiceId } = account();
    const admin = seedOwner(db, T0);
    db.run(sql`UPDATE user SET role = 'admin' WHERE id = ${admin}`);
    const id = send(owner, invoiceId);
    await duringRender(() => deactivateUser(webActor(admin), owner));
    expect(logOf(id).status).toBe("cancelled");
    expect(smtp.connections()).toBe(0);
  });
});

describe("deaktivace za běhu", () => {
  test("opakovatelná chyba po deaktivaci během SMTP zruší záznam, ne jen úlohu", async () => {
    const { owner, invoiceId } = account();
    const admin = seedOwner(db, T0);
    db.run(sql`UPDATE user SET role = 'admin' WHERE id = ${admin}`);
    smtp.rejectEvery(421);
    const release = smtp.holdData();
    const id = send(owner, invoiceId);
    const drained = drainJobs(WORKER);
    await vi.waitFor(() => expect(smtp.connections()).toBe(1), RENDER_WAIT);
    await vi.waitFor(() => expect(logOf(id).status).toBe("sending"), RENDER_WAIT);
    deactivateUser(webActor(admin), owner);
    expect(logOf(id).status).toBe("sending");
    release();
    await drained;
    expect(logOf(id).status).toBe("cancelled");
    expect(jobOf(id).status).toBe("done");

    reactivateUser(webActor(admin), owner);
    expect(send(owner, invoiceId)).toBeTruthy();
  });
});

describe("obnova po přerušení", () => {
  test("recover ze sending je unknown, z queued nový pokus", async () => {
    const stuck = account();
    const sending = send(stuck.owner, stuck.invoiceId);
    db.update(emailLog).set({ status: "sending" }).where(eq(emailLog.id, sending)).run();
    crash(sending);

    const waiting = account();
    const queued = send(waiting.owner, waiting.invoiceId);
    crash(queued);

    recoverInterrupted(WORKER);
    expect(logOf(sending).status).toBe("unknown");
    expect(jobOf(sending).status).toBe("done");
    expect(noticesOf(stuck.owner)).toMatchObject([{ kind: "mail_unknown" }]);
    expect(logOf(queued).status).toBe("queued");
    expect(jobOf(queued).status).toBe("pending");

    await drainJobs(WORKER);
    expect(logOf(queued).status).toBe("sent");
    expect(logOf(sending).status).toBe("unknown");
    expect(smtp.messages).toHaveLength(1);
    assertConsistent(db, stuck.owner);
  });

  test("recover z queued u deaktivovaného účtu zruší záznam a po reaktivaci nic neodejde", async () => {
    const { owner, invoiceId } = account();
    const id = send(owner, invoiceId);
    crash(id);
    db.run(sql`UPDATE user SET banned = 1 WHERE id = ${owner}`);

    recoverInterrupted(WORKER);
    expect(logOf(id).status).toBe("cancelled");
    expect(jobOf(id).status).toBe("cancelled");

    db.run(sql`UPDATE user SET banned = 0 WHERE id = ${owner}`);
    later(600 * MINUTE);
    await drainJobs(WORKER);
    expect(smtp.connections()).toBe(0);
  });

  test("recover ze sending u deaktivovaného účtu je unknown bez nového pokusu", async () => {
    const { owner, invoiceId } = account();
    const id = send(owner, invoiceId);
    db.update(emailLog).set({ status: "sending" }).where(eq(emailLog.id, id)).run();
    crash(id);
    db.run(sql`UPDATE user SET banned = 1 WHERE id = ${owner}`);
    recoverInterrupted(WORKER);
    expect(logOf(id).status).toBe("unknown");
    expect(jobOf(id).status).toBe("done");
  });

  test("recover z queued po vyčerpaných pokusech je failed", async () => {
    const { owner, invoiceId } = account();
    const id = send(owner, invoiceId);
    crash(id);
    db.update(job)
      .set({ attempts: 4 })
      .where(eq(job.id, jobOf(id).id))
      .run();
    recoverInterrupted(WORKER);
    expect(logOf(id).status).toBe("failed");
    expect(jobOf(id).status).toBe("done");
    expect(noticesOf(owner)).toMatchObject([{ kind: "mail_failed" }]);
  });

  test("pád mezi requeue a retryJob drží odstup R-3", async () => {
    const { owner, invoiceId } = account();
    smtp.rejectNext(421);
    const id = send(owner, invoiceId);
    await drainJobs(WORKER);
    crash(id);
    later(MINUTE);
    recoverInterrupted(WORKER);
    expect(jobOf(id)).toMatchObject({
      status: "pending",
      runAt: new Date(T0.getTime() + 5 * MINUTE),
    });
    await drainJobs(WORKER);
    expect(smtp.connections()).toBe(1);
    later(4 * MINUTE);
    await drainJobs(WORKER);
    expect(smtp.connections()).toBe(2);
    expect(logOf(id).status).toBe("sent");
  });

  test("recover po vyčerpaných pokusech ponechá důvod serveru, jinak řekne, že zpráva neodešla", async () => {
    const tried = account();
    smtp.rejectNext(421);
    const withReason = send(tried.owner, tried.invoiceId);
    await drainJobs(WORKER);
    crash(withReason);
    db.update(job)
      .set({ attempts: 4 })
      .where(eq(job.id, jobOf(withReason).id))
      .run();

    const fresh = account();
    const without = send(fresh.owner, fresh.invoiceId);
    crash(without);
    db.update(job)
      .set({ attempts: 4 })
      .where(eq(job.id, jobOf(without).id))
      .run();

    recoverInterrupted(WORKER);
    expect(logOf(withReason).reason).toContain("421");
    expect(logOf(without).reason).toMatch(/neodešla/);
  });

  test("mrtvá úloha se záznamem sending je unknown s upozorněním a uvolní blokaci", async () => {
    const { owner, invoiceId } = account();
    const id = send(owner, invoiceId);
    db.update(emailLog).set({ status: "sending" }).where(eq(emailLog.id, id)).run();
    db.update(job)
      .set({ status: "dead" })
      .where(eq(job.id, jobOf(id).id))
      .run();
    settleDeadMail();
    expect(logOf(id).status).toBe("unknown");
    expect(noticesOf(owner)).toMatchObject([{ kind: "mail_unknown" }]);
    expect(send(owner, invoiceId, { confirmedUnknown: true })).toBeTruthy();
  });

  test("mrtvá úloha se záznamem queued je failed a neodešle nic", async () => {
    const { owner, invoiceId } = account();
    const id = send(owner, invoiceId);
    db.update(job)
      .set({ status: "dead" })
      .where(eq(job.id, jobOf(id).id))
      .run();
    settleDeadMail();
    await drainJobs(WORKER);
    expect(logOf(id).status).toBe("failed");
    expect(smtp.connections()).toBe(0);
  });

  test("výjimka u jednoho mrtvého záznamu nezastaví ostatní a jde do monitoringu", () => {
    const first = account();
    const second = account();
    const broken = send(first.owner, first.invoiceId);
    const healthy = send(second.owner, second.invoiceId);
    db.update(job).set({ status: "dead" }).run();
    db.$client.exec(`CREATE TEMP TRIGGER refuse_settle BEFORE UPDATE ON email_log
      WHEN old.id = '${broken}' BEGIN SELECT RAISE(ABORT, 'disk spadl'); END`);
    try {
      expect(() => settleDeadMail()).not.toThrow();
    } finally {
      db.$client.exec("DROP TRIGGER refuse_settle");
    }
    expect(logOf(broken).status).toBe("queued");
    expect(logOf(healthy).status).toBe("failed");
    expect(mocks.captureException).toHaveBeenCalledOnce();
    expect(mocks.captureException.mock.calls[0][1]).toMatchObject({
      tags: { task: "dead-mail", job_id: jobOf(broken).id, kind: "mail.send" },
      user: { id: first.owner },
    });

    settleDeadMail();
    expect(logOf(broken).status).toBe("failed");
  });

  test("tick spustí úkol mrtvých záznamů", async () => {
    const { owner, invoiceId } = account();
    const id = send(owner, invoiceId);
    db.update(job)
      .set({ status: "dead" })
      .where(eq(job.id, jobOf(id).id))
      .run();
    resetTickTasksForTests();
    registerTickTask(deadMailTask);
    try {
      await tick("tick-holder");
    } finally {
      resetTickTasksForTests();
    }
    expect(logOf(id).status).toBe("failed");
  });

  test("recover hotového záznamu jen ukončí úlohu", async () => {
    const { owner, invoiceId } = account();
    const id = send(owner, invoiceId);
    await drainJobs(WORKER);
    crash(id);
    recoverInterrupted(WORKER);
    expect(jobOf(id).status).toBe("done");
    expect(logOf(id).status).toBe("sent");
    expect(smtp.messages).toHaveLength(1);
  });
});

describe("převzetí úlohy za běhu", () => {
  test("pozdní pokus po doručení novým držitelem nic neodešle", async () => {
    const { owner, invoiceId } = account();
    const id = send(owner, invoiceId);
    const { attempt, release } = await stalledAttempt();
    await drainJobs("B");
    expect(logOf(id).status).toBe("sent");

    release();
    await attempt;
    expect(smtp.messages).toHaveLength(1);
    expect(smtp.connections()).toBe(1);
    expect(logOf(id).status).toBe("sent");
    expect(db.select().from(file).where(eq(file.userId, owner)).all()).toHaveLength(1);
    assertConsistent(db, owner);
  });

  test("pozdní pokus po 421 nového držitele čeká na jeho opakování a neposílá", async () => {
    const { owner, invoiceId } = account();
    smtp.rejectNext(421);
    const id = send(owner, invoiceId);
    const { attempt, release } = await stalledAttempt();
    await drainJobs("B");
    expect(logOf(id).status).toBe("queued");
    expect(smtp.connections()).toBe(1);

    release();
    await attempt;
    expect(smtp.connections()).toBe(1);
    expect(logOf(id)).toMatchObject({ status: "queued", attempts: 1 });
    expect(jobOf(id).status).toBe("pending");

    later(30 * MINUTE);
    await drainJobs("B");
    expect(smtp.messages).toHaveLength(1);
    expect(smtp.connections()).toBe(2);
    expect(logOf(id).status).toBe("sent");
  });

  test("pozdní pokus se spadlým renderem nového držitele nepřebije", async () => {
    const { owner, invoiceId } = account();
    smtp.rejectNext(421);
    const id = send(owner, invoiceId);
    const setAttempts = (attempts: number) =>
      db
        .update(job)
        .set({ attempts })
        .where(eq(job.id, jobOf(id).id))
        .run();
    // A claims its last attempt and keeps that snapshot, while B still has attempts left.
    setAttempts(3);
    const { attempt, release } = await stalledAttempt(() => setAttempts(1));
    await drainJobs("B");
    expect(logOf(id).status).toBe("queued");

    mocks.failRender.on = true;
    release();
    await expect(attempt).rejects.toThrow("render spadl");
    expect(logOf(id).status).toBe("queued");
    expect(jobOf(id).status).toBe("pending");

    mocks.failRender.on = false;
    later(30 * MINUTE);
    await drainJobs("B");
    expect(logOf(id).status).toBe("sent");
    expect(smtp.messages).toHaveLength(1);
  });
});

describe("změna během odesílání", () => {
  async function whileSending(owner: string, invoiceId: string, change: (id: string) => void) {
    const release = smtp.holdData();
    const id = send(owner, invoiceId);
    const drained = drainJobs(WORKER);
    await vi.waitFor(() => expect(logOf(id).status).toBe("sending"), RENDER_WAIT);
    change(id);
    release();
    await drained;
    return id;
  }

  test("storno během sending: záznam je odeslaný, stav dokladu zůstane a uživatel se to dozví", async () => {
    const { owner, invoiceId } = account();
    const id = await whileSending(owner, invoiceId, () =>
      cancelInvoice(webActor(owner), invoiceId),
    );

    expect(logOf(id).status).toBe("sent");
    expect(getInvoice(owner, invoiceId)?.status).toBe("cancelled");
    expect(noticesOf(owner).map((row) => row.kind)).toContain("mail_stale");
    expect(mocks.captureException).not.toHaveBeenCalled();
    assertConsistent(db, owner);
  });

  test("beze změny dokladu upozornění nevznikne", async () => {
    const { owner, invoiceId } = account();
    await whileSending(owner, invoiceId, () => {});
    expect(noticesOf(owner)).toEqual([]);
  });

  test("záznam převzatý obnovou výsledek nepřepíše a není to chyba kódu", async () => {
    const { owner, invoiceId } = account();
    const id = await whileSending(owner, invoiceId, (logId) => {
      db.update(emailLog).set({ status: "unknown" }).where(eq(emailLog.id, logId)).run();
    });

    expect(logOf(id).status).toBe("unknown");
    expect(mocks.captureException).not.toHaveBeenCalled();
  });
});

describe("časový strop", () => {
  test("jedno odeslání dodrží celkový strop času i na zablokovaném serveru", async () => {
    const { owner, invoiceId } = account();
    const release = smtp.holdData();
    // Long enough to reach DATA on a loaded machine: earlier the attempt is a plain retry.
    setDeliveryLimitsForTests({ smtpMs: 3_000 });
    const id = send(owner, invoiceId);
    const started = performance.now();
    await drainJobs(WORKER);
    release();
    expect(performance.now() - started).toBeLessThan(SEND_TIMEOUTS.socketTimeout);
    expect(logOf(id).status).toBe("unknown");
    expect(smtp.connections()).toBe(1);
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  test("render přes strop pdfMs do SMTP nedojde a zkusí se znovu", async () => {
    const { owner, invoiceId } = account();
    const release = holdRender();
    setDeliveryLimitsForTests({ pdfMs: 100 });
    const id = send(owner, invoiceId);
    await drainJobs(WORKER);
    release();
    expect(logOf(id)).toMatchObject({ status: "queued", attempts: 0 });
    expect(jobOf(id).status).toBe("pending");
    expect(smtp.connections()).toBe(0);
    expect(mocks.captureException).toHaveBeenCalledOnce();

    setDeliveryLimitsForTests(null);
    later(5 * MINUTE);
    await drainJobs(WORKER);
    expect(logOf(id).status).toBe("sent");
  });

  test("součet stropů zůstává pod lease 120 s", () => {
    expect(DELIVERY_LIMITS.pdfMs + DELIVERY_LIMITS.smtpMs).toBeLessThan(120_000);
    expect(DELIVERY_LIMITS.pdfMs).toBeGreaterThan(30_000);
  });
});

describe("výpis", () => {
  test("[MAIL-006] historie ukáže čas, příjemce, předmět, výsledek a archiv", async () => {
    const { owner, invoiceId } = account();
    const id = send(owner, invoiceId, { subject: "Vaše faktura" });
    await drainJobs(WORKER);
    expect(listEmailLog(owner, invoiceId)).toMatchObject([
      {
        id,
        to: ["alfa@example.cz"],
        subject: "Vaše faktura",
        status: "sent",
        sentAt: T0,
        createdAt: T0,
        hasArchive: true,
      },
    ]);
  });

  test("[MAIL-004] vystavení ani uložení nepošle nic", async () => {
    const owner = seedOwner(db, T0);
    ownSmtp(db, owner, smtp.port);
    const customer = seedCustomer(owner);
    draftFor(owner, customer);
    issuedInvoice(owner, customer);
    await drainJobs(WORKER);
    expect(smtp.connections()).toBe(0);
    expect(db.select().from(emailLog).where(eq(emailLog.userId, owner)).all()).toEqual([]);
  });
});
