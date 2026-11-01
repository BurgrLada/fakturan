import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ParsedNotice } from "@/lib/bank-notices/types";
import { czechAccountToIban } from "@/lib/iban";
import { notificationText } from "@/lib/notification-text";
import { TEXTS } from "@/lib/texts";
import { setClockForTests } from "@/server/clock";
import {
  auditLog,
  bankNotification,
  invoice,
  invoiceLine,
  notification,
  payment,
  user,
} from "@/server/db/schema";
import { scoped } from "@/server/db/scoped";
import { ServiceError } from "@/server/services/access";
import {
  assignNotice,
  dismissNotice,
  hasQueuedNotice,
  ingestNotice,
  listNotices,
  noticeCandidates,
  purgeNotices,
  restoreNotice,
  splitNotice,
  undoNotice,
  type IngestInput,
} from "@/server/services/bank-notices";
import { refreshBalance } from "@/server/services/invoice-balance";
import { issueInvoice } from "@/server/services/invoice-lifecycle";
import { getInvoice } from "@/server/services/invoices";
import {
  addPayment,
  closeDifference,
  deletePayment,
  insertPayment,
  updatePayment,
} from "@/server/services/payments";
import { deleteUser, USER_OWNED_TABLES } from "@/server/services/users";
import { createCreditNote } from "@/server/services/credit-notes";
import { mutate } from "@/server/services/mutation";
import { seedCreditNote, seedPayment } from "../fixtures/invoices";
import { assertConsistent } from "../helpers/consistency";
import { createTestDb } from "../helpers/db";
import {
  COUNTERPARTY,
  INVOICE_TOTAL,
  seedAccount,
  seedBankAccount,
  TARGET,
  VS,
} from "../helpers/fixtures-bank";
import { assertIsolated } from "../helpers/isolation";
import { issuedInvoice, webActor } from "../helpers/fixtures-mail";

vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-bank-notices-")));

const db = createTestDb();
const NOW = new Date("2026-11-01T10:00:00Z");
const DAY = 86_400_000;

let nextId = 1;
const parsed = (over: Partial<ParsedNotice> = {}): ParsedNotice => ({
  variant: "en",
  targetAccount: `${TARGET.number}/${TARGET.bankCode}`,
  amountMinor: INVOICE_TOTAL,
  currency: "CZK",
  occurredAt: { date: "2026-10-30", time: "14:05" },
  variableSymbol: VS,
  constantSymbol: "0308",
  counterpartyAccount: COUNTERPARTY,
  counterpartyName: "Ukazkova Firma s.r.o.",
  message: "Fiktivni platba",
  instructionId: String(nextId++),
  ...over,
});
const income = (notice: ParsedNotice, over: Partial<IngestInput> = {}): IngestInput =>
  ({
    bank: "fio",
    notice,
    text: `Protiucet ${COUNTERPARTY} ucet ${TARGET.number}/${TARGET.bankCode}`,
    authResult: "pass",
    requireConfirmation: true,
    receivedAt: NOW,
    ...over,
  }) as IngestInput;
const unrecognized = (fingerprint = "m1"): IngestInput => ({
  bank: "fio",
  notice: null,
  fingerprint,
  text: null,
  authResult: "none",
  requireConfirmation: true,
  receivedAt: NOW,
});

function pay(owner: string, id: string, amountMinor: number, paidOn: string) {
  const { revision } = getInvoice(owner, id)!;
  addPayment({ userId: owner, source: "web" }, id, {
    revision,
    paidOn,
    amountMinor,
    currency: "CZK",
    method: "transfer",
    note: "",
  });
}

const rows = (owner: string) =>
  db.select().from(bankNotification).where(eq(bankNotification.userId, owner)).all();
const payments = (owner: string) =>
  db.select().from(payment).where(eq(payment.userId, owner)).all();

beforeEach(() => setClockForTests({ now: () => NOW }));
afterEach(() => setClockForTests(null));

