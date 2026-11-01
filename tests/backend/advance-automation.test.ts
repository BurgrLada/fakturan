import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { ParsedNotice } from "@/lib/bank-notices/types";
import { DEFAULT_PREFERENCES, type Preferences } from "@/lib/preferences";
import { formatMoney } from "@/lib/money";
import { notificationText } from "@/lib/notification-text";
import { amountDue } from "@/lib/qr-payload";
import { setClockForTests } from "@/server/clock";
import {
  auditLog,
  customer,
  emailLog,
  exchangeRate,
  invoice,
  job,
  notification,
  payment,
  supplier,
} from "@/server/db/schema";
import { registerJob } from "@/server/jobs/registry";
import { drainJobs } from "@/server/jobs/worker";
import { convertAdvance } from "@/server/services/advances";
import { setAutomation, setPaused } from "@/server/services/automation";
import {
  assignNotice,
  ingestNotice,
  undoNotice,
  type IngestInput,
} from "@/server/services/bank-notices";
import { finalOf } from "@/server/services/invoice-balance";
import { cancelInvoice, issueInvoice, restoreInvoice } from "@/server/services/invoice-lifecycle";
import { sendPrefill } from "@/server/services/invoice-mail";
import { createCreditNote } from "@/server/services/credit-notes";
import { deleteDraft, getInvoice, listInvoices, saveDraft } from "@/server/services/invoices";
import { deliverMail, recoverMail } from "@/server/services/mail-delivery";
import {
  addPayment,
  addRefund,
  closeDifference,
  deletePayment,
  listPayments,
  updatePayment,
} from "@/server/services/payments";
import { getPreferences, savePreferences } from "@/server/services/preferences";
import { assertConsistent } from "../helpers/consistency";
import { createTestDb } from "../helpers/db";
import { seedBankAccount, TARGET, VS } from "../helpers/fixtures-bank";
import {
  issuedAdvance,
  ownSmtp,
  seedCustomer,
  seedOwner,
  webActor,
} from "../helpers/fixtures-mail";
import { startSmtp, type TestSmtp } from "../helpers/smtp";

vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-advance-automation-")));
vi.stubEnv("ALLOW_PRIVATE_MAIL_HOSTS", "true");
vi.stubEnv("SMTP_HOST", "");
vi.stubEnv("SMTP_PORT", "");
vi.stubEnv("SMTP_FROM", "");

const db = createTestDb();
const NOW = new Date("2026-11-02T10:00:00Z");
const TODAY = "2026-11-02";
const WORKER = "worker-advance";
const CLIENT = "alfa@example.cz";
const TOTAL = 1_000_000;
const ENABLED = { confirmed: true };

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

function account(mode: Preferences["advanceFinalMode"], { send = false, email = CLIENT } = {}) {
  const owner = seedOwner(db, NOW);
  ownSmtp(db, owner, smtp.port);
  const customerId = seedCustomer(owner, email);
  const advanceId = issuedAdvance(owner, customerId);
  savePreferences(webActor(owner), { advanceFinalMode: mode });
  if (send) setAutomation(webActor(owner), "advanceInvoice", true, ENABLED);
  return { owner, customerId, advanceId };
}

const row = (owner: string, id: string) => getInvoice(owner, id)!;
const finalId = (owner: string, advanceId: string) => finalOf(db, owner, advanceId)!.id;
const logsOf = (owner: string) =>
  db.select().from(emailLog).where(eq(emailLog.userId, owner)).all();
const noticesOf = (owner: string) =>
  db.select().from(notification).where(eq(notification.userId, owner)).all();
const open = (owner: string) => noticesOf(owner).filter((item) => item.resolvedAt === null);
const kinds = (owner: string) => noticesOf(owner).map((item) => item.kind);
const toClient = () => smtp.messages.filter((message) => message.to.includes(CLIENT));
const finals = (owner: string) =>
  listInvoices(owner, { type: "invoice" }).rows.filter((item) => item.status !== "cancelled");

function pay(owner: string, id: string, amountMinor = TOTAL, paidOn = TODAY) {
  return addPayment(webActor(owner), id, {
    revision: row(owner, id).revision,
    paidOn,
    amountMinor,
    currency: "CZK",
    method: "transfer",
    note: "",
  });
}

