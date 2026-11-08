import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { ParsedNotice } from "@/lib/bank-notices/types";
import { formatMoney } from "@/lib/money";
import { notificationText } from "@/lib/notification-text";
import { TEXTS } from "@/lib/texts";
import { setClockForTests } from "@/server/clock";
import {
  auditLog,
  customer,
  emailLog,
  job,
  mailSettings,
  notification,
  payment,
} from "@/server/db/schema";
import { enqueue } from "@/server/jobs/queue";
import { registerJob } from "@/server/jobs/registry";
import { drainJobs } from "@/server/jobs/worker";
import { ServiceError } from "@/server/services/access";
import { setAutomation, setPaused } from "@/server/services/automation";
import {
  assignNotice,
  ingestNotice,
  splitNotice,
  undoNotice,
  type IngestInput,
} from "@/server/services/bank-notices";
import { saveEmailTemplate } from "@/server/services/email-templates";
import {
  listEmailLog,
  resendFromLog,
  sendPrefill,
  sendReceipt,
} from "@/server/services/invoice-mail";
import { getInvoice } from "@/server/services/invoices";
import { deliverMail, recoverMail } from "@/server/services/mail-delivery";
import {
  addPayment,
  deletePayment,
  markPaid,
  markPaidMany,
  updatePayment,
} from "@/server/services/payments";
import { assertConsistent } from "../helpers/consistency";
import { createTestDb } from "../helpers/db";
import { INVOICE_TOTAL, seedAccount, TARGET, VS } from "../helpers/fixtures-bank";
import { issuedInvoice, ownSmtp, webActor } from "../helpers/fixtures-mail";
import { startSmtp, type TestSmtp } from "../helpers/smtp";

vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-receipt-")));
vi.stubEnv("ALLOW_PRIVATE_MAIL_HOSTS", "true");
vi.stubEnv("SMTP_HOST", "");
vi.stubEnv("SMTP_PORT", "");
vi.stubEnv("SMTP_FROM", "");

const db = createTestDb();
const NOW = new Date("2026-11-01T10:00:00Z");
const TODAY = "2026-11-01";
const WORKER = "worker-receipt";
const CLIENT = "alfa@example.cz";
const ENABLED = { confirmed: true };
const R = TEXTS.invoiceMail.reasons;

const money = (minor: number) => formatMoney(minor, "CZK");

let smtp: TestSmtp;
let nextId = 1;

beforeAll(async () => {
  smtp = await startSmtp();
});
afterAll(() => smtp.stop());

beforeEach(() => {
  smtp.reset();
  db.delete(job).run();
  setClockForTests({ now: () => NOW });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  registerJob("mail.send", { run: deliverMail, recover: recoverMail });
});
afterEach(() => {
  setClockForTests(null);
  vi.restoreAllMocks();
});

const parsed = (over: Partial<ParsedNotice> = {}): ParsedNotice => ({
  variant: "cs",
  targetAccount: `${TARGET.number}/${TARGET.bankCode}`,
  amountMinor: INVOICE_TOTAL,
  currency: "CZK",
  occurredAt: { date: TODAY, time: "09:05" },
  variableSymbol: VS,
  constantSymbol: null,
  counterpartyAccount: null,
  counterpartyName: null,
  message: null,
  instructionId: `r-${nextId++}`,
  ...over,
});

const income = (notice: ParsedNotice, over: Partial<IngestInput> = {}): IngestInput =>
  ({
    bank: "fio",
    notice,
    text: "avizo",
    authResult: "pass",
    requireConfirmation: true,
    receivedAt: NOW,
    ...over,
  }) as IngestInput;

function account({ enabled = true }: { enabled?: boolean } = {}) {
  const seeded = seedAccount(db, NOW);
  ownSmtp(db, seeded.owner, smtp.port);
  if (enabled) setAutomation(webActor(seeded.owner), "paymentReceipt", true, ENABLED);
  return seeded;
}