describe("ingestNotice", () => {
  test("avízo na dobropisovanou fakturu jde do fronty s důvodem closed", () => {
    const { owner, invoiceId } = seedAccount(db, NOW);
    const actor = webActor(owner);
    const note = createCreditNote(actor, invoiceId);
    issueInvoice(actor, note.id, { revision: getInvoice(owner, note.id)!.revision });
    expect(getInvoice(owner, invoiceId)!.status).toBe("credited");

    ingestNotice(owner, income(parsed()));

    expect(rows(owner)).toMatchObject([{ status: "pending", reason: "closed" }]);
    expect(getInvoice(owner, invoiceId)).toMatchObject({ paidMinor: 0, status: "credited" });
    expect(getInvoice(owner, note.id)).toMatchObject({ paidMinor: 0, variableSymbol: null });
  });

  test("[BNK-008] shoda VS, částky a měny na otevřené faktuře uhradí s datem z avíza", () => {
    const { owner, invoiceId } = seedAccount(db, NOW);

    const result = ingestNotice(owner, income(parsed()));

    expect(result).toMatchObject({ status: "matched", invoiceId });
    expect(getInvoice(owner, invoiceId)!.status).toBe("paid");
    expect(payments(owner)[0]).toMatchObject({ paidOn: "2026-10-30", source: "notice", note: "" });
    expect(rows(owner)[0]).toMatchObject({
      status: "matched",
      bankAccountId: expect.any(String),
      paidOn: "2026-10-30",
      paidTime: "14:05",
      variableSymbol: VS,
      reason: null,
    });
    assertConsistent(db, owner);
  });

  test("[BNK-008] dílčí zbytek se páruje proti amountDue a jiná částka jde do fronty", () => {
    const { owner, invoiceId } = seedAccount(db, NOW);

    expect(ingestNotice(owner, income(parsed({ amountMinor: 100 })))).toMatchObject({
      status: "pending",
      reason: "amount",
    });
    expect(getInvoice(owner, invoiceId)!.paidMinor).toBe(0);
    assertConsistent(db, owner);
  });

  test("[BNK-008] avízo na 6 000,00 uhradí fakturu po opravě, 12 100,00 jde do fronty", () => {
    const { owner, invoiceId } = seedAccount(db, NOW);
    const noteId = seedCreditNote(db, invoiceId, -210_000);
    db.update(invoice)
      .set({ subtotalMinor: 1_210_000, totalMinor: 1_210_000 })
      .where(eq(invoice.id, invoiceId))
      .run();
    db.update(invoiceLine)
      .set({ quantityMilli: 1000, unitPriceMinor: 1_210_000, netMinor: 1_210_000 })
      .where(eq(invoiceLine.invoiceId, invoiceId))
      .run();
    seedPayment(db, invoiceId, 400_000);
    mutate(webActor(owner), "invoice.balance", (tx, audit) =>
      refreshBalance(tx, audit, owner, invoiceId),
    );

    expect(ingestNotice(owner, income(parsed({ amountMinor: 1_210_000 })))).toMatchObject({
      status: "pending",
      reason: "amount",
    });
    expect(ingestNotice(owner, income(parsed({ amountMinor: 600_000 })))).toMatchObject({
      status: "matched",
    });
    expect(getInvoice(owner, invoiceId)).toMatchObject({ status: "paid", paidMinor: 1_000_000 });
    expect(getInvoice(owner, noteId)!.paidMinor).toBe(0);
  });

  test("[BNK-010] neznámý VS, jiná částka a jiná měna jdou do fronty bez platby", () => {
    const { owner } = seedAccount(db, NOW);
    const reasons = [
      parsed({ variableSymbol: "111" }),
      parsed({ variableSymbol: null }),
      parsed({ amountMinor: 1 }),
      parsed({ currency: "EUR" }),
    ].map((notice) => ingestNotice(owner, income(notice)));

    expect(reasons.map((result) => "reason" in result && result.reason)).toEqual([
      "unknown_vs",
      "no_vs",
      "amount",
      "currency",
    ]);
    expect(payments(owner)).toEqual([]);
    assertConsistent(db, owner);
  });

  test("[BNK-008] storno, dobropis ani koncept nejsou kandidát", () => {
    for (const change of [{ status: "cancelled" as const }, { type: "credit_note" as const }]) {
      const { owner, invoiceId } = seedAccount(db, NOW);
      db.update(invoice).set(change).where(eq(invoice.id, invoiceId)).run();
      expect(ingestNotice(owner, income(parsed()))).toMatchObject({
        status: "pending",
        reason: "unknown_vs",
      });
    }
  });

  test("[BNK-008] doklad jiného uživatele se stejným VS se nenabídne", () => {
    const first = seedAccount(db, NOW);
    const second = seedAccount(db, NOW);
    db.update(invoice).set({ variableSymbol: "111" }).where(eq(invoice.id, second.invoiceId)).run();

    expect(ingestNotice(second.owner, income(parsed()))).toMatchObject({
      status: "pending",
      reason: "unknown_vs",
    });
    expect(getInvoice(first.owner, first.invoiceId)!.paidMinor).toBe(0);
  });

  test("[BNK-007] cizí cílový účet se ignoruje a zaznamená", () => {
    const { owner, invoiceId } = seedAccount(db, NOW);

    const result = ingestNotice(owner, income(parsed({ targetAccount: "1234567899/2010" })));

    expect(result).toMatchObject({ status: "ignored", reason: "foreign_account" });
    expect(rows(owner)[0]).toMatchObject({ status: "ignored", bankAccountId: null });
    expect(getInvoice(owner, invoiceId)!.paidMinor).toBe(0);
  });

  test("[BNK-007] stejné číslo u jiné banky je cizí účet a neplatné číslo také", () => {
    const { owner } = seedAccount(db, NOW);
    expect(
      ingestNotice(owner, income(parsed({ targetAccount: `${TARGET.number}/0800` }))),
    ).toMatchObject({ status: "ignored" });
    expect(ingestNotice(owner, income(parsed({ targetAccount: "5/2010" })))).toMatchObject({
      status: "ignored",
    });
  });

  test("[BNK-007] zápis bez kódu banky znamená 2010", () => {
    const { owner } = seedAccount(db, NOW);
    expect(ingestNotice(owner, income(parsed({ targetAccount: TARGET.number })))).toMatchObject({
      status: "matched",
    });
  });

  test("[BNK-007] skrytý účet je účet uživatele", () => {
    const { owner, invoiceId } = seedAccount(db, NOW);
    db.update(invoice).set({ bankAccountId: null }).where(eq(invoice.id, invoiceId)).run();
    db.delete(bankNotification).where(eq(bankNotification.userId, owner)).run();
    const iban = czechAccountToIban("1234567899", "0800").toLowerCase();
    const hidden = seedBankAccount(db, owner, NOW, {
      number: "1234567899",
      bankCode: "0800",
      iban: iban.replace(/(.{4})/g, "$1 "),
      hidden: true,
    });

    const result = ingestNotice(
      owner,
      income(parsed({ targetAccount: "1234567899/0800", amountMinor: 1 })),
    );

    expect(result).toMatchObject({ status: "pending" });
    expect(rows(owner)[0]!.bankAccountId).toBe(hidden);
  });

  test("jiný cílový účet než na dokladu jde do fronty", () => {
    const { owner, invoiceId } = seedAccount(db, NOW);
    const other = seedBankAccount(db, owner, NOW, { number: "1234567899", bankCode: "0800" });
    db.update(invoice).set({ bankAccountId: other }).where(eq(invoice.id, invoiceId)).run();

    expect(ingestNotice(owner, income(parsed()))).toMatchObject({
      status: "pending",
      reason: "other_account",
    });
  });

  test("[BNK-006] stejné ID pokynu se zpracuje jen jednou a nic neauditujeme", () => {
    const { owner } = seedAccount(db, NOW);
    const notice = parsed();
    ingestNotice(owner, income(notice));
    const audits = db.select().from(auditLog).all().length;

    expect(ingestNotice(owner, income(notice))).toEqual({ status: "duplicate" });

    expect(payments(owner)).toHaveLength(1);
    expect(db.select().from(auditLog).all()).toHaveLength(audits);
  });

  test("[BNK-006] jiný účet se stejným ID pokynu je jiné avízo", () => {
    const { owner } = seedAccount(db, NOW);
    const notice = parsed();
    ingestNotice(owner, income(notice));
    expect(
      ingestNotice(owner, income({ ...notice, targetAccount: "1234567899/2010" })),
    ).toMatchObject({ status: "ignored" });
  });

  test("[BNK-012] nerozpoznaná zpráva se stejným otiskem se zapíše jednou", () => {
    const { owner } = seedAccount(db, NOW);
    expect(ingestNotice(owner, unrecognized())).toMatchObject({ status: "unrecognized" });
    expect(ingestNotice(owner, unrecognized())).toEqual({ status: "duplicate" });
    expect(rows(owner)[0]!.dedupeKey).not.toContain("m1");
  });

  test("[BNK-012] strop platí i pro čitelná neověřená avíza a nic se neztratí", () => {
    const { owner } = seedAccount(db, NOW);
    const forged = (over = {}) =>
      income(parsed({ variableSymbol: "1", ...over }), {
        authResult: "none",
        text: "x".repeat(9000),
      });
    for (let i = 0; i < 50; i += 1) ingestNotice(owner, forged());

    expect(rows(owner).every((row) => row.textMasked!.length === 2048)).toBe(true);

    const over = ingestNotice(owner, forged({ amountMinor: 77 }));

    expect(over).toMatchObject({ status: "pending" });
    expect(rows(owner).find((row) => row.amountMinor === 77)).toMatchObject({
      textMasked: null,
      message: null,
      counterpartyName: null,
      paidOn: "2026-10-30",
    });
    expect(
      db.select().from(notification).where(eq(notification.userId, owner)).all(),
    ).toMatchObject([{ kind: "notices_over_limit" }]);

    expect(
      ingestNotice(owner, income(parsed({ amountMinor: 78, variableSymbol: "1" }))),
    ).toMatchObject({ status: "pending" });
    expect(rows(owner).find((row) => row.amountMinor === 78)!.textMasked).not.toBeNull();
  });

  test("[BNK-006] rozpor bez ověření se zapíše do auditu a řádek nezmění", () => {
    const { owner } = seedAccount(db, NOW);
    const notice = parsed({ variableSymbol: "1" });
    ingestNotice(owner, income(notice));
    const before = rows(owner)[0]!;

    const result = ingestNotice(
      owner,
      income({ ...notice, amountMinor: 999 }, { authResult: "fail" }),
    );

    expect(result).toEqual({ status: "duplicate" });
    expect(rows(owner)).toEqual([before]);
    const entries = db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ownerId, owner), eq(auditLog.action, "notice.conflict")))
      .all();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.after).toMatchObject({ amountMinor: 999, reason: "conflict" });
  });

  test("[BNK-006] stejná zpráva znovu do auditu nejde ani po čištění", () => {
    const { owner } = seedAccount(db, NOW);
    const notice = parsed();
    ingestNotice(owner, income(notice));
    purgeNotices(new Date(NOW.getTime() + 91 * DAY));
    const audits = db.select().from(auditLog).all().length;

    expect(ingestNotice(owner, income(notice))).toEqual({ status: "duplicate" });

    expect(db.select().from(auditLog).all()).toHaveLength(audits);
  });

  test("avízo z budoucnosti dostane čas příjmu", () => {
    const { owner } = seedAccount(db, NOW);
    ingestNotice(owner, income(parsed(), { receivedAt: new Date(NOW.getTime() + DAY) }));
    expect(rows(owner)[0]!.receivedAt).toEqual(NOW);
  });

  test("audit nese jen ID, částku, měnu a důvod", () => {
    const { owner } = seedAccount(db, NOW);
    ingestNotice(owner, income(parsed()));
    ingestNotice(owner, income(parsed({ amountMinor: 5 })));
    ingestNotice(owner, income(parsed({ targetAccount: "1234567899/2010" })));
    ingestNotice(owner, unrecognized());

    const entries = db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entity, "bank_notification"), eq(auditLog.ownerId, owner)))
      .all();
    expect(entries.map((entry) => entry.action).sort()).toEqual([
      "notice.ignored",
      "notice.matched",
      "notice.queued",
      "notice.unrecognized",
    ]);
    for (const entry of entries) {
      expect(Object.keys(entry.after as object).sort()).toEqual(
        expect.arrayContaining(["amountMinor", "currency", "reason"]),
      );
    }
    const stored = JSON.stringify(
      db.select().from(auditLog).where(eq(auditLog.ownerId, owner)).all(),
    );
    expect(stored).not.toContain("Ukazkova");
    expect(stored).not.toContain("1111111116");
    expect(stored).not.toContain(TARGET.number);
    expect(stored).not.toContain("Fiktivni");
  });
});

