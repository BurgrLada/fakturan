import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { invoiceDocument } from "@/lib/invoice-document";
import { MAX_BULK_DOCUMENTS } from "@/lib/invoice";
import type { PaymentInput } from "@/lib/payments";
import { documentQrInput, qrStateOf } from "@/lib/qr-payload";
import { TEXTS } from "@/lib/texts";
import { setClockForTests } from "@/server/clock";
import { auditLog, invoice, payment, user } from "@/server/db/schema";
import {
  applySent,
  cancelInvoice,
  issueInvoice,
  markSent,
} from "@/server/services/invoice-lifecycle";
import { updateIssuedInvoice } from "@/server/services/invoice-versions";
import {
  customerInvoiceStats,
  getInvoice,
  invoiceSummary,
  listInvoices,
} from "@/server/services/invoices";
import {
  addPayment,
  applyPayments,
  averagePaymentDays,
  closeDifference,
  deletePayment,
  listPayments,
  markPaid,
  markPaidMany,
  updatePayment,
} from "@/server/services/payments";
import { deleteUser, USER_OWNED_TABLES } from "@/server/services/users";
import { assertConsistent } from "../helpers/consistency";
import { createTestDb } from "../helpers/db";
import {
  draftFor,
  issuedInvoice,
  seedCustomer,
  seedOwner,
  webActor,
} from "../helpers/fixtures-mail";
import { assertIsolated } from "../helpers/isolation";

vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-payments-")));

const db = createTestDb();
const E = TEXTS.payments.errors;
const V = TEXTS.invoices.validation;
const TOTAL = 300_000;
const NOW = new Date("2026-03-20T10:00:00Z");

let current = NOW;

beforeEach(() => {
  current = NOW;
  setClockForTests({ now: () => current });
});
afterEach(() => setClockForTests(null));

function account() {
  const owner = seedOwner(db, NOW);
  const customerId = seedCustomer(owner);
  return { owner, customerId, id: issuedInvoice(owner, customerId) };
}

const row = (owner: string, id: string) => getInvoice(owner, id)!;
const revisionOf = (owner: string, id: string) => row(owner, id).revision;
const input = (owner: string, id: string, over: Partial<PaymentInput> = {}): PaymentInput => ({
  revision: revisionOf(owner, id),
  paidOn: "2026-03-20",
  amountMinor: 100_000,
  currency: "CZK",
  method: "transfer",
  note: "",
  ...over,
});
const pay = (owner: string, id: string, over: Partial<PaymentInput> = {}) =>
  addPayment(webActor(owner), id, input(owner, id, over));
const storedRevision = (id: string) =>
  db.select({ revision: invoice.revision }).from(invoice).where(eq(invoice.id, id)).get()!.revision;
const qrDocument = (owner: string, id: string) => invoiceDocument(row(owner, id));
const auditOf = (id: string) =>
  db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entity, "payment"), eq(auditLog.entityId, id)))
    .orderBy(desc(auditLog.id))
    .all();