function matched(owner: string, over: Partial<ParsedNotice> = {}) {
  const result = ingestNotice(owner, income(parsed(over)));
  if (result.status !== "matched") throw new Error(`nespárováno: ${result.status}`);
  return result;
}

function pendingNotice(owner: string, over: Partial<ParsedNotice> = {}): string {
  const result = ingestNotice(owner, income(parsed({ variableSymbol: "1", ...over })));
  if (result.status !== "pending") throw new Error(`mimo frontu: ${result.status}`);
  return result.id;
}

// Only the exact amount due matches on its own, a partial payment comes through the queue.
function partial(owner: string, invoiceId: string, amountMinor: number): string {
  const id = pendingNotice(owner, { amountMinor });
  assignNotice(webActor(owner), id, { invoiceId });
  return id;
}

const logsOf = (owner: string) =>
  db.select().from(emailLog).where(eq(emailLog.userId, owner)).all();
const noticesOf = (owner: string) =>
  db.select().from(notification).where(eq(notification.userId, owner)).all();
const paymentsOf = (owner: string) =>
  db.select().from(payment).where(eq(payment.userId, owner)).all();
const toClient = () => smtp.messages.filter((message) => message.to.includes(CLIENT));

const manualInput = (revision: number, amountMinor: number, over = {}) => ({
  revision,
  paidOn: TODAY,
  amountMinor,
  currency: "CZK" as const,
  creditedMinor: amountMinor,
  method: "transfer" as const,
  note: "",
  ...over,
});

const jobOf = (logId: string) =>
  db
    .select()
    .from(job)
    .all()
    .find((row) => row.payload.logId === logId)!;

// Stands for a first attempt that waited out the second payment.
function reenqueue(owner: string, logId: string): void {
  db.transaction((tx) =>
    enqueue(tx, {
      kind: "mail.send",
      key: `retest:${logId}`,
      userId: owner,
      payload: { logId },
      maxAttempts: 4,
    }),
  );
}

const revisionOf = (owner: string, invoiceId: string) => getInvoice(owner, invoiceId)!.revision;

const clickInput = (owner: string, invoiceId: string, requestId: string) => {
  const { to, cc, bcc, subject, body, revision } = sendPrefill(owner, invoiceId, undefined, {
    kind: "payment_receipt",
    paymentId: paymentsOf(owner)[0]!.id,
  });
  return { requestId, revision, to, cc, bcc, subject, body };
};

