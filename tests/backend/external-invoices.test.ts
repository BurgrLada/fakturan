import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { calendarDateInPrague } from "@/lib/number-format";
import { TEXTS } from "@/lib/texts";
import { setClockForTests } from "@/server/clock";
import {
  auditLog,
  emailLog,
  file,
  importBatch,
  invoice,
  job,
  mappingPreset,
  numberSeriesCounter,
  payment,
  user,
} from "@/server/db/schema";
import { userDir, writeBlob } from "@/server/files/store";
import { convertAdvance } from "@/server/services/advances";
import { setAutomation } from "@/server/services/automation";
import { assignNotice, ingestNotice } from "@/server/services/bank-notices";
import { createCreditNote } from "@/server/services/credit-notes";
import {
  cancelInvoice,
  deleteImported,
  markSent,
  markSentMany,
} from "@/server/services/invoice-lifecycle";
import { bulkSend, bulkSendPreview, sendInvoice } from "@/server/services/invoice-mail";
import { refreshCustomerSnapshot, updateIssuedInvoice } from "@/server/services/invoice-versions";
import { findOwned, getInvoice, listInvoices } from "@/server/services/invoices";
import { defaultSeriesFor, peekNumber } from "@/server/services/number-series";
import { addPayment, listPayments, updatePayment } from "@/server/services/payments";
import { savePreferences } from "@/server/services/preferences";
import { deleteUser } from "@/server/services/users";
import { externalInvoice, seedImportBatch } from "../fixtures/external-invoice";
import { assertConsistent } from "../helpers/consistency";
import { createTestDb } from "../helpers/db";
import { seedBankAccount, TARGET } from "../helpers/fixtures-bank";
import { issuedInvoice, ownSmtp, seedOwner, webActor } from "../helpers/fixtures-mail";
import { assertIsolated } from "../helpers/isolation";

vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-external-")));
vi.stubEnv("ALLOW_PRIVATE_MAIL_HOSTS", "true");
vi.stubEnv("SMTP_HOST", "");
vi.stubEnv("SMTP_PORT", "");
vi.stubEnv("SMTP_FROM", "");

const db = createTestDb();
const NOW = new Date("2026-03-01T10:00:00Z");
const TODAY = calendarDateInPrague(NOW);
const V = TEXTS.invoices.validation;
const ENABLED = { confirmed: true };

beforeEach(() => {
  setClockForTests({ now: () => NOW });
});
afterEach(() => setClockForTests(null));

const row = (id: string) => db.select().from(invoice).where(eq(invoice.id, id)).get()!;
const counters = (owner: string) =>
  db.select().from(numberSeriesCounter).where(eq(numberSeriesCounter.userId, owner)).all();
const mailOf = (owner: string) =>
  db.select().from(emailLog).where(eq(emailLog.userId, owner)).all();
const jobsOf = (owner: string) => db.select().from(job).where(eq(job.userId, owner)).all();

function edit(owner: string, id: string) {
  const detail = getInvoice(owner, id)!;
  return { ...detail, number: detail.number!, note: "jinak" };
}

