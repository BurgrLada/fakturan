import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { InvoiceDocument } from "@/lib/invoice-document";
import { documentQrInput, planQr } from "@/lib/qr-payload";
import { TEXTS } from "@/lib/texts";
import { setClockForTests } from "@/server/clock";
import { auditLog, exchangeRate, invoice, numberSeries, payment } from "@/server/db/schema";
import { renderInvoicePdf } from "@/server/pdf/render";
import { buildInvoiceView } from "@/server/pdf/view";
import { hideBankAccount, listBankAccounts } from "@/server/services/bank-accounts";
import {
  createCreditNote,
  creditableMinor,
  relatedDocuments,
} from "@/server/services/credit-notes";
import { loadInvoiceDocument } from "@/server/services/invoice-document";
import {
  cancelInvoice,
  checkIssuable,
  issueInvoice,
  markSent,
  restoreInvoice,
} from "@/server/services/invoice-lifecycle";
import { templateFromInvoice } from "@/server/services/invoice-templates";
import {
  listVersions,
  restoreVersion,
  updateIssuedInvoice,
  type EditResult,
} from "@/server/services/invoice-versions";
import {
  customerInvoiceStats,
  duplicateInvoice,
  getInvoice,
  invoiceSummary,
  newDraftDefaults,
  saveDraft,
  type DraftInput,
  type IssuedInput,
} from "@/server/services/invoices";
import {
  addPayment,
  addRefund,
  closeDifference,
  deletePayment,
  updatePayment,
} from "@/server/services/payments";
import { assertConsistent } from "../helpers/consistency";
import { createTestDb } from "../helpers/db";
import { pdfText } from "../helpers/pdf";
import { draftFor, seedCustomer, seedOwner, webActor } from "../helpers/fixtures-mail";

vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-credit-notes-")));
vi.setConfig({ testTimeout: 30_000 });

const db = createTestDb();
const NOW = new Date("2026-03-20T10:00:00Z");
const TODAY = "2026-03-20";
const V = TEXTS.invoices.validation;
const E = TEXTS.payments.errors;

beforeEach(() => setClockForTests({ now: () => NOW }));
afterEach(() => setClockForTests(null));

type LineInput = DraftInput["lines"][number];

const line = (unitPriceMinor: number, over: Partial<LineInput> = {}): LineInput => ({
  catalogItemId: null,
  name: "Konzultace",
  description: "",
  quantityMilli: 1000,
  unit: "ks",
  unitPriceMinor,
  discountKind: "none",
  discountValue: 0,
  ...over,
});

function setup(totalMinor = 100_000, over: Partial<DraftInput> = {}) {
  const owner = seedOwner(db, NOW);
  const customerId = seedCustomer(owner);
  const { id, revision } = draftFor(owner, customerId, {
    rounding: "none",
    lines: [line(totalMinor)],
    ...over,
  });
  issueInvoice(webActor(owner), id, { revision });
  return { owner, customerId, id, actor: webActor(owner) };
}

const row = (owner: string, id: string) => getInvoice(owner, id)!;

function draftInput(owner: string, id: string, over: Partial<DraftInput> = {}): DraftInput {
  const { lines, ...doc } = row(owner, id);
  return {
    id,
    revision: doc.revision,
    type: doc.type,
    customerId: doc.customerId,
    seriesId: doc.seriesId,
    bankAccountId: doc.bankAccountId,
    issueDate: doc.issueDate,
    dueDate: doc.dueDate,
    taxableDate: doc.taxableDate,
    language: doc.language,
    currency: doc.currency,
    exchangeRateMicros: doc.exchangeRateMicros,
    paymentMethod: doc.paymentMethod,
    orderRef: doc.orderRef,
    reference: doc.reference,
    textBefore: doc.textBefore,
    textAfter: doc.textAfter,
    note: doc.note,
    discountKind: doc.discountKind,
    discountValue: doc.discountValue,
    rounding: doc.rounding,
    appearance: doc.appearance,
    lines: lines.map((item) => ({
      catalogItemId: item.catalogItemId,
      name: item.name,
      description: item.description,
      quantityMilli: item.quantityMilli,
      unit: item.unit,
      unitPriceMinor: item.unitPriceMinor,
      discountKind: item.discountKind,
      discountValue: item.discountValue,
    })),
    ...over,
  };
}