describe("rozhodnutí po kontrole", () => {
  const forged = (notice: ParsedNotice) => income(notice, { authResult: "fail" });
  const unverified = (notice: ParsedNotice) => income(notice, { authResult: "none" });

  test("[BNK-006] pravé avízo přepíše neověřený řádek a znovu rozhodne", () => {
    const { owner, invoiceId } = seedAccount(db, NOW);
    const notice = parsed();
    ingestNotice(owner, unverified(notice));
    const before = rows(owner)[0]!;

    const result = ingestNotice(owner, income(notice));

    expect(result).toMatchObject({ status: "matched", id: before.id, invoiceId });
    expect(rows(owner)).toEqual([
      expect.objectContaining({
        id: before.id,
        status: "matched",
        authResult: "pass",
        reason: null,
      }),
    ]);
    expect(payments(owner)).toHaveLength(1);
    assertConsistent(db, owner);
  });

  test("[BNK-006] rozpor v částce, VS nebo účtu se audituje a jde do fronty", () => {
    for (const change of [
      { amountMinor: 5 },
      { variableSymbol: "999" },
      { currency: "EUR" as const },
    ]) {
      const { owner, invoiceId } = seedAccount(db, NOW);
      const notice = parsed();
      ingestNotice(owner, forged({ ...notice, ...change }));

      const result = ingestNotice(owner, income(notice));

      expect(result).toMatchObject({ status: "pending", reason: "conflict" });
      expect(rows(owner)).toEqual([
        expect.objectContaining({
          status: "pending",
          reason: "conflict",
          authResult: "pass",
          amountMinor: notice.amountMinor,
          variableSymbol: VS,
        }),
      ]);
      expect(getInvoice(owner, invoiceId)!.paidMinor).toBe(0);
      const actions = db
        .select()
        .from(auditLog)
        .where(eq(auditLog.ownerId, owner))
        .all()
        .map((entry) => entry.action);
      expect(actions).toContain("notice.conflict");
    }
  });

  test("[BNK-006] podvržený řádek s rozdílnými nulami ve VS rozpor nezaloží", () => {
    const { owner } = seedAccount(db, NOW);
    const notice = parsed();
    ingestNotice(owner, unverified({ ...notice, variableSymbol: `00${VS}` }));
    expect(ingestNotice(owner, income(notice))).toMatchObject({ status: "matched" });
  });

  test("[BNK-006] přepis se netýká ověřeného, vráceného ani vyřízeného řádku", () => {
    const { owner } = seedAccount(db, NOW);
    const verified = parsed({ amountMinor: 5 });
    ingestNotice(owner, income(verified));
    expect(ingestNotice(owner, income(verified))).toEqual({ status: "duplicate" });
    expect(ingestNotice(owner, unverified(verified))).toEqual({ status: "duplicate" });

    const undone = parsed({ amountMinor: 6 });
    ingestNotice(owner, unverified(undone));
    db.update(bankNotification)
      .set({ reason: "undone" })
      .where(eq(bankNotification.instructionId, undone.instructionId))
      .run();
    expect(ingestNotice(owner, income(undone))).toEqual({ status: "duplicate" });

    const closed = parsed({ amountMinor: 7 });
    ingestNotice(owner, unverified(closed));
    db.update(bankNotification)
      .set({ status: "dismissed" })
      .where(eq(bankNotification.instructionId, closed.instructionId))
      .run();
    expect(ingestNotice(owner, income(closed))).toEqual({ status: "duplicate" });
  });

  test("[BNK-008] ruční platba se stejnou částkou a datem pošle avízo do fronty", () => {
    const { owner, invoiceId } = seedAccount(db, NOW);
    pay(owner, invoiceId, 100_000, "2026-10-30");

    const same = ingestNotice(owner, income(parsed({ amountMinor: 200_000 })));
    expect(same).toMatchObject({ status: "matched" });

    const second = seedAccount(db, NOW);
    pay(second.owner, second.invoiceId, 150_000, "2026-10-30");
    expect(ingestNotice(second.owner, income(parsed({ amountMinor: 150_000 })))).toMatchObject({
      status: "pending",
      reason: "manual_duplicate",
    });
    expect(getInvoice(second.owner, second.invoiceId)!.paidMinor).toBe(150_000);
  });

  test("[BNK-008] budoucí datum avíza jde do fronty a nezapíše platbu", () => {
    const { owner } = seedAccount(db, NOW);
    const notice = parsed({ occurredAt: { date: "2026-11-02", time: null } });

    expect(ingestNotice(owner, income(notice))).toMatchObject({
      status: "pending",
      reason: "future_date",
    });
    expect(payments(owner)).toEqual([]);
  });

  test("insertPayment odmítne budoucí datum", () => {
    const { owner, invoiceId } = seedAccount(db, NOW);
    expect(() =>
      mutate({ userId: owner, source: "system" }, "payment.create", (tx, audit) =>
        insertPayment(tx, audit, owner, invoiceId, {
          paidOn: "2026-11-02",
          amountMinor: 1,
          currency: "CZK",
          creditedMinor: 1,
          method: "transfer",
          note: "",
          source: "notice",
        }),
      ),
    ).toThrow(TEXTS.payments.errors.future);
  });

  test("[BNK-017] retence běží od uložení, ne od data ve zprávě", () => {
    const { owner } = seedAccount(db, NOW);
    ingestNotice(owner, income(parsed(), { receivedAt: new Date(NOW.getTime() - 200 * DAY) }));

    purgeNotices(new Date(NOW.getTime() + DAY));

    expect(rows(owner)[0]!.purgedAt).toBeNull();
  });

  test("[BNK-007] avízo na cizí účet jde přiřadit ručně", () => {
    const foreign = parsed({ targetAccount: "1234567899/2010" });
    const assigned = seedAccount(db, NOW);
    const first = ingestNotice(assigned.owner, income(foreign)) as { id: string };
    assignNotice({ userId: assigned.owner, source: "web" }, first.id, {
      invoiceId: assigned.invoiceId,
    });
    expect(rows(assigned.owner)[0]).toMatchObject({ status: "matched" });
    expect(getInvoice(assigned.owner, assigned.invoiceId)!.paidMinor).toBe(INVOICE_TOTAL);
    assertConsistent(db, assigned.owner);
  });

  test("[BNK-012] zahozené ani nerozpoznané avízo přiřadit nejde", () => {
    const { owner, invoiceId } = seedAccount(db, NOW);
    const { id } = ingestNotice(owner, unrecognized()) as { id: string };
    expect(() => assignNotice({ userId: owner, source: "web" }, id, { invoiceId })).toThrow(
      TEXTS.bankQueue.errors.notPending,
    );
  });

  test("avízo ve frontě se najde podle VS bez úvodních nul a vyřízené se nepočítá", () => {
    const { owner } = seedAccount(db, NOW);
    expect(hasQueuedNotice(owner, VS)).toBe(false);
    const { id } = ingestNotice(
      owner,
      income(parsed({ amountMinor: 5, variableSymbol: `00${VS}` })),
    ) as { id: string };

    expect(hasQueuedNotice(owner, VS)).toBe(true);
    expect(hasQueuedNotice(owner, "1")).toBe(false);
    expect(hasQueuedNotice(owner, null)).toBe(false);
    expect(hasQueuedNotice(seedAccount(db, NOW).owner, VS)).toBe(false);

    dismissNotice({ userId: owner, source: "web" }, id);
    expect(hasQueuedNotice(owner, VS)).toBe(false);
  });

  test("[BNK-012] nad strop 50 za den zůstane záznam bez obsahu a trvalé upozornění", () => {
    const { owner } = seedAccount(db, NOW);
    for (let i = 0; i < 50; i += 1) {
      expect(ingestNotice(owner, unrecognized(`m${i}`))).toMatchObject({ status: "unrecognized" });
    }
    db.update(bankNotification)
      .set({ status: "dismissed" })
      .where(eq(bankNotification.userId, owner))
      .run();

    const over = ingestNotice(owner, { ...unrecognized("navic"), text: "text navic" });
    ingestNotice(owner, { ...unrecognized("navic-2"), text: "dalsi" });

    expect(over).toMatchObject({ status: "unrecognized" });
    const extra = rows(owner).filter((row) => row.status === "unrecognized");
    expect(extra).toHaveLength(2);
    expect(extra.every((row) => row.textMasked === null)).toBe(true);
    const alerts = db
      .select()
      .from(notification)
      .where(and(eq(notification.userId, owner), eq(notification.kind, "notices_over_limit")))
      .all();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.resolvedAt).toBeNull();
    expect(notificationText("notices_over_limit", alerts[0]!.params)).toContain("50");
    expect(ingestNotice(owner, income(parsed({ amountMinor: 5 })))).toMatchObject({
      status: "pending",
    });

    setClockForTests({ now: () => new Date(NOW.getTime() + DAY + 1) });
    expect(ingestNotice(owner, unrecognized("zitra"))).toMatchObject({ status: "unrecognized" });
    expect(ingestNotice(seedAccount(db, NOW).owner, unrecognized("jiny"))).toMatchObject({
      status: "unrecognized",
    });
  });

  test("[BNK-017] text při auth=fail je omezený", () => {
    const { owner } = seedAccount(db, NOW);
    const text = "x".repeat(10_000);
    ingestNotice(owner, income(parsed({ amountMinor: 5 }), { authResult: "fail", text }));
    ingestNotice(owner, income(parsed({ amountMinor: 6 }), { text }));

    const lengths = rows(owner)
      .map((row) => row.textMasked!.length)
      .sort((a, b) => a - b);
    expect(lengths).toEqual([2048, 10_000]);
  });
});