describe("importovaný doklad", () => {
  test("[IMP-004] importovaný doklad nemění počítadlo řady a číslo je obsazené", () => {
    const owner = seedOwner(db, NOW);
    const series = defaultSeriesFor(owner, "invoice")!;
    const next = peekNumber(db, owner, series, TODAY);
    const before = counters(owner);

    const id = externalInvoice(db, owner, { number: next });

    expect(counters(owner)).toEqual(before);
    expect(row(id)).toMatchObject({
      external: true,
      sourceSystem: "Fakturovač",
      seriesId: null,
      sentAt: null,
      status: "issued",
    });
    const own = issuedInvoice(owner);
    expect(row(own).number).not.toBe(next);
    const listed = listInvoices(owner, { external: true }).rows;
    expect(listed.map((item) => item.id)).toEqual([id]);
    expect(listed[0]).toMatchObject({ external: true, sourceSystem: "Fakturovač" });
    assertConsistent(db, owner);
  });

  test("[IMP-005] úprava, storno, oprava a odeslání importovaného dokladu jsou odmítnuté službou", () => {
    const owner = seedOwner(db, NOW);
    ownSmtp(db, owner, 2525);
    const actor = webActor(owner);
    const id = externalInvoice(db, owner, { transfer: true });
    const advance = externalInvoice(db, owner, { type: "advance" });
    const before = row(id);

    const refusals = [
      () => updateIssuedInvoice(actor, id, edit(owner, id)),
      () => refreshCustomerSnapshot(actor, id),
      () => cancelInvoice(actor, id),
      () => createCreditNote(actor, id),
      () => markSent(actor, id),
      () => convertAdvance(actor, advance),
      () =>
        sendInvoice(actor, id, {
          requestId: randomUUID(),
          revision: before.revision,
          to: ["beta@example.cz"],
          cc: [],
          bcc: [],
          subject: "Faktura",
          body: "Dobrý den",
        }),
    ];
    for (const refuse of refusals) expect(refuse).toThrow(V.external);

    expect(row(id)).toEqual(before);
    expect(mailOf(owner)).toEqual([]);
    expect(db.select().from(invoice).where(eq(invoice.userId, owner)).all()).toHaveLength(2);
    assertConsistent(db, owner);
  });

  test("[IMP-005] úhradu a smazání povoluje, smazání s navázanou opravou ne", () => {
    const owner = seedOwner(db, NOW);
    const actor = webActor(owner);
    const paid = externalInvoice(db, owner, { paid: "full" });
    const [imported] = listPayments(owner, paid);
    expect(imported).toMatchObject({ source: "import", dateEstimated: true });
    expect(row(paid).status).toBe("paid");

    updatePayment(actor, imported!.id, {
      revision: row(paid).revision,
      paidOn: "2026-01-20",
      amountMinor: imported!.amountMinor,
      currency: imported!.currency,
      method: imported!.method,
      note: "",
    });
    expect(listPayments(owner, paid)[0]).toMatchObject({
      paidOn: "2026-01-20",
      dateEstimated: false,
    });

    const open = externalInvoice(db, owner);
    addPayment(actor, open, {
      revision: row(open).revision,
      paidOn: TODAY,
      amountMinor: row(open).totalMinor,
      currency: "CZK",
      method: "transfer",
      note: "",
    });
    expect(row(open).status).toBe("paid");
    expect(listPayments(owner, open)[0]).toMatchObject({ source: "manual", dateEstimated: false });

    const original = externalInvoice(db, owner);
    const note = externalInvoice(db, owner, {
      type: "credit_note",
      totalMinor: 200_000,
      relatedInvoiceId: original,
    });
    expect(row(original).creditsMinor).toBe(-200_000);
    expect(() => deleteImported(actor, original)).toThrow(V.importedLinked);
    expect(() => deleteImported(actor, issuedInvoice(owner))).toThrow(V.notImported);

    deleteImported(actor, note);
    expect(row(original).creditsMinor).toBe(0);
    deleteImported(actor, original);
    deleteImported(actor, paid);
    deleteImported(actor, open);

    const left = db.select().from(invoice).where(eq(invoice.userId, owner)).all();
    expect(left.filter((item) => item.external)).toEqual([]);
    expect(db.select().from(payment).where(eq(payment.userId, owner)).all()).toEqual([]);
    const audits = db.select().from(auditLog).where(eq(auditLog.action, "invoice.delete_imported"));
    expect(audits.all().filter((entry) => entry.ownerId === owner)).toHaveLength(4);
    assertConsistent(db, owner);
  });

  test("[IMP-005] smazání importovaného dokladu cizím účtem neprojde", async () => {
    await assertIsolated({
      owners: [seedOwner(db, NOW), seedOwner(db, NOW)],
      create: (owner) => externalInvoice(db, owner),
      find: (owner, id) => getInvoice(owner, id),
      remove: (owner, id) => {
        deleteImported(webActor(owner), id);
        return 1;
      },
    });
  });

  test("[TST-016] ruční platba importované zálohy nezaloží konečnou fakturu ani potvrzení", () => {
    const owner = seedOwner(db, NOW);
    ownSmtp(db, owner, 2525);
    const actor = webActor(owner);
    savePreferences(actor, { advanceFinalMode: "issue" });
    setAutomation(actor, "advanceInvoice", true, ENABLED);
    setAutomation(actor, "paymentReceipt", true, ENABLED);
    const advance = externalInvoice(db, owner, { type: "advance" });

    addPayment(actor, advance, {
      revision: row(advance).revision,
      paidOn: TODAY,
      amountMinor: row(advance).totalMinor,
      currency: "CZK",
      method: "transfer",
      note: "",
    });

    expect(row(advance).status).toBe("paid");
    const finals = db.select().from(invoice).where(eq(invoice.relatedInvoiceId, advance)).all();
    expect(finals).toEqual([]);
    expect(mailOf(owner)).toEqual([]);
    expect(jobsOf(owner)).toEqual([]);
    assertConsistent(db, owner);
  });

  test("[BNK-008] avízo se stejným VS a částkou importovaný doklad nespáruje, jde do fronty", () => {
    const owner = seedOwner(db, NOW);
    ownSmtp(db, owner, 2525);
    setAutomation(webActor(owner), "paymentReceipt", true, ENABLED);
    seedBankAccount(db, owner, NOW);
    const id = externalInvoice(db, owner, { transfer: true, variableSymbol: "20260077" });

    const result = ingestNotice(owner, {
      bank: "fio",
      notice: {
        variant: "en",
        targetAccount: `${TARGET.number}/${TARGET.bankCode}`,
        amountMinor: row(id).totalMinor,
        currency: "CZK",
        occurredAt: { date: TODAY, time: "09:00" },
        variableSymbol: "20260077",
        constantSymbol: null,
        counterpartyAccount: null,
        counterpartyName: null,
        message: null,
        instructionId: "external-1",
      },
      text: "avizo",
      authResult: "pass",
      requireConfirmation: false,
      receivedAt: NOW,
    });

    expect(result).toMatchObject({ status: "pending", reason: "external" });
    expect(row(id).paidMinor).toBe(0);
    if (result.status !== "pending") throw new Error("avízo se spárovalo");

    assignNotice(webActor(owner), result.id, { invoiceId: id });

    expect(row(id).status).toBe("paid");
    expect(mailOf(owner)).toEqual([]);
    assertConsistent(db, owner);
  });

  test("[INV-024] hromadné odeslání importovaný doklad přeskočí a vypíše", () => {
    const owner = seedOwner(db, NOW);
    ownSmtp(db, owner, 2525);
    const actor = webActor(owner);
    const id = externalInvoice(db, owner, { number: "FV-2025-0042" });

    const preview = bulkSendPreview(owner, [id]);
    expect(preview.ready).toEqual([]);
    expect(preview.skipped).toEqual([{ id, number: "FV-2025-0042", reason: V.external }]);
    expect(bulkSend(actor, [id], randomUUID())).toEqual({
      queued: 0,
      skipped: 1,
      reasons: [{ number: "FV-2025-0042", reason: V.external }],
    });
    expect(markSentMany(actor, [id])).toEqual({ done: 0, skipped: 1 });
    expect(row(id)).toMatchObject({ status: "issued", sentAt: null });
    expect(mailOf(owner)).toEqual([]);
    assertConsistent(db, owner);
  });

  test("cizí měna bez kurzu se založí a v přehledu je bez převodu", () => {
    const owner = seedOwner(db, NOW);
    const id = externalInvoice(db, owner, { currency: "EUR", totalMinor: 50_000, paid: "full" });
    const rated = externalInvoice(db, owner, {
      currency: "EUR",
      totalMinor: 50_000,
      exchangeRateMicros: 25_000_000,
      paid: "partial",
    });

    expect(row(id)).toMatchObject({ exchangeRateMicros: null, exchangeRateSource: "import" });
    expect(row(rated)).toMatchObject({
      exchangeRateSource: "import",
      exchangeRateDate: "2026-01-15",
    });
    expect(listPayments(owner, rated)[0]).toMatchObject({ rateMicros: 25_000_000 });
    expect(row(rated).status).toBe("partially_paid");
    assertConsistent(db, owner);
  });
});

