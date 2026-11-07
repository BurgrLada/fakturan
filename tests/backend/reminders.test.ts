import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { setClockForTests } from "@/server/clock";
import { createDb, runMigrations } from "@/server/db";
import {
  auditLog,
  automationSettings,
  customer,
  emailLog,
  invoice,
  invoiceVersion,
  job,
  notification,
  reminderRule,
  reminderSent,
} from "@/server/db/schema";
import { registerJob } from "@/server/jobs/registry";
import { drainJobs } from "@/server/jobs/worker";
import { setAutomation, setPaused } from "@/server/services/automation";
import { refreshBalance } from "@/server/services/invoice-balance";
import { markSent } from "@/server/services/invoice-lifecycle";
import { queueMail, sendPrefill } from "@/server/services/invoice-mail";
import { getInvoice } from "@/server/services/invoices";
import { deliverMail, recoverMail } from "@/server/services/mail-delivery";
import { mutate } from "@/server/services/mutation";
import { addPayment, markPaid } from "@/server/services/payments";
import {
  deleteReminderRule,
  listReminderRules,
  planReminders,
  reminderHistory,
  reminderPrefill,
  remindersForReview,
  saveReminderRule,
  sendManualReminder,
  setPartialReminders,
  setRemindersOff,
  snoozeReminders,
} from "@/server/services/reminders";
import { MANUAL_STAGE } from "@/lib/reminders";
import { TEXTS } from "@/lib/texts";
import { seedCreditNote } from "../fixtures/invoices";
import { createTestDb } from "../helpers/db";
import {
  issuedInvoice,
  ownSmtp,
  seedCustomer,
  seedOwner,
  webActor,
} from "../helpers/fixtures-mail";
import { assertIsolated } from "../helpers/isolation";
import { pdfText } from "../helpers/pdf";
import { runJobWorkers } from "../helpers/run-workers";
import { startSmtp, type TestSmtp } from "../helpers/smtp";

vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-reminders-")));
vi.stubEnv("ALLOW_PRIVATE_MAIL_HOSTS", "true");
vi.stubEnv("SENTRY_DSN", "http://public@localhost/1");
vi.stubEnv("SMTP_HOST", "");
vi.stubEnv("SMTP_PORT", "");
vi.stubEnv("SMTP_FROM", "");

const db = createTestDb();
const ENABLED = { confirmed: true };
const DAY_ONE = "2026-03-02T09:30:00Z";

let smtp: TestSmtp;
let current = new Date(DAY_ONE);

const at = (iso: string) => {
  current = new Date(iso);
};
const tickAt = async (iso: string) => {
  at(iso);
  planReminders(current);
  await drainJobs("w");
};

beforeAll(async () => {
  smtp = await startSmtp();
});
afterAll(() => smtp.stop());

beforeEach(() => {
  smtp.reset();
  db.delete(job).run();
  // Accounts left by earlier tests would otherwise send into this test's mailbox.
  db.delete(automationSettings).run();
  current = new Date(DAY_ONE);
  setClockForTests({ now: () => current });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  registerJob("mail.send", { run: deliverMail, recover: recoverMail });
});
afterEach(() => {
  setClockForTests(null);
  vi.restoreAllMocks();
});

function account(over: { cc?: string[]; bcc?: string[] } = {}) {
  const owner = seedOwner(db, current);
  ownSmtp(db, owner, smtp.port, over);
  return { owner, customerId: seedCustomer(owner) };
}

// Enabled on the first of March, so a stage dated later is past the opening date.
function reminding(over: { cc?: string[]; bcc?: string[] } = {}) {
  const seeded = account(over);
  at("2026-03-01T08:00:00Z");
  setAutomation(webActor(seeded.owner), "reminders", true, ENABLED);
  at(DAY_ONE);
  return seeded;
}

const LONG_AGO = new Date("2026-01-05T10:00:00Z");

function sentInvoice(owner: string, customerId: string, dueDate = "2026-03-02") {
  const id = issuedInvoice(owner, customerId);
  db.update(invoice)
    .set({ status: "sent", dueDate, sentAt: LONG_AGO })
    .where(eq(invoice.id, id))
    .run();
  return id;
}

// Dated well before the tests' stages: a rule never catches up on a day it did not exist.
const rule = (owner: string, offsetDays: number, texts: unknown = null) => {
  const before = current;
  current = LONG_AGO;
  const { id } = saveReminderRule(webActor(owner), { offsetDays, texts });
  current = before;
  return id;
};
const logsOf = (owner: string) =>
  db.select().from(emailLog).where(eq(emailLog.userId, owner)).all();
const sentOf = (owner: string) =>
  db.select().from(reminderSent).where(eq(reminderSent.userId, owner)).all();
const noticesOf = (owner: string) =>
  db.select().from(notification).where(eq(notification.userId, owner)).all();
const setInvoice = (id: string, fields: Partial<typeof invoice.$inferInsert>) =>
  db.update(invoice).set(fields).where(eq(invoice.id, id)).run();