const paymentInput = (owner: string, id: string, amountMinor: number, over = {}) => ({
  revision: row(owner, id).revision,
  paidOn: TODAY,
  amountMinor,
  currency: "CZK" as const,
  method: "transfer" as const,
  note: "",
  ...over,
});

const parsed = (over: Partial<ParsedNotice> = {}): ParsedNotice => ({
  variant: "en",
  targetAccount: `${TARGET.number}/${TARGET.bankCode}`,
  amountMinor: TOTAL,
  currency: "CZK",
  occurredAt: { date: TODAY, time: "09:05" },
  variableSymbol: VS,
  constantSymbol: null,
  counterpartyAccount: null,
  counterpartyName: null,
  message: null,
  instructionId: `a-${nextId++}`,
  ...over,
});

const income = (notice: ParsedNotice): IngestInput =>
  ({
    bank: "fio",
    notice,
    text: "avizo",
    authResult: "pass",
    requireConfirmation: true,
    receivedAt: NOW,
  }) as IngestInput;

function noteDraft(owner: string, id: string, unitPriceMinor: number) {
  const { lines, ...doc } = row(owner, id);
  return { ...doc, id, lines: [{ ...lines[0]!, catalogItemId: null, unitPriceMinor }] };
}

function payable(owner: string, advanceId: string) {
  const bankAccountId = seedBankAccount(db, owner, NOW);
  db.update(invoice)
    .set({ variableSymbol: VS, bankAccountId })
    .where(eq(invoice.id, advanceId))
    .run();
}

function matched(owner: string, advanceId: string, over: Partial<ParsedNotice> = {}) {
  payable(owner, advanceId);
  const result = ingestNotice(owner, income(parsed(over)));
  if (result.status !== "matched") throw new Error(`nespárováno: ${result.status}`);
  return result;
}