describe("automatické potvrzení", () => {
  test("[BNK-009] spárování bez zapnutého potvrzení nic neodešle", async () => {
    const { owner } = account({ enabled: false });

    matched(owner);
    await drainJobs(WORKER);

    expect(logsOf(owner)).toEqual([]);
    expect(smtp.connections()).toBe(0);
  });

  test("[BNK-009] se zapnutým potvrzením odejde jedna zpráva s přijatou částkou", async () => {
    const { owner, invoiceId } = account();
    ownSmtpCopies(owner);

    partial(owner, invoiceId, 100_000);
    const [log] = logsOf(owner);
    const before = getInvoice(owner, invoiceId)!;
    expect(log).toMatchObject({
      kind: "payment_receipt",
      trigger: "automatic",
      automation: "paymentReceipt",
      plannedFor: TODAY,
      paymentId: paymentsOf(owner)[0]!.id,
      invoiceRevision: before.revision,
      cc: ["kopie@example.cz"],
      bcc: ["skryta@example.cz"],
    });
    const [queued] = db.select().from(job).where(eq(job.userId, owner)).all();
    expect(queued!.key).toBe(`mail:receipt:${paymentsOf(owner)[0]!.id}`);

    await drainJobs(WORKER);

    expect(toClient()).toHaveLength(1);
    expect(logsOf(owner)[0]).toMatchObject({ status: "sent" });
    expect(logsOf(owner)[0]!.body).toContain(money(100_000));
    expect(logsOf(owner)[0]!.body).not.toContain("{{");
    assertConsistent(db, owner);
  });

  function ownSmtpCopies(owner: string) {
    db.update(mailSettings)
      .set({ cc: ["kopie@example.cz"], bcc: ["skryta@example.cz"] })
      .where(eq(mailSettings.userId, owner))
      .run();
  }

  test("[BNK-009] hlavní vypínač potvrzení zastaví a po uvolnění se samo neodešle", async () => {
    const { owner } = account();
    setPaused(webActor(owner), true, { confirmed: false });

    matched(owner);
    await drainJobs(WORKER);
    expect(logsOf(owner)).toEqual([]);

    setPaused(webActor(owner), false, ENABLED);
    await drainJobs(WORKER);
    expect(logsOf(owner)).toEqual([]);
    expect(smtp.connections()).toBe(0);
  });

  test("[BNK-009] pozastavení po zařazení zprávu zadrží před SMTP", async () => {
    const { owner } = account();
    matched(owner);
    setPaused(webActor(owner), true, { confirmed: false });

    await drainJobs(WORKER);

    expect(logsOf(owner)[0]).toMatchObject({ status: "held", reason: R.automation });
    expect(smtp.connections()).toBe(0);
  });

  test("přiřazení z fronty založí potvrzení s novou revizí", async () => {
    const { owner, invoiceId } = account();
    const id = pendingNotice(owner);

    assignNotice(webActor(owner), id, { invoiceId });

    expect(logsOf(owner)).toMatchObject([
      { kind: "payment_receipt", invoiceRevision: getInvoice(owner, invoiceId)!.revision },
    ]);
  });

  test("rozdělení založí jedno potvrzení za doklad, u téhož dokladu se součtem", () => {
    const { owner, invoiceId, customerId } = account();
    const other = issuedInvoice(owner, customerId);
    const id = pendingNotice(owner);

    splitNotice(webActor(owner), id, {
      parts: [
        { invoiceId, amountMinor: 100_000 },
        { invoiceId, amountMinor: 50_000 },
        { invoiceId: other, amountMinor: INVOICE_TOTAL - 150_000 },
      ],
    });

    const logs = logsOf(owner);
    expect(logs.map((log) => log.invoiceId).sort()).toEqual([invoiceId, other].sort());
    expect(logs.find((log) => log.invoiceId === invoiceId)!.body).toContain(money(150_000));
  });

  test("avízo staré 4 dny potvrzení nezaloží", () => {
    const { owner } = account();

    matched(owner, { occurredAt: { date: "2026-10-28", time: "09:00" } });

    expect(logsOf(owner)).toEqual([]);
    expect(noticesOf(owner)).toEqual([]);
  });

  test("avízo staré 3 dny potvrzení založí", () => {
    const { owner } = account();

    matched(owner, { occurredAt: { date: "2026-10-29", time: "09:00" } });

    expect(logsOf(owner)).toHaveLength(1);
  });

  test("staré datum zastaví i zákazníka bez adresy, a to bez upozornění", () => {
    const { owner, customerId } = account();
    db.update(customer).set({ email: "" }).where(eq(customer.id, customerId)).run();

    matched(owner, { occurredAt: { date: "2026-10-28", time: "09:00" } });

    expect(noticesOf(owner)).toEqual([]);
  });

  test("zákazník bez adresy založí upozornění", () => {
    const { owner, customerId, invoiceId } = account();
    db.update(customer).set({ email: "" }).where(eq(customer.id, customerId)).run();

    matched(owner);

    expect(logsOf(owner)).toEqual([]);
    expect(paymentsOf(owner)).toHaveLength(1);
    const [notice] = noticesOf(owner);
    expect(notice).toMatchObject({ kind: "receipt_no_address" });
    expect(notificationText("receipt_no_address", notice!.params)).toContain(
      getInvoice(owner, invoiceId)!.number,
    );
  });

  test("zpráva, kterou nejde odeslat, platbu nezruší a založí upozornění", () => {
    const { owner } = account();
    db.update(mailSettings)
      .set({ cc: Array.from({ length: 20 }, (_, i) => `k${i}@example.cz`) })
      .where(eq(mailSettings.userId, owner))
      .run();

    matched(owner);

    expect(logsOf(owner)).toEqual([]);
    expect(paymentsOf(owner)).toHaveLength(1);
    expect(noticesOf(owner)).toMatchObject([{ kind: "receipt_bad_mail" }]);
  });

  test("opakované čtení téhož avíza nezaloží druhé potvrzení", () => {
    const { owner } = account();
    const notice = parsed();

    ingestNotice(owner, income(notice));
    ingestNotice(owner, income(notice));

    expect(logsOf(owner)).toHaveLength(1);
  });

  test("ruční platba a hromadné označení nic neodešlou", async () => {
    const { owner, invoiceId, customerId } = account();
    const other = issuedInvoice(owner, customerId);
    const actor = webActor(owner);

    addPayment(actor, invoiceId, {
      paidOn: TODAY,
      amountMinor: 100,
      currency: "CZK",
      creditedMinor: 100,
      method: "transfer",
      note: "",
      revision: getInvoice(owner, invoiceId)!.revision,
    });
    markPaid(actor, invoiceId, { revision: getInvoice(owner, invoiceId)!.revision });
    markPaidMany(actor, [other]);
    await drainJobs(WORKER);

    expect(logsOf(owner)).toEqual([]);
    expect(smtp.connections()).toBe(0);
  });
});