describe("maskování a retence", () => {
  test("[BNK-017] uložené údaje jsou maskované, po 90 dnech zmizí a platba zůstane", () => {
    const { owner, invoiceId } = seedAccount(db, NOW);
    ingestNotice(owner, income(parsed()));
    const stored = rows(owner)[0]!;
    expect(stored).toMatchObject({
      accountMasked: "******9999/2010",
      counterpartyMasked: "******1116/0800",
      textMasked: "Protiucet ******1116/0800 ucet ******9999/2010",
    });
    expect(JSON.stringify(stored)).not.toContain(TARGET.number);
    expect(JSON.stringify(stored)).not.toContain("1111111116");

    purgeNotices(new Date(NOW.getTime() + 89 * DAY));
    expect(rows(owner)[0]!.purgedAt).toBeNull();

    const later = new Date(NOW.getTime() + 91 * DAY);
    purgeNotices(later);
    expect(rows(owner)[0]).toMatchObject({
      purgedAt: later,
      textMasked: null,
      counterpartyName: null,
      counterpartyMasked: null,
      message: null,
      variableSymbol: null,
      constantSymbol: null,
      dedupeKey: stored.dedupeKey,
      status: "matched",
    });
    expect(payments(owner)).toHaveLength(1);
    expect(getInvoice(owner, invoiceId)!.status).toBe("paid");
    assertConsistent(db, owner);
  });

  test("[BNK-006] po 90 dnech a čištění se stejné avízo nezapočte znovu", () => {
    const { owner, invoiceId } = seedAccount(db, NOW);
    const notice = parsed();
    ingestNotice(owner, income(notice));
    purgeNotices(new Date(NOW.getTime() + 91 * DAY));

    expect(ingestNotice(owner, income(notice))).toEqual({ status: "duplicate" });

    expect(getInvoice(owner, invoiceId)!.paidMinor).toBe(INVOICE_TOTAL);
    expect(payments(owner)).toHaveLength(1);
  });

  test("[BNK-017] nevyřízené avízo se nečistí", () => {
    const { owner } = seedAccount(db, NOW);
    ingestNotice(owner, income(parsed({ amountMinor: 5 })));
    ingestNotice(owner, unrecognized());
    ingestNotice(owner, income(parsed({ targetAccount: "1234567899/2010" })));

    purgeNotices(new Date(NOW.getTime() + 91 * DAY));

    const byStatus = Object.fromEntries(rows(owner).map((row) => [row.status, row.purgedAt]));
    expect(byStatus.pending).toBeNull();
    expect(byStatus.unrecognized).toBeNull();
    expect(byStatus.ignored).not.toBeNull();
  });

  test("[BNK-017] druhé čištění nic nezapíše", () => {
    const { owner } = seedAccount(db, NOW);
    ingestNotice(owner, income(parsed()));
    purgeNotices(new Date(NOW.getTime() + 91 * DAY));
    const audits = db.select().from(auditLog).all().length;

    purgeNotices(new Date(NOW.getTime() + 92 * DAY));

    expect(db.select().from(auditLog).all()).toHaveLength(audits);
  });
});