describe("režim po úhradě", () => {
  test("[ADV-002] výchozí režim je koncept a platí pro starý účet bez uložené volby", () => {
    expect(DEFAULT_PREFERENCES.advanceFinalMode).toBe("draft");
    const owner = seedOwner(db, NOW);
    expect(getPreferences(owner).advanceFinalMode).toBe("draft");
  });

  test("[ADV-002] výchozí režim po úhradě 10 000,00 založí koncept a nic neodešle", async () => {
    const owner = seedOwner(db, NOW);
    ownSmtp(db, owner, smtp.port);
    const advanceId = issuedAdvance(owner, seedCustomer(owner, CLIENT));

    pay(owner, advanceId);
    await drainJobs(WORKER);

    const final = finalOf(db, owner, advanceId)!;
    expect(final).toMatchObject({
      status: "draft",
      number: null,
      totalMinor: TOTAL,
      advanceMinor: TOTAL,
    });
    expect(row(owner, advanceId)).toMatchObject({ status: "paid", supersededAt: null });
    expect(logsOf(owner)).toEqual([]);
    expect(smtp.connections()).toBe(0);
    assertConsistent(db, owner);
  });

  test("[ADV-002] režim vypnuto nezaloží nic, ruční převod jde dál", () => {
    const { owner, advanceId } = account("off");

    pay(owner, advanceId);

    expect(finalOf(db, owner, advanceId)).toBeNull();
    expect(noticesOf(owner)).toEqual([]);
    const { id } = convertAdvance(webActor(owner), advanceId);
    expect(finalId(owner, advanceId)).toBe(id);
    assertConsistent(db, owner);
  });

  test("[ADV-002] režim vystavit dá číslo z řady faktur", () => {
    const { owner, advanceId } = account("issue");

    pay(owner, advanceId);

    const final = finalOf(db, owner, advanceId)!;
    expect(final).toMatchObject({ status: "paid", advanceMinor: TOTAL });
    expect(final.number).toMatch(/^2026-/);
    expect(amountDue(final)).toBe(0);
    expect(row(owner, advanceId).supersededAt).not.toBeNull();
    expect(logsOf(owner)).toEqual([]);
    assertConsistent(db, owner);
  });

  test("[ADV-002] chyba vystavení nechá platbu i koncept a založí upozornění", () => {
    const { owner, advanceId } = account("issue", { send: true });
    db.update(supplier).set({ name: "" }).where(eq(supplier.userId, owner)).run();

    pay(owner, advanceId);

    expect(row(owner, advanceId).status).toBe("paid");
    const final = finalOf(db, owner, advanceId)!;
    expect(final).toMatchObject({ status: "draft", number: null });
    const [notice] = noticesOf(owner);
    expect(notice).toMatchObject({
      kind: "advance_final_failed",
      entityType: "invoice",
      entityId: final.id,
    });
    expect(notificationText("advance_final_failed", notice!.params)).toContain("koncept");
    expect(logsOf(owner)).toEqual([]);
    const issued = db.select().from(auditLog).where(eq(auditLog.ownerId, owner)).all();
    expect(issued.filter((item) => item.action === "invoice.issue")).toHaveLength(1);
  });

  test("[ADV-002] platba, smazání a nová platba dají jednu fakturu", () => {
    const { owner, advanceId } = account("draft");

    const { id } = pay(owner, advanceId);
    const first = finalId(owner, advanceId);
    deletePayment(webActor(owner), id, row(owner, advanceId).revision);
    expect(finalOf(db, owner, advanceId)).toMatchObject({ id: first, advanceMinor: 0 });
    pay(owner, advanceId);

    expect(finals(owner).map((item) => item.id)).toEqual([first]);
    expect(finalOf(db, owner, advanceId)).toMatchObject({ advanceMinor: TOTAL });
    assertConsistent(db, owner);
  });

  test("ruční koncept před úhradou zůstane jediný", () => {
    const { owner, advanceId } = account("issue");
    const { id } = convertAdvance(webActor(owner), advanceId);

    pay(owner, advanceId);

    expect(finals(owner).map((item) => item.id)).toEqual([id]);
    expect(row(owner, id).status).toBe("draft");
  });

  test("[ADV-002] uzavření rozdílu uhradí zálohu a založí fakturu", () => {
    const { owner, advanceId } = account("draft");
    pay(owner, advanceId, TOTAL - 100);
    expect(finalOf(db, owner, advanceId)).toBeNull();

    closeDifference(webActor(owner), advanceId, {
      revision: row(owner, advanceId).revision,
      confirmed: true,
    });

    expect(finalOf(db, owner, advanceId)).toMatchObject({ status: "draft", advanceMinor: TOTAL });
    assertConsistent(db, owner);
  });

  test("[ADV-002] úhrada z avíza i přiřazení z fronty fakturu založí", () => {
    const direct = account("draft");
    matched(direct.owner, direct.advanceId);
    expect(finalOf(db, direct.owner, direct.advanceId)).not.toBeNull();

    const queued = account("draft");
    payable(queued.owner, queued.advanceId);
    const result = ingestNotice(queued.owner, income(parsed({ variableSymbol: "1" })));
    if (result.status !== "pending") throw new Error(`mimo frontu: ${result.status}`);
    assignNotice(webActor(queued.owner), result.id, { invoiceId: queued.advanceId });
    expect(finalOf(db, queued.owner, queued.advanceId)).not.toBeNull();
  });

  test("[ADV-002] oprava platby na plnou částku fakturu založí k datu poslední platby", () => {
    const { owner, advanceId } = account("issue", { send: true });
    const { id } = pay(owner, advanceId, TOTAL - 200_000, "2026-11-01");
    pay(owner, advanceId, 100_000, "2026-10-30");

    updatePayment(
      webActor(owner),
      id,
      paymentInput(owner, advanceId, TOTAL - 100_000, { paidOn: "2026-11-01" }),
    );

    expect(finalOf(db, owner, advanceId)?.status).toBe("paid");
    expect(logsOf(owner)).toMatchObject([{ plannedFor: "2026-11-01" }]);
  });

  test("[ADV-002] záznam auditu řekne, že fakturu založila automatika", () => {
    const { owner, advanceId } = account("draft");

    pay(owner, advanceId);

    const created = db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "invoice.final_from_advance"))
      .all()
      .filter((item) => item.ownerId === owner);
    expect(created).toHaveLength(1);
    expect(created[0]!.after).toMatchObject({ automatic: true, advanceId });
  });
});