function issuedInput(owner: string, id: string, over: Partial<IssuedInput> = {}): IssuedInput {
  const { id: _i, type: _t, customerId: _c, seriesId: _s, ...fields } = draftInput(owner, id);
  const doc = row(owner, id);
  return { ...fields, number: doc.number!, variableSymbol: doc.variableSymbol ?? "", ...over };
}

function noteOf(owner: string, id: string, totalMinor?: number): string {
  const actor = webActor(owner);
  const { id: noteId } = createCreditNote(actor, id);
  if (totalMinor !== undefined) {
    saveDraft(actor, draftInput(owner, noteId, { lines: [line(totalMinor)] }));
  }
  return noteId;
}

const issue = (owner: string, id: string) =>
  issueInvoice(webActor(owner), id, { revision: row(owner, id).revision });

function issuedNote(owner: string, id: string, totalMinor?: number): string {
  const noteId = noteOf(owner, id, totalMinor);
  issue(owner, noteId);
  return noteId;
}

const money = (revision: number, amountMinor: number) => ({
  revision,
  paidOn: TODAY,
  amountMinor,
  currency: "CZK" as const,
  method: "transfer" as const,
  note: "",
});

const pay = (owner: string, id: string, amountMinor: number) =>
  addPayment(webActor(owner), id, money(row(owner, id).revision, amountMinor));
const refund = (owner: string, id: string, amountMinor: number) =>
  addRefund(webActor(owner), id, money(row(owner, id).revision, amountMinor));

