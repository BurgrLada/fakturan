import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { isOverdue } from "@/lib/invoice";
import { documentQrInput, planQr } from "@/lib/qr-payload";
import { isEligibleForReminder } from "@/lib/reminders";
import { TEXTS } from "@/lib/texts";
import { setClockForTests } from "@/server/clock";
import { auditLog, invoice, payment } from "@/server/db/schema";
import { composeMail } from "@/server/services/email-templates";
import { hasPayments, refreshBalance } from "@/server/services/invoice-balance";
import { loadInvoiceDocument } from "@/server/services/invoice-document";
import { issueInvoice, markSent } from "@/server/services/invoice-lifecycle";
import { dueAlerts } from "@/server/services/due-alerts";
import {
  customerInvoiceStats,
  getInvoice,
  invoiceSummary,
  listInvoices,
} from "@/server/services/invoices";
import { mutate } from "@/server/services/mutation";
import {
  addPayment,
  deletePayment,
  hasPayments as reexported,
  markPaid,
} from "@/server/services/payments";
import { reminderPrefill } from "@/server/services/reminders";
import { seedCreditNote, seedPayment } from "../fixtures/invoices";
import { assertConsistent } from "../helpers/consistency";
import { createTestDb } from "../helpers/db";
import { draftFor, seedCustomer, seedOwner, webActor } from "../helpers/fixtures-mail";

vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-invoice-balance-")));

const db = createTestDb();
const NOW = new Date("2026-03-20T10:00:00Z");
const TODAY = "2026-03-20";

beforeEach(() => setClockForTests({ now: () => NOW }));
afterEach(() => setClockForTests(null));

function issuedFor(owner: string, customerId: string, totalMinor: number) {
  const { id, revision } = draftFor(owner, customerId, {
    lines: [
      {
        catalogItemId: null,
        name: "Konzultace",
        description: "",
        quantityMilli: 1000,
        unit: "ks",
        unitPriceMinor: totalMinor,
        discountKind: "none",
        discountValue: 0,
      },
    ],
  });
  issueInvoice(webActor(owner), id, { revision });
  return id;
}

function account(totalMinor: number) {
  const owner = seedOwner(db, NOW);
  const customerId = seedCustomer(owner);
  return { owner, customerId, id: issuedFor(owner, customerId, totalMinor) };
}

const row = (owner: string, id: string) => getInvoice(owner, id)!;
const refresh = (owner: string, id: string) =>
  mutate(webActor(owner), "invoice.balance", (tx, audit) => refreshBalance(tx, audit, owner, id));
const overdue = (id: string) =>
  db.update(invoice).set({ dueDate: "2026-03-01" }).where(eq(invoice.id, id)).run();
const send = (owner: string, id: string) => markSent(webActor(owner), id);

function paidAndCredited() {
  const seeded = account(1_210_000);
  seedCreditNote(db, seeded.id, -210_000);
  seedPayment(db, seeded.id, 400_000);
  refresh(seeded.owner, seeded.id);
  return seeded;
}