describe("hlavní vypínač a odeslání", () => {
  test("[SET-043] hlavní vypínač změní vystavit na koncept a po uvolnění se nic samo neodešle", async () => {
    const { owner, advanceId } = account("issue", { send: true });
    setPaused(webActor(owner), true, { confirmed: false });

    pay(owner, advanceId);

    const final = finalOf(db, owner, advanceId)!;
    expect(final.status).toBe("draft");
    expect(noticesOf(owner)).toMatchObject([{ kind: "advance_final_held", entityId: final.id }]);

    setPaused(webActor(owner), false, ENABLED);
    await drainJobs(WORKER);

    expect(finalOf(db, owner, advanceId)!.status).toBe("draft");
    expect(logsOf(owner)).toEqual([]);
    expect(smtp.connections()).toBe(0);
  });

  test("[BNK-009] vypnutá automatika po záloze SMTP nic nepošle", async () => {
    const { owner, advanceId } = account("issue");

    matched(owner, advanceId);
    await drainJobs(WORKER);

    expect(finalOf(db, owner, advanceId)!.status).toBe("paid");
    expect(logsOf(owner)).toEqual([]);
    expect(smtp.connections()).toBe(0);
  });

  test("[MAIL-004] zapnutá automatika pošle jednu zprávu s fakturou na adresu zákazníka", async () => {
    const { owner, advanceId } = account("issue", { send: true });

    matched(owner, advanceId);
    const final = finalOf(db, owner, advanceId)!;
    expect(logsOf(owner)).toMatchObject([
      {
        invoiceId: final.id,
        kind: "invoice",
        trigger: "automatic",
        automation: "advanceInvoice",
        plannedFor: TODAY,
        invoiceRevision: final.revision,
      },
    ]);
    await drainJobs(WORKER);

    expect(toClient()).toHaveLength(1);
    expect(toClient()[0]!.subject).toContain(final.number);
    expect(logsOf(owner)).toMatchObject([{ status: "sent" }]);
    expect(row(owner, final.id)).toMatchObject({ status: "paid" });
    expect(row(owner, final.id).sentAt).not.toBeNull();
    assertConsistent(db, owner);
  });

  test("[MAIL-003] zpráva faktury po záloze uvede zálohu a že je uhrazena", () => {
    const { owner, advanceId } = account("issue", { send: true });

    pay(owner, advanceId);

    const [log] = logsOf(owner);
    const money = (minor: number) => formatMoney(minor, "CZK");
    expect(log!.body).toContain(`se splatností`);
    expect(log!.body).toContain(`záloha ${money(TOTAL)}`);
    expect(log!.body).toContain("Faktura je tím uhrazena.");
    expect(log!.body).not.toContain("Zbývá uhradit");
    expect(log!.body.indexOf("S pozdravem")).toBeLessThan(log!.body.indexOf("uhrazena."));
  });

  test("[MAIL-003] dialog odeslání větu o záloze ukáže předem", () => {
    const { owner, advanceId } = account("issue");

    pay(owner, advanceId);

    const { body } = sendPrefill(owner, finalId(owner, advanceId));
    expect(body).toContain("Faktura je tím uhrazena.");
  });

  test("úhrada stará 4 dny fakturu založí, nepošle a řekne proč", () => {
    const { owner, advanceId } = account("issue", { send: true });

    pay(owner, advanceId, TOTAL, "2026-10-29");

    const final = finalOf(db, owner, advanceId)!;
    expect(final.status).toBe("paid");
    expect(logsOf(owner)).toEqual([]);
    const [notice] = noticesOf(owner);
    expect(notice).toMatchObject({ kind: "advance_final_old_payment", entityId: final.id });
    expect(notificationText("advance_final_old_payment", notice!.params)).toContain(final.number);
  });

  test("stará úhrada s vypnutou automatikou mlčí, nic odejít nemělo", () => {
    const { owner, advanceId } = account("issue");

    pay(owner, advanceId, TOTAL, "2026-10-29");

    expect(noticesOf(owner)).toEqual([]);
  });

  test("režim vystavit s ručním konceptem nic nevystaví a upozorní na koncept", () => {
    const { owner, advanceId } = account("issue", { send: true });
    const { id } = convertAdvance(webActor(owner), advanceId);

    pay(owner, advanceId);

    expect(row(owner, id).status).toBe("draft");
    expect(logsOf(owner)).toEqual([]);
    const [notice] = noticesOf(owner);
    expect(notice).toMatchObject({ kind: "advance_final_manual", entityId: id });
    expect(notificationText("advance_final_manual", notice!.params)).toContain(
      row(owner, advanceId).number,
    );
  });

  test("režim koncept s ručním konceptem neupozorní, je to očekávaný stav", () => {
    const { owner, advanceId } = account("draft");
    convertAdvance(webActor(owner), advanceId);

    pay(owner, advanceId);

    expect(noticesOf(owner)).toEqual([]);
  });

  test("úhrada stará 3 dny ještě odejde", () => {
    const { owner, advanceId } = account("issue", { send: true });

    pay(owner, advanceId, TOTAL, "2026-10-30");

    expect(logsOf(owner)).toHaveLength(1);
  });

  test("zákazník bez adresy založí upozornění", () => {
    const { owner, advanceId } = account("issue", { send: true, email: "" });

    pay(owner, advanceId);

    const final = finalOf(db, owner, advanceId)!;
    expect(final.status).toBe("paid");
    const [notice] = noticesOf(owner);
    expect(notice).toMatchObject({ kind: "advance_final_no_address", entityId: final.id });
    expect(notificationText("advance_final_no_address", notice!.params)).toContain(final.number);
    expect(logsOf(owner)).toEqual([]);
  });

  test("neodeslatelná zpráva založí upozornění a platbu nechá", () => {
    const { owner, customerId, advanceId } = account("issue", { send: true });
    db.update(customer).set({ email: "neni-adresa" }).where(eq(customer.id, customerId)).run();

    pay(owner, advanceId);

    expect(kinds(owner)).toEqual(["advance_final_bad_mail"]);
    expect(row(owner, advanceId).status).toBe("paid");
    expect(logsOf(owner)).toEqual([]);
  });

  test("režim koncept nikdy neodešle ani se zapnutou automatikou", async () => {
    const { owner, advanceId } = account("draft", { send: true });

    pay(owner, advanceId);
    await drainJobs(WORKER);

    expect(finalOf(db, owner, advanceId)!.status).toBe("draft");
    expect(logsOf(owner)).toEqual([]);
    expect(smtp.connections()).toBe(0);
  });

  test("poznámka k platbě zálohy zprávu ve frontě nezadrží", async () => {
    const { owner, advanceId } = account("issue", { send: true });
    const { id } = pay(owner, advanceId);
    const before = finalOf(db, owner, advanceId)!.revision;

    updatePayment(webActor(owner), id, paymentInput(owner, advanceId, TOTAL, { note: "ověřeno" }));

    expect(finalOf(db, owner, advanceId)!.revision).toBe(before);
    await drainJobs(WORKER);
    expect(toClient()).toHaveLength(1);
    expect(logsOf(owner)).toMatchObject([{ status: "sent" }]);
  });
});