describe("vznik opravy", () => {
  test("[CRN-001] opravná faktura vzniká jen z vystavené faktury a odkazuje na ni", () => {
    const { owner, customerId, id, actor } = setup();
    const draft = draftFor(owner, customerId);
    const cancelled = setup();
    cancelInvoice(cancelled.actor, cancelled.id);

    const { id: noteId } = createCreditNote(actor, id);

    expect(row(owner, noteId)).toMatchObject({
      type: "credit_note",
      status: "draft",
      relatedInvoiceId: id,
      customerId,
      textBefore: "",
      issueDate: TODAY,
      dueDate: TODAY,
    });
    expect(() => createCreditNote(actor, draft.id)).toThrow(V.notCreditable);
    expect(() => createCreditNote(cancelled.actor, cancelled.id)).toThrow(V.notCreditable);
    issue(owner, noteId);
    expect(() => createCreditNote(actor, noteId)).toThrow(V.notCreditable);
    expect(() =>
      saveDraft(actor, { ...newDraftDefaults(owner, customerId), type: "credit_note" }),
    ).toThrow(V.creditNoteManual);
    expect(relatedDocuments(owner, id).children.map((item) => item.id)).toEqual([noteId]);
    expect(relatedDocuments(owner, noteId).parent?.id).toBe(id);
    assertConsistent(db, owner);
  });

  test("[CRN-001] má vlastní řadu D2026-001 a faktura dál 2026-002", () => {
    const { owner, customerId, id } = setup();
    const noteId = noteOf(owner, id);
    const noteSeries = db
      .select()
      .from(numberSeries)
      .where(and(eq(numberSeries.userId, owner), eq(numberSeries.documentType, "credit_note")))
      .get()!;

    expect(row(owner, noteId).seriesId).toBe(noteSeries.id);
    expect(issue(owner, noteId).number).toBe("D2026-001");
    const next = draftFor(owner, customerId);
    expect(issueInvoice(webActor(owner), next.id, { revision: next.revision }).number).toBe(
      "2026-002",
    );
  });

  test("[CRN-002] úplná oprava 12 100,00 se slevou a zaokrouhlením dá přesně -12 100,00", () => {
    const { owner, id } = setup(0, {
      rounding: "whole",
      discountKind: "amount",
      discountValue: 40_000,
      lines: [line(1_000_000), line(250_040)],
    });
    expect(row(owner, id).totalMinor).toBe(1_210_000);

    const noteId = noteOf(owner, id);

    expect(row(owner, noteId)).toMatchObject({
      subtotalMinor: -1_250_040,
      discountMinor: -40_000,
      roundingMinor: 40,
      totalMinor: -1_210_000,
    });
    expect(row(owner, noteId).lines.map((item) => item.unitPriceMinor)).toEqual([
      -1_000_000, -250_040,
    ]);
    issue(owner, noteId);
    expect(row(owner, id)).toMatchObject({ creditsMinor: -1_210_000, status: "credited" });
  });

  test("[CRN-002] částečná oprava upraveným množstvím dá -2 100,00", () => {
    const { owner, id } = setup(0, { lines: [line(70_000, { quantityMilli: 10_000 })] });
    const noteId = noteOf(owner, id);

    const { totals } = saveDraft(
      webActor(owner),
      draftInput(owner, noteId, { lines: [line(-70_000, { quantityMilli: 3000 })] }),
    );

    expect(totals.totalMinor).toBe(-210_000);
    issue(owner, noteId);
    expect(creditableMinor(db, owner, id)).toBe(490_000);
    expect(row(owner, id)).toMatchObject({ creditsMinor: -210_000, status: "issued" });
  });

  test("[CRN-003] oprava sníží fakturováno v seznamu i na kartě zákazníka z 1 000,00 na 600,00", () => {
    const { owner, customerId, id } = setup();
    expect(invoiceSummary(owner, {})[0]).toMatchObject({ invoicedMinor: 100_000 });

    issuedNote(owner, id, -40_000);

    expect(invoiceSummary(owner, {})[0]).toMatchObject({ invoicedMinor: 60_000 });
    expect(customerInvoiceStats(owner, customerId).sums[0]).toMatchObject({
      invoicedMinor: 60_000,
    });
  });

  test("oprava nejde založit ručně ani změnou typu konceptu", () => {
    const { owner, customerId, actor } = setup();
    const draft = draftFor(owner, customerId);

    expect(() => saveDraft(actor, draftInput(owner, draft.id, { type: "credit_note" }))).toThrow(
      V.creditNoteManual,
    );
    expect(row(owner, draft.id).type).toBe("invoice");
  });

  test("podvržený koncept credit_note bez odkazu na fakturu je odmítnutý", () => {
    const { owner, customerId, actor } = setup();
    const { id } = draftFor(owner, customerId);
    db.update(invoice).set({ type: "credit_note" }).where(eq(invoice.id, id)).run();

    expect(() => saveDraft(actor, draftInput(owner, id, { lines: [line(-100)] }))).toThrow(
      V.creditNoteManual,
    );
  });

  test("koncept nemůže změnit typ ani na zálohu", () => {
    const { owner, customerId, actor } = setup();
    const { id } = draftFor(owner, customerId);

    expect(() => saveDraft(actor, draftInput(owner, id, { type: "advance" }))).toThrow(
      V.typeLocked,
    );
    expect(row(owner, id).type).toBe("invoice");
  });

  test("koncept opravy má zamčený typ, zákazníka, měnu i kurz", () => {
    const { owner, id, actor } = setup();
    const noteId = noteOf(owner, id);
    const other = seedCustomer(owner, "beta@example.cz");

    for (const over of [
      { type: "invoice" as const, lines: [line(100)] },
      { customerId: other },
      { currency: "EUR" as const },
      { exchangeRateMicros: 25_000_000 },
    ]) {
      expect(() => saveDraft(actor, draftInput(owner, noteId, over))).toThrow(V.linkedLocked);
    }
  });

  test("koncept s kladným celkem vystavit nejde", () => {
    const { owner, id } = setup();
    const noteId = noteOf(owner, id, 10_000);

    expect(checkIssuable(owner, noteId).map((item) => item.message)).toContain(V.creditNotNegative);
    expect(() => issue(owner, noteId)).toThrow(V.creditNotNegative);
  });

  test("odebrat a přidat: řádky smí mít obě znaménka, celek musí být pod nulou", () => {
    const { owner, id } = setup();
    const noteId = noteOf(owner, id);
    saveDraft(
      webActor(owner),
      draftInput(owner, noteId, { lines: [line(-100_000), line(60_000)] }),
    );

    issue(owner, noteId);

    expect(row(owner, noteId).totalMinor).toBe(-40_000);
    expect(row(owner, id).creditsMinor).toBe(-40_000);
  });
});

