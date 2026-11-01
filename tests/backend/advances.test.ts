import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ADVANCE_NOTE } from "@/lib/clauses";
import { isOverdue } from "@/lib/invoice";
import { amountDue, documentQrInput, planQr } from "@/lib/qr-payload";
import { isEligibleForReminder } from "@/lib/reminders";
import { TEXTS } from "@/lib/texts";
import { setClockForTests } from "@/server/clock";
import { auditLog, invoice, invoiceTag, type bankNotification } from "@/server/db/schema";
import { convertAdvance } from "@/server/services/advances";
import { ingestNotice, noticeCandidates, type IngestInput } from "@/server/services/bank-notices";
import { createCreditNote } from "@/server/services/credit-notes";
import { saveSupplier, getSupplier } from "@/server/services/supplier";
import { loadInvoiceDocument } from "@/server/services/invoice-document";
import {
  cancelInvoice,
  isFinalConflict,
  issueInvoice,
  markSent,
  restoreInvoice,
} from "@/server/services/invoice-lifecycle";
import { refreshCustomerSnapshot, updateIssuedInvoice } from "@/server/services/invoice-versions";
import { finalOf } from "@/server/services/invoice-balance";
import {
  customerInvoiceStats,
  getInvoice,
  invoiceSummary,
  listInvoices,
  newDraftDefaults,
  saveDraft,
  type IssuedInput,
} from "@/server/services/invoices";
import {
  addPayment,
  addRefund,
  closeDifference,
  deletePayment,
  listPayments,
} from "@/server/services/payments";
import { setInvoiceTags } from "@/server/services/tags";
import { buildInvoiceView } from "@/server/pdf/view";
import { assertConsistent } from "../helpers/consistency";
import { createTestDb } from "../helpers/db";
import { COUNTERPARTY, seedBankAccount, TARGET } from "../helpers/fixtures-bank";
import { draftFor, seedCustomer, seedOwner, webActor } from "../helpers/fixtures-mail";
import { runAdvanceWorkers } from "../helpers/run-workers";

vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-advances-")));

const hidden = vi.hoisted(() => ({ final: false }));
vi.mock("@/server/services/invoice-balance", async (original) => {
  const real = await original<typeof import("@/server/services/invoice-balance")>();
  const finalOf: typeof real.finalOf = (...args) => (hidden.final ? null : real.finalOf(...args));
  return { ...real, finalOf };
});

const db = createTestDb();
const NOW = new Date("2026-03-20T10:00:00Z");
const TODAY = "2026-03-20";
const V = TEXTS.invoices.validation;
const E = TEXTS.payments.errors;

beforeEach(() => setClockForTests({ now: () => NOW }));
afterEach(() => setClockForTests(null));

const line = (unitPriceMinor: number) => ({
  catalogItemId: null,
  name: "Konzultace",
  description: "",
  quantityMilli: 1000,
  unit: "ks",
  unitPriceMinor,
  discountKind: "none" as const,
  discountValue: 0,
});

const row = (owner: string, id: string) => getInvoice(owner, id)!;

function account() {
  const owner = seedOwner(db, NOW);
  return { owner, customerId: seedCustomer(owner) };
}

function issue(owner: string, id: string) {
  issueInvoice(webActor(owner), id, { revision: row(owner, id).revision });
  return id;
}

function issuedAdvance(owner: string, customerId: string, totalMinor = 1_000_000, over = {}) {
  const { id } = draftFor(owner, customerId, {
    ...newDraftDefaults(owner, customerId, "advance"),
    lines: [line(totalMinor)],
    ...over,
  });
  return issue(owner, id);
}

function issuedPlain(owner: string, customerId: string, totalMinor: number, over = {}) {
  const { id } = draftFor(owner, customerId, { lines: [line(totalMinor)], ...over });
  return issue(owner, id);
}

function pay(owner: string, id: string, amountMinor: number, paidOn = TODAY) {
  addPayment(webActor(owner), id, {
    revision: row(owner, id).revision,
    paidOn,
    amountMinor,
    currency: "CZK",
    method: "transfer",
    note: "",
  });
}

function refund(owner: string, id: string, amountMinor: number) {
  addRefund(webActor(owner), id, {
    revision: row(owner, id).revision,
    paidOn: TODAY,
    amountMinor,
    currency: "CZK",
    method: "transfer",
    note: "",
  });
}

function convert(owner: string, advanceId: string) {
  return convertAdvance(webActor(owner), advanceId).id;
}

function raiseTotal(owner: string, id: string, totalMinor: number) {
  const doc = row(owner, id);
  const input: IssuedInput = {
    ...doc,
    number: doc.number!,
    variableSymbol: doc.variableSymbol,
    lines: [line(totalMinor)],
  };
  return updateIssuedInvoice(webActor(owner), id, input);
}