describe("zůstatek po opravě", () => {
  test("[CRN-005] 12 100,00 + oprava -2 100,00 - platba 4 000,00 dá zbývá 6 000,00", () => {
    const { owner, id } = paidAndCredited();

    expect(row(owner, id)).toMatchObject({
      creditsMinor: -210_000,
      paidMinor: 400_000,
      status: "partially_paid",
    });
    expect(listInvoices(owner, { status: "partially_paid" }).rows[0]).toMatchObject({
      type: "invoice",
      creditsMinor: -210_000,
    });
    assertConsistent(db, owner);
  });

  test("[CRN-005] QR, upomínka, souhrn a karta zákazníka vycházejí ze stejné hodnoty 6 000,00", () => {
    const { owner, customerId, id } = paidAndCredited();
    send(owner, id);
    overdue(id);

    const doc = loadInvoiceDocument(owner, id)!;
    expect(documentQrInput(doc, "").dueMinor).toBe(600_000);
    expect(composeMail(owner, id, "reminder").body).toMatch(/6\s000,00\sKč/);
    expect(invoiceSummary(owner, {})[0]).toMatchObject({ overdueMinor: 600_000 });
    expect(customerInvoiceStats(owner, customerId).sums[0]).toMatchObject({
      outstandingMinor: 600_000,
    });
    expect(dueAlerts(owner, TODAY).overdue[0]!.amountDueMinor).toBe(600_000);
    expect(listInvoices(owner, { status: "overdue" }).rows.map((item) => item.id)).toEqual([id]);
  });

  test("[QR-006] částka v QR je 6 000,00 po opravě a platbě", () => {
    const { owner, id } = paidAndCredited();

    const input = documentQrInput(loadInvoiceDocument(owner, id)!, "");
    const plan = planQr({ ...input, enabled: true, iban: "CZ6508000000192000145399" });

    expect(input.dueMinor).toBe(600_000);
    expect(plan).toMatchObject({ kind: "spayd", payload: expect.stringContaining("*AM:6000.00*") });
  });

  test("[CRN-006] 5 000,00 + oprava -5 000,00 bez plateb je credited a nejde na ni upomínka", () => {
    const { owner, id } = account(500_000);
    send(owner, id);
    seedCreditNote(db, id, -500_000);

    const after = refresh(owner, id);

    expect(after.status).toBe("credited");
    expect(isEligibleForReminder(after, null)).toBe(false);
    expect(() => reminderPrefill(owner, id, null)).toThrow(TEXTS.reminders.errors.nothingDue);
    expect(() =>
      addPayment(webActor(owner), id, {
        revision: after.revision,
        paidOn: TODAY,
        amountMinor: 100,
        currency: "CZK",
        method: "transfer",
        note: "",
      }),
    ).toThrow(TEXTS.payments.errors.notPayable);
    assertConsistent(db, owner);
  });

  test("[CRN-006] 5 000,00, platba 5 000,00, oprava -1 500,00 je paid s přeplatkem 1 500,00", () => {
    const { owner, id } = account(500_000);
    markPaid(webActor(owner), id, { revision: row(owner, id).revision });
    seedCreditNote(db, id, -150_000);

    expect(refresh(owner, id)).toMatchObject({ status: "paid", creditsMinor: -150_000 });
    expect(documentQrInput(loadInvoiceDocument(owner, id)!, "").dueMinor).toBe(-150_000);
    assertConsistent(db, owner);
  });

  test("[REM-006] upomínka s vlastní šablonou uvede zbytek po opravě", () => {
    const { owner, id } = account(1_210_000);
    send(owner, id);
    seedCreditNote(db, id, -210_000);
    refresh(owner, id);
    expect(row(owner, id).status).toBe("sent");

    const texts = { cs: { subject: "Prosím o platbu", body: "Prosím o platbu." } };
    const { body } = composeMail(owner, id, "reminder", undefined, texts);

    expect(body).toMatch(/Zbývá uhradit 10\s000,00\sKč/);
  });

  test("[REM-006] plná faktura vlastní šablonu podrží", () => {
    const { owner, id } = account(1_210_000);
    send(owner, id);

    const texts = { cs: { subject: "Prosím o platbu", body: "Prosím o platbu." } };

    expect(composeMail(owner, id, "reminder", undefined, texts).body).toBe("Prosím o platbu.");
  });

  test("po splatnosti v SQL souhlasí s isOverdue u částečné i úplné opravy", () => {
    const owner = seedOwner(db, NOW);
    const customerId = seedCustomer(owner);
    const partly = issuedFor(owner, customerId, 100_000);
    const fully = issuedFor(owner, customerId, 100_000);
    for (const id of [partly, fully]) overdue(id);
    seedCreditNote(db, partly, -40_000);
    seedCreditNote(db, fully, -100_000);
    refresh(owner, partly);
    refresh(owner, fully);

    const listed = listInvoices(owner, { status: "overdue" }).rows.map((item) => item.id);

    expect(listed).toEqual([partly]);
    expect(isOverdue(row(owner, partly), TODAY)).toBe(true);
    expect(isOverdue(row(owner, fully), TODAY)).toBe(false);
  });
});