describe("souběh a vrácení", () => {
  test("dvě rychlé platby dají dvě potvrzení a druhá první nezadrží", async () => {
    const { owner, invoiceId } = account();

    partial(owner, invoiceId, 100_000);
    partial(owner, invoiceId, 50_000);

    const logs = logsOf(owner);
    expect(logs).toHaveLength(2);
    expect(new Set(logs.map((log) => log.paymentId)).size).toBe(2);
    expect(logs[0]!.invoiceRevision).toBeLessThan(getInvoice(owner, invoiceId)!.revision);

    await drainJobs(WORKER);

    expect(logsOf(owner).map((log) => log.status)).toEqual(["sent", "sent"]);
    expect(toClient()).toHaveLength(2);
    expect(noticesOf(owner).map((row) => row.kind)).toEqual([]);
    assertConsistent(db, owner);
  });

  test("vrácení avíza zadrží potvrzení ve frontě", async () => {
    const { owner, invoiceId } = account();
    const id = partial(owner, invoiceId, 100_000);
    const first = logsOf(owner)[0]!;

    undoNotice(webActor(owner), id);
    await drainJobs(WORKER);

    expect(logsOf(owner)[0]).toMatchObject({ status: "held", reason: R.paymentGone });
    expect(smtp.connections()).toBe(0);
    const [row] = listEmailLog(owner, invoiceId);
    expect(row).toMatchObject({ id: first.id, resendable: false });
    expect(() => sendPrefill(owner, invoiceId, first.id)).toThrow(ServiceError);
    expect(() =>
      resendFromLog(webActor(owner), first.id, {
        confirmedUnknown: false,
        requestId: "55555555-5555-4555-8555-555555555555",
      }),
    ).toThrow(ServiceError);
  });

  test("vrácení jednoho avíza nezadrží potvrzení druhé platby a text je stejný", async () => {
    const { owner, invoiceId } = account();
    const id = partial(owner, invoiceId, 100_000);
    partial(owner, invoiceId, 100_000);

    undoNotice(webActor(owner), id);
    await drainJobs(WORKER);

    const [undone, kept] = logsOf(owner);
    expect(undone).toMatchObject({ status: "held", reason: R.paymentGone });
    expect(kept).toMatchObject({ status: "sent", body: undone!.body, subject: undone!.subject });
  });

  test("po vrácení a novém přiřazení odejde stejný text jako původní", async () => {
    const { owner, invoiceId } = account();
    const id = partial(owner, invoiceId, 100_000);
    undoNotice(webActor(owner), id);
    await drainJobs(WORKER);

    assignNotice(webActor(owner), id, { invoiceId });
    await drainJobs(WORKER);

    const [held, sent] = logsOf(owner);
    expect(held).toMatchObject({ status: "held" });
    expect(sent).toMatchObject({ status: "sent", subject: held!.subject, body: held!.body });
    expect(sent!.paymentId).not.toBe(held!.paymentId);
  });

  describe("úprava platby s potvrzením ve frontě", () => {
    function queued() {
      const { owner, invoiceId } = account({ enabled: false });
      const actor = webActor(owner);
      const { id } = addPayment(
        actor,
        invoiceId,
        manualInput(revisionOf(owner, invoiceId), 100_000),
      );
      sendReceipt(
        actor,
        invoiceId,
        id,
        clickInput(owner, invoiceId, "77777777-7777-4777-8777-777777777777"),
      );
      return { owner, invoiceId, id, actor };
    }

    test("změna částky zadrží potvrzení tiše", async () => {
      const { owner, invoiceId, id, actor } = queued();

      updatePayment(actor, id, manualInput(revisionOf(owner, invoiceId), 120_000));
      await drainJobs(WORKER);

      expect(smtp.connections()).toBe(0);
      expect(logsOf(owner)[0]).toMatchObject({ status: "held", reason: R.paymentChanged });
      expect(noticesOf(owner)).toEqual([]);
      const audited = db.select().from(auditLog).where(eq(auditLog.action, "mail.held")).all();
      expect(audited.filter((row) => row.ownerId === owner)).toHaveLength(1);
      assertConsistent(db, owner);
    });

    test("změna data zadrží potvrzení, poznámka ne", async () => {
      const { owner, invoiceId, id, actor } = queued();

      updatePayment(
        actor,
        id,
        manualInput(revisionOf(owner, invoiceId), 100_000, { note: "jen poznámka" }),
      );
      expect(logsOf(owner)[0]).toMatchObject({ status: "queued" });

      updatePayment(
        actor,
        id,
        manualInput(revisionOf(owner, invoiceId), 100_000, { paidOn: "2026-10-31" }),
      );
      await drainJobs(WORKER);
      expect(smtp.connections()).toBe(0);
      expect(logsOf(owner)[0]).toMatchObject({ status: "held", reason: R.paymentChanged });
    });

    test("odeslané potvrzení úprava nezmění a jiné platby se nedotkne", async () => {
      const { owner, invoiceId, id, actor } = queued();
      await drainJobs(WORKER);
      expect(logsOf(owner)[0]).toMatchObject({ status: "sent" });

      updatePayment(actor, id, manualInput(revisionOf(owner, invoiceId), 120_000));
      expect(logsOf(owner)[0]).toMatchObject({ status: "sent" });
    });

    test("zadržené potvrzení jde poslat znovu s novou částkou", async () => {
      const { owner, invoiceId, id, actor } = queued();
      updatePayment(actor, id, manualInput(revisionOf(owner, invoiceId), 120_000));
      await drainJobs(WORKER);

      sendReceipt(
        actor,
        invoiceId,
        id,
        clickInput(owner, invoiceId, "88888888-8888-4888-8888-888888888888"),
      );
      await drainJobs(WORKER);

      expect(toClient()).toHaveLength(1);
      expect(toClient()[0]!.body).toContain(money(120_000));
    });
  });

  test("smazání ruční platby zadrží její ruční potvrzení se stejným důvodem", async () => {
    const { owner, invoiceId } = account({ enabled: false });
    const actor = webActor(owner);
    const { id } = markPaid(actor, invoiceId, {
      revision: getInvoice(owner, invoiceId)!.revision,
    });
    sendReceipt(
      actor,
      invoiceId,
      id,
      clickInput(owner, invoiceId, "66666666-6666-4666-8666-666666666666"),
    );
    deletePayment(actor, id, getInvoice(owner, invoiceId)!.revision);

    await drainJobs(WORKER);

    expect(logsOf(owner)[0]).toMatchObject({ status: "held", reason: R.paymentGone });
    expect(smtp.connections()).toBe(0);
  });

  test("selhání jednoho potvrzení nevyřeší odeslání potvrzení jiné platby", async () => {
    const { owner, invoiceId } = account();
    partial(owner, invoiceId, 100_000);
    const firstRow = logsOf(owner)[0]!;
    db.update(emailLog).set({ status: "failed" }).where(eq(emailLog.id, firstRow.id)).run();
    db.delete(job).where(eq(job.userId, owner)).run();

    partial(owner, invoiceId, 50_000);
    await drainJobs(WORKER);

    const rows = listEmailLog(owner, invoiceId);
    expect(rows.find((row) => row.id === firstRow.id)).toMatchObject({ resendable: true });
    expect(sendPrefill(owner, invoiceId, firstRow.id).log).toMatchObject({ current: true });

    resendFromLog(webActor(owner), firstRow.id, {
      confirmedUnknown: false,
      requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    await drainJobs(WORKER);

    expect(logsOf(owner).filter((log) => log.paymentId === firstRow.paymentId)).toMatchObject([
      { status: "failed" },
      { status: "sent", trigger: "manual" },
    ]);
  });

  test("potvrzení na vystavenou fakturu nenastaví sent_at", async () => {
    const { owner, invoiceId } = account();

    partial(owner, invoiceId, 100_000);
    await drainJobs(WORKER);

    expect(logsOf(owner)[0]).toMatchObject({ status: "sent" });
    expect(getInvoice(owner, invoiceId)).toMatchObject({ sentAt: null });
  });
});

describe("[BNK-009] opakované odeslání po změně platby", () => {
  const REQUEST = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  async function deliveredWithStatus(status: "failed" | "unknown") {
    const { owner, invoiceId } = account({ enabled: false });
    const actor = webActor(owner);
    const { id } = addPayment(actor, invoiceId, manualInput(revisionOf(owner, invoiceId), 100_000));
    sendReceipt(
      actor,
      invoiceId,
      id,
      clickInput(owner, invoiceId, "cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
    );
    db.update(emailLog).set({ status, reason: "x" }).where(eq(emailLog.userId, owner)).run();
    db.delete(job).where(eq(job.userId, owner)).run();
    return { owner, invoiceId, id, actor, logId: logsOf(owner)[0]!.id };
  }

  test.each(["failed", "unknown"] as const)(
    "%s po změně částky nepošle starý text a nový jde přes sendReceipt",
    async (status) => {
      const { owner, invoiceId, id, actor, logId } = await deliveredWithStatus(status);
      updatePayment(actor, id, manualInput(revisionOf(owner, invoiceId), 120_000));

      const draft = sendPrefill(owner, invoiceId, logId);
      expect(draft.log).toMatchObject({ current: false, paymentId: id });
      expect(draft.body).toContain(money(120_000));
      expect(() =>
        resendFromLog(actor, logId, { confirmedUnknown: true, requestId: REQUEST }),
      ).toThrow(TEXTS.invoiceMail.errors.staleDraft);

      const { to, cc, bcc, subject, body, revision, requestId } = draft;
      sendReceipt(actor, invoiceId, id, {
        requestId,
        revision,
        logId,
        to,
        cc,
        bcc,
        subject,
        body,
        confirmedUnknown: true,
      });
      await drainJobs(WORKER);

      expect(toClient()).toHaveLength(1);
      expect(toClient()[0]!.body).toContain(money(120_000));
      expect(toClient()[0]!.body).not.toContain(money(100_000));
    },
  );

  test("změna data se počítá také", async () => {
    const { owner, invoiceId, id, actor, logId } = await deliveredWithStatus("failed");
    updatePayment(
      actor,
      id,
      manualInput(revisionOf(owner, invoiceId), 100_000, { paidOn: "2026-10-31" }),
    );
    expect(sendPrefill(owner, invoiceId, logId).log).toMatchObject({ current: false });
  });

  test("změna připsané částky cizí měny zadrží potvrzení a text se přepíše", async () => {
    const { owner, invoiceId } = account({ enabled: false });
    const actor = webActor(owner);
    const foreign = { currency: "EUR" as const, creditedMinor: 25_000 };
    const { id } = addPayment(
      actor,
      invoiceId,
      manualInput(revisionOf(owner, invoiceId), 1_000, foreign),
    );
    sendReceipt(
      actor,
      invoiceId,
      id,
      clickInput(owner, invoiceId, "dddddddd-dddd-4ddd-8ddd-dddddddddddd"),
    );

    updatePayment(
      actor,
      id,
      manualInput(revisionOf(owner, invoiceId), 1_000, { ...foreign, creditedMinor: 26_000 }),
    );

    expect(logsOf(owner)[0]).toMatchObject({ status: "held", reason: R.paymentChanged });
    expect(sendPrefill(owner, invoiceId, logsOf(owner)[0]!.id).body).toContain(money(26_000));
  });

  test("záznam bez otisku se bere jako změněný", async () => {
    const { owner, invoiceId, logId } = await deliveredWithStatus("failed");
    db.update(emailLog).set({ receiptPrint: null }).where(eq(emailLog.id, logId)).run();
    expect(sendPrefill(owner, invoiceId, logId).log).toMatchObject({ current: false });
  });

  test("beze změny se pošle uložený text", async () => {
    const { owner, invoiceId, actor, logId } = await deliveredWithStatus("failed");
    expect(sendPrefill(owner, invoiceId, logId).log).toMatchObject({ current: true });
    resendFromLog(actor, logId, { confirmedUnknown: false, requestId: REQUEST });
    await drainJobs(WORKER);
    expect(toClient()).toHaveLength(1);
  });

  test("cizí záznam přes sendReceipt nejde nahradit", async () => {
    const { owner, invoiceId, actor, logId } = await deliveredWithStatus("failed");
    const other = addPayment(actor, invoiceId, manualInput(revisionOf(owner, invoiceId), 1_000));
    expect(() =>
      sendReceipt(actor, invoiceId, other.id, {
        ...clickInput(owner, invoiceId, REQUEST),
        logId,
      }),
    ).toThrow(TEXTS.invoiceMail.errors.logNotFound);
  });
});

describe("[BNK-009] {{zbyva}} v potvrzení", () => {
  const withRest = (owner: string) =>
    saveEmailTemplate(webActor(owner), {
      kind: "payment_receipt",
      language: "cs",
      subject: "Potvrzení",
      body: "Přijato {{prijato}}, zbývá {{zbyva}}.",
    });

  test("další platba zadrží potvrzení, které uvádí zbytek, a nový text ho přepočítá", async () => {
    const { owner, invoiceId } = account();
    withRest(owner);
    partial(owner, invoiceId, 100_000);
    const first = logsOf(owner)[0]!;

    db.delete(job)
      .where(eq(job.id, jobOf(first.id).id))
      .run();
    partial(owner, invoiceId, 50_000);
    await drainJobs(WORKER);
    reenqueue(owner, first.id);
    await drainJobs(WORKER);

    expect(logsOf(owner).find((log) => log.id === first.id)).toMatchObject({
      status: "held",
      reason: R.paymentChanged,
    });
    expect(noticesOf(owner)).toMatchObject([{ kind: "mail_held" }]);
    const due = INVOICE_TOTAL - 150_000;
    expect(sendPrefill(owner, invoiceId, first.id)).toMatchObject({
      log: { current: false },
      body: expect.stringContaining(money(due)),
    });
  });
});

describe("[BNK-009] upozornění na neodeslané potvrzení", () => {
  function noAddress() {
    const seeded = account();
    db.update(customer).set({ email: "" }).where(eq(customer.id, seeded.customerId)).run();
    const { id } = matched(seeded.owner);
    db.update(customer).set({ email: CLIENT }).where(eq(customer.id, seeded.customerId)).run();
    return { ...seeded, noticeId: id };
  }

  test("odeslané potvrzení upozornění vyřeší", async () => {
    const { owner, invoiceId } = noAddress();
    const paymentId = paymentsOf(owner)[0]!.id;
    sendReceipt(
      webActor(owner),
      invoiceId,
      paymentId,
      clickInput(owner, invoiceId, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"),
    );
    await drainJobs(WORKER);

    expect(toClient()).toHaveLength(1);
    expect(noticesOf(owner)[0]!.resolvedAt).not.toBeNull();
  });

  test("vrácení avíza upozornění vyřeší", () => {
    const { owner, noticeId } = noAddress();
    undoNotice(webActor(owner), noticeId);
    expect(noticesOf(owner)[0]!.resolvedAt).not.toBeNull();
  });
});

describe("ruční potvrzení", () => {
  test("předvyplní text s přijatou částkou a odejde jen po kliknutí", async () => {
    const { owner, invoiceId } = account({ enabled: false });
    setPaused(webActor(owner), true, { confirmed: false });
    const { id } = markPaid(webActor(owner), invoiceId, {
      revision: getInvoice(owner, invoiceId)!.revision,
    });
    await drainJobs(WORKER);
    expect(logsOf(owner)).toEqual([]);

    const input = clickInput(owner, invoiceId, "77777777-7777-4777-8777-777777777777");
    expect(input.body).toContain(money(300_000));
    sendReceipt(webActor(owner), invoiceId, id, input);
    await drainJobs(WORKER);

    expect(logsOf(owner)).toMatchObject([
      { kind: "payment_receipt", trigger: "manual", paymentId: id, status: "sent" },
    ]);
    expect(toClient()).toHaveLength(1);
  });

  test("odmítne platbu jiného dokladu i uzavřený rozdíl", () => {
    const { owner, invoiceId, customerId } = account({ enabled: false });
    const other = issuedInvoice(owner, customerId);
    const { id } = markPaid(webActor(owner), invoiceId, {
      revision: getInvoice(owner, invoiceId)!.revision,
    });

    expect(() =>
      sendPrefill(owner, other, undefined, { kind: "payment_receipt", paymentId: id }),
    ).toThrow(ServiceError);
    expect(() =>
      sendReceipt(webActor(owner), other, id, {
        ...clickInput(owner, invoiceId, "88888888-8888-4888-8888-888888888888"),
        revision: getInvoice(owner, other)!.revision,
      }),
    ).toThrow(ServiceError);
    expect(logsOf(owner)).toEqual([]);
  });

  test("uložená vlastní šablona platí a {{prijato}} se v ní doplní", () => {
    const { owner, invoiceId } = account();
    saveEmailTemplate(webActor(owner), {
      kind: "payment_receipt",
      language: "cs",
      subject: "Díky",
      body: "Přišlo {{prijato}}, zbývá {{zbyva}}.",
    });

    partial(owner, invoiceId, 100_000);

    expect(logsOf(owner)[0]).toMatchObject({ subject: "Díky" });
    expect(logsOf(owner)[0]!.body).toContain(`Přišlo ${money(100_000)}`);
    expect(logsOf(owner)[0]!.body).toContain(`zbývá ${money(200_000)}`);
    expect(getInvoice(owner, invoiceId)!.paidMinor).toBe(100_000);
  });
});