async function viewOf(owner: string, id: string) {
  return buildInvoiceView(loadInvoiceDocument(owner, id)!, {
    today: TODAY,
    draft: false,
    readImage: () => null,
  });
}

function setFinalDraft(owner: string, finalId: string, totalMinor: number) {
  const doc = row(owner, finalId);
  saveDraft(webActor(owner), {
    ...doc,
    id: finalId,
    revision: doc.revision,
    lines: [line(totalMinor)],
  });
}

describe("záloha", () => {
  test("[ADV-001] záloha má řadu Z2026-001 a text Toto není daňový doklad.", async () => {
    const { owner, customerId } = account();

    const id = issuedAdvance(owner, customerId);

    expect(row(owner, id)).toMatchObject({ type: "advance", number: "Z2026-001" });
    expect((await viewOf(owner, id)).advanceNote).toBe("Toto není daňový doklad.");
    expect((await viewOf(owner, issuedPlain(owner, customerId, 100))).advanceNote).toBe("");
    assertConsistent(db, owner);
  });

  test("[ADV-001] text jde upravit a vystavená záloha drží původní", async () => {
    const { owner, customerId } = account();
    const before = issuedAdvance(owner, customerId);
    const {
      logoFileId: _l,
      qrLogoFileId: _q,
      signatureFileId: _s,
      ...profile
    } = {
      ...getSupplier(owner)!,
    };

    saveSupplier(webActor(owner), { ...profile, advanceNoteCs: "Nejde o daňový doklad." });

    const after = issuedAdvance(owner, customerId);
    expect((await viewOf(owner, before)).advanceNote).toBe("Toto není daňový doklad.");
    expect((await viewOf(owner, after)).advanceNote).toBe("Nejde o daňový doklad.");
  });

  test("[ADV-001] anglická záloha má text v jazyce dokladu a starý snapshot výchozí", async () => {
    const { owner, customerId } = account();
    const id = issuedAdvance(owner, customerId, 100_000, { language: "en" });
    expect((await viewOf(owner, id)).advanceNote).toBe(ADVANCE_NOTE.en);

    const stored = row(owner, id).supplierSnapshot!;
    const { advanceNoteCs: _c, advanceNoteEn: _e, ...old } = stored;
    db.update(invoice).set({ supplierSnapshot: old }).where(eq(invoice.id, id)).run();

    expect((await viewOf(owner, id)).advanceNote).toBe(ADVANCE_NOTE.en);
  });

  test("[NUM-003] záloha, oprava a faktura mají své řady", () => {
    const { owner, customerId } = account();

    expect(newDraftDefaults(owner, customerId, "advance").seriesId).not.toBe(
      newDraftDefaults(owner, customerId).seriesId,
    );
    expect(row(owner, issuedAdvance(owner, customerId)).number).toBe("Z2026-001");
    expect(row(owner, issuedPlain(owner, customerId, 100_000)).number).toBe("2026-001");
  });
});