describe("vrácení peněz", () => {
  const reviewOf = (owner: string) =>
    open(owner).filter((item) => item.kind === "advance_final_review");

  test("vrácení avíza sníží advance_minor, zadrží zprávu a založí kontrolu", async () => {
    const { owner, advanceId } = account("issue", { send: true });
    const { id: noticeId } = matched(owner, advanceId);
    const id = finalId(owner, advanceId);

    undoNotice(webActor(owner), noticeId);
    await drainJobs(WORKER);

    expect(row(owner, id)).toMatchObject({ advanceMinor: 0, status: "issued" });
    expect(logsOf(owner)).toMatchObject([{ status: "held" }]);
    expect(toClient()).toEqual([]);
    const [review] = reviewOf(owner);
    expect(review).toMatchObject({ entityId: id });
    expect(notificationText("advance_final_review", review!.params)).toContain(
      row(owner, id).number,
    );
    assertConsistent(db, owner);
  });

  test("vrácení peněz ze zálohy 10 000,00 po faktuře chce doplatek 10 000,00", () => {
    const { owner, advanceId } = account("issue");
    pay(owner, advanceId);
    const id = finalId(owner, advanceId);

    addRefund(webActor(owner), advanceId, paymentInput(owner, advanceId, TOTAL));

    expect(amountDue(row(owner, id))).toBe(TOTAL);
    expect(reviewOf(owner)).toHaveLength(1);
    expect(finals(owner)).toHaveLength(1);
    assertConsistent(db, owner);
  });

  test("smazání platby zálohy založí kontrolu, koncept ji nepotřebuje", () => {
    const issued = account("issue");
    const paid = pay(issued.owner, issued.advanceId);
    deletePayment(webActor(issued.owner), paid.id, row(issued.owner, issued.advanceId).revision);
    expect(reviewOf(issued.owner)).toHaveLength(1);

    const draft = account("draft");
    const kept = pay(draft.owner, draft.advanceId);
    deletePayment(webActor(draft.owner), kept.id, row(draft.owner, draft.advanceId).revision);
    expect(reviewOf(draft.owner)).toEqual([]);
  });

  test("doplatek na faktuře kontrolu vyřeší a další vrácení ji založí znovu", () => {
    const { owner, advanceId } = account("issue");
    pay(owner, advanceId);
    const id = finalId(owner, advanceId);
    addRefund(webActor(owner), advanceId, paymentInput(owner, advanceId, 100_000));
    addRefund(webActor(owner), advanceId, paymentInput(owner, advanceId, 100_000));
    expect(reviewOf(owner)).toHaveLength(1);

    pay(owner, id, 100_000);
    expect(reviewOf(owner)).toHaveLength(1);
    pay(owner, id, 100_000);
    expect(reviewOf(owner)).toEqual([]);

    addRefund(webActor(owner), advanceId, paymentInput(owner, advanceId, 100_000));
    expect(reviewOf(owner)).toHaveLength(1);
  });

  test("kontrolu vyřeší i oprava konečné faktury na celý zbytek", () => {
    const { owner, advanceId } = account("issue");
    pay(owner, advanceId);
    const id = finalId(owner, advanceId);
    addRefund(webActor(owner), advanceId, paymentInput(owner, advanceId, 100_000));
    const { id: noteId } = createCreditNote(webActor(owner), id);
    saveDraft(webActor(owner), noteDraft(owner, noteId, -60_000));
    issueInvoice(webActor(owner), noteId, { revision: row(owner, noteId).revision });
    expect(reviewOf(owner)).toHaveLength(1);

    const { id: restId } = createCreditNote(webActor(owner), id);
    saveDraft(webActor(owner), noteDraft(owner, restId, -40_000));
    issueInvoice(webActor(owner), restId, { revision: row(owner, restId).revision });

    expect(amountDue(row(owner, id))).toBe(0);
    expect(reviewOf(owner)).toEqual([]);
    assertConsistent(db, owner);
  });

  test("kontrolu vyřeší storno konečné faktury", () => {
    const { owner, advanceId } = account("issue");
    pay(owner, advanceId);
    const id = finalId(owner, advanceId);
    addRefund(webActor(owner), advanceId, paymentInput(owner, advanceId, 100_000));
    expect(reviewOf(owner)).toHaveLength(1);

    cancelInvoice(webActor(owner), id);

    expect(reviewOf(owner)).toEqual([]);
  });

  test("kontrola po vrácení zmizí i po opravě platby zálohy zpět", () => {
    const { owner, advanceId } = account("issue");
    pay(owner, advanceId);
    addRefund(webActor(owner), advanceId, paymentInput(owner, advanceId, 100_000));
    const refund = listPayments(owner, advanceId).find((item) => item.creditedMinor < 0)!;

    deletePayment(webActor(owner), refund.id, row(owner, advanceId).revision);

    expect(reviewOf(owner)).toEqual([]);
  });
});