describe("konzistence", () => {
  function broken(change: (owner: string, id: string) => void) {
    const { owner } = seedAccount(db, NOW);
    ingestNotice(owner, income(parsed()));
    change(owner, rows(owner)[0]!.id);
    return () => assertConsistent(db, owner);
  }

  test("spárované avízo bez platby je chyba", () => {
    const check = broken((owner) => {
      db.update(payment).set({ notificationId: null }).where(eq(payment.userId, owner)).run();
    });
    expect(check).toThrow(/bez platby/);
  });

  test("součet plateb avíza musí sedět", () => {
    const check = broken((_owner, id) => {
      db.update(bankNotification).set({ amountMinor: 1 }).where(eq(bankNotification.id, id)).run();
    });
    expect(check).toThrow(/částk/);
  });

  test("nevyřízené avízo s platbou je chyba", () => {
    const check = broken((_owner, id) => {
      db.update(bankNotification)
        .set({ status: "pending" })
        .where(eq(bankNotification.id, id))
        .run();
    });
    expect(check).toThrow(/nevyřízen/);
  });

  test("opakovaný dedupe_key je chyba", () => {
    const { owner } = seedAccount(db, NOW);
    ingestNotice(owner, unrecognized("a"));
    ingestNotice(owner, unrecognized("b"));
    db.$client.exec("DROP INDEX bank_notification_user_dedupe_idx");
    try {
      db.update(bankNotification)
        .set({ dedupeKey: "x" })
        .where(eq(bankNotification.userId, owner))
        .run();
      expect(() => assertConsistent(db, owner)).toThrow(/dedupe_key/);
    } finally {
      db.delete(bankNotification).where(eq(bankNotification.userId, owner)).run();
      db.$client.exec(
        "CREATE UNIQUE INDEX bank_notification_user_dedupe_idx ON bank_notification (user_id, dedupe_key)",
      );
    }
  });
});