describe("konečná faktura", () => {
  function paidAdvance(totalMinor = 1_000_000) {
    const { owner, customerId } = account();
    const advanceId = issuedAdvance(owner, customerId, totalMinor);
    pay(owner, advanceId, totalMinor);
    return { owner, customerId, advanceId };
  }

  test("[ADV-003] konečná faktura po záloze 10 000,00 ukáže Uhrazeno zálohou a zbývá 0,00", async () => {
    const { owner, advanceId } = paidAdvance();
    const finalId = issue(owner, convert(owner, advanceId));

    expect(row(owner, finalId)).toMatchObject({
      type: "invoice",
      totalMinor: 1_000_000,
      advanceMinor: 1_000_000,
      paidMinor: 0,
      status: "paid",
    });
    const { totals } = await viewOf(owner, finalId);
    expect(totals.map((item) => item.label)).toEqual([
      "Celkem k úhradě",
      "Uhrazeno zálohou",
      "Zbývá uhradit",
    ]);
    expect(totals[2]!.value).toMatch(/^0,00/);
    assertConsistent(db, owner);
  });

  test("[ADV-003] faktura 12 100,00 po záloze 10 000,00 chce doplatek 2 100,00", async () => {
    const { owner, advanceId } = paidAdvance();
    const finalId = convert(owner, advanceId);
    setFinalDraft(owner, finalId, 1_210_000);

    issue(owner, finalId);

    expect(row(owner, finalId).status).toBe("issued");
    const doc = loadInvoiceDocument(owner, finalId)!;
    expect(documentQrInput(doc, "").dueMinor).toBe(210_000);
    assertConsistent(db, owner);
  });

  test("[ADV-003] faktura odkazuje na zálohu a záloha na fakturu", async () => {
    const { owner, advanceId } = paidAdvance();
    const finalId = issue(owner, convert(owner, advanceId));

    expect(row(owner, finalId).relatedSnapshot).toEqual({
      type: "advance",
      number: "Z2026-001",
      issueDate: TODAY,
    });
    expect((await viewOf(owner, finalId)).details).toContainEqual({
      label: "Vyúčtování zálohy",
      value: "Z2026-001 ze dne 20. 3. 2026",
    });
    expect(finalOf(db, owner, advanceId)?.id).toBe(finalId);
    expect(row(owner, advanceId).supersededAt).toEqual(NOW);
  });

  test("kopie zálohy: řádky, štítky, odstup splatnosti, bez DUZP a s řadou faktur", () => {
    const { owner, customerId } = account();
    const advanceId = issuedAdvance(owner, customerId, 500_000, {
      issueDate: "2026-03-01",
      dueDate: "2026-03-11",
      taxableDate: "2026-03-01",
      note: "Díky",
    });
    setInvoiceTags(webActor(owner), advanceId, ["projekt"]);

    const final = row(owner, convert(owner, advanceId));

    expect(final).toMatchObject({
      status: "draft",
      issueDate: TODAY,
      dueDate: "2026-03-30",
      taxableDate: null,
      note: "Díky",
      relatedInvoiceId: advanceId,
      customerId,
    });
    expect(final.lines.map((item) => item.netMinor)).toEqual([500_000]);
    expect(final.tags.map((tag) => tag.name)).toEqual(["projekt"]);
    expect(
      db.select().from(invoiceTag).where(eq(invoiceTag.invoiceId, final.id)).all(),
    ).toHaveLength(1);
    expect(final.seriesId).toBe(newDraftDefaults(owner, customerId).seriesId);
    assertConsistent(db, owner);
  });

  test("[ADV-004] převod před úhradou dá koncept a opakovaný klik stejný doklad", () => {
    const { owner, customerId } = account();
    const advanceId = issuedAdvance(owner, customerId);

    const first = convert(owner, advanceId);

    expect(row(owner, first)).toMatchObject({ status: "draft", advanceMinor: 0 });
    expect(convert(owner, advanceId)).toBe(first);
    expect(row(owner, advanceId).supersededAt).toBeNull();
  });

  test("[ADV-004] převod konceptu zálohy je odmítnutý", () => {
    const { owner, customerId } = account();
    const { id } = draftFor(owner, customerId, newDraftDefaults(owner, customerId, "advance"));

    expect(() => convert(owner, id)).toThrow(V.notConvertible);
  });

  test("[ADV-004] převod jde jen ze zálohy a ne ze storna", () => {
    const { owner, customerId } = account();
    const advanceId = issuedAdvance(owner, customerId);
    cancelInvoice(webActor(owner), advanceId);

    expect(() => convert(owner, advanceId)).toThrow(V.notConvertible);
    expect(() => convert(owner, issuedPlain(owner, customerId, 100))).toThrow(V.notConvertible);
  });

  test("koncept z převodu dostane úhradu zálohy dodatečně", () => {
    const { owner, customerId } = account();
    const advanceId = issuedAdvance(owner, customerId);
    const finalId = convert(owner, advanceId);

    pay(owner, advanceId, 1_000_000);

    expect(row(owner, finalId)).toMatchObject({ advanceMinor: 1_000_000, status: "draft" });
    expect(row(owner, issue(owner, finalId)).status).toBe("paid");
    assertConsistent(db, owner);
  });

  test("částečná úhrada 4 000,00 z 10 000,00 a vystavená faktura: zbývá 6 000,00 a záloha je partially_paid", () => {
    const { owner, customerId } = account();
    const advanceId = issuedAdvance(owner, customerId);
    pay(owner, advanceId, 400_000);

    const finalId = issue(owner, convert(owner, advanceId));

    expect(row(owner, advanceId).status).toBe("partially_paid");
    expect(documentQrInput(loadInvoiceDocument(owner, finalId)!, "").dueMinor).toBe(600_000);
    assertConsistent(db, owner);
  });

  test("faktura uhrazená jen zálohou má po zvýšení celku základní stav a varuje", () => {
    const { owner, advanceId } = paidAdvance();
    const finalId = issue(owner, convert(owner, advanceId));
    markSent(webActor(owner), finalId);

    const result = raiseTotal(owner, finalId, 1_210_000);

    expect(result).toMatchObject({ status: "sent", balanceWarning: "underpaid" });
    refreshCustomerSnapshot(webActor(owner), finalId);
    expect(row(owner, finalId).status).toBe("sent");
    assertConsistent(db, owner);
  });

  test("faktura uhrazená zálohou jde stornovat a vrácení storna dopočítá stav", () => {
    const { owner, advanceId } = paidAdvance();
    const finalId = issue(owner, convert(owner, advanceId));
    expect(row(owner, finalId).status).toBe("paid");

    cancelInvoice(webActor(owner), finalId);

    expect(row(owner, finalId)).toMatchObject({ status: "cancelled", cancelledFrom: "paid" });
    expect(row(owner, advanceId).supersededAt).toBeNull();
    assertConsistent(db, owner);

    refund(owner, advanceId, 1_000_000);
    restoreInvoice(webActor(owner), finalId);

    expect(row(owner, finalId)).toMatchObject({ status: "issued", advanceMinor: 0 });
    assertConsistent(db, owner);
  });

  test("faktura s vlastní platbou stornovat nejde ani po záloze", () => {
    const { owner, advanceId } = paidAdvance();
    const finalId = convert(owner, advanceId);
    setFinalDraft(owner, finalId, 1_210_000);
    issue(owner, finalId);
    pay(owner, finalId, 100_000);

    expect(() => cancelInvoice(webActor(owner), finalId)).toThrow(V.hasPayments);
  });

  test("[CRN-005] oprava konečné faktury a vrácení na záloze dá credited", () => {
    const { owner, advanceId } = paidAdvance();
    const finalId = issue(owner, convert(owner, advanceId));
    const note = createCreditNote(webActor(owner), finalId);
    issue(owner, note.id);

    expect(row(owner, finalId)).toMatchObject({ status: "paid", creditsMinor: -1_000_000 });
    expect(amountDue(row(owner, finalId))).toBe(-1_000_000);
    assertConsistent(db, owner);

    refund(owner, advanceId, 1_000_000);

    expect(row(owner, finalId)).toMatchObject({ status: "credited", advanceMinor: 0 });
    assertConsistent(db, owner);
  });

  test("měna konečné faktury je zamčená i při úpravě", () => {
    const { owner, advanceId } = paidAdvance();
    const finalId = issue(owner, convert(owner, advanceId));
    const doc = row(owner, finalId);

    expect(() =>
      updateIssuedInvoice(webActor(owner), finalId, {
        ...doc,
        number: doc.number!,
        currency: "EUR",
        bankAccountId: seedBankAccount(db, owner, NOW, { currency: "EUR" }),
        exchangeRateMicros: 25_000_000,
      }),
    ).toThrow(V.currencyHasCredits);
  });

  test("měna zálohy s konečnou fakturou je zamčená", () => {
    const { owner, customerId } = account();
    const advanceId = issuedAdvance(owner, customerId);
    convert(owner, advanceId);
    const doc = row(owner, advanceId);

    expect(() =>
      updateIssuedInvoice(webActor(owner), advanceId, {
        ...doc,
        number: doc.number!,
        currency: "EUR",
        bankAccountId: seedBankAccount(db, owner, NOW, { currency: "EUR" }),
        exchangeRateMicros: 25_000_000,
      }),
    ).toThrow(V.currencyHasCredits);
  });

  test("změna částky zálohy s konceptem faktury nemění uhrazeno zálohou", () => {
    const { owner, advanceId } = paidAdvance();
    const finalId = convert(owner, advanceId);

    raiseTotal(owner, advanceId, 1_100_000);

    expect(row(owner, finalId).advanceMinor).toBe(1_000_000);
    assertConsistent(db, owner);
  });

  test("souběh dvou převodů dá jednu fakturu", async () => {
    const { owner, customerId } = account();
    const advanceId = issuedAdvance(owner, customerId);

    const results = await runAdvanceWorkers<{ id: string }>(
      Array.from({ length: 4 }, () => ({ ownerId: owner, advanceId })),
      db.$client.name,
    );

    expect(new Set(results.map((item) => item.id)).size).toBe(1);
    expect(
      db
        .select()
        .from(invoice)
        .where(and(eq(invoice.relatedInvoiceId, advanceId), eq(invoice.type, "invoice")))
        .all(),
    ).toHaveLength(1);
  }, 30_000);
});