describe("po storně konečné faktury", () => {
  const CANCELLED = "advance_final_cancelled";
  const finalsCreated = (owner: string) =>
    db
      .select()
      .from(invoice)
      .where(eq(invoice.userId, owner))
      .all()
      .filter((item) => item.type === "invoice");
  const openCancelled = (owner: string) => open(owner).filter((item) => item.kind === CANCELLED);

  function cancelledFinal(mode: "issue" | "draft") {
    const { owner, advanceId } = account("issue", { send: true });
    const { id: paymentId } = pay(owner, advanceId);
    const id = finalId(owner, advanceId);
    cancelInvoice(webActor(owner), id);
    savePreferences(webActor(owner), { advanceFinalMode: mode });
    return { owner, advanceId, id, paymentId };
  }

  async function expectNothingNew(owner: string, advanceId: string) {
    await drainJobs(WORKER);
    expect(finalOf(db, owner, advanceId)).toBeNull();
    expect(finalsCreated(owner)).toHaveLength(1);
    expect(toClient()).toEqual([]);
    expect(row(owner, advanceId).supersededAt).toBeNull();
  }

  test.each(["issue", "draft"] as const)(
    "režim %s: další úhrada nic nezaloží a jen upozorní",
    async (mode) => {
      const { owner, advanceId, paymentId } = cancelledFinal(mode);

      deletePayment(webActor(owner), paymentId, row(owner, advanceId).revision);
      pay(owner, advanceId);

      await expectNothingNew(owner, advanceId);
      const [notice] = openCancelled(owner);
      expect(notice).toMatchObject({ entityId: advanceId });
      expect(notificationText(CANCELLED, notice!.params)).toContain(row(owner, advanceId).number);
      assertConsistent(db, owner);
    },
  );

  test("režim vypnuto mlčí", async () => {
    const { owner, advanceId, paymentId } = cancelledFinal("issue");
    savePreferences(webActor(owner), { advanceFinalMode: "off" });

    deletePayment(webActor(owner), paymentId, row(owner, advanceId).revision);
    pay(owner, advanceId);

    await expectNothingNew(owner, advanceId);
    expect(openCancelled(owner)).toEqual([]);
  });

  test("oprava platby tam a zpět nic nezaloží a nechá jedno otevřené upozornění", async () => {
    const { owner, advanceId, paymentId } = cancelledFinal("issue");

    for (const round of [1, 2]) {
      updatePayment(webActor(owner), paymentId, paymentInput(owner, advanceId, TOTAL - round));
      updatePayment(webActor(owner), paymentId, paymentInput(owner, advanceId, TOTAL));
    }

    await expectNothingNew(owner, advanceId);
    expect(openCancelled(owner)).toHaveLength(1);
    expect(noticesOf(owner).filter((item) => item.kind === CANCELLED)).toHaveLength(2);
  });

  test("vrácení avíza a nové přiřazení nic nezaloží", async () => {
    const { owner, advanceId } = account("issue", { send: true });
    const { id: noticeId } = matched(owner, advanceId);
    cancelInvoice(webActor(owner), finalId(owner, advanceId));

    undoNotice(webActor(owner), noticeId);
    assignNotice(webActor(owner), noticeId, { invoiceId: advanceId });

    expect(row(owner, advanceId).status).toBe("paid");
    await expectNothingNew(owner, advanceId);
    expect(openCancelled(owner)).toHaveLength(1);
  });

  test("ruční převod po storně jde dál a upozornění vyřeší", () => {
    const { owner, advanceId, id, paymentId } = cancelledFinal("issue");
    deletePayment(webActor(owner), paymentId, row(owner, advanceId).revision);
    pay(owner, advanceId);

    const created = convertAdvance(webActor(owner), advanceId);

    expect(created.id).not.toBe(id);
    expect(row(owner, created.id)).toMatchObject({ status: "draft", advanceMinor: TOTAL });
    expect(openCancelled(owner)).toEqual([]);
  });

  test("vrácení storna upozornění vyřeší", () => {
    const { owner, advanceId, id, paymentId } = cancelledFinal("issue");
    deletePayment(webActor(owner), paymentId, row(owner, advanceId).revision);
    pay(owner, advanceId);
    expect(openCancelled(owner)).toHaveLength(1);

    restoreInvoice(webActor(owner), id);

    expect(openCancelled(owner)).toEqual([]);
    expect(finalOf(db, owner, advanceId)!.id).toBe(id);
  });

  test("další úhrada po smazaném konceptu storno nepotřebuje a fakturu založí", () => {
    const { owner, advanceId } = account("draft");
    const { id: paymentId } = pay(owner, advanceId);
    deleteDraft(webActor(owner), finalId(owner, advanceId));

    deletePayment(webActor(owner), paymentId, row(owner, advanceId).revision);
    pay(owner, advanceId);

    expect(finalOf(db, owner, advanceId)).toMatchObject({ status: "draft" });
    expect(noticesOf(owner)).toEqual([]);
  });
});

