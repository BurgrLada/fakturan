import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ParsedNotice } from "@/lib/bank-notices/types";
import { czechAccountToIban } from "@/lib/iban";
import { setClockForTests } from "@/server/clock";
import { auditLog, bankNotification, invoice, payment, user } from "@/server/db/schema";
import { scoped } from "@/server/db/scoped";
import { ingestNotice, purgeNotices, type IngestInput } from "@/server/services/bank-notices";
import { getInvoice } from "@/server/services/invoices";
import { deleteUser, USER_OWNED_TABLES } from "@/server/services/users";
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

const rows = (owner: string) =>
  db.select().from(bankNotification).where(eq(bankNotification.userId, owner)).all();
const payments = (owner: string) =>
  db.select().from(payment).where(eq(payment.userId, owner)).all();

beforeEach(() => setClockForTests({ now: () => NOW }));
afterEach(() => setClockForTests(null));

describe("ingestNotice", () => {
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