describe("nahrazení zálohy", () => {
  function replaced() {
    const { owner, customerId } = account();
    const advanceId = issuedAdvance(owner, customerId);
    return { owner, customerId, advanceId, finalId: issue(owner, convert(owner, advanceId)) };
  }

  test("vystavení nahradí zálohu a zvýší revizi, koncept ne", () => {
    const { owner, customerId } = account();
    const advanceId = issuedAdvance(owner, customerId);
    const finalId = convert(owner, advanceId);
    const { revision } = row(owner, advanceId);
    expect(row(owner, advanceId).supersededAt).toBeNull();

    issue(owner, finalId);

    expect(row(owner, advanceId)).toMatchObject({ supersededAt: NOW, revision: revision + 1 });
    assertConsistent(db, owner);
  });

  test("platba na nahrazenou zálohu je odmítnutá, vrácení projde", () => {
    const { owner, customerId } = account();
    const advanceId = issuedAdvance(owner, customerId);
    pay(owner, advanceId, 400_000);
    const finalId = issue(owner, convert(owner, advanceId));

    expect(() => pay(owner, advanceId, 100_000)).toThrow(E.superseded);
    refund(owner, advanceId, 100_000);

    expect(row(owner, advanceId).paidMinor).toBe(300_000);
    expect(row(owner, finalId).advanceMinor).toBe(300_000);
    assertConsistent(db, owner);
  });

  test("uzavření rozdílu na nahrazené záloze má vlastní hlášku", () => {
    const { owner, customerId } = account();
    const advanceId = issuedAdvance(owner, customerId);
    pay(owner, advanceId, 400_000);
    issue(owner, convert(owner, advanceId));

    expect(() =>
      closeDifference(webActor(owner), advanceId, {
        revision: row(owner, advanceId).revision,
        confirmed: true,
      }),
    ).toThrow(E.supersededDifference);
  });

  test("smazání platby zálohy zvedne doplatek na faktuře a stav se přepočítá", () => {
    const { owner, customerId } = account();
    const advanceId = issuedAdvance(owner, customerId);
    pay(owner, advanceId, 1_000_000);
    const finalId = issue(owner, convert(owner, advanceId));
    expect(row(owner, finalId).status).toBe("paid");

    deletePayment(
      webActor(owner),
      listPayments(owner, advanceId)[0]!.id,
      row(owner, advanceId).revision,
    );

    expect(row(owner, finalId)).toMatchObject({ advanceMinor: 0, status: "issued" });
    assertConsistent(db, owner);
  });

  test("storno konečné faktury vrátí zálohu mezi otevřené", () => {
    const { owner, advanceId, finalId } = replaced();
    const { revision } = row(owner, advanceId);

    cancelInvoice(webActor(owner), finalId);

    expect(row(owner, advanceId)).toMatchObject({ supersededAt: null, revision: revision + 1 });
    expect(listInvoices(owner, { type: "advance", status: "issued" }).rows).toHaveLength(1);
    expect(invoiceSummary(owner, {})[0]).toMatchObject({ advanceOpenMinor: 1_000_000 });
    assertConsistent(db, owner);
  });

  test("vrácení storna konečné faktury zálohu znovu nahradí a dopočítá zůstatek", () => {
    const { owner, advanceId, finalId } = replaced();
    cancelInvoice(webActor(owner), finalId);
    pay(owner, advanceId, 1_000_000);
    expect(row(owner, finalId)).toMatchObject({ advanceMinor: 0, status: "cancelled" });
    assertConsistent(db, owner);

    restoreInvoice(webActor(owner), finalId);

    expect(row(owner, finalId)).toMatchObject({ advanceMinor: 1_000_000, status: "paid" });
    expect(row(owner, advanceId).supersededAt).toEqual(NOW);
    assertConsistent(db, owner);
  });

  test("vrácení storna při druhé aktivní faktuře je odmítnuté", () => {
    const { owner, advanceId, finalId } = replaced();
    cancelInvoice(webActor(owner), finalId);
    const second = convert(owner, advanceId);
    expect(second).not.toBe(finalId);

    expect(() => restoreInvoice(webActor(owner), finalId)).toThrow(V.finalExists);
    assertConsistent(db, owner);
  });

  test("vrácení storna faktury ke stornované záloze je odmítnuté", () => {
    const { owner, advanceId, finalId } = replaced();
    cancelInvoice(webActor(owner), finalId);
    cancelInvoice(webActor(owner), advanceId);

    expect(() => restoreInvoice(webActor(owner), finalId)).toThrow(V.advanceCancelled);
  });

  test("unikátní index zastaví druhou aktivní fakturu a poznáme ho", () => {
    const { owner, advanceId, finalId } = replaced();
    cancelInvoice(webActor(owner), finalId);
    convert(owner, advanceId);

    let conflict: unknown;
    try {
      db.update(invoice).set({ status: "issued" }).where(eq(invoice.id, finalId)).run();
    } catch (error) {
      conflict = error;
    }

    expect(isFinalConflict(conflict)).toBe(true);
    expect(isFinalConflict(new Error("jiná chyba"))).toBe(false);
  });

  test("restoreInvoice převede porušení indexu na finalExists", () => {
    const { owner, advanceId, finalId } = replaced();
    cancelInvoice(webActor(owner), finalId);
    convert(owner, advanceId);

    hidden.final = true;
    try {
      expect(() => restoreInvoice(webActor(owner), finalId)).toThrow(V.finalExists);
    } finally {
      hidden.final = false;
    }
    expect(row(owner, finalId).status).toBe("cancelled");
  });

  test("zálohu s aktivní fakturou nejde stornovat", () => {
    const { owner, advanceId } = replaced();

    expect(() => cancelInvoice(webActor(owner), advanceId)).toThrow(V.hasFinalInvoice);
  });

  test("nahrazená záloha je mimo pohledávky a ostatní přehledy", () => {
    const { owner, customerId, advanceId } = replaced();
    db.update(invoice).set({ dueDate: "2026-01-01" }).where(eq(invoice.id, advanceId)).run();

    expect(isOverdue(row(owner, advanceId), TODAY)).toBe(false);
    expect(invoiceSummary(owner, {})[0]).toMatchObject({ advanceOpenMinor: 0, overdueMinor: 0 });
    expect(customerInvoiceStats(owner, customerId).sums[0]).toMatchObject({
      outstandingMinor: 1_000_000,
      advanceOpenMinor: 0,
    });
  });

  test("[REM-006] nahrazená záloha nedostane upomínku, ani se zapnutým přepínačem", () => {
    const { owner, advanceId } = replaced();
    markSent(webActor(owner), advanceId);
    db.update(invoice)
      .set({ dueDate: "2026-01-01", remindersPartial: true })
      .where(eq(invoice.id, advanceId))
      .run();

    expect(isEligibleForReminder(row(owner, advanceId), null)).toBe(false);
  });

  test("[QR-006] nahrazená záloha nemá QR a doplatek 6 000,00 je v QR faktury", () => {
    const { owner, customerId } = account();
    const accountId = seedBankAccount(db, owner, NOW);
    const advanceId = issuedAdvance(owner, customerId, 1_000_000, { bankAccountId: accountId });
    pay(owner, advanceId, 400_000);
    const finalId = issue(owner, convert(owner, advanceId));

    const planOf = (id: string) =>
      planQr(documentQrInput(loadInvoiceDocument(owner, id)!, "Doklad"));

    expect(planOf(advanceId).kind).toBe("none");
    expect(planOf(finalId)).toMatchObject({
      kind: "spayd",
      payload: expect.stringContaining("*AM:6000.00*"),
    });
  });

  test("zaplacená záloha nemá QR", () => {
    const { owner, customerId } = account();
    const accountId = seedBankAccount(db, owner, NOW);
    const advanceId = issuedAdvance(owner, customerId, 1_000_000, { bankAccountId: accountId });
    pay(owner, advanceId, 1_000_000);

    expect(planQr(documentQrInput(loadInvoiceDocument(owner, advanceId)!, "x")).kind).toBe("none");
  });
});