describe("zápis plateb", () => {
  test("[PAY-002] dvě dílčí platby dají partially_paid a pak paid", () => {
    const { owner, id } = account();

    pay(owner, id);
    expect(row(owner, id)).toMatchObject({ status: "partially_paid", paidMinor: 100_000 });

    pay(owner, id, { amountMinor: 200_000 });
    expect(row(owner, id)).toMatchObject({ status: "paid", paidMinor: TOTAL });
    assertConsistent(db, owner);
  });

  test("[PAY-001] jedno kliknutí uhradí zbytek s dnešním datem a datum jde změnit", () => {
    const { owner, id } = account();
    pay(owner, id);

    const { id: paymentId } = markPaid(webActor(owner), id, { revision: revisionOf(owner, id) });
    const second = account();
    markPaid(webActor(second.owner), second.id, {
      revision: revisionOf(second.owner, second.id),
      paidOn: "2026-03-05",
    });

    expect(listPayments(owner, id).find((p) => p.id === paymentId)).toMatchObject({
      amountMinor: 200_000,
      creditedMinor: 200_000,
      paidOn: "2026-03-20",
      method: "transfer",
      source: "manual",
      kind: "payment",
    });
    expect(row(owner, id).status).toBe("paid");
    expect(listPayments(second.owner, second.id)[0]!.paidOn).toBe("2026-03-05");
  });

  test("hotovost a karta se při úhradě jedním klikem promítnou do způsobu platby", () => {
    const owner = seedOwner(db, NOW);
    const customerId = seedCustomer(owner);
    const paidBy = (paymentMethod: "cash" | "card") => {
      const { id, revision } = draftFor(owner, customerId, { paymentMethod });
      db.update(invoice).set({ status: "issued" }).where(eq(invoice.id, id)).run();
      markPaid(webActor(owner), id, { revision });
      return listPayments(owner, id)[0]!.method;
    };

    expect(paidBy("cash")).toBe("cash");
    expect(paidBy("card")).toBe("other");
  });

  test("[PAY-001] úhrada jedním klikem odmítne nulové zbývá, budoucí i neplatné datum", () => {
    const { owner, id } = account();
    const revision = revisionOf(owner, id);

    expect(() => markPaid(webActor(owner), id, { revision, paidOn: "2026-03-21" })).toThrow(
      E.future,
    );
    expect(() => markPaid(webActor(owner), id, { revision, paidOn: "2026-13-01" })).toThrow(E.date);

    markPaid(webActor(owner), id, { revision });
    expect(() => markPaid(webActor(owner), id, { revision: revisionOf(owner, id) })).toThrow(
      E.nothingDue,
    );
    expect(listPayments(owner, id)).toHaveLength(1);
  });

  test("[PAY-003] platba nese datum, částku, měnu, způsob, poznámku a zdroj", () => {
    const { owner, id } = account();

    pay(owner, id, {
      paidOn: "2026-03-15",
      amountMinor: 12_345,
      method: "cash",
      note: "Na pokladně",
    });

    expect(listPayments(owner, id)).toMatchObject([
      {
        invoiceId: id,
        paidOn: "2026-03-15",
        amountMinor: 12_345,
        creditedMinor: 12_345,
        currency: "CZK",
        method: "cash",
        note: "Na pokladně",
        source: "manual",
        kind: "payment",
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
  });

  test("[PAY-004] přeplatek nechá paid a ukáže se jako přeplatek", () => {
    const { owner, id } = account();

    pay(owner, id, { amountMinor: TOTAL + 5000 });

    expect(row(owner, id)).toMatchObject({ status: "paid", paidMinor: TOTAL + 5000 });
    assertConsistent(db, owner);
  });

  test("[PAY-005] úprava a smazání přepočítají stav, po poslední platbě je zpět sent", () => {
    const { owner, id } = account();
    markSent(webActor(owner), id);
    const { id: first } = pay(owner, id, { amountMinor: TOTAL });
    expect(row(owner, id).status).toBe("paid");

    updatePayment(webActor(owner), first, input(owner, id, { amountMinor: 50_000 }));
    expect(row(owner, id)).toMatchObject({ status: "partially_paid", paidMinor: 50_000 });

    const { id: second } = pay(owner, id, { amountMinor: 250_000 });
    expect(row(owner, id).status).toBe("paid");

    deletePayment(webActor(owner), second, revisionOf(owner, id));
    expect(row(owner, id).status).toBe("partially_paid");

    deletePayment(webActor(owner), first, revisionOf(owner, id));
    expect(row(owner, id)).toMatchObject({ status: "sent", paidMinor: 0 });
    expect(listPayments(owner, id)).toEqual([]);
    assertConsistent(db, owner);
  });

  test("[PAY-006] jiná měna vyžaduje ručně připsanou částku", () => {
    const { owner, id } = account();

    expect(() => pay(owner, id, { currency: "EUR", amountMinor: 4000 })).toThrow(
      E.creditedRequired,
    );

    const { id: paymentId } = pay(owner, id, {
      currency: "EUR",
      amountMinor: 4000,
      creditedMinor: 100_000,
    });

    expect(listPayments(owner, id)[0]).toMatchObject({
      currency: "EUR",
      amountMinor: 4000,
      creditedMinor: 100_000,
    });
    expect(row(owner, id).paidMinor).toBe(100_000);
    assertConsistent(db, owner);

    updatePayment(
      webActor(owner),
      paymentId,
      input(owner, id, { currency: "CZK", amountMinor: 70_000, creditedMinor: 1 }),
    );
    expect(listPayments(owner, id)[0]!.creditedMinor).toBe(70_000);
    assertConsistent(db, owner);
  });

  test("[PAY-007] uzavření uloží rozdíl, nic nezaokrouhlí a smazání ho vrátí", () => {
    const { owner, id } = account();
    pay(owner, id, { amountMinor: TOTAL - 37 });
    const revision = revisionOf(owner, id);

    expect(() => closeDifference(webActor(owner), id, { revision, confirmed: false })).toThrow(
      E.confirmDifference,
    );
    expect(row(owner, id).status).toBe("partially_paid");

    const closed = closeDifference(webActor(owner), id, { revision, confirmed: true });

    expect(closed.differenceMinor).toBe(37);
    expect(row(owner, id)).toMatchObject({ status: "paid", paidMinor: TOTAL });
    expect(listPayments(owner, id).find((p) => p.id === closed.id)).toMatchObject({
      kind: "difference",
      method: "other",
      source: "manual",
      amountMinor: 37,
      creditedMinor: 37,
    });
    assertConsistent(db, owner);
    expect(() =>
      updatePayment(webActor(owner), closed.id, input(owner, id, { amountMinor: 1 })),
    ).toThrow(E.differenceLocked);

    deletePayment(webActor(owner), closed.id, revisionOf(owner, id));
    expect(row(owner, id)).toMatchObject({ status: "partially_paid", paidMinor: TOTAL - 37 });
  });

  test("[PAY-007] uzavřít jde jen částečně uhrazený doklad", () => {
    const { owner, id } = account();

    expect(() =>
      closeDifference(webActor(owner), id, {
        revision: revisionOf(owner, id),
        confirmed: true,
      }),
    ).toThrow(E.notClosable);
    expect(listPayments(owner, id)).toEqual([]);
  });

  test("každý zápis platby zvýší revision o 1", () => {
    const { owner, id } = account();
    const start = revisionOf(owner, id);

    const { id: first } = pay(owner, id);
    expect(revisionOf(owner, id)).toBe(start + 1);
    updatePayment(webActor(owner), first, input(owner, id, { note: "stejný stav" }));
    expect(revisionOf(owner, id)).toBe(start + 2);
    markPaid(webActor(owner), id, { revision: revisionOf(owner, id) });
    expect(revisionOf(owner, id)).toBe(start + 3);
    deletePayment(webActor(owner), first, revisionOf(owner, id));
    expect(revisionOf(owner, id)).toBe(start + 4);
  });

  test("applyPayments vždy zapíše nový součet, ne přírůstek", () => {
    const { owner, id } = account();
    pay(owner, id);
    db.update(invoice).set({ paidMinor: 999 }).where(eq(invoice.id, id)).run();

    const repaired = db.transaction((tx) => applyPayments(tx, owner, id));

    expect(repaired.paidMinor).toBe(100_000);
  });

  test("zastaralá revize neprojde, dvojklik nezaloží druhou platbu", () => {
    const { owner, id } = account();
    const revision = revisionOf(owner, id);
    const same = input(owner, id);

    const { id: paymentId } = addPayment(webActor(owner), id, same);

    const stale = TEXTS.invoices.stale;
    expect(() => addPayment(webActor(owner), id, same)).toThrow(stale);
    expect(() => markPaid(webActor(owner), id, { revision })).toThrow(stale);
    expect(() => updatePayment(webActor(owner), paymentId, same)).toThrow(stale);
    expect(() => deletePayment(webActor(owner), paymentId, revision)).toThrow(stale);
    expect(() => closeDifference(webActor(owner), id, { revision, confirmed: true })).toThrow(
      stale,
    );
    expect(listPayments(owner, id)).toHaveLength(1);
  });

  test("budoucí datum a neplatný vstup odmítne i ruční platba", () => {
    const { owner, id } = account();

    expect(() => pay(owner, id, { paidOn: "2026-03-21" })).toThrow(E.future);
    expect(() => pay(owner, id, { amountMinor: 0 })).toThrow(E.amount);
    expect(() => addPayment(webActor(owner), id, null as never)).toThrow(E.invalid);

    const { id: paymentId } = pay(owner, id);
    expect(() =>
      updatePayment(webActor(owner), paymentId, input(owner, id, { paidOn: "2026-03-21" })),
    ).toThrow(E.future);
  });

  test("platba na koncept, storno a dobropis je odmítnutá", () => {
    const { owner, customerId, id } = account();
    const draft = draftFor(owner, customerId);
    const credit = draftFor(owner, customerId);
    db.update(invoice)
      .set({ status: "issued", type: "credit_note" })
      .where(eq(invoice.id, credit.id))
      .run();
    cancelInvoice(webActor(owner), id);

    for (const target of [draft.id, id, credit.id]) {
      expect(() => pay(owner, target)).toThrow(E.notPayable);
      expect(() =>
        markPaid(webActor(owner), target, { revision: revisionOf(owner, target) }),
      ).toThrow(E.notPayable);
    }
    expect(db.select().from(payment).where(eq(payment.userId, owner)).all()).toEqual([]);
  });

  test("platba z avíza má zamčené částky a nejde smazat ručně", () => {
    const { owner, id } = account();
    const { id: paymentId } = pay(owner, id);
    db.update(payment).set({ source: "notice" }).where(eq(payment.id, paymentId)).run();

    expect(() =>
      updatePayment(webActor(owner), paymentId, input(owner, id, { amountMinor: 1 })),
    ).toThrow(E.noticeLocked);
    expect(() =>
      updatePayment(
        webActor(owner),
        paymentId,
        input(owner, id, { currency: "EUR", creditedMinor: 100_000 }),
      ),
    ).toThrow(E.noticeLocked);
    expect(() => deletePayment(webActor(owner), paymentId, revisionOf(owner, id))).toThrow(
      E.noticeDelete,
    );

    updatePayment(
      webActor(owner),
      paymentId,
      input(owner, id, { paidOn: "2026-03-01", method: "other", note: "Upřesněno" }),
    );
    expect(listPayments(owner, id)[0]).toMatchObject({
      paidOn: "2026-03-01",
      method: "other",
      note: "Upřesněno",
      amountMinor: 100_000,
      source: "notice",
    });
  });
});

describe("hromadná úhrada", () => {
  test("přeskočí doklady mimo stavy a nulové zbývá, ostatní uhradí", () => {
    const { owner, customerId, id } = account();
    const second = issuedInvoice(owner, customerId);
    const paid = issuedInvoice(owner, customerId);
    markPaid(webActor(owner), paid, { revision: revisionOf(owner, paid) });
    const cancelled = issuedInvoice(owner, customerId);
    cancelInvoice(webActor(owner), cancelled);
    const draft = draftFor(owner, customerId).id;
    const stranger = account().id;

    const result = markPaidMany(webActor(owner), [
      id,
      id,
      second,
      paid,
      cancelled,
      draft,
      stranger,
    ]);

    expect(result).toEqual({ done: 2, skipped: 4 });
    expect(row(owner, id).status).toBe("paid");
    expect(row(owner, second).status).toBe("paid");
    expect(listPayments(owner, paid)).toHaveLength(1);
  });

  test("má horní mez počtu dokladů", () => {
    const { owner } = account();
    const ids = Array.from({ length: MAX_BULK_DOCUMENTS + 1 }, (_, i) => `id-${i}`);

    expect(() => markPaidMany(webActor(owner), ids)).toThrow(
      TEXTS.invoices.list.bulk.tooMany(MAX_BULK_DOCUMENTS),
    );
  });
});

describe("stav dokladu a odeslání", () => {
  test("[INV-005] platba zachová sent_at a smazání vrátí sent", () => {
    const { owner, id } = account();
    markSent(webActor(owner), id);
    const { sentAt } = row(owner, id);
    expect(sentAt).not.toBeNull();

    const { id: paymentId } = pay(owner, id);
    expect(row(owner, id)).toMatchObject({ status: "partially_paid", sentAt });

    deletePayment(webActor(owner), paymentId, revisionOf(owner, id));
    expect(row(owner, id)).toMatchObject({ status: "sent", sentAt });
  });

  test("[INV-005] odeslání po platbě doplní sent_at a stav zůstane", () => {
    const { owner, customerId, id } = account();
    const { id: paymentId } = pay(owner, id, { amountMinor: TOTAL });
    expect(row(owner, id)).toMatchObject({ status: "paid", sentAt: null });

    db.transaction((tx) => applySent(tx, owner, id));
    expect(row(owner, id)).toMatchObject({ status: "paid", sentAt: NOW });

    current = new Date("2026-03-20T11:00:00Z");
    const revision = revisionOf(owner, id);
    db.transaction((tx) => applySent(tx, owner, id));
    expect(row(owner, id)).toMatchObject({ sentAt: NOW, revision });

    deletePayment(webActor(owner), paymentId, revisionOf(owner, id));
    expect(row(owner, id).status).toBe("sent");

    const manual = issuedInvoice(owner, customerId);
    pay(owner, manual);
    markSent(webActor(owner), manual);
    expect(row(owner, manual)).toMatchObject({ status: "partially_paid", sentAt: current });
    expect(() => markSent(webActor(owner), manual)).toThrow(V.notMarkable);
  });

  test("storno dokladu s platbou je odmítnuté", () => {
    const { owner, id } = account();
    const { id: paymentId } = pay(owner, id);

    expect(() => cancelInvoice(webActor(owner), id)).toThrow(V.hasPayments);

    deletePayment(webActor(owner), paymentId, revisionOf(owner, id));
    cancelInvoice(webActor(owner), id);
    expect(row(owner, id).status).toBe("cancelled");
  });

  test("storno odmítne i doklad, který podle součtu stále čeká na úhradu", () => {
    const { owner, id } = account();
    pay(owner, id);
    db.update(invoice).set({ status: "issued" }).where(eq(invoice.id, id)).run();

    expect(() => cancelInvoice(webActor(owner), id)).toThrow(V.hasPayments);
  });

  test("[QR-005] skutečně uhrazená faktura QR nemá, po smazání platby ano", () => {
    const { owner, id } = account();
    expect(qrStateOf(qrDocument(owner, id))).toBe("spayd");

    const { id: paymentId } = markPaid(webActor(owner), id, {
      revision: revisionOf(owner, id),
    });
    expect(qrStateOf(qrDocument(owner, id))).toBe("paid");

    deletePayment(webActor(owner), paymentId, revisionOf(owner, id));
    expect(qrStateOf(qrDocument(owner, id))).toBe("spayd");
  });

  test("[QR-006] částka v QR je zbytek po skutečné platbě", () => {
    const { owner, id } = account();

    pay(owner, id, { amountMinor: 120_000 });

    expect(documentQrInput(qrDocument(owner, id), "").dueMinor).toBe(180_000);
  });
});

describe("doklad s nulovou částkou", () => {
  const zeroLine = {
    catalogItemId: null,
    name: "Bez ceny",
    description: "",
    quantityMilli: 1000,
    unit: "ks",
    unitPriceMinor: 0,
    discountKind: "none" as const,
    discountValue: 0,
  };

  test("platbu nepřijme a úhradu jedním klikem také ne", () => {
    const owner = seedOwner(db, NOW);
    const customerId = seedCustomer(owner);
    const { id, revision } = draftFor(owner, customerId, { lines: [zeroLine] });
    issueInvoice(webActor(owner), id, { revision });

    expect(() => pay(owner, id)).toThrow(E.zeroTotal);
    expect(() => markPaid(webActor(owner), id, { revision: revisionOf(owner, id) })).toThrow(
      E.nothingDue,
    );
    expect(listPayments(owner, id)).toEqual([]);
  });

  test("úprava na nulu po platbě varuje přeplatkem a nezkreslí souhrny", () => {
    const { owner, customerId, id } = account();
    const late = { dueDate: "2026-03-20" };
    db.update(invoice).set(late).where(eq(invoice.id, id)).run();
    pay(owner, id);
    current = new Date("2026-04-20T10:00:00Z");
    const edit = { ...row(owner, id), number: row(owner, id).number! };

    const result = updateIssuedInvoice(webActor(owner), id, { ...edit, lines: [zeroLine] });

    expect(result.balanceWarning).toBe("overpaid");
    expect(row(owner, id)).toMatchObject({ status: "issued", totalMinor: 0, paidMinor: 100_000 });
    expect(customerInvoiceStats(owner, customerId).sums[0]!.outstandingMinor).toBe(0);
    expect(invoiceSummary(owner, {})[0]!.overdueMinor).toBe(0);
    expect(listInvoices(owner, { status: "overdue" }).rows).toEqual([]);
    expect(listInvoices(owner, {}).rows[0]!.overdue).toBe(false);
    assertConsistent(db, owner);
  });
});

describe("průměrná doba úhrady", () => {
  test("počítá uhrazené doklady podle poslední platby a vynechá doklady s rozdílem", () => {
    const { owner, customerId, id } = account();
    expect(averagePaymentDays(owner, customerId)).toBeNull();
    expect(customerInvoiceStats(owner, customerId).averageDays).toBeNull();

    db.update(invoice).set({ issueDate: "2026-03-01" }).where(eq(invoice.id, id)).run();
    pay(owner, id, { paidOn: "2026-03-05", amountMinor: 100_000 });
    pay(owner, id, { paidOn: "2026-03-11", amountMinor: 200_000 });

    const partial = issuedInvoice(owner, customerId);
    pay(owner, partial, { paidOn: "2026-03-20" });

    const closed = issuedInvoice(owner, customerId);
    pay(owner, closed, { paidOn: "2026-03-20", amountMinor: TOTAL - 1 });
    closeDifference(webActor(owner), closed, {
      revision: revisionOf(owner, closed),
      confirmed: true,
    });

    expect(averagePaymentDays(owner, customerId)).toBe(10);

    const other = issuedInvoice(owner, customerId);
    db.update(invoice).set({ issueDate: "2026-03-10" }).where(eq(invoice.id, other)).run();
    pay(owner, other, { paidOn: "2026-03-15", amountMinor: TOTAL });

    expect(averagePaymentDays(owner, customerId)).toBe(7.5);
    expect(customerInvoiceStats(owner, customerId).averageDays).toBe(7.5);
    expect(averagePaymentDays(account().owner, customerId)).toBeNull();
  });
});

describe("izolace a audit", () => {
  test("[TST-009] izolace plateb včetně update a remove", async () => {
    await assertIsolated({
      owners: [seedOwner(db, NOW), seedOwner(db, NOW)],
      create: (owner) => {
        const id = issuedInvoice(owner);
        return { invoiceId: id, paymentId: pay(owner, id).id };
      },
      find: (owner, { invoiceId, paymentId }) =>
        listPayments(owner, invoiceId).find((p) => p.id === paymentId),
      update: (owner, { invoiceId, paymentId }) => {
        updatePayment(webActor(owner), paymentId, {
          revision: storedRevision(invoiceId),
          paidOn: "2026-03-20",
          amountMinor: 1,
          currency: "CZK",
          method: "transfer",
          note: "",
        });
        return 1;
      },
      remove: (owner, { invoiceId, paymentId }) => {
        deletePayment(webActor(owner), paymentId, storedRevision(invoiceId));
        return 1;
      },
    });
  });

  test("cizí doklad platbu nepřijme", () => {
    const { owner, id } = account();
    const stranger = account().owner;

    expect(() => addPayment(webActor(stranger), id, input(owner, id))).toThrow(V.notFound);
    expect(() => markPaid(webActor(stranger), id, { revision: 1 })).toThrow(V.notFound);
    expect(() => closeDifference(webActor(stranger), id, { revision: 1, confirmed: true })).toThrow(
      V.notFound,
    );
    expect(listPayments(stranger, id)).toEqual([]);
  });

  test("cizí platbu nejde upravit ani smazat", () => {
    const { owner, id } = account();
    const stranger = account().owner;
    const { id: paymentId } = pay(owner, id);
    const revision = storedRevision(id);

    expect(() => updatePayment(webActor(stranger), paymentId, input(owner, id))).toThrow(
      E.notFound,
    );
    expect(() => deletePayment(webActor(stranger), paymentId, revision)).toThrow(E.notFound);
    expect(listPayments(owner, id)).toHaveLength(1);
    expect(storedRevision(id)).toBe(revision);
  });

  test("smazání účtu smaže i jeho platby", () => {
    const { owner, id } = account();
    pay(owner, id);
    expect(USER_OWNED_TABLES.indexOf(payment)).toBeLessThan(USER_OWNED_TABLES.indexOf(invoice));

    const admin = seedOwner(db, NOW);
    db.update(user).set({ role: "admin" }).where(eq(user.id, admin)).run();
    deleteUser(webActor(admin), owner, `${owner}@example.cz`);

    expect(db.select().from(payment).where(eq(payment.userId, owner)).all()).toEqual([]);
  });

  test("[AUD-001] každá změna platby je v auditu", () => {
    const { owner, id } = account();

    const { id: created } = pay(owner, id, { amountMinor: 100_000 });
    updatePayment(webActor(owner), created, input(owner, id, { amountMinor: 250_000 }));
    const closed = closeDifference(webActor(owner), id, {
      revision: revisionOf(owner, id),
      confirmed: true,
    });
    deletePayment(webActor(owner), closed.id, revisionOf(owner, id));
    const paid = markPaid(webActor(owner), id, { revision: revisionOf(owner, id) });

    expect(auditOf(created).map((entry) => entry.action)).toEqual([
      "payment.update",
      "payment.create",
    ]);
    expect(auditOf(created)[1]).toMatchObject({
      ownerId: owner,
      scope: "user",
      before: { invoiceId: id, status: "issued" },
      after: {
        invoiceId: id,
        amountMinor: 100_000,
        currency: "CZK",
        status: "partially_paid",
      },
    });
    expect(auditOf(created)[0]).toMatchObject({
      before: { amountMinor: 100_000, status: "partially_paid" },
      after: { amountMinor: 250_000, status: "partially_paid" },
    });
    expect(auditOf(closed.id).map((entry) => entry.action)).toEqual([
      "payment.delete",
      "payment.close_difference",
    ]);
    expect(auditOf(closed.id)[0]).toMatchObject({
      before: { amountMinor: 50_000, currency: "CZK", status: "paid" },
      after: { status: "partially_paid" },
    });
    expect(auditOf(paid.id)[0]).toMatchObject({
      action: "payment.mark_paid",
      after: { amountMinor: 50_000, currency: "CZK", status: "paid" },
    });
  });
});