describe("vlastnictví", () => {
  test("[TST-009] izolace avíz včetně update a remove", async () => {
    await assertIsolated<string>({
      owners: [seedAccount(db, NOW).owner, seedAccount(db, NOW).owner],
      create: (ownerId) => {
        ingestNotice(ownerId, unrecognized());
        return rows(ownerId)[0]!.id;
      },
      find: (ownerId, id) =>
        db
          .select()
          .from(bankNotification)
          .where(scoped(ownerId).where(bankNotification, (t, { eq }) => eq(t.id, id)))
          .get(),
      update: (ownerId, id) =>
        db
          .update(bankNotification)
          .set({ status: "dismissed" })
          .where(scoped(ownerId).where(bankNotification, (t, { eq }) => eq(t.id, id)))
          .run().changes,
      remove: (ownerId, id) =>
        db
          .delete(bankNotification)
          .where(scoped(ownerId).where(bankNotification, (t, { eq }) => eq(t.id, id)))
          .run().changes,
    });
  });

  test("smazání účtu smaže avíza a tabulka je před fakturou", () => {
    expect(USER_OWNED_TABLES.indexOf(payment)).toBeLessThan(
      USER_OWNED_TABLES.indexOf(bankNotification),
    );
    expect(USER_OWNED_TABLES.indexOf(bankNotification)).toBeLessThan(
      USER_OWNED_TABLES.indexOf(invoice),
    );
    const { owner } = seedAccount(db, NOW);
    ingestNotice(owner, income(parsed()));
    const admin = seedAccount(db, NOW).owner;
    db.$client.prepare("UPDATE user SET role = 'admin' WHERE id = ?").run(admin);

    const { email } = db.select().from(user).where(eq(user.id, owner)).get()!;
    deleteUser({ userId: admin, source: "web" }, owner, email);

    expect(rows(owner)).toEqual([]);
  });
});