describe("souhrny", () => {
  test("[ADV-005] platba 10 000,00 zůstane na záloze a souhrn ji počítá jednou", () => {
    const { owner, customerId } = account();
    const advanceId = issuedAdvance(owner, customerId);
    pay(owner, advanceId, 1_000_000);
    const finalId = issue(owner, convert(owner, advanceId));

    expect(listPayments(owner, advanceId)).toHaveLength(1);
    expect(listPayments(owner, finalId)).toHaveLength(0);
    expect(invoiceSummary(owner, {})[0]).toMatchObject({
      invoicedMinor: 1_000_000,
      paidMinor: 1_000_000,
    });
    expect(customerInvoiceStats(owner, customerId).sums[0]).toMatchObject({
      paidMinor: 1_000_000,
      outstandingMinor: 0,
    });
  });

  test("[ADV-005] úhrada v prosinci a faktura v lednu mají příjem k datu úhrady", () => {
    const { owner, customerId } = account();
    setClockForTests({ now: () => new Date("2026-12-20T10:00:00Z") });
    const advanceId = issuedAdvance(owner, customerId);
    pay(owner, advanceId, 1_000_000, "2026-12-20");
    setClockForTests({ now: () => new Date("2027-01-10T10:00:00Z") });

    const finalId = issue(owner, convert(owner, advanceId));

    expect(row(owner, finalId).issueDate).toBe("2027-01-10");
    expect(listPayments(owner, advanceId).map((item) => item.paidOn)).toEqual(["2026-12-20"]);
    expect(listPayments(owner, finalId)).toEqual([]);
  });

  test("[ADV-007] fakturováno 10 000,00 zahrnuje konečnou fakturu, ne zálohu", () => {
    const { owner, customerId } = account();
    const advanceId = issuedAdvance(owner, customerId);

    expect(invoiceSummary(owner, {})[0]).toMatchObject({ invoicedMinor: 0 });

    issue(owner, convert(owner, advanceId));

    expect(invoiceSummary(owner, {})[0]).toMatchObject({ invoicedMinor: 1_000_000 });
  });

  test("[ADV-007] neuhrazená záloha 8 000,00 není v pohledávkách ani po splatnosti a je v advanceOpenMinor", () => {
    const { owner, customerId } = account();
    const advanceId = issuedAdvance(owner, customerId, 800_000);
    db.update(invoice).set({ dueDate: "2026-01-01" }).where(eq(invoice.id, advanceId)).run();

    expect(invoiceSummary(owner, {})[0]).toMatchObject({
      overdueMinor: 0,
      advanceOpenMinor: 800_000,
    });
    expect(customerInvoiceStats(owner, customerId).sums[0]).toMatchObject({
      outstandingMinor: 0,
      advanceOpenMinor: 800_000,
    });
  });
});