function manual(
  owner: string,
  invoiceId: string,
  stageKey: string | null,
  confirmedRepeat = false,
) {
  const { to, cc, bcc, subject, body, requestId, revision } = reminderPrefill(
    owner,
    invoiceId,
    stageKey,
  );
  return sendManualReminder(webActor(owner), invoiceId, {
    to,
    cc,
    bcc,
    subject,
    body,
    requestId,
    revision,
    stageKey,
    confirmedRepeat,
  });
}

describe("automatické upomínky", () => {
  test("[REM-001] selhání úklidu blokací denní upomínky nezastaví", async () => {
    const { owner, customerId } = reminding();
    rule(owner, 0);
    sentInvoice(owner, customerId);
    const failure = new Error("úklid spadl");
    vi.spyOn(db, "select").mockImplementationOnce(() => {
      throw failure;
    });

    await tickAt(DAY_ONE);

    expect(sentOf(owner)).toHaveLength(1);
  });

  test("[REM-001] bez zapnutí neodejde nic, ani s pravidly a dlužnými fakturami", async () => {
    const { owner, customerId } = account();
    rule(owner, 0);
    sentInvoice(owner, customerId);

    await tickAt(DAY_ONE);

    expect(smtp.messages).toEqual([]);
    expect(sentOf(owner)).toEqual([]);
  });

  test("[REM-002] stupně před i po splatnosti s vlastním textem", async () => {
    const { owner, customerId } = reminding();
    rule(owner, -1);
    rule(owner, 5, {
      cs: { subject: "Stále dlužíte {{cislo_faktury}}", body: "Zbývá {{zbyva}}." },
    });
    const id = sentInvoice(owner, customerId, "2026-03-10");

    await tickAt("2026-03-09T09:30:00Z");
    expect(smtp.messages).toHaveLength(1);
    expect(smtp.messages[0]!.subject).toContain("Upomínka k faktuře");

    await tickAt("2026-03-15T09:30:00Z");
    expect(smtp.messages).toHaveLength(2);
    const number = getInvoice(owner, id)!.number;
    expect(smtp.messages[1]!.subject).toBe(`Stále dlužíte ${number}`);
    expect(smtp.messages[1]!.body).toMatch(/Zbývá 3\s000,00\sKč\./);
    expect(logsOf(owner).map((log) => log.kind)).toEqual(["reminder", "reminder"]);
    expect(logsOf(owner).map((log) => log.automation)).toEqual(["reminders", "reminders"]);
    expect(getInvoice(owner, id)!.status).toBe("sent");
  });

  test("[SEC-011] vlastní text upomínky je v textu doslova a v HTML jen escapovaný", async () => {
    const { owner, customerId } = reminding();
    rule(owner, 0, { cs: { subject: "Pozor", body: "<script>alert(1)</script>" } });
    sentInvoice(owner, customerId);

    await tickAt("2026-03-02T09:30:00Z");

    expect(smtp.messages[0]!.body).toContain("<script>alert(1)</script>");
    expect(smtp.messages[0]!.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(smtp.messages[0]!.html).not.toMatch(/<script/i);
  });

  test("zpráva převezme stálé kopie a přiloží aktuální PDF se zbývající částkou", async () => {
    const { owner, customerId } = reminding({ cc: ["ucetni@novak.cz"], bcc: ["archiv@novak.cz"] });
    rule(owner, 0);
    const id = sentInvoice(owner, customerId);
    setInvoice(id, { status: "partially_paid", paidMinor: 100_000, remindersPartial: true });

    await tickAt(DAY_ONE);

    expect(logsOf(owner)[0]).toMatchObject({
      to: ["alfa@example.cz"],
      cc: ["ucetni@novak.cz"],
      bcc: ["archiv@novak.cz"],
    });
    const message = smtp.messages[0]!;
    expect(message.to).toEqual(
      expect.arrayContaining(["alfa@example.cz", "ucetni@novak.cz", "archiv@novak.cz"]),
    );
    expect(message.body).toMatch(/Zbývá uhradit 2\s000,00\sKč/);
    expect((await pdfText(message.attachments[0]!.content)).join(" ")).toMatch(/2\s000,00/);
  });

  test("zákazník bez adresy stupeň nespotřebuje a upozornění nese datum", async () => {
    const { owner } = reminding();
    const silent = seedCustomer(owner, "");
    rule(owner, 0);
    const id = sentInvoice(owner, silent);

    await tickAt(DAY_ONE);
    await tickAt("2026-03-02T09:31:00Z");
    await tickAt("2026-03-03T09:30:00Z");

    expect(sentOf(owner)).toEqual([]);
    const notices = noticesOf(owner).filter((row) => row.kind === "reminder_failed");
    expect(notices.map((row) => row.dedupeKey.split(":").at(-1))).toEqual([
      "2026-03-02",
      "2026-03-03",
    ]);
    expect(notices[0]!.entityId).toBe(id);

    db.update(customer).set({ email: "nova@example.cz" }).where(eq(customer.id, silent)).run();
    await tickAt("2026-03-04T09:30:00Z");

    expect(smtp.messages).toHaveLength(1);
    const left = noticesOf(owner).filter((row) => row.kind === "reminder_failed");
    expect(left.every((row) => row.resolvedAt !== null)).toBe(true);
  });

  test("neplatný text zprávu nezařadí a stupeň nespotřebuje", async () => {
    const { owner, customerId } = reminding({ cc: ["spatna-adresa"] });
    rule(owner, 0);
    sentInvoice(owner, customerId);

    await tickAt(DAY_ONE);

    expect(logsOf(owner)).toEqual([]);
    expect(sentOf(owner)).toEqual([]);
    expect(noticesOf(owner).map((row) => row.kind)).toEqual(["reminder_failed"]);
  });

  test("[REM-004] odklad o 30 dní projde, o 31 je odmítnutý, stupeň odejde po odkladu", async () => {
    const { owner, customerId } = reminding();
    rule(owner, 0);
    const id = sentInvoice(owner, customerId, "2026-03-03");
    const actor = webActor(owner);
    const { revision, updatedAt } = getInvoice(owner, id)!;
    const versions = db.select().from(invoiceVersion).all().length;

    expect(() => snoozeReminders(actor, id, "2026-04-02")).toThrow(
      TEXTS.reminders.errors.snoozeRange,
    );
    expect(() => snoozeReminders(actor, id, "2026-03-01")).toThrow(
      TEXTS.reminders.errors.snoozeRange,
    );
    expect(() => snoozeReminders(actor, id, "nesmysl")).toThrow(TEXTS.reminders.errors.snoozeRange);
    snoozeReminders(actor, id, "2026-04-01");
    snoozeReminders(actor, id, "2026-03-06");

    const row = getInvoice(owner, id)!;
    expect(row).toMatchObject({ remindersSnoozeUntil: "2026-03-06", revision, updatedAt });
    expect(db.select().from(invoiceVersion).all()).toHaveLength(versions);

    await tickAt("2026-03-03T09:30:00Z");
    expect(smtp.messages).toEqual([]);
    await tickAt("2026-03-06T09:30:00Z");
    expect(smtp.messages).toHaveLength(1);
  });

  test("[REM-004] vypnutí na faktuře zastaví stupně", async () => {
    const { owner, customerId } = reminding();
    rule(owner, 0);
    const id = sentInvoice(owner, customerId);
    const { revision } = getInvoice(owner, id)!;

    setRemindersOff(webActor(owner), id, true);
    setPartialReminders(webActor(owner), id, true);
    await tickAt(DAY_ONE);

    expect(smtp.messages).toEqual([]);
    expect(getInvoice(owner, id)!.revision).toBe(revision);
    const actions = db
      .select()
      .from(auditLog)
      .all()
      .map((row) => row.action);
    expect(actions).toContain("invoice.reminders_off");
    expect(actions).toContain("invoice.reminders_partial");
  });

  test("[REM-005] vypnutí na zákazníkovi blokuje a true nepřebije vypnutou automatiku", async () => {
    const off = reminding();
    rule(off.owner, 0);
    sentInvoice(off.owner, off.customerId);
    db.update(customer)
      .set({ remindersEnabled: false })
      .where(eq(customer.id, off.customerId))
      .run();

    const forced = account();
    rule(forced.owner, 0);
    sentInvoice(forced.owner, forced.customerId);
    db.update(customer)
      .set({ remindersEnabled: true })
      .where(eq(customer.id, forced.customerId))
      .run();

    await tickAt(DAY_ONE);

    expect(smtp.messages).toEqual([]);
  });

  test("[REM-006] uhrazená a stornovaná nikdy, částečná jen po zapnutí se zbývající částkou", async () => {
    const { owner, customerId } = reminding();
    rule(owner, 0);
    const paid = sentInvoice(owner, customerId);
    setInvoice(paid, { status: "paid", paidMinor: 300_000 });
    const cancelled = sentInvoice(owner, customerId);
    setInvoice(cancelled, { status: "cancelled" });
    const partial = sentInvoice(owner, customerId);
    setInvoice(partial, { status: "partially_paid", paidMinor: 50_000 });

    await tickAt(DAY_ONE);
    expect(smtp.messages).toEqual([]);

    setPartialReminders(webActor(owner), partial, true);
    await tickAt("2026-03-02T09:31:00Z");

    expect(smtp.messages).toHaveLength(1);
    expect(smtp.messages[0]!.body).toMatch(/Zbývá uhradit 2\s500,00\sKč/);
  });

  test("[REM-008] odchází po nastaveném čase, výchozí 9:00", async () => {
    const { owner, customerId } = reminding();
    rule(owner, 0);
    sentInvoice(owner, customerId);

    await tickAt("2026-03-02T07:59:00Z");
    expect(smtp.messages).toEqual([]);
    await tickAt("2026-03-02T08:00:00Z");
    expect(smtp.messages).toHaveLength(1);
  });

  test("zapnutí upomínek nepošle nic na staré dluhy, zůstanou ke kontrole", async () => {
    const { owner, customerId } = account();
    const stage = rule(owner, 1);
    const id = sentInvoice(owner, customerId, "2026-02-20");

    setAutomation(webActor(owner), "reminders", true, ENABLED);
    await tickAt(DAY_ONE);
    await tickAt("2026-03-03T09:30:00Z");

    expect(smtp.messages).toEqual([]);
    expect(remindersForReview(owner, "2026-03-03")).toMatchObject([
      { invoiceId: id, stageKey: stage, stageDate: "2026-02-21", amountDueMinor: 300_000 },
    ]);
  });

  test("zkontrolovaná ruční upomínka ze seznamu zmizí", () => {
    const { owner, customerId } = account();
    const stage = rule(owner, 1);
    const id = sentInvoice(owner, customerId, "2026-02-20");
    setAutomation(webActor(owner), "reminders", true, ENABLED);

    manual(owner, id, stage);

    expect(remindersForReview(owner, "2026-03-03")).toEqual([]);
  });

  test("hlavní vypínač zapnutý a vypnutý v jeden den dnešní stupeň neuvolní", async () => {
    const { owner, customerId } = reminding();
    rule(owner, 0);
    sentInvoice(owner, customerId);

    setPaused(webActor(owner), true, { confirmed: false });
    await tickAt(DAY_ONE);
    setPaused(webActor(owner), false, ENABLED);
    await tickAt("2026-03-02T10:00:00Z");

    expect(smtp.messages).toEqual([]);
  });

  test("upomínka na stav vystavená bez odeslání automaticky neodejde", async () => {
    const { owner, customerId } = reminding();
    rule(owner, 0);
    const id = sentInvoice(owner, customerId);
    setInvoice(id, { status: "issued" });

    await tickAt(DAY_ONE);

    expect(smtp.messages).toEqual([]);
  });

  test("stupně neodejdou mimo pořadí po výpadku", async () => {
    const { owner, customerId } = reminding();
    const early = rule(owner, 1);
    const late = rule(owner, 3);
    sentInvoice(owner, customerId, "2026-03-05");

    await tickAt("2026-03-08T09:30:00Z");
    await tickAt("2026-03-09T09:30:00Z");

    expect(sentOf(owner).map((row) => row.stageKey)).toEqual([late]);
    expect(sentOf(owner).map((row) => row.stageKey)).not.toContain(early);
    expect(smtp.messages).toHaveLength(1);
  });

  test("[REM-007] smazaný a znovu založený stupeň neodejde podruhé a historie drží původní dny", async () => {
    const { owner, customerId } = reminding();
    const stage = rule(owner, 0);
    const id = sentInvoice(owner, customerId);
    await tickAt(DAY_ONE);

    deleteReminderRule(webActor(owner), stage);
    expect(listReminderRules(owner)).toEqual([]);
    expect(reminderHistory(owner, id)).toMatchObject([{ offsetDays: 0, status: "sent" }]);

    rule(owner, 0);
    await tickAt("2026-03-02T09:31:00Z");
    await tickAt("2026-03-03T09:30:00Z");

    expect(smtp.messages).toHaveLength(1);
    expect(reminderPrefill(owner, id, listReminderRules(owner)[0]!.id).repeat).toBe(true);
  });

  test("[REM-007] znovu založený dřívější stupeň po pozdějším pořadí nerozbije", async () => {
    const { owner, customerId } = reminding();
    const early = rule(owner, 1);
    rule(owner, 3);
    sentInvoice(owner, customerId, "2026-03-05");
    await tickAt("2026-03-08T09:30:00Z");

    deleteReminderRule(webActor(owner), early);
    rule(owner, 1);
    await tickAt("2026-03-08T09:31:00Z");

    expect(smtp.messages).toHaveLength(1);
  });

  test("upomínka nepřijde minutu po faktuře ani po pozdním Označit jako odeslané", async () => {
    const { owner, customerId } = reminding();
    rule(owner, 0);
    const late = issuedInvoice(owner, customerId);
    setInvoice(late, { dueDate: "2026-03-02" });
    at("2026-03-02T09:29:00Z");
    markSent(webActor(owner), late);
    const mailed = issuedInvoice(owner, customerId);
    setInvoice(mailed, { status: "sent", dueDate: "2026-03-02", sentAt: current });

    await tickAt("2026-03-02T09:30:00Z");
    await tickAt("2026-03-03T09:30:00Z");

    expect(smtp.messages).toEqual([]);
  });

  test("nové pravidlo a změna dnů nedohánějí, další den stupeň odejde", async () => {
    const { owner, customerId } = reminding();
    const moved = rule(owner, 9);
    const id = sentInvoice(owner, customerId, "2026-03-01");

    const added = saveReminderRule(webActor(owner), { offsetDays: 1, texts: null }).id;
    await tickAt(DAY_ONE);
    saveReminderRule(webActor(owner), { id: added, offsetDays: 1, texts: null });
    saveReminderRule(webActor(owner), { id: moved, offsetDays: 2, texts: null });
    await tickAt(DAY_ONE);
    expect(smtp.messages).toEqual([]);

    setInvoice(id, { dueDate: "2026-03-02" });
    await tickAt("2026-03-03T09:30:00Z");

    expect(sentOf(owner).map((row) => row.offsetDays)).toEqual([1]);
    expect(listReminderRules(owner).find((item) => item.id === added)?.activeSince).toBe(
      "2026-03-02",
    );
  });

  test("[REM-006] částečná platba nechá upomínku způsobilou se zapnutým přepínačem", async () => {
    const { owner, customerId } = reminding();
    rule(owner, 0);
    const id = sentInvoice(owner, customerId);
    addPayment(webActor(owner), id, {
      revision: getInvoice(owner, id)!.revision,
      paidOn: "2026-03-02",
      amountMinor: 100_000,
      currency: "CZK",
      method: "transfer",
      note: "",
    });
    expect(getInvoice(owner, id)!.status).toBe("partially_paid");

    await tickAt(DAY_ONE);
    expect(smtp.messages).toEqual([]);

    setPartialReminders(webActor(owner), id, true);
    await tickAt("2026-03-02T09:31:00Z");

    expect(smtp.messages).toHaveLength(1);
    expect(smtp.messages[0]!.body).toMatch(/Zbývá uhradit 2\s000,00\sKč/);
  });

  test("[REM-006] částečně uhrazený neodeslaný doklad upomínku nedostane", async () => {
    const { owner, customerId } = reminding();
    rule(owner, 0);
    const id = issuedInvoice(owner, customerId);
    setInvoice(id, { dueDate: "2026-03-02", remindersPartial: true });
    addPayment(webActor(owner), id, {
      revision: getInvoice(owner, id)!.revision,
      paidOn: "2026-03-02",
      amountMinor: 100_000,
      currency: "CZK",
      method: "transfer",
      note: "",
    });

    await tickAt("2026-03-05T09:30:00Z");

    expect(smtp.messages).toEqual([]);
    expect(remindersForReview(owner, "2026-03-05")).toEqual([]);
    expect(() => reminderPrefill(owner, id, null)).toThrow(TEXTS.reminders.errors.notSent);
    const prefill = sendPrefill(owner, id, undefined, { kind: "reminder", texts: null });
    expect(() =>
      sendManualReminder(webActor(owner), id, {
        ...prefill,
        stageKey: null,
        confirmedRepeat: false,
      }),
    ).toThrow(TEXTS.reminders.errors.notSent);
  });

  test("[REM-006] částečná úhrada bez {{zbyva}} v rozhodujícím textu dostane výchozí text", async () => {
    const { owner, customerId } = reminding();
    rule(owner, 0, { cs: { subject: "Prosím o platbu", body: "Prosím o platbu." } });
    const id = sentInvoice(owner, customerId);
    setInvoice(id, { status: "partially_paid", paidMinor: 100_000, remindersPartial: true });

    await tickAt(DAY_ONE);

    expect(smtp.messages[0]!.subject).toContain("Upomínka k faktuře");
    expect(smtp.messages[0]!.body).toMatch(/Zbývá uhradit 2\s000,00\sKč/);
  });

  test("[REM-006] vlastní text s {{zbyva}} zůstane a plná faktura vlastní text nemění", async () => {
    const { owner, customerId } = reminding();
    rule(owner, 0, { cs: { subject: "Doplatek", body: "Doplaťte {{zbyva}}." } });
    rule(owner, 1, { cs: { subject: "Platba", body: "Prosím o platbu." } });
    const id = sentInvoice(owner, customerId);
    setInvoice(id, { status: "partially_paid", paidMinor: 100_000, remindersPartial: true });
    sentInvoice(owner, customerId, "2026-03-01");

    await tickAt(DAY_ONE);

    expect(smtp.messages.map((mail) => mail.subject).sort()).toEqual(["Doplatek", "Platba"]);
  });

  test("oprava adresy odblokuje stupeň týž den a blokace se vyřeší i úhradou", async () => {
    const { owner } = reminding();
    const silent = seedCustomer(owner, "");
    rule(owner, 0);
    sentInvoice(owner, silent);
    const unpaid = seedCustomer(owner, "");
    const paidLater = sentInvoice(owner, unpaid);

    await tickAt(DAY_ONE);
    db.update(customer).set({ email: "nova@example.cz" }).where(eq(customer.id, silent)).run();
    await tickAt("2026-03-02T09:31:00Z");
    expect(smtp.messages).toHaveLength(1);

    setInvoice(paidLater, { status: "paid", paidMinor: 300_000 });
    await tickAt("2026-03-02T09:32:00Z");

    const left = noticesOf(owner).filter((row) => row.kind === "reminder_failed");
    expect(left).toHaveLength(2);
    expect(left.every((row) => row.resolvedAt !== null)).toBe(true);
  });

  test("chyba jedné faktury nezastaví další v účtu", async () => {
    const { owner, customerId } = reminding();
    rule(owner, 0);
    const broken = sentInvoice(owner, customerId);
    const healthy = sentInvoice(owner, customerId);
    db.$client.exec(`CREATE TRIGGER broken_invoice BEFORE INSERT ON email_log
      WHEN NEW.invoice_id = '${broken}' BEGIN SELECT RAISE(ABORT, 'porucha'); END`);
    try {
      planReminders(current);
    } finally {
      db.$client.exec("DROP TRIGGER broken_invoice");
    }

    expect(sentOf(owner).map((row) => row.invoiceId)).toEqual([healthy]);
  });

  test("[TST-005] upomínka zaplacená za letu neodejde a automatika ji neuvolní", async () => {
    const { owner, customerId } = reminding();
    rule(owner, 0);
    const paidLater = sentInvoice(owner, customerId);
    at(DAY_ONE);
    planReminders(current);
    setInvoice(paidLater, { status: "paid", paidMinor: 300_000 });

    await drainJobs("w");

    expect(smtp.messages).toEqual([]);
    expect(logsOf(owner)[0]).toMatchObject({
      status: "held",
      reason: TEXTS.reminders.held,
    });
  });

  test("odklad a vypnutí zastaví i zprávu, která čeká ve frontě", async () => {
    const { owner, customerId } = reminding();
    rule(owner, 0);
    const snoozed = sentInvoice(owner, customerId);
    const off = sentInvoice(owner, customerId);
    planReminders(current);
    snoozeReminders(webActor(owner), snoozed, "2026-03-10");
    setRemindersOff(webActor(owner), off, true);

    await drainJobs("w");

    expect(smtp.messages).toEqual([]);
    expect(logsOf(owner).map((row) => row.status)).toEqual(["held", "held"]);
  });

  test("[ARC-007] upomínka jde přes frontu s klíčem faktury a stupně", () => {
    const { owner, customerId } = reminding();
    rule(owner, 0);
    const id = sentInvoice(owner, customerId);

    planReminders(current);

    const rows = db.select().from(job).where(eq(job.userId, owner)).all();
    expect(rows.map((row) => row.key)).toEqual([`reminder:${id}:0`]);
    expect(rows[0]!.kind).toBe("mail.send");
    expect(Object.keys(rows[0]!.payload)).toEqual(["logId"]);
  });

  test("běžící zpráva stupeň nespotřebuje a doručí se později", async () => {
    const { owner, customerId } = reminding();
    rule(owner, 0);
    const id = sentInvoice(owner, customerId);
    mutate(webActor(owner), "invoice.send", (tx, audit) =>
      queueMail(tx, audit, {
        userId: owner,
        invoiceId: id,
        kind: "reminder",
        trigger: "manual",
        key: "obsazeno",
        message: { to: ["a@b.cz"], cc: [], bcc: [], subject: "S", body: "T" },
      }),
    );

    planReminders(current);
    expect(sentOf(owner)).toEqual([]);

    await drainJobs("w");
    await tickAt("2026-03-02T09:31:00Z");
    expect(sentOf(owner)).toHaveLength(1);
  });
});

describe("souběh", () => {
  const dir = mkdtempSync(join(tmpdir(), "fakturan-reminder-race-"));
  const databasePath = join(dir, "race.db");
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("[REM-007] 8 souběžných ticků pošle stupeň jednou", async () => {
    const { owner, customerId } = reminding();
    const stage = rule(owner, 0);
    const id = sentInvoice(owner, customerId);
    db.$client.exec(`VACUUM INTO '${databasePath}'`);

    await runJobWorkers(
      Array.from({ length: 8 }, (_, i) => ({
        mode: "reminders",
        worker: `r${i}`,
        now: current.getTime(),
      })),
      databasePath,
    );

    const shared = createDb(databasePath);
    runMigrations(shared);
    const log = shared.select().from(emailLog).where(eq(emailLog.invoiceId, id)).all();
    const sent = shared.select().from(reminderSent).where(eq(reminderSent.invoiceId, id)).all();
    const jobs = shared.select().from(job).where(eq(job.userId, owner)).all();
    shared.$client.close();
    expect(log).toHaveLength(1);
    expect(sent).toMatchObject([{ stageKey: stage, trigger: "automatic" }]);
    expect(jobs).toHaveLength(1);
  }, 60_000);

  test("[REM-007] druhý den se odeslaný stupeň neopakuje", async () => {
    const { owner, customerId } = reminding();
    rule(owner, 0);
    sentInvoice(owner, customerId);

    await tickAt(DAY_ONE);
    await tickAt("2026-03-03T09:30:00Z");

    expect(smtp.messages).toHaveLength(1);
  });

  test("[REM-007] konflikt v reminder_sent vrátí i zařazenou zprávu", async () => {
    const { owner, customerId } = reminding();
    const stage = rule(owner, 0);
    const id = sentInvoice(owner, customerId);
    db.$client.exec(
      `CREATE TRIGGER race_stage BEFORE INSERT ON email_log BEGIN
         INSERT INTO reminder_sent (id, user_id, invoice_id, stage_key, offset_days, trigger, created_at)
         VALUES ('race', NEW.user_id, NEW.invoice_id, '${stage}', 0, 'automatic', 0);
       END`,
    );
    try {
      planReminders(current);
    } finally {
      db.$client.exec("DROP TRIGGER race_stage");
    }

    expect(logsOf(owner)).toEqual([]);
    expect(sentOf(owner)).toEqual([]);
    expect(db.select().from(job).where(eq(job.userId, owner)).all()).toEqual([]);
    expect(getInvoice(owner, id)).not.toBeNull();
  });
});

describe("ruční upomínka", () => {
  test("[REM-003] vystavenou neodeslanou odmítne s vysvětlením", () => {
    const { owner, customerId } = account();
    const id = issuedInvoice(owner, customerId);

    expect(() => manual(owner, id, null)).toThrow(TEXTS.reminders.errors.notSent);
  });

  test("[REM-003] stav dokladu nezmění a hlavní vypínač ji neblokuje", async () => {
    const { owner, customerId } = account();
    const id = sentInvoice(owner, customerId);
    setPaused(webActor(owner), true, { confirmed: false });

    manual(owner, id, null);
    await drainJobs("w");

    expect(smtp.messages).toHaveLength(1);
    expect(getInvoice(owner, id)!.status).toBe("sent");
    expect(sentOf(owner)).toMatchObject([
      { stageKey: MANUAL_STAGE, offsetDays: null, trigger: "manual" },
    ]);
    const audits = db.select().from(auditLog).where(eq(auditLog.ownerId, owner)).all();
    expect(audits.find((row) => row.action === "reminder.manual")?.after).toMatchObject({
      stageKey: null,
      confirmedRepeat: false,
    });
    expect(sendPrefill(owner, id).subject).toContain("Faktura");
  });

  test("[REM-003] zaplacený doklad ruční upomínku odmítne", () => {
    const { owner, customerId } = account();
    const id = sentInvoice(owner, customerId);
    setInvoice(id, { status: "paid", paidMinor: 300_000 });

    expect(() => reminderPrefill(owner, id, null)).toThrow(TEXTS.reminders.errors.nothingDue);
  });

  test("[REM-003] opakování vyžaduje potvrzení a automatika stupeň přeskočí", async () => {
    const { owner, customerId } = reminding();
    const stage = rule(owner, 0, { cs: { subject: "Vlastní", body: "Zbývá {{zbyva}}" } });
    const id = sentInvoice(owner, customerId);

    expect(reminderPrefill(owner, id, stage)).toMatchObject({ subject: "Vlastní", repeat: false });
    manual(owner, id, stage);
    await drainJobs("w");

    expect(reminderPrefill(owner, id, stage).repeat).toBe(true);
    expect(() => manual(owner, id, stage)).toThrow(TEXTS.reminders.errors.confirmRepeat);
    expect(logsOf(owner)).toHaveLength(1);

    await tickAt("2026-03-02T09:31:00Z");
    expect(smtp.messages).toHaveLength(1);

    manual(owner, id, stage, true);
    await drainJobs("w");
    expect(smtp.messages).toHaveLength(2);
    expect(sentOf(owner)).toHaveLength(2);
  });

  test("[REM-006] zpráva po úhradě za letu neodejde ani ručně", async () => {
    const { owner, customerId } = account();
    const id = sentInvoice(owner, customerId);
    manual(owner, id, null);
    setInvoice(id, { status: "paid", paidMinor: 300_000 });

    await drainJobs("w");

    expect(smtp.messages).toEqual([]);
    expect(logsOf(owner)[0]!.status).toBe("held");
  });
});

describe("zpráva, která přestala platit", () => {
  test("[REM-006] upomínka zaplacená s novou revizí skončí held bez upozornění", async () => {
    const { owner, customerId } = account();
    const id = sentInvoice(owner, customerId);
    manual(owner, id, null);
    setInvoice(id, { status: "paid", paidMinor: 300_000, revision: 99 });

    await drainJobs("w");

    expect(smtp.messages).toEqual([]);
    expect(logsOf(owner)[0]).toMatchObject({ status: "held", reason: TEXTS.reminders.held });
    expect(noticesOf(owner)).toEqual([]);
  });

  test("refreshBalance zvýší revision a upomínka ve frontě se zadrží", async () => {
    const { owner, customerId } = account();
    const id = sentInvoice(owner, customerId);
    manual(owner, id, null);
    const { revision } = getInvoice(owner, id)!;
    seedCreditNote(db, id, -100_000);
    mutate(webActor(owner), "invoice.balance", (tx, audit) => refreshBalance(tx, audit, owner, id));

    expect(getInvoice(owner, id)!.revision).toBe(revision + 1);
    await drainJobs("w");

    expect(smtp.messages).toEqual([]);
    expect(logsOf(owner)[0]).toMatchObject({
      status: "held",
      reason: TEXTS.invoiceMail.reasons.revision,
    });
  });

  test("upomínka ve frontě se po platbě zadrží a SMTP nic nedostane", async () => {
    const { owner, customerId } = account();
    const id = sentInvoice(owner, customerId);
    manual(owner, id, null);
    markPaid(webActor(owner), id, { revision: getInvoice(owner, id)!.revision });

    await drainJobs("w");

    expect(smtp.messages).toEqual([]);
    expect(logsOf(owner)[0]).toMatchObject({ status: "held", reason: TEXTS.reminders.held });
    expect(noticesOf(owner)).toEqual([]);
  });

  test("[REM-003] odeslání jiného stupně nevyřeší unknown, stejný stupeň ano", async () => {
    const { owner, customerId } = account();
    const first = rule(owner, 1);
    const second = rule(owner, 5);
    const id = sentInvoice(owner, customerId);
    smtp.dropDuringData();
    manual(owner, id, first);
    await drainJobs("w");
    const open = () => noticesOf(owner).filter((row) => row.resolvedAt === null);
    expect(open().map((row) => row.kind)).toEqual(["mail_unknown"]);

    const again = (stageKey: string, confirmedRepeat: boolean) => {
      const { to, cc, bcc, subject, body, requestId, revision } = reminderPrefill(
        owner,
        id,
        stageKey,
      );
      sendManualReminder(webActor(owner), id, {
        to,
        cc,
        bcc,
        subject,
        body,
        requestId,
        revision,
        stageKey,
        confirmedRepeat,
        confirmedUnknown: true,
      });
    };

    again(second, false);
    await drainJobs("w");
    expect(open()).toHaveLength(1);

    again(first, true);
    await drainJobs("w");
    expect(open()).toEqual([]);
  });
});

describe("nastavení na faktuře", () => {
  test("koncept a storno změny upomínek odmítnou", () => {
    const { owner, customerId } = account();
    const cancelled = sentInvoice(owner, customerId);
    setInvoice(cancelled, { status: "cancelled" });
    const draft = sentInvoice(owner, customerId);
    setInvoice(draft, { status: "draft" });
    const actor = webActor(owner);
    const E = TEXTS.reminders.errors.notChangeable;

    for (const id of [cancelled, draft]) {
      expect(() => snoozeReminders(actor, id, "2026-03-05")).toThrow(E);
      expect(() => setRemindersOff(actor, id, true)).toThrow(E);
      expect(() => setPartialReminders(actor, id, true)).toThrow(E);
    }
  });
});

describe("pravidla", () => {
  test("[REM-002] stupeň s obsazeným počtem dnů je odmítnutý a úprava drží své ID", () => {
    const { owner } = account();
    const id = rule(owner, 5);
    rule(owner, 1);

    expect(() => rule(owner, 5)).toThrow(TEXTS.reminders.errors.duplicate);
    expect(saveReminderRule(webActor(owner), { id, offsetDays: 6, texts: null }).id).toBe(id);
    expect(listReminderRules(owner).map((row) => row.offsetDays)).toEqual([1, 6]);
    expect(() => saveReminderRule(webActor(owner), { id, offsetDays: 1, texts: null })).toThrow(
      TEXTS.reminders.errors.duplicate,
    );
  });

  test("[TST-009] izolace pravidel a upomínek včetně update a remove", async () => {
    const { owner: a } = account();
    const { owner: b } = account();
    await assertIsolated<string>({
      owners: [a, b],
      create: (owner) => rule(owner, Math.floor(Math.random() * 300) + 1),
      find: (owner, id) => listReminderRules(owner).find((row) => row.id === id),
      list: (owner) => listReminderRules(owner).map((row) => row.id),
      update: (owner, id) => {
        saveReminderRule(webActor(owner), { id, offsetDays: 301, texts: null });
        return 1;
      },
      remove: (owner, id) => {
        deleteReminderRule(webActor(owner), id);
        return 1;
      },
    });

    const mine = account();
    const stranger = account();
    const stage = rule(stranger.owner, 2);
    const id = sentInvoice(mine.owner, mine.customerId);
    const actor = webActor(stranger.owner);
    expect(() => snoozeReminders(actor, id, null)).toThrow();
    expect(() => setRemindersOff(actor, id, true)).toThrow();
    expect(() => setPartialReminders(actor, id, true)).toThrow();
    expect(() => reminderPrefill(stranger.owner, id, null)).toThrow();
    expect(() => reminderPrefill(mine.owner, id, stage)).toThrow(TEXTS.reminders.errors.notFound);
    expect(remindersForReview(stranger.owner, "2026-03-02")).toEqual([]);
    expect(getInvoice(mine.owner, id)!.remindersOff).toBe(false);
    expect(db.select().from(reminderRule).where(eq(reminderRule.id, stage)).get()).toBeDefined();
  });
});