describe("smazání účtu s importem", () => {
  test("[ADM-006] smazání účtu odstraní dávky, předlohy a dočasné soubory", () => {
    const owner = seedOwner(db, NOW);
    const keep = seedOwner(db, NOW);
    db.update(user).set({ role: "admin" }).where(eq(user.id, keep)).run();
    const batch = seedImportBatch(db, owner);
    externalInvoice(db, owner, { batchId: batch, paid: "full" });
    const upload = randomUUID();
    db.insert(file)
      .values({
        id: upload,
        userId: owner,
        kind: "import_upload",
        mimeType: "application/zip",
        name: "faktury.zip",
        size: 4,
        importBatchId: batch,
        createdAt: NOW,
      })
      .run();
    writeBlob(owner, upload, Buffer.from("PK.."));
    db.insert(mappingPreset)
      .values({
        id: randomUUID(),
        userId: owner,
        name: "Fakturoid",
        target: "customers",
        mapping: { name: "Název" },
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();
    const kept = seedImportBatch(db, keep);

    deleteUser(webActor(keep), owner, `${owner}@example.cz`);

    expect(db.select().from(importBatch).where(eq(importBatch.userId, owner)).all()).toEqual([]);
    expect(db.select().from(mappingPreset).where(eq(mappingPreset.userId, owner)).all()).toEqual(
      [],
    );
    expect(db.select().from(file).where(eq(file.userId, owner)).all()).toEqual([]);
    expect(existsSync(userDir(owner))).toBe(false);
    expect(findOwned(db, keep, externalInvoice(db, keep, { batchId: kept })).external).toBe(true);
  });
});