describe("fronta", () => {
  const actor = (userId: string) => ({ userId, source: "web" as const });
  const unverified = (over: Partial<ParsedNotice> = {}) =>
    income(parsed(over), { authResult: "none" });

  function queued(over: Partial<ParsedNotice> = {}) {
    const account = seedAccount(db, NOW);
    ingestNotice(account.owner, unverified(over));
    return { ...account, noticeId: rows(account.owner)[0]!.id };
  }

  test("[BNK-010] přiřazení z fronty zapíše platbu s datem avíza", () => {
    const { owner, invoiceId, noticeId } = queued();
    expect(rows(owner)[0]).toMatchObject({ status: "pending", reason: "unverified" });

    assignNotice(actor(owner), noticeId, { invoiceId });

    expect(payments(owner)).toMatchObject([
      {
        paidOn: "2026-10-30",
        source: "notice",
        notificationId: noticeId,
        amountMinor: INVOICE_TOTAL,
      },
    ]);
    expect(getInvoice(owner, invoiceId)!.status).toBe("paid");
    expect(rows(owner)[0]!.status).toBe("matched");
    assertConsistent(db, owner);
  });

  test("[BNK-010] nabídka dokladů dá napřed shodu podle VS a nezná cizí avízo", () => {
    const { owner, invoiceId, noticeId, customerId } = queued();
    const other = issuedInvoice(owner, customerId);
    const stranger = seedAccount(db, NOW);

    const { candidates: offered, more } = noticeCandidates(owner, noticeId);

    expect(more).toBe(false);
    expect(offered[0]).toMatchObject({ id: invoiceId, suggested: true });
    expect(offered.slice(1).map((row) => row.id)).toEqual([other]);
    expect(() => noticeCandidates(stranger.owner, noticeId)).toThrow(ServiceError);
  });

  test("[BNK-010] rozdělení na dvě faktury musí dát celou částku", () => {
    const { owner, invoiceId, noticeId, customerId } = queued();
    const second = issuedInvoice(owner, customerId);

    for (const parts of [
      [
        { invoiceId, amountMinor: 100_000 },
        { invoiceId: second, amountMinor: 100_000 },
      ],
      [{ invoiceId, amountMinor: INVOICE_TOTAL }],
    ]) {
      expect(() => splitNotice(actor(owner), noticeId, { parts })).toThrow(ServiceError);
    }
    expect(payments(owner)).toEqual([]);
    expect(rows(owner)[0]!.status).toBe("pending");

    splitNotice(actor(owner), noticeId, {
      parts: [
        { invoiceId, amountMinor: 100_000 },
        { invoiceId: second, amountMinor: 200_000 },
      ],
    });

    expect(getInvoice(owner, invoiceId)).toMatchObject({
      status: "partially_paid",
      paidMinor: 100_000,
    });
    expect(getInvoice(owner, second)).toMatchObject({
      status: "partially_paid",
      paidMinor: 200_000,
    });
    expect(payments(owner).every((row) => row.notificationId === noticeId)).toBe(true);
    expect(rows(owner)[0]!.status).toBe("matched");
    assertConsistent(db, owner);
  });

  test("[BNK-010] zahození jde vrátit a nevznikne platba", () => {
    const { owner, invoiceId, noticeId } = queued();

    dismissNotice(actor(owner), noticeId);
    expect(rows(owner)[0]!.status).toBe("dismissed");
    expect(() => assignNotice(actor(owner), noticeId, { invoiceId })).toThrow(ServiceError);
    expect(() => dismissNotice(actor(owner), noticeId)).toThrow(ServiceError);
    expect(payments(owner)).toEqual([]);

    restoreNotice(actor(owner), noticeId);
    expect(rows(owner)[0]!.status).toBe("pending");
    expect(() => restoreNotice(actor(owner), noticeId)).toThrow(ServiceError);
  });

  test("[BNK-012] nerozpoznané avízo jde jen zahodit a po obnovení je zase nerozpoznané", () => {
    const { owner, invoiceId } = seedAccount(db, NOW);
    ingestNotice(owner, unrecognized());
    const id = rows(owner)[0]!.id;

    expect(() => assignNotice(actor(owner), id, { invoiceId })).toThrow(ServiceError);
    expect(() =>
      splitNotice(actor(owner), id, {
        parts: [
          { invoiceId, amountMinor: 1 },
          { invoiceId, amountMinor: 2 },
        ],
      }),
    ).toThrow(ServiceError);

    dismissNotice(actor(owner), id);
    restoreNotice(actor(owner), id);

    expect(rows(owner)[0]!.status).toBe("unrecognized");
    expect(listNotices(owner, { statuses: ["unrecognized"] })).toMatchObject([
      { id, amountMinor: null, invoices: [] },
    ]);
  });

  test("ignorované avízo z cizího účtu zahodit nejde", () => {
    const { owner } = seedAccount(db, NOW);
    ingestNotice(owner, income(parsed({ targetAccount: "1234567899/2010" })));
    const id = rows(owner)[0]!.id;

    expect(() => dismissNotice(actor(owner), id)).toThrow(ServiceError);
  });

  test("[BNK-011] přijetí částečné platby z fronty dá partially_paid", () => {
    const { owner, invoiceId } = seedAccount(db, NOW);
    ingestNotice(owner, income(parsed({ amountMinor: 100_000 })));
    const noticeId = rows(owner)[0]!.id;
    expect(rows(owner)[0]!.reason).toBe("amount");

    assignNotice(actor(owner), noticeId, { invoiceId });

    expect(getInvoice(owner, invoiceId)).toMatchObject({
      status: "partially_paid",
      paidMinor: 100_000,
    });
    assertConsistent(db, owner);
  });

  test("platba v jiné měně vyžaduje připsanou částku a přeplatek je povolený", () => {
    const { owner, invoiceId, noticeId } = queued({ currency: "EUR", amountMinor: 10_000 });

    expect(() => assignNotice(actor(owner), noticeId, { invoiceId })).toThrow(/jiné měně/);
    expect(rows(owner)[0]!.status).toBe("pending");

    assignNotice(actor(owner), noticeId, { invoiceId, creditedMinor: 310_000 });

    expect(payments(owner)[0]).toMatchObject({
      amountMinor: 10_000,
      currency: "EUR",
      creditedMinor: 310_000,
    });
    expect(getInvoice(owner, invoiceId)).toMatchObject({ status: "paid", paidMinor: 310_000 });
    assertConsistent(db, owner);
  });

  test("dvojklik: spárované avízo už přiřadit nejde a nevzniknou dvě platby", () => {
    const { owner, invoiceId, noticeId } = queued();
    assignNotice(actor(owner), noticeId, { invoiceId });

    expect(() => assignNotice(actor(owner), noticeId, { invoiceId })).toThrow(ServiceError);

    expect(payments(owner)).toHaveLength(1);
  });

  test("[BNK-014] vrácení jedním kliknutím smaže platbu, vrátí stav a avízo jde do fronty", () => {
    const { owner, invoiceId, noticeId } = queued();
    assignNotice(actor(owner), noticeId, { invoiceId });
    const revision = getInvoice(owner, invoiceId)!.revision;

    undoNotice(actor(owner), noticeId);

    expect(payments(owner)).toEqual([]);
    expect(getInvoice(owner, invoiceId)).toMatchObject({ status: "issued", paidMinor: 0 });
    expect(getInvoice(owner, invoiceId)!.revision).toBeGreaterThan(revision);
    expect(rows(owner)[0]).toMatchObject({ status: "pending", reason: "undone" });
    expect(() => undoNotice(actor(owner), noticeId)).toThrow(ServiceError);
    assertConsistent(db, owner);
  });

  test("[BNK-014] vrácené avízo se samo znovu nespáruje", () => {
    const account = seedAccount(db, NOW);
    const notice = parsed();
    expect(ingestNotice(account.owner, income(notice))).toMatchObject({ status: "matched" });
    undoNotice(actor(account.owner), rows(account.owner)[0]!.id);

    expect(ingestNotice(account.owner, income(notice))).toEqual({ status: "duplicate" });
    purgeNotices(new Date(NOW.getTime() + 91 * DAY));

    expect(payments(account.owner)).toEqual([]);
    expect(rows(account.owner)[0]).toMatchObject({ status: "pending", reason: "undone" });
    expect(getInvoice(account.owner, account.invoiceId)!.status).toBe("issued");
  });

  test("vrácení nechá sent_at a vrátí odeslanou fakturu na sent", () => {
    const { owner, invoiceId, noticeId } = queued();
    db.update(invoice).set({ sentAt: NOW, status: "sent" }).where(eq(invoice.id, invoiceId)).run();
    assignNotice(actor(owner), noticeId, { invoiceId });

    undoNotice(actor(owner), noticeId);

    expect(getInvoice(owner, invoiceId)).toMatchObject({ status: "sent", sentAt: NOW });
  });

  test("smazání platby z avíza vrátí celé avízo", () => {
    const { owner, invoiceId, noticeId, customerId } = queued();
    const second = issuedInvoice(owner, customerId);
    splitNotice(actor(owner), noticeId, {
      parts: [
        { invoiceId, amountMinor: 100_000 },
        { invoiceId: second, amountMinor: 200_000 },
      ],
    });
    const target = payments(owner).find((row) => row.invoiceId === invoiceId)!;

    deletePayment(actor(owner), target.id, getInvoice(owner, invoiceId)!.revision);

    expect(payments(owner)).toEqual([]);
    expect(getInvoice(owner, invoiceId)!.status).toBe("issued");
    expect(getInvoice(owner, second)).toMatchObject({ status: "issued", paidMinor: 0 });
    expect(rows(owner)[0]).toMatchObject({ status: "pending", reason: "undone" });
    assertConsistent(db, owner);
  });

  test("částky platby z avíza nejde upravit, datum a poznámku ano", () => {
    const { owner, invoiceId, noticeId } = queued();
    assignNotice(actor(owner), noticeId, { invoiceId });
    const [stored] = payments(owner);
    const edit = (over: object) => ({
      revision: getInvoice(owner, invoiceId)!.revision,
      paidOn: stored!.paidOn,
      amountMinor: stored!.amountMinor,
      currency: stored!.currency,
      creditedMinor: stored!.creditedMinor,
      method: stored!.method,
      note: "",
      ...over,
    });

    expect(() => updatePayment(actor(owner), stored!.id, edit({ amountMinor: 5 }))).toThrow(
      ServiceError,
    );
    updatePayment(actor(owner), stored!.id, edit({ note: "ověřeno", paidOn: "2026-10-29" }));

    expect(payments(owner)[0]).toMatchObject({ note: "ověřeno", amountMinor: INVOICE_TOTAL });
  });

  test("[SEC-002] cizí avízo ani cizí doklad service nepřijme", () => {
    const mine = queued();
    const stranger = seedAccount(db, NOW);

    for (const run of [
      () => assignNotice(actor(stranger.owner), mine.noticeId, { invoiceId: stranger.invoiceId }),
      () => dismissNotice(actor(stranger.owner), mine.noticeId),
      () => restoreNotice(actor(stranger.owner), mine.noticeId),
      () => undoNotice(actor(stranger.owner), mine.noticeId),
      () => assignNotice(actor(mine.owner), mine.noticeId, { invoiceId: stranger.invoiceId }),
    ]) {
      expect(run).toThrow(ServiceError);
    }
    expect(rows(mine.owner)[0]!.status).toBe("pending");
    expect(payments(stranger.owner)).toEqual([]);
  });

  test("[AUD-001] přiřazení, rozdělení, zahození a vrácení jsou v auditu bez osobních údajů", () => {
    const first = queued();
    const second = queued();
    const dismissed = queued({ variableSymbol: "111" });
    const split = issuedInvoice(second.owner, second.customerId);
    assignNotice(actor(first.owner), first.noticeId, { invoiceId: first.invoiceId });
    undoNotice(actor(first.owner), first.noticeId);
    splitNotice(actor(second.owner), second.noticeId, {
      parts: [
        { invoiceId: second.invoiceId, amountMinor: 100_000 },
        { invoiceId: split, amountMinor: 200_000 },
      ],
    });
    dismissNotice(actor(dismissed.owner), dismissed.noticeId);
    restoreNotice(actor(dismissed.owner), dismissed.noticeId);

    const actions = (owner: string) =>
      db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.ownerId, owner), eq(auditLog.entity, "bank_notification")))
        .all()
        .map((entry) => entry.action);
    expect(actions(first.owner)).toEqual(
      expect.arrayContaining(["notice.assigned", "notice.undone"]),
    );
    expect(actions(second.owner)).toContain("notice.split");
    expect(actions(dismissed.owner)).toEqual(
      expect.arrayContaining(["notice.dismissed", "notice.restored"]),
    );
    const stored = JSON.stringify(db.select().from(auditLog).all());
    expect(stored).not.toContain("Ukazkova");
    expect(stored).not.toContain("1111111116");
    expect(stored).not.toContain("Fiktivni");
  });

  test("vrácení odmítne doklad s uzavřeným rozdílem, ručně i smazáním platby, a projde po jeho smazání", () => {
    const { owner, invoiceId, noticeId } = queued({ amountMinor: 100_000 });
    addPayment(actor(owner), invoiceId, {
      revision: getInvoice(owner, invoiceId)!.revision,
      paidOn: "2026-10-20",
      amountMinor: 100_000,
      currency: "CZK",
      method: "transfer",
      note: "",
    });
    assignNotice(actor(owner), noticeId, { invoiceId });
    closeDifference(actor(owner), invoiceId, {
      revision: getInvoice(owner, invoiceId)!.revision,
      confirmed: true,
    });
    const notice = payments(owner).find((row) => row.notificationId === noticeId)!;

    expect(() => undoNotice(actor(owner), noticeId)).toThrow(/uzavřený rozdíl/);
    expect(() =>
      deletePayment(actor(owner), notice.id, getInvoice(owner, invoiceId)!.revision),
    ).toThrow(/uzavřený rozdíl/);
    expect(payments(owner)).toHaveLength(3);
    expect(rows(owner)[0]!.status).toBe("matched");
    assertConsistent(db, owner);

    const difference = payments(owner).find((row) => row.kind === "difference")!;
    deletePayment(actor(owner), difference.id, getInvoice(owner, invoiceId)!.revision);
    undoNotice(actor(owner), noticeId);

    expect(payments(owner)).toMatchObject([{ source: "manual", amountMinor: 100_000 }]);
    expect(getInvoice(owner, invoiceId)).toMatchObject({
      status: "partially_paid",
      paidMinor: 100_000,
    });
    assertConsistent(db, owner);
  });

  test("dvě části na týž doklad se vrátí společně", () => {
    const { owner, invoiceId, noticeId } = queued();

    splitNotice(actor(owner), noticeId, {
      parts: [
        { invoiceId, amountMinor: 100_000 },
        { invoiceId, amountMinor: 200_000 },
      ],
    });
    expect(getInvoice(owner, invoiceId)).toMatchObject({
      status: "paid",
      paidMinor: INVOICE_TOTAL,
    });

    undoNotice(actor(owner), noticeId);

    expect(payments(owner)).toEqual([]);
    expect(getInvoice(owner, invoiceId)).toMatchObject({ status: "issued", paidMinor: 0 });
    assertConsistent(db, owner);
  });

  test("kandidáti nad limit se dají dohledat hledáním", () => {
    const { owner, noticeId, customerId } = queued();
    for (let i = 0; i < 52; i++) issuedInvoice(owner, customerId);

    const all = noticeCandidates(owner, noticeId);
    expect(all.more).toBe(true);
    expect(all.candidates).toHaveLength(51);

    const last = db
      .select()
      .from(invoice)
      .where(eq(invoice.userId, owner))
      .all()
      .filter((row) => row.number)
      .map((row) => row.number!)
      .sort()
      .at(-1)!;
    const found = noticeCandidates(owner, noticeId, last);
    expect(found.candidates.map((row) => row.number)).toContain(last);
    expect(found.more).toBe(false);
  });

  test("seznam ukáže prozatímní variantu a doklady spárovaných avíz", () => {
    const { owner, invoiceId } = seedAccount(db, NOW);
    ingestNotice(owner, income(parsed()));
    ingestNotice(owner, income(parsed({ variant: "cs_block", amountMinor: 5 })));

    const all = listNotices(owner, { statuses: ["matched", "pending"] });

    expect(all.find((row) => row.status === "matched")).toMatchObject({
      provisional: false,
      invoices: [{ id: invoiceId }],
    });
    expect(all.find((row) => row.status === "pending")).toMatchObject({
      provisional: true,
      reason: "provisional",
    });
    expect(JSON.stringify(all)).not.toContain(TARGET.number);
  });
});