describe("stejný VS záloh a faktur", () => {
  const VS = "2026001";
  let nextId = 1;
  const income = (amountMinor: number): IngestInput =>
    ({
      bank: "fio",
      notice: {
        variant: "en",
        targetAccount: `${TARGET.number}/${TARGET.bankCode}`,
        amountMinor,
        currency: "CZK",
        occurredAt: { date: "2026-03-19", time: "14:05" },
        variableSymbol: VS,
        constantSymbol: "0308",
        counterpartyAccount: COUNTERPARTY,
        counterpartyName: "Ukazkova Firma s.r.o.",
        message: "Fiktivni platba",
        instructionId: String(nextId++),
      },
      text: `Protiucet ${COUNTERPARTY} ucet ${TARGET.number}/${TARGET.bankCode}`,
      authResult: "pass",
      requireConfirmation: true,
      receivedAt: NOW,
    }) as IngestInput;
  type Notice = typeof bankNotification.$inferSelect;

  function bankAccount() {
    const seeded = account();
    return { ...seeded, bankAccountId: seedBankAccount(db, seeded.owner, NOW) };
  }

  function bothSeries(advanceMinor: number, invoiceMinor: number) {
    const { owner, customerId, bankAccountId } = bankAccount();
    const advanceId = issuedAdvance(owner, customerId, advanceMinor, { bankAccountId });
    const invoiceId = issuedPlain(owner, customerId, invoiceMinor, { bankAccountId });
    expect(row(owner, advanceId).variableSymbol).toBe(VS);
    expect(row(owner, invoiceId).variableSymbol).toBe(VS);
    return { owner, advanceId, invoiceId };
  }

  test("stejný VS: záloha 12 000,00 a faktura 8 000,00 rozhodne částka", () => {
    const { owner, advanceId, invoiceId } = bothSeries(1_200_000, 800_000);

    expect(ingestNotice(owner, income(1_200_000))).toMatchObject<Partial<Notice>>({
      status: "matched",
    });
    expect(row(owner, advanceId).paidMinor).toBe(1_200_000);
    expect(ingestNotice(owner, income(800_000))).toMatchObject<Partial<Notice>>({
      status: "matched",
    });
    expect(row(owner, invoiceId).paidMinor).toBe(800_000);
    assertConsistent(db, owner);
  });

  test("stejný VS a stejná částka jde do fronty jako multiple", () => {
    const { owner } = bothSeries(800_000, 800_000);

    expect(ingestNotice(owner, income(800_000))).toMatchObject<Partial<Notice>>({
      status: "pending",
      reason: "multiple",
    });
  });

  test("po nahrazení zálohy jde stejný VS na konečnou fakturu", () => {
    const { owner, customerId, bankAccountId } = bankAccount();
    const advanceId = issuedAdvance(owner, customerId, 1_000_000, { bankAccountId });
    const finalId = issue(owner, convert(owner, advanceId));
    expect(row(owner, finalId).variableSymbol).toBe(VS);

    expect(ingestNotice(owner, income(1_000_000))).toMatchObject<Partial<Notice>>({
      status: "matched",
    });

    expect(row(owner, finalId)).toMatchObject({ paidMinor: 1_000_000, status: "paid" });
    expect(row(owner, advanceId).paidMinor).toBe(0);
    assertConsistent(db, owner);
  });

  test("nahrazená záloha není mezi kandidáty a pro frontu se nepočítá", () => {
    const { owner, customerId, bankAccountId } = bankAccount();
    const advanceId = issuedAdvance(owner, customerId, 1_000_000, { bankAccountId });
    const finalId = issue(owner, convert(owner, advanceId));

    const notice = ingestNotice(owner, income(555_00));

    expect(notice).toMatchObject<Partial<Notice>>({ status: "pending", reason: "amount" });
    if (notice.status === "duplicate") throw new Error("avízo je nové");
    const ids = noticeCandidates(owner, notice.id, "").candidates.map((item) => item.id);
    expect(ids).toEqual([finalId]);
  });
});