describe("klíče upozornění", () => {
  function secondFinal(owner: string, advanceId: string, paymentId: string) {
    deleteDraft(webActor(owner), finalId(owner, advanceId));
    deletePayment(webActor(owner), paymentId, row(owner, advanceId).revision);
    pay(owner, advanceId);
    return finalId(owner, advanceId);
  }

  test("druhý koncept po smazaném prvním dostane vlastní upozornění o vypínači", () => {
    const { owner, advanceId } = account("issue", { send: true });
    setPaused(webActor(owner), true, { confirmed: false });
    const { id: paymentId } = pay(owner, advanceId);
    const first = finalId(owner, advanceId);

    const second = secondFinal(owner, advanceId, paymentId);

    expect(noticesOf(owner).map((item) => item.entityId)).toEqual([first, second]);
  });

  test("druhé selhání vystavení dostane vlastní upozornění", () => {
    const { owner, advanceId } = account("issue", { send: true });
    db.update(supplier).set({ name: "" }).where(eq(supplier.userId, owner)).run();
    const { id: paymentId } = pay(owner, advanceId);
    const first = finalId(owner, advanceId);

    const second = secondFinal(owner, advanceId, paymentId);

    const failed = noticesOf(owner).filter((item) => item.kind === "advance_final_failed");
    expect(failed.map((item) => item.entityId)).toEqual([first, second]);
  });
});