describe("refreshBalance", () => {
  test("refreshBalance je idempotentní a nepřičítá", () => {
    const { owner, id } = account(100_000);
    seedCreditNote(db, id, -40_000);
    seedCreditNote(db, id, -10_000);

    refresh(owner, id);
    const again = refresh(owner, id);

    expect(again.creditsMinor).toBe(-50_000);
    assertConsistent(db, owner);
  });

  test("zapíše audit invoice.balance a zvýší revizi", () => {
    const { owner, id } = account(100_000);
    const { revision } = row(owner, id);
    seedCreditNote(db, id, -40_000);

    refresh(owner, id);

    expect(row(owner, id).revision).toBe(revision + 1);
    const audit = db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "invoice.balance"), eq(auditLog.entityId, id)))
      .get();
    expect(audit).toMatchObject({
      before: { creditsMinor: 0, advanceMinor: 0, status: "issued" },
      after: { creditsMinor: -40_000, advanceMinor: 0, status: "issued" },
    });
  });

  test("stornovaná oprava se nezapočte", () => {
    const { owner, id } = account(100_000);
    seedCreditNote(db, id, -40_000, "cancelled");

    expect(refresh(owner, id).creditsMinor).toBe(0);
  });

  test("po stornu opravy se dobropisovaná vrátí na základ", () => {
    const { owner, id } = account(100_000);
    const noteId = seedCreditNote(db, id, -100_000);
    expect(refresh(owner, id).status).toBe("credited");

    db.update(invoice).set({ status: "cancelled" }).where(eq(invoice.id, noteId)).run();

    expect(refresh(owner, id)).toMatchObject({ status: "issued", creditsMinor: 0 });
    assertConsistent(db, owner);
  });

  test("[R-4] platbu na dobropisované faktuře jde smazat", () => {
    const { owner, id } = account(100_000);
    seedPayment(db, id, 100_000);
    seedPayment(db, id, -100_000);
    seedCreditNote(db, id, -100_000);
    expect(refresh(owner, id).status).toBe("credited");
    const refund = db
      .select({ id: payment.id })
      .from(payment)
      .where(and(eq(payment.invoiceId, id), eq(payment.creditedMinor, -100_000)))
      .get()!.id;

    deletePayment(webActor(owner), refund, row(owner, id).revision);

    expect(row(owner, id)).toMatchObject({ status: "paid", paidMinor: 100_000 });
  });

  test("odkaz opravy na fakturu se za úhradu zálohy nepočítá", () => {
    const { owner, id } = account(100_000);
    seedPayment(db, id, 30_000);
    const noteId = seedCreditNote(db, id, -40_000);

    expect(refresh(owner, noteId).advanceMinor).toBe(0);
  });

  test("cizí oprava se nepočítá a cizí účet doklad nenajde", () => {
    const first = account(100_000);
    const second = account(100_000);
    seedCreditNote(db, second.id, -40_000);

    expect(refresh(first.owner, first.id).creditsMinor).toBe(0);
    expect(() => refresh(first.owner, second.id)).toThrow(TEXTS.invoices.validation.notFound);
  });

  test("hasPayments je stejná funkce i v payments.ts", () => {
    const { owner, id } = account(100_000);
    expect(hasPayments(db, owner, id)).toBe(false);
    expect(reexported).toBe(hasPayments);
  });
});