describe("vrácení peněz", () => {
  test("[CRN-004] vrácení 1 500,00 je záporná platba a paid_minor klesne z 5 000,00 na 3 500,00", () => {
    const { owner, id } = setup(500_000);
    pay(owner, id, 500_000);

    const { id: refundId } = refund(owner, id, 150_000);

    expect(db.select().from(payment).where(eq(payment.id, refundId)).get()).toMatchObject({
      amountMinor: -150_000,
      creditedMinor: -150_000,
      kind: "payment",
      source: "manual",
    });
    expect(row(owner, id)).toMatchObject({ paidMinor: 350_000, status: "partially_paid" });
    assertConsistent(db, owner);
  });

  test("[CRN-004] vrácení nad přijatou částku je odmítnuté", () => {
    const { owner, id } = setup(500_000);
    pay(owner, id, 100_000);

    expect(() => refund(owner, id, 100_001)).toThrow(E.refundExceeds);
    expect(row(owner, id).paidMinor).toBe(100_000);
  });

  test("[CRN-004] smazání kladné platby pod vrácenou částku je odmítnuté", () => {
    const { owner, id } = setup(500_000);
    const first = pay(owner, id, 300_000);
    pay(owner, id, 200_000);
    refund(owner, id, 400_000);

    expect(() => deletePayment(webActor(owner), first.id, row(owner, id).revision)).toThrow(
      E.refundExceeds,
    );
    expect(row(owner, id).paidMinor).toBe(100_000);
  });

  test("úprava vrácení drží znaménko a nepřekročí přijatou částku", () => {
    const { owner, id } = setup(500_000);
    pay(owner, id, 500_000);
    const { id: refundId } = refund(owner, id, 150_000);
    const actor = webActor(owner);

    updatePayment(actor, refundId, money(row(owner, id).revision, 100_000));

    expect(row(owner, id).paidMinor).toBe(400_000);
    expect(() => updatePayment(actor, refundId, money(row(owner, id).revision, 500_001))).toThrow(
      E.refundExceeds,
    );
  });

  test("vrácení nejde na koncept, storno ani opravu", () => {
    const { owner, customerId, id } = setup();
    const draft = draftFor(owner, customerId);
    const noteId = issuedNote(owner, id, -10_000);
    const gone = setup();
    cancelInvoice(gone.actor, gone.id);

    for (const [who, target] of [
      [owner, draft.id],
      [owner, noteId],
      [gone.owner, gone.id],
    ] as const) {
      expect(() => refund(who, target, 100)).toThrow(E.notPayable);
    }
  });

  test("vrácení přes uzavřený rozdíl nesmí překročit skutečně přijaté peníze", () => {
    const { owner, id, actor } = setup(100_000);
    pay(owner, id, 90_000);
    closeDifference(actor, id, { revision: row(owner, id).revision, confirmed: true });

    expect(() => refund(owner, id, 90_001)).toThrow(E.refundExceeds);
    refund(owner, id, 90_000);
    expect(row(owner, id).paidMinor).toBe(10_000);
  });
});