test("faktura vystavená automaticky s posledním známým kurzem na to upozorní", () => {
  const owner = seedOwner(db, NOW);
  const customerId = seedCustomer(owner, CLIENT);
  db.delete(exchangeRate).run();
  db.insert(exchangeRate)
    .values({ currency: "EUR", listDate: "2026-10-20", rateMicros: 24_000_000, fetchedAt: NOW })
    .run();
  const advanceId = issuedAdvance(owner, customerId, TOTAL, {
    currency: "EUR",
    paymentMethod: "cash",
    bankAccountId: null,
  });
  savePreferences(webActor(owner), { advanceFinalMode: "issue" });

  addPayment(webActor(owner), advanceId, {
    revision: row(owner, advanceId).revision,
    paidOn: TODAY,
    amountMinor: TOTAL,
    currency: "EUR",
    method: "cash",
    note: "",
  });

  const final = finalOf(db, owner, advanceId)!;
  expect(final).toMatchObject({ status: "paid", exchangeRateSource: "last_known" });
  const [notice] = noticesOf(owner);
  expect(notice).toMatchObject({ kind: "rate_last_known", entityId: final.id });
  expect(notificationText("rate_last_known", notice!.params)).toContain(final.number);
  expect(notice!.dedupeKey).toBe(`advance-final:${final.id}:rate`);
  db.delete(exchangeRate).run();
});

test("faktura vystavená ručně z konceptu nečeká na žádnou automatiku", () => {
  const { owner, advanceId } = account("draft", { send: true });
  pay(owner, advanceId);
  const { id, revision } = finalOf(db, owner, advanceId)!;

  issueInvoice(webActor(owner), id, { revision });

  expect(db.select().from(payment).where(eq(payment.userId, owner)).all()).toHaveLength(1);
  expect(logsOf(owner)).toEqual([]);
});