describe("záloha", () => {
  function advance(owner: string, customerId: string, totalMinor: number) {
    const { id, revision } = draftFor(owner, customerId, { type: "advance", seriesId: null });
    issueInvoice(webActor(owner), id, { revision });
    db.update(invoice)
      .set({ subtotalMinor: totalMinor, totalMinor })
      .where(eq(invoice.id, id))
      .run();
    return id;
  }

  function linked(advanceId: string, finalId: string) {
    db.update(invoice).set({ relatedInvoiceId: advanceId }).where(eq(invoice.id, finalId)).run();
  }

  function seeded() {
    const owner = seedOwner(db, NOW);
    const customerId = seedCustomer(owner);
    const advanceId = advance(owner, customerId, 300_000);
    const finalId = issuedFor(owner, customerId, 300_000);
    linked(advanceId, finalId);
    return { owner, customerId, advanceId, finalId };
  }

  test("[CRN-005] overdueMinor faktury po částečné záloze počítá zbytek po záloze", () => {
    const { owner, advanceId, finalId } = seeded();
    addPayment(webActor(owner), advanceId, {
      revision: row(owner, advanceId).revision,
      paidOn: TODAY,
      amountMinor: 100_000,
      currency: "CZK",
      method: "transfer",
      note: "",
    });
    overdue(finalId);

    expect(row(owner, finalId).advanceMinor).toBe(100_000);
    expect(invoiceSummary(owner, {})[0]).toMatchObject({ overdueMinor: 200_000 });
  });

  test("úhrada zálohy přepočítá konečnou fakturu", () => {
    const { owner, advanceId, finalId } = seeded();
    const { revision } = row(owner, finalId);

    markPaid(webActor(owner), advanceId, { revision: row(owner, advanceId).revision });

    expect(row(owner, finalId)).toMatchObject({
      advanceMinor: 300_000,
      status: "paid",
      paidMinor: 0,
      revision: revision + 1,
    });
  });

  test("stornovaná konečná faktura se po úhradě zálohy nepřepočítá", () => {
    const { owner, advanceId, finalId } = seeded();
    db.update(invoice).set({ status: "cancelled" }).where(eq(invoice.id, finalId)).run();

    markPaid(webActor(owner), advanceId, { revision: row(owner, advanceId).revision });

    expect(row(owner, finalId)).toMatchObject({ advanceMinor: 0, status: "cancelled" });
  });

  test("smazání platby zálohy zůstatek vrátí", () => {
    const { owner, advanceId, finalId } = seeded();
    markPaid(webActor(owner), advanceId, { revision: row(owner, advanceId).revision });
    const paymentId = db
      .select({ id: payment.id })
      .from(payment)
      .where(eq(payment.invoiceId, advanceId))
      .get()!.id;

    deletePayment(webActor(owner), paymentId, row(owner, advanceId).revision);

    expect(row(owner, finalId)).toMatchObject({ advanceMinor: 0, status: "issued" });
  });

  test("[R-27] nahrazená záloha nemá co vybírat, stav počítá z nezkrácené částky", () => {
    const { owner, advanceId } = seeded();
    seedPayment(db, advanceId, 100_000);
    db.update(invoice).set({ supersededAt: NOW }).where(eq(invoice.id, advanceId)).run();

    const after = refresh(owner, advanceId);

    expect(after.status).toBe("partially_paid");
    expect(documentQrInput(loadInvoiceDocument(owner, advanceId)!, "").dueMinor).toBe(0);
    expect(listInvoices(owner, { status: "overdue" }).rows).toEqual([]);
  });

  test("[R-32] záloha není fakturováno ani pohledávka a je v advanceOpenMinor", () => {
    const owner = seedOwner(db, NOW);
    const customerId = seedCustomer(owner);
    const advanceId = advance(owner, customerId, 800_000);
    overdue(advanceId);

    expect(invoiceSummary(owner, {})[0]).toMatchObject({
      invoicedMinor: 0,
      overdueMinor: 0,
      advanceOpenMinor: 800_000,
    });
    expect(customerInvoiceStats(owner, customerId).sums[0]).toMatchObject({
      invoicedMinor: 0,
      outstandingMinor: 0,
    });
  });

  test("[R-32] uhrazená záloha je příjem, ne otevřená záloha", () => {
    const { owner, advanceId } = seeded();
    markPaid(webActor(owner), advanceId, { revision: row(owner, advanceId).revision });

    expect(invoiceSummary(owner, {})[0]).toMatchObject({
      invoicedMinor: 300_000,
      paidMinor: 300_000,
      advanceOpenMinor: 0,
    });
  });
});

describe("souhrny", () => {
  test("souhrn: 1 000,00 a -400,00 dá fakturováno 600,00, po splatnosti 600,00", () => {
    const { owner, customerId, id } = account(100_000);
    overdue(id);
    seedCreditNote(db, id, -40_000);
    refresh(owner, id);

    expect(invoiceSummary(owner, {})).toEqual([
      {
        currency: "CZK",
        invoicedMinor: 60_000,
        paidMinor: 0,
        overdueMinor: 60_000,
        advanceOpenMinor: 0,
      },
    ]);
    expect(customerInvoiceStats(owner, customerId).sums[0]).toMatchObject({
      invoicedMinor: 60_000,
      outstandingMinor: 60_000,
    });
  });

  test("souhrn: stornovaná oprava se nepočítá", () => {
    const { owner, id } = account(100_000);
    overdue(id);
    seedCreditNote(db, id, -40_000, "cancelled");
    refresh(owner, id);

    expect(invoiceSummary(owner, {})[0]).toMatchObject({
      invoicedMinor: 100_000,
      overdueMinor: 100_000,
    });
  });

  test("souhrn: dobropisovaná faktura a její oprava se vynulují", () => {
    const { owner, id } = account(100_000);
    seedCreditNote(db, id, -100_000);
    refresh(owner, id);

    expect(invoiceSummary(owner, {})[0]).toMatchObject({ invoicedMinor: 0, overdueMinor: 0 });
  });
});