describe("stav původní faktury", () => {
  test("[CRN-006] úplná oprava bez plateb dá credited, storno opravy vrátí sent", () => {
    const { owner, id, actor } = setup();
    markSent(actor, id);
    const noteId = issuedNote(owner, id);

    expect(row(owner, id).status).toBe("credited");
    cancelInvoice(actor, noteId);

    expect(row(owner, id)).toMatchObject({ status: "sent", creditsMinor: 0 });
    assertConsistent(db, owner);
  });

  test("[CRN-006] 5 000,00 po opravě -1 500,00 a vrácení 1 500,00 je paid bez přeplatku", () => {
    const { owner, id } = setup(500_000);
    pay(owner, id, 500_000);
    issuedNote(owner, id, -150_000);

    refund(owner, id, 150_000);

    expect(row(owner, id)).toMatchObject({
      status: "paid",
      paidMinor: 350_000,
      creditsMinor: -150_000,
    });
    assertConsistent(db, owner);
  });

  test("[CRN-006] úplná oprava a vrácení všeho dá credited a vrácení jde smazat", () => {
    const { owner, id, actor } = setup();
    pay(owner, id, 100_000);
    issuedNote(owner, id);
    expect(row(owner, id).status).toBe("paid");

    const { id: refundId } = refund(owner, id, 100_000);
    expect(row(owner, id)).toMatchObject({ status: "credited", paidMinor: 0 });

    deletePayment(actor, refundId, row(owner, id).revision);
    expect(row(owner, id)).toMatchObject({ status: "paid", paidMinor: 100_000 });
    assertConsistent(db, owner);
  });

  test("[CRN-005] vystavení, úprava a storno opravy přepočítají zůstatek a revizi původní faktury", () => {
    const { owner, id, actor } = setup();
    const noteId = noteOf(owner, id, -40_000);
    const start = row(owner, id).revision;

    issue(owner, noteId);
    expect(row(owner, id)).toMatchObject({ creditsMinor: -40_000, revision: start + 1 });

    updateIssuedInvoice(actor, noteId, issuedInput(owner, noteId, { lines: [line(-70_000)] }));
    expect(row(owner, id)).toMatchObject({ creditsMinor: -70_000, revision: start + 2 });

    cancelInvoice(actor, noteId);
    expect(row(owner, id)).toMatchObject({ creditsMinor: 0, revision: start + 3 });

    restoreInvoice(actor, noteId);
    expect(row(owner, id)).toMatchObject({ creditsMinor: -70_000, revision: start + 4 });
    assertConsistent(db, owner);
  });

  test("[CRN-005] 1 000,00, oprava -600,00, druhá -500,00 je odmítnutá, -400,00 projde a dá credited", () => {
    const { owner, id } = setup();
    issuedNote(owner, id, -60_000);

    const second = noteOf(owner, id, -50_000);
    expect(checkIssuable(owner, second).map((item) => item.message)).toContain(V.creditExceeds);
    expect(() => issue(owner, second)).toThrow(V.creditExceeds);

    saveDraft(webActor(owner), draftInput(owner, second, { lines: [line(-40_000)] }));
    issue(owner, second);

    expect(row(owner, id)).toMatchObject({ status: "credited", creditsMinor: -100_000 });
    expect(creditableMinor(db, owner, id)).toBe(0);
    assertConsistent(db, owner);
  });

  test("úprava opravy nad limit a vrácení jejího storna nad limit jsou odmítnuté", () => {
    const { owner, id, actor } = setup();
    const first = issuedNote(owner, id, -60_000);

    expect(() =>
      updateIssuedInvoice(actor, first, issuedInput(owner, first, { lines: [line(-100_001)] })),
    ).toThrow(V.creditExceeds);
    expect(() =>
      updateIssuedInvoice(actor, first, issuedInput(owner, first, { lines: [line(10)] })),
    ).toThrow(V.creditNotNegative);

    cancelInvoice(actor, first);
    issuedNote(owner, id, -50_000);

    expect(() => restoreInvoice(actor, first)).toThrow(V.creditExceeds);
    expect(row(owner, first).status).toBe("cancelled");
  });

  test("vrácení storna opravy na stornované faktuře je odmítnuté", () => {
    const { owner, id, actor } = setup();
    const noteId = issuedNote(owner, id, -10_000);
    cancelInvoice(actor, noteId);
    cancelInvoice(actor, id);

    expect(() => restoreInvoice(actor, noteId)).toThrow(V.notCreditable);
  });

  test("koncept opravy nelze vystavit, když mezitím vyčerpala limit jiná oprava", () => {
    const { owner, id } = setup();
    const waiting = noteOf(owner, id);
    issuedNote(owner, id);

    expect(() => issue(owner, waiting)).toThrow(V.notCreditable);
  });

  test("koncept opravy po změně měny faktury vystavit nejde", () => {
    const { owner, id, actor } = setup();
    const noteId = noteOf(owner, id);
    updateIssuedInvoice(
      actor,
      id,
      issuedInput(owner, id, {
        currency: "EUR",
        exchangeRateMicros: 25_000_000,
        paymentMethod: "cash",
        bankAccountId: null,
      }),
    );

    expect(() => issue(owner, noteId)).toThrow(V.currencyHasCredits);
  });

  test("[INV-002] faktura s opravou nejde stornovat", () => {
    const { owner, id, actor } = setup();
    const noteId = issuedNote(owner, id, -10_000);

    expect(() => cancelInvoice(actor, id)).toThrow(V.hasCredits);

    cancelInvoice(actor, noteId);
    cancelInvoice(actor, id);
    expect(row(owner, id).status).toBe("cancelled");
  });

  test("[INV-021] oprava má verze a obnovení přepočítá původní fakturu", () => {
    const { owner, id, actor } = setup();
    const noteId = issuedNote(owner, id, -40_000);
    updateIssuedInvoice(actor, noteId, issuedInput(owner, noteId, { lines: [line(-70_000)] }));
    expect(row(owner, id).creditsMinor).toBe(-70_000);
    const revision = row(owner, id).revision;

    const [version] = listVersions(owner, noteId);
    restoreVersion(actor, version!.id);

    expect(row(owner, noteId).totalMinor).toBe(-40_000);
    expect(row(owner, id)).toMatchObject({ creditsMinor: -40_000, revision: revision + 1 });
    assertConsistent(db, owner);
  });

  test("obnovení verze opravy nad limit je odmítnuté", () => {
    const { owner, id, actor } = setup();
    const noteId = issuedNote(owner, id, -70_000);
    updateIssuedInvoice(actor, noteId, issuedInput(owner, noteId, { lines: [line(-10_000)] }));
    issuedNote(owner, id, -50_000);

    const [version] = listVersions(owner, noteId);

    expect(() => restoreVersion(actor, version!.id)).toThrow(V.creditExceeds);
  });

  test("úprava faktury s opravou nesmí snížit částku pod opravenou", () => {
    const { owner, id, actor } = setup();
    issuedNote(owner, id, -60_000);

    expect(() =>
      updateIssuedInvoice(actor, id, issuedInput(owner, id, { lines: [line(59_999)] })),
    ).toThrow(V.creditsExceedTotal);

    const result: EditResult = updateIssuedInvoice(
      actor,
      id,
      issuedInput(owner, id, { lines: [line(60_000)] }),
    );
    expect(result.status).toBe("credited");
    assertConsistent(db, owner);
  });

  test("úprava vystavené opravy nehlásí přeplatek", () => {
    const { owner, id, actor } = setup();
    const noteId = issuedNote(owner, id, -40_000);

    const result = updateIssuedInvoice(
      actor,
      noteId,
      issuedInput(owner, noteId, { lines: [line(-30_000)] }),
    );

    expect(result.balanceWarning).toBe("none");
  });

  test("přečíslování původní faktury nezmění vystavenou opravu", () => {
    const { owner, id, actor } = setup();
    const noteId = issuedNote(owner, id, -10_000);
    const before = row(owner, id);

    updateIssuedInvoice(actor, id, issuedInput(owner, id, { number: "2026-099" }));

    expect(row(owner, noteId).relatedSnapshot).toEqual({
      type: "invoice",
      number: before.number,
      issueDate: before.issueDate,
    });
    expect(relatedDocuments(owner, noteId).parent?.number).toBe("2026-099");
  });

  test("kurz a měna faktury s opravou jsou zamčené i při obnovení verze", () => {
    const { owner, id, actor } = setup(100_000, {
      currency: "EUR",
      exchangeRateMicros: 25_000_000,
      paymentMethod: "cash",
      bankAccountId: null,
    });
    updateIssuedInvoice(actor, id, issuedInput(owner, id, { exchangeRateMicros: 26_000_000 }));
    issuedNote(owner, id, -10_000);

    expect(() =>
      updateIssuedInvoice(actor, id, issuedInput(owner, id, { exchangeRateMicros: 27_000_000 })),
    ).toThrow(V.currencyHasCredits);
    expect(() =>
      updateIssuedInvoice(actor, id, issuedInput(owner, id, { currency: "CZK" })),
    ).toThrow(V.currencyHasCredits);
    const [version] = listVersions(owner, id);
    expect(() => restoreVersion(actor, version!.id)).toThrow(V.currencyHasCredits);
  });

  test("[FOR-003] oprava zdědí kurz, jeho zdroj i datum a vystavení je nepřepočítá", () => {
    const { owner, id } = setup(100_000, {
      currency: "EUR",
      exchangeRateMicros: 25_000_000,
      paymentMethod: "cash",
      bankAccountId: null,
    });
    db.update(invoice)
      .set({ exchangeRateSource: "last_known", exchangeRateDate: "2026-03-02" })
      .where(eq(invoice.id, id))
      .run();
    db.insert(exchangeRate)
      .values({
        currency: "EUR",
        listDate: row(owner, id).issueDate!,
        rateMicros: 30_000_000,
        fetchedAt: NOW,
      })
      .run();

    const noteId = noteOf(owner, id);
    expect(row(owner, noteId)).toMatchObject({
      exchangeRateMicros: 25_000_000,
      exchangeRateSource: "last_known",
      exchangeRateDate: "2026-03-02",
    });
    issue(owner, noteId);

    expect(row(owner, noteId)).toMatchObject({
      status: "issued",
      exchangeRateMicros: 25_000_000,
      exchangeRateSource: "last_known",
      exchangeRateDate: "2026-03-02",
    });
  });

  test("kurz a měnu vystavené opravy změnit nejde", () => {
    const { owner, id, actor } = setup(100_000, {
      currency: "EUR",
      exchangeRateMicros: 25_000_000,
      paymentMethod: "cash",
      bankAccountId: null,
    });
    const noteId = issuedNote(owner, id, -10_000);

    expect(row(owner, noteId).exchangeRateMicros).toBe(25_000_000);
    expect(() =>
      updateIssuedInvoice(
        actor,
        noteId,
        issuedInput(owner, noteId, { exchangeRateMicros: 26_000_000 }),
      ),
    ).toThrow(V.currencyHasCredits);
  });

  test("oprava nejde duplikovat ani uložit jako šablona", () => {
    const { owner, id, actor } = setup();
    const noteId = issuedNote(owner, id, -10_000);

    expect(() => duplicateInvoice(actor, noteId)).toThrow(V.creditNoteCopy);
    expect(() => templateFromInvoice(actor, noteId, "Oprava")).toThrow(V.creditNoteCopy);
  });

  test("oprava se skrytým účtem jde vystavit", () => {
    const { owner, id, actor } = setup();
    const accountId = row(owner, id).bankAccountId!;
    hideBankAccount(actor, accountId);
    expect(listBankAccounts(owner).find((item) => item.id === accountId)?.hidden).toBe(true);

    const noteId = noteOf(owner, id);
    expect(row(owner, noteId).bankAccountId).toBe(accountId);

    expect(checkIssuable(owner, noteId)).toEqual([]);
    issue(owner, noteId);
    expect(row(owner, noteId).status).toBe("issued");
  });

  test("banka opravu nikdy nepáruje", () => {
    const { owner, id } = setup(100_000);
    const noteId = issuedNote(owner, id, -10_000);
    expect(row(owner, noteId)).toMatchObject({ variableSymbol: null, variableSymbolManual: false });

    updateIssuedInvoice(webActor(owner), noteId, issuedInput(owner, noteId, { number: "D-77" }));
    expect(row(owner, noteId).variableSymbol).toBeNull();
  });

  test("[AUD-001] oprava, přepočet zůstatku a vrácení jsou v auditu", () => {
    const { owner, id } = setup();
    pay(owner, id, 100_000);
    const noteId = noteOf(owner, id, -10_000);
    issue(owner, noteId);
    const { id: refundId } = refund(owner, id, 10_000);

    const of = (action: string) =>
      db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.ownerId, owner), eq(auditLog.action, action)))
        .all();

    expect(of("invoice.credit_note")).toMatchObject([
      { entityId: noteId, after: { relatedInvoiceId: id } },
    ]);
    expect(of("invoice.balance")).toMatchObject([
      { entityId: id, after: { creditsMinor: -10_000 } },
    ]);
    expect(of("payment.refund")).toMatchObject([
      { entityId: refundId, after: { amountMinor: -10_000 } },
    ]);
  });
});