describe("kontrola konzistence", () => {
  const INDEX = sql.raw(`invoice_final_of_advance_idx`);

  function withoutIndex(run: () => void) {
    const definition = db.get<{ sql: string }>(
      sql`SELECT sql FROM sqlite_master WHERE name = 'invoice_final_of_advance_idx'`,
    )!.sql;
    db.run(sql`DROP INDEX ${INDEX}`);
    try {
      run();
    } finally {
      db.run(sql.raw(definition));
    }
  }

  test("[TST-018] dvě aktivní konečné faktury kontrola odhalí", () => {
    const { owner, customerId } = account();
    const advanceId = issuedAdvance(owner, customerId);
    issue(owner, convert(owner, advanceId));
    const stray = issuedPlain(owner, customerId, 1_000_000);

    withoutIndex(() => {
      db.update(invoice).set({ relatedInvoiceId: advanceId }).where(eq(invoice.id, stray)).run();
      expect(() => assertConsistent(db, owner)).toThrow("více aktivních konečných faktur");
      db.update(invoice).set({ relatedInvoiceId: null }).where(eq(invoice.id, stray)).run();
    });
  });

  test("[TST-018] jiná měna, chybějící nahrazení a sedící advance_minor", () => {
    const { owner, customerId } = account();
    const advanceId = issuedAdvance(owner, customerId);
    const finalId = issue(owner, convert(owner, advanceId));

    db.update(invoice).set({ supersededAt: null }).where(eq(invoice.id, advanceId)).run();
    expect(() => assertConsistent(db, owner)).toThrow("superseded_at");
    db.update(invoice).set({ supersededAt: NOW }).where(eq(invoice.id, advanceId)).run();

    db.update(invoice)
      .set({ currency: "EUR", exchangeRateMicros: 25_000_000, exchangeRateSource: "manual" })
      .where(eq(invoice.id, finalId))
      .run();
    expect(() => assertConsistent(db, owner)).toThrow("jiné měně");
  });

  test("[TST-018] kontrola odhalí jiného zákazníka a nesedící advance_minor", () => {
    const { owner, customerId } = account();
    const advanceId = issuedAdvance(owner, customerId);
    const finalId = issue(owner, convert(owner, advanceId));

    db.update(invoice)
      .set({ customerId: seedCustomer(owner) })
      .where(eq(invoice.id, finalId))
      .run();
    expect(() => assertConsistent(db, owner)).toThrow("jiného zákazníka");
    db.update(invoice).set({ customerId }).where(eq(invoice.id, finalId)).run();

    db.update(invoice).set({ advanceMinor: 100 }).where(eq(invoice.id, finalId)).run();
    expect(() => assertConsistent(db, owner)).toThrow("advance_minor");
  });

  test("[TST-018] stornovaná konečná faktura smí mít advance_minor starý", () => {
    const { owner, customerId } = account();
    const advanceId = issuedAdvance(owner, customerId);
    const finalId = issue(owner, convert(owner, advanceId));
    cancelInvoice(webActor(owner), finalId);
    pay(owner, advanceId, 500_000);

    expect(() => assertConsistent(db, owner)).not.toThrow();
    expect(row(owner, finalId).advanceMinor).toBe(0);
  });
});

describe("audit", () => {
  test("[AUD-001] převod a nahrazení jsou v auditu", () => {
    const { owner, customerId } = account();
    const advanceId = issuedAdvance(owner, customerId);
    const finalId = convert(owner, advanceId);
    issue(owner, finalId);
    cancelInvoice(webActor(owner), finalId);

    const actions = (id: string) =>
      db
        .select({ action: auditLog.action })
        .from(auditLog)
        .where(eq(auditLog.entityId, id))
        .all()
        .map((item) => item.action);

    expect(actions(finalId)).toContain("invoice.final_from_advance");
    expect(actions(advanceId).filter((item) => item === "invoice.superseded")).toHaveLength(2);
  });
});