describe("PDF opravy", () => {
  const today = TODAY;
  const view = (doc: InvoiceDocument, draft = false) =>
    buildInvoiceView(doc, { today, draft, readImage: () => null });

  test("[PDF-001] PDF opravy uvede číslo a datum původní faktury a nemá VS ani QR", async () => {
    const { owner, id } = setup();
    const noteId = issuedNote(owner, id, -10_000);
    const doc = loadInvoiceDocument(owner, noteId)!;

    const built = await view(doc);
    const text = (await pdfText(await renderInvoicePdf(built))).join("\n");

    expect(built.title).toBe("Opravná faktura");
    expect(built.details).toContainEqual({
      label: "Opravuje doklad",
      value: "2026-001 ze dne 20. 3. 2026",
    });
    expect(built.totals.at(-1)).toMatchObject({ label: "Celkem opraveno", strong: true });
    expect(built.payment.qr).toBeNull();
    expect(built.payment.rows.map((item) => item.label)).not.toContain("Variabilní symbol");
    expect(planQr(documentQrInput(doc, "")).kind).toBe("none");
    expect(text).toContain("Opravná faktura");
    expect(text).toContain("2026-001");
    expect(text).not.toContain("Celkem k úhradě");
  });

  test("koncept opravy tiskne odkaz bez zamrzlého snímku a bez čekání na QR", async () => {
    const { owner, id } = setup();
    const noteId = noteOf(owner, id);

    const doc = loadInvoiceDocument(owner, noteId)!;
    const built = await view(doc, true);

    expect(doc.relatedDocument).toMatchObject({ number: "2026-001" });
    expect(row(owner, noteId).relatedSnapshot).toBeNull();
    expect(built.payment.qrPending).toBe(false);
  });

  test("anglické PDF opravy má anglické popisky", async () => {
    const { owner, id } = setup(100_000, { language: "en" });
    const noteId = issuedNote(owner, id, -10_000);

    const built = await view(loadInvoiceDocument(owner, noteId)!);

    expect(built.title).toBe("Credit note");
    expect(built.details.map((item) => item.label)).toContain("Corrects document");
    expect(built.totals.at(-1)?.label).toBe("Total credited");
  });
});
