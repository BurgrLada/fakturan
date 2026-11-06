import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, test, vi } from "vitest";
import {
  deleteBankAccountAction,
  hideBankAccountAction,
  saveBankAccountAction,
  setDefaultAccountAction,
  unhideBankAccountAction,
} from "@/app/(app)/nastaveni/ucty/actions";
import {
  deleteSeriesAction,
  saveSeriesAction,
  setDefaultSeriesAction,
  setNextNumberAction,
} from "@/app/(app)/nastaveni/rady/actions";
import {
  clearBankMailboxAction,
  saveBankMailboxAction,
  testBankMailboxAction,
} from "@/app/(app)/nastaveni/aviza/actions";
import { saveMailSettingsAction } from "@/app/(app)/nastaveni/posta/actions";
import {
  resetEmailTemplateAction,
  saveEmailTemplateAction,
} from "@/app/(app)/nastaveni/posta/sablony/actions";
import { savePreferencesAction } from "@/app/(app)/nastaveni/vychozi/actions";
import { createExportAction, exportListAction } from "@/app/(app)/nastaveni/export/actions";
import {
  confirmBatchAction,
  createImportBatchAction,
  deletePresetAction,
  discardBatchAction,
  editPreviewAction,
  importStateAction,
  remapBatchAction,
  savePresetAction,
  startParseAction,
  submitMappingAction,
  undoBatchAction,
} from "@/app/(app)/nastaveni/import/actions";
import {
  deleteRecurringAction,
  pauseRecurringAction,
  previewRecurringAction,
  recurringFromTemplateAction,
  resolveMissedAction,
  resumeRecurringAction,
  saveRecurringAction,
} from "@/app/(app)/pravidelne/actions";
import {
  assignNoticeAction,
  checkMailboxNowAction,
  dismissNoticeAction,
  noticeCandidatesAction,
  restoreNoticeAction,
  splitNoticeAction,
  undoNoticeAction,
} from "@/app/(app)/platby/actions";
import {
  deleteTemplateAction,
  draftFromTemplateAction,
  saveInvoiceAsTemplateAction,
} from "@/app/(app)/faktury/sablony/actions";
import {
  deleteReminderRuleAction,
  saveReminderRuleAction,
} from "@/app/(app)/nastaveni/automatizace/actions";
import {
  addPaymentAction,
  addRefundAction,
  bulkSendAction,
  closeDifferenceAction,
  convertAdvanceAction,
  createCreditNoteAction,
  creditPreviewAction,
  loadRateAction,
  deletePaymentAction,
  markPaidAction,
  markPaidManyAction,
  updatePaymentAction,
  bulkSendPreviewAction,
  reminderPrefillAction,
  resendFromLogAction,
  sendInvoiceAction,
  receiptPrefillAction,
  sendPrefillAction,
  sendReceiptAction,
  sendReminderAction,
  setPartialRemindersAction,
  setRemindersOffAction,
  snoozeRemindersAction,
} from "@/app/(app)/faktury/actions";
import {
  bankNotification,
  customer,
  emailLog,
  invoice,
  payment,
  recurringInvoice,
  user,
} from "@/server/db/schema";
import { ingestNotice } from "@/server/services/bank-notices";
import { seedAccount } from "../helpers/fixtures-bank";
import { issuedInvoice, ownSmtp, seedCustomer, seedOwner } from "../helpers/fixtures-mail";
import { listBankAccounts, saveBankAccount } from "@/server/services/bank-accounts";
import { getTemplate, listTemplates, saveTemplate } from "@/server/services/invoice-templates";
import { getInvoice, listInvoices, newDraftDefaults, saveDraft } from "@/server/services/invoices";
import { getEmailTemplate } from "@/server/services/email-templates";
import { getBankMailbox } from "@/server/services/bank-mailbox";
import { getMailSettings } from "@/server/services/mail-settings";
import { listSeries, saveSeries } from "@/server/services/number-series";
import { getPreferences } from "@/server/services/preferences";
import { nextOccurrences } from "@/lib/recurrence";
import { TEXTS } from "@/lib/texts";
import { getRecurring } from "@/server/services/recurring";
import { listPayments, markPaid } from "@/server/services/payments";
import { listReminderRules, saveReminderRule } from "@/server/services/reminders";
import { pauseRecurring, processOccurrence } from "@/server/services/recurring-run";
import {
  addWidgetAction,
  createDashboardAction,
  deleteDashboardAction,
  duplicateDashboardAction,
  importDashboardAction,
  previewImportAction,
  previewWidgetAction,
  removeWidgetAction,
  renameDashboardAction,
  saveLayoutAction,
  setDefaultDashboardAction,
  updateWidgetAction,
} from "@/app/(app)/dashboardy/actions";
import { WIDGET_GALLERY } from "@/lib/dashboard-defaults";
import {
  createDashboard,
  deleteDashboard,
  duplicateDashboard,
  ensureDashboards,
  exportDashboard,
  exportWidget,
  getDashboard,
  listDashboards,
  renameDashboard,
  saveLayout,
  setDefaultDashboard,
} from "@/server/services/dashboards";
import { addWidget, removeWidget, updateWidget } from "@/server/services/widgets";
import { assertIsolated } from "../helpers/isolation";
import { registerJob } from "@/server/jobs/registry";
import { drainHeavy } from "@/server/jobs/worker";
import { runExport } from "@/server/services/export-run";
import {
  createExport,
  ExportNotFoundError,
  findExport,
  listExports,
  openExport,
  recoverExportJob,
} from "@/server/services/exports";
import { createBatch, discardBatch, getBatch, listBatches } from "@/server/services/import-batch";
import { deletePreset, listPresets, savePreset } from "@/server/services/mapping-presets";
import { listInstanceAudit } from "@/server/services/instance-audit";
import { recoverBackupJob, runBackup } from "@/server/services/account-backup";
import { backupListAction, createBackupAction } from "@/app/(app)/nastaveni/zaloha/actions";
import { RATE_RULES } from "@/server/rate-limit";
import { rateLimit } from "@/server/db/schema";
import { writePreview } from "@/server/services/import-batch";
import { importBatch } from "@/server/db/schema";
import { createTestDb } from "../helpers/db";
import { readOpened } from "../helpers/opened";
import { externalInvoice } from "../fixtures/external-invoice";
import { planInput, savePlan } from "../helpers/fixtures-recurring";

const session = vi.hoisted(() => ({ userId: "a1" }));

vi.mock("@/server/auth/session", () => ({
  requireSession: async () => ({ user: { id: session.userId } }),
  getCurrentSession: async () => (session.userId ? { user: { id: session.userId } } : null),
  actorFromRequest: async () => ({ userId: session.userId, source: "web" }),
}));
const cache = vi.hoisted(() => ({ revalidated: 0 }));
vi.mock("next/cache", () => ({
  revalidatePath: () => {
    cache.revalidated += 1;
  },
  updateTag: () => {},
}));
vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-actions-")));

const db = createTestDb();
const actor = (userId: string) => ({ userId, source: "web" as const });

function seed(id: string) {
  const now = new Date();
  db.insert(user)
    .values({ id, name: id, email: `${id}@example.cz`, createdAt: now, updatedAt: now })
    .onConflictDoNothing()
    .run();
}

const account = {
  name: "Provozní",
  currency: "CZK" as const,
  number: "1234567890",
  bankCode: "2010",
  iban: "",
  swift: "",
};

const REQUEST = "11111111-1111-4111-8111-111111111111";
const message = {
  requestId: REQUEST,
  revision: 1,
  to: ["alfa@example.cz"],
  cc: [],
  bcc: [],
  subject: "Faktura",
  body: "Text",
};

describe("akce pošty", () => {
  function mailAccount() {
    const owner = seedOwner(db, new Date());
    ownSmtp(db, owner, 2525);
    const invoiceId = issuedInvoice(owner, seedCustomer(owner));
    return { owner, invoiceId };
  }

  test("[SEC-002] akce plateb odmítnou cizí ID", async () => {
    const mine = mailAccount();
    const stranger = mailAccount();
    session.userId = mine.owner;
    const before = getInvoice(mine.owner, mine.invoiceId)!;
    const input = {
      revision: before.revision,
      paidOn: "2026-01-10",
      amountMinor: 1000,
      currency: "CZK",
      method: "transfer",
      note: "",
    };
    const added = await addPaymentAction({ id: mine.invoiceId, payment: input });
    if (!added.ok) throw new Error(added.error);
    const revision = getInvoice(mine.owner, mine.invoiceId)!.revision;

    session.userId = stranger.owner;
    const replies = [
      await addPaymentAction({ id: mine.invoiceId, payment: { ...input, revision } }),
      await updatePaymentAction({ id: added.id, payment: { ...input, revision, amountMinor: 5 } }),
      await deletePaymentAction({ id: added.id, revision }),
      await markPaidAction({ id: mine.invoiceId, revision }),
      await markPaidManyAction({ ids: [mine.invoiceId] }),
      await closeDifferenceAction({ id: mine.invoiceId, revision, confirmed: true }),
    ];

    expect(replies.slice(0, 4)).toEqual(
      replies.slice(0, 4).map(() => expect.objectContaining({ ok: false })),
    );
    expect(replies[4]).toMatchObject({ ok: true, done: 0, skipped: 1 });
    expect(replies[5]).toMatchObject({ ok: false });
    expect(listPayments(mine.owner, mine.invoiceId)).toMatchObject([{ amountMinor: 1000 }]);
    expect(getInvoice(mine.owner, mine.invoiceId)).toMatchObject({
      status: "partially_paid",
      paidMinor: 1000,
    });
    expect(listPayments(stranger.owner, stranger.invoiceId)).toEqual([]);
  });

  test("[TST-009] předvyplnění platby kurzem odmítne cizí doklad a načtení kurzu vyžaduje platná data", async () => {
    const mine = mailAccount();
    const stranger = mailAccount();
    session.userId = stranger.owner;

    const foreign = await creditPreviewAction({
      id: mine.invoiceId,
      currency: "EUR",
      amountMinor: 1000,
      paidOn: "2026-01-10",
    });
    const same = await creditPreviewAction({
      id: mine.invoiceId,
      currency: "CZK",
      amountMinor: 1000,
      paidOn: "2026-01-10",
    });

    expect(foreign).toMatchObject({ ok: false });
    expect(same).toMatchObject({ ok: false });
    expect(await loadRateAction({ currency: "XXX", date: "2026-01-10" })).toMatchObject({
      ok: false,
    });
    expect(await loadRateAction({ currency: "EUR", date: "2026-02-31" })).toMatchObject({
      ok: false,
    });
  });

  test("[TST-009] akce oprav a vrácení odmítnou cizí ID", async () => {
    const mine = mailAccount();
    const stranger = mailAccount();
    session.userId = mine.owner;
    const before = getInvoice(mine.owner, mine.invoiceId)!;
    const added = await addPaymentAction({
      id: mine.invoiceId,
      payment: {
        revision: before.revision,
        paidOn: "2026-01-10",
        amountMinor: 1000,
        currency: "CZK",
        method: "transfer",
        note: "",
      },
    });
    if (!added.ok) throw new Error(added.error);
    const { revision } = getInvoice(mine.owner, mine.invoiceId)!;

    session.userId = stranger.owner;
    const replies = [
      await createCreditNoteAction({ id: mine.invoiceId }),
      await addRefundAction({
        id: mine.invoiceId,
        payment: {
          revision,
          paidOn: "2026-01-10",
          amountMinor: 100,
          currency: "CZK",
          method: "transfer",
          note: "",
        },
      }),
    ];

    expect(replies).toEqual(replies.map(() => expect.objectContaining({ ok: false })));
    expect(listInvoices(mine.owner, {}).rows).toHaveLength(1);
    expect(listInvoices(stranger.owner, {}).rows).toHaveLength(1);
    expect(getInvoice(mine.owner, mine.invoiceId)).toMatchObject({ paidMinor: 1000, revision });

    session.userId = mine.owner;
    await expect(createCreditNoteAction({ id: mine.invoiceId })).resolves.toMatchObject({
      ok: true,
    });
  });

  test("[TST-009] akce záloh odmítnou cizí ID", async () => {
    const mine = mailAccount();
    const stranger = mailAccount();
    db.update(invoice).set({ type: "advance" }).where(eq(invoice.id, mine.invoiceId)).run();

    session.userId = stranger.owner;
    await expect(convertAdvanceAction({ id: mine.invoiceId })).resolves.toMatchObject({
      ok: false,
    });
    expect(listInvoices(mine.owner, {}).rows).toHaveLength(1);
    expect(listInvoices(stranger.owner, {}).rows).toHaveLength(1);

    session.userId = mine.owner;
    await expect(convertAdvanceAction({ id: mine.invoiceId })).resolves.toMatchObject({ ok: true });
  });

  test("[SEC-002] akce upomínek odmítnou cizí ID", async () => {
    const mine = mailAccount();
    const stranger = mailAccount();
    const stage = saveReminderRule(actor(mine.owner), { offsetDays: 3, texts: null }).id;
    const before = getInvoice(mine.owner, mine.invoiceId)!;

    session.userId = stranger.owner;
    const replies = [
      await reminderPrefillAction({ id: mine.invoiceId, stageKey: null }),
      await reminderPrefillAction({ id: stranger.invoiceId, stageKey: stage }),
      await sendReminderAction({
        id: mine.invoiceId,
        stageKey: null,
        confirmedRepeat: false,
        message: { ...message, revision: before.revision },
      }),
      await sendReminderAction({
        id: stranger.invoiceId,
        stageKey: stage,
        confirmedRepeat: false,
        message: {
          ...message,
          requestId: "55555555-5555-4555-8555-555555555555",
          revision: getInvoice(stranger.owner, stranger.invoiceId)!.revision,
        },
      }),
      await snoozeRemindersAction({ id: mine.invoiceId, until: null }),
      await setRemindersOffAction({ id: mine.invoiceId, on: true }),
      await setPartialRemindersAction({ id: mine.invoiceId, on: true }),
      await saveReminderRuleAction({ id: stage, offsetDays: 9, texts: null }),
      await deleteReminderRuleAction(stage),
    ];

    for (const reply of replies) expect(reply).toMatchObject({ ok: false });
    expect(getInvoice(mine.owner, mine.invoiceId)).toMatchObject({
      remindersOff: false,
      remindersPartial: false,
    });
    expect(listReminderRules(mine.owner)).toMatchObject([{ id: stage, offsetDays: 3 }]);
    expect(db.select().from(emailLog).where(eq(emailLog.userId, mine.owner)).all()).toEqual([]);
    expect(db.select().from(emailLog).where(eq(emailLog.userId, stranger.owner)).all()).toEqual([]);
  });

  test("[SEC-002] akce pošty odmítnou cizí ID", async () => {
    const mine = mailAccount();
    const stranger = mailAccount();
    session.userId = mine.owner;
    const { revision } = getInvoice(mine.owner, mine.invoiceId)!;
    const sent = await sendInvoiceAction({ id: mine.invoiceId, message: { ...message, revision } });
    if (!sent.ok) throw new Error(sent.error);
    const paid = markPaid({ userId: mine.owner, source: "web" }, mine.invoiceId, {
      revision: getInvoice(mine.owner, mine.invoiceId)!.revision,
    });

    session.userId = stranger.owner;
    const replies = [
      await sendPrefillAction({ id: mine.invoiceId }),
      await sendPrefillAction({ id: stranger.invoiceId, logId: sent.logId }),
      await receiptPrefillAction({ id: mine.invoiceId, paymentId: paid.id }),
      await receiptPrefillAction({ id: stranger.invoiceId, paymentId: paid.id }),
      await sendReceiptAction({
        id: stranger.invoiceId,
        paymentId: paid.id,
        message: {
          ...message,
          revision: getInvoice(stranger.owner, stranger.invoiceId)!.revision,
          requestId: "99999999-9999-4999-8999-999999999999",
        },
      }),
      await sendInvoiceAction({
        id: mine.invoiceId,
        message: { ...message, requestId: "22222222-2222-4222-8222-222222222222" },
      }),
      await sendInvoiceAction({
        id: stranger.invoiceId,
        message: {
          ...message,
          requestId: "44444444-4444-4444-8444-444444444444",
          revision: getInvoice(stranger.owner, stranger.invoiceId)!.revision,
          logId: sent.logId,
        },
      }),
      await resendFromLogAction({
        id: sent.logId,
        requestId: "33333333-3333-4333-8333-333333333333",
        confirmedUnknown: true,
      }),
    ];

    for (const reply of replies) expect(reply).toMatchObject({ ok: false });
    expect(await bulkSendPreviewAction({ ids: [mine.invoiceId] })).toMatchObject({
      ok: true,
      ready: [],
      skipped: [{ id: mine.invoiceId, number: "" }],
    });
    expect(
      await bulkSendAction({ ids: [mine.invoiceId], requestId: REQUEST, previewed: {} }),
    ).toMatchObject({
      ok: true,
      queued: 0,
      skipped: 1,
    });
    expect(
      db.select().from(emailLog).where(eq(emailLog.invoiceId, mine.invoiceId)).all(),
    ).toHaveLength(1);
  });

  test("[SEC-006] akce pošty odmítnou neplatnou adresu a předmět s koncem řádku", async () => {
    const { owner, invoiceId } = mailAccount();
    session.userId = owner;

    const replies = [
      await sendInvoiceAction({ id: invoiceId, message: { ...message, to: ["nic"] } }),
      await sendInvoiceAction({ id: invoiceId, message: { ...message, cc: ["a@b"] } }),
      await sendInvoiceAction({
        id: invoiceId,
        message: { ...message, subject: "A\r\nBcc: x@example.cz" },
      }),
      await sendInvoiceAction({ id: invoiceId, message: { ...message, requestId: "x" } }),
      await resendFromLogAction({ id: "x", requestId: "x", confirmedUnknown: false }),
      await bulkSendAction({ ids: [invoiceId], requestId: "x", previewed: {} }),
    ];

    for (const reply of replies) expect(reply).toMatchObject({ ok: false });
    expect(db.select().from(emailLog).where(eq(emailLog.userId, owner)).all()).toEqual([]);
  });
});

describe("cizí id přes server actions", () => {
  test("[TST-009] nastavení pošty platí jen pro přihlášený účet, cizí id se ignoruje", async () => {
    seed("m1");
    seed("m2");
    session.userId = "m1";

    const result = await saveMailSettingsAction({
      userId: "m2",
      smtpHost: "",
      smtpPort: "",
      smtpUser: "",
      smtpPassword: "",
      fromEmail: "",
      senderName: "Jméno m1",
      replyTo: "",
      cc: "",
      bcc: "",
    });

    expect(result).toEqual({ ok: true });
    expect(getMailSettings("m1").senderName).toBe("Jméno m1");
    expect(getMailSettings("m2").senderName).toBeNull();
  });

  test("[SEC-002] akce schránky odmítnou cizí účet a cizí id se ignoruje", async () => {
    seed("b1");
    seed("b2");
    const mailbox = {
      host: "8.8.8.8",
      port: "993",
      tls: "implicit",
      username: "avizo",
      password: "tajne-heslo-imap",
      folder: "",
      enabled: true,
      requireConfirmation: true,
    };

    session.userId = "b1";
    expect(await saveBankMailboxAction({ ...mailbox, userId: "b2" })).toEqual({ ok: true });
    expect(getBankMailbox("b1")).toMatchObject({ host: "8.8.8.8", hasCredentials: true });
    expect(getBankMailbox("b2")).toBeNull();

    session.userId = "b2";
    expect(await clearBankMailboxAction()).toEqual({ ok: true });
    expect(await testBankMailboxAction()).toEqual({ ok: false, error: "Schránka není nastavená" });
    expect(getBankMailbox("b1")).not.toBeNull();
  });

  test("[TST-009] šablona e-mailu platí jen pro přihlášený účet, cizí id se ignoruje", async () => {
    seed("s1");
    seed("s2");
    session.userId = "s1";
    const template = { kind: "invoice", language: "cs", subject: "Moje", body: "Text" };

    expect(await saveEmailTemplateAction({ ...template, userId: "s2" })).toEqual({ ok: true });
    expect(getEmailTemplate("s1", "invoice", "cs").subject).toBe("Moje");
    expect(getEmailTemplate("s2", "invoice", "cs").subject).not.toBe("Moje");

    session.userId = "s2";
    expect(await resetEmailTemplateAction({ kind: "invoice", language: "cs" })).toMatchObject({
      ok: true,
    });
    expect(getEmailTemplate("s1", "invoice", "cs").subject).toBe("Moje");
    expect(await resetEmailTemplateAction({ kind: "x", language: "cs" })).toMatchObject({
      ok: false,
    });
  });

  test("[TST-009] cizí šablonu ani fakturu nejde použít ani smazat přes server action", async () => {
    seed("t1");
    seed("t2");
    const { id: templateId } = saveTemplate(actor("t1"), {
      name: "Moje šablona",
      customerId: null,
      document: {
        ...newDraftDefaults("t1", null),
        type: "invoice",
        dueDays: 14,
        lines: [],
      },
    });
    const { id: invoiceId } = saveDraft(actor("t1"), {
      ...newDraftDefaults("t1", null),
      note: "Soukromá poznámka",
    });
    session.userId = "t2";

    const replies = [
      await draftFromTemplateAction({ id: templateId }),
      await deleteTemplateAction({ id: templateId }),
      await saveInvoiceAsTemplateAction({ id: invoiceId, name: "Kopie cizí faktury" }),
    ];

    for (const reply of replies) expect(reply).toMatchObject({ ok: false });
    expect(listInvoices("t2", {}).rows).toEqual([]);
    expect(listTemplates("t2")).toEqual([]);
    expect(getTemplate("t1", templateId)?.name).toBe("Moje šablona");
  });

  test("[TST-009] vlastní šablona přes server action projde", async () => {
    seed("t3");
    session.userId = "t3";
    const { id: invoiceId } = saveDraft(actor("t3"), newDraftDefaults("t3", null));

    const saved = await saveInvoiceAsTemplateAction({ id: invoiceId, name: "Vlastní" });
    if (!saved.ok) throw new Error(saved.error);
    const draft = await draftFromTemplateAction({ id: saved.id });
    const removed = await deleteTemplateAction({ id: saved.id });

    expect(draft).toMatchObject({ ok: true });
    expect(removed).toMatchObject({ ok: true });
  });

  test("[TST-009] cizí plán pravidelné faktury nejde změnit, pozastavit, smazat ani použít přes server action", async () => {
    const mine = seedOwner(db, new Date());
    const stranger = seedOwner(db, new Date());
    const customerId = seedCustomer(mine);
    const id = savePlan(mine, customerId);
    const plan = getRecurring(mine, id)!;
    pauseRecurring(actor(mine), id);
    const { runId } = processOccurrence(mine, id, nextOccurrences(plan, plan.cursorDate, 1)[0]!)!;
    const { id: templateId } = saveTemplate(actor(mine), {
      name: "Moje šablona",
      customerId,
      document: { ...newDraftDefaults(mine, null), type: "invoice", dueDays: 14, lines: [] },
    });
    session.userId = stranger;

    const replies = [
      await saveRecurringAction(planInput(null, { id, name: "Přepsáno" })),
      await previewRecurringAction(planInput(null, { id })),
      await pauseRecurringAction({ id }),
      await resumeRecurringAction({ id }),
      await resolveMissedAction({ runId, action: "draft" }),
      await recurringFromTemplateAction({ id: templateId }),
      await deleteRecurringAction({ id }),
    ];

    for (const reply of replies) expect(reply).toMatchObject({ ok: false });
    expect(getRecurring(mine, id)).toMatchObject({ name: "Správa webu", status: "paused" });
    expect(
      db.select().from(recurringInvoice).where(eq(recurringInvoice.userId, stranger)).all(),
    ).toEqual([]);

    session.userId = mine;
    const preview = await previewRecurringAction(planInput(customerId, { id }));
    expect(preview).toMatchObject({ ok: true });
    expect(preview.ok && preview.rows).toHaveLength(12);
    expect(await resolveMissedAction({ runId, action: "skip" })).toMatchObject({ ok: true });
  });

  test("[SEC-002] cizí bankovní účet nejde změnit, skrýt, nastavit ani smazat přes server action", async () => {
    seed("a1");
    seed("a2");
    const mine = saveBankAccount(actor("a1"), account);
    session.userId = "a2";

    const results = [
      await saveBankAccountAction({ ...account, id: mine, name: "Přepsáno" }),
      await setDefaultAccountAction({ id: mine, currency: "CZK" }),
      await hideBankAccountAction({ id: mine }),
      await unhideBankAccountAction({ id: mine }),
      await deleteBankAccountAction({ id: mine }),
    ];

    for (const result of results) expect(result).toMatchObject({ ok: false });
    expect(listBankAccounts("a1")).toMatchObject([{ id: mine, name: "Provozní", hidden: false }]);
    expect(listBankAccounts("a2")).toEqual([]);
  });

  test("[SEC-002] cizí číselná řada nejde změnit, nastavit ani smazat přes server action", async () => {
    seed("b1");
    seed("b2");
    const mine = saveSeries(actor("b1"), {
      name: "Exporty",
      documentType: "invoice",
      template: "EX{RR}-{NN}",
      reset: "yearly",
    });
    session.userId = "b2";

    const results = [
      await saveSeriesAction({
        id: mine,
        name: "Přepsáno",
        documentType: "invoice",
        template: "EX{RR}-{NN}",
        reset: "yearly",
      }),
      await setNextNumberAction({ id: mine, next: 40, date: "2026-10-30" }),
      await setDefaultSeriesAction({ id: mine }),
      await deleteSeriesAction({ id: mine }),
    ];

    for (const result of results) expect(result).toMatchObject({ ok: false });
    const rows = listSeries("b1", "2026-10-30");
    expect(rows.find((row) => row.id === mine)).toMatchObject({ name: "Exporty", next: 1 });
    expect(listSeries("b2", "2026-10-30").map((row) => row.id)).not.toContain(mine);
  });

  test("[SEC-002] výchozí hodnoty se ukládají jen přihlášenému uživateli, i když vstup nese cizí id", async () => {
    seed("c1");
    seed("c2");
    session.userId = "c2";

    const result = await savePreferencesAction({ dueDays: 30, userId: "c1" });

    expect(result).toMatchObject({ ok: true });
    expect(getPreferences("c2").dueDays).toBe(30);
    expect(getPreferences("c1").dueDays).toBe(14);
  });

  test("[SEC-002] akce avíz odmítnou cizí ID", async () => {
    const NOW = new Date();
    const mine = seedAccount(db, NOW);
    const stranger = seedAccount(db, NOW);
    ingestNotice(mine.owner, {
      bank: "fio",
      notice: {
        variant: "en",
        targetAccount: "9999999999/2010",
        amountMinor: 300_000,
        currency: "CZK",
        occurredAt: { date: "2026-10-30", time: null },
        variableSymbol: "20260042",
        constantSymbol: null,
        counterpartyAccount: null,
        counterpartyName: null,
        message: null,
        instructionId: "77",
      },
      text: "x",
      authResult: "none",
      requireConfirmation: true,
      receivedAt: NOW,
    });
    const noticeId = db
      .select()
      .from(bankNotification)
      .where(eq(bankNotification.userId, mine.owner))
      .get()!.id;

    session.userId = stranger.owner;
    const replies = [
      await assignNoticeAction({ id: noticeId, assign: { invoiceId: stranger.invoiceId } }),
      await assignNoticeAction({ id: noticeId, assign: { invoiceId: mine.invoiceId } }),
      await splitNoticeAction({
        id: noticeId,
        split: {
          parts: [
            { invoiceId: stranger.invoiceId, amountMinor: 100_000 },
            { invoiceId: mine.invoiceId, amountMinor: 200_000 },
          ],
        },
      }),
      await dismissNoticeAction({ id: noticeId }),
      await restoreNoticeAction({ id: noticeId }),
      await undoNoticeAction({ id: noticeId }),
      await noticeCandidatesAction({ id: noticeId }),
      await checkMailboxNowAction({ requestId: REQUEST }),
      await assignNoticeAction({ id: noticeId, assign: { invoiceId: "" } }),
    ];

    for (const reply of replies) expect(reply).toMatchObject({ ok: false });
    expect(
      db.select().from(bankNotification).where(eq(bankNotification.id, noticeId)).get(),
    ).toMatchObject({
      status: "pending",
    });
    expect(db.select().from(payment).where(eq(payment.userId, mine.owner)).all()).toEqual([]);

    session.userId = mine.owner;
    expect(await noticeCandidatesAction({ id: noticeId })).toMatchObject({
      ok: true,
      more: false,
      candidates: [{ id: mine.invoiceId, suggested: true }],
    });
    expect(await dismissNoticeAction({ id: noticeId })).toEqual({ ok: true });
  });
});

describe("dashboardy", () => {
  const chart = WIDGET_GALLERY.find((item) => item.id === "revenue_by_month")!.config;
  let round = 0;
  const owners = (): [string, string] => {
    round += 1;
    const pair: [string, string] = [`dash-a-${round}`, `dash-b-${round}`];
    for (const id of pair) seed(id);
    return pair;
  };
  const widgetOf = (ownerId: string, id: string) =>
    listDashboards(ownerId)
      .flatMap((row) => getDashboard(ownerId, row.id)!.widgets)
      .find((widget) => widget.id === id);

  test("[TST-009] cizí dashboard i widget nejde číst, měnit ani smazat", async () => {
    await assertIsolated({
      owners: owners(),
      create: (ownerId) => {
        ensureDashboards(actor(ownerId));
        return createDashboard(actor(ownerId), { name: "Obchod" }).id;
      },
      find: (ownerId, id) => getDashboard(ownerId, id),
      list: (ownerId) => listDashboards(ownerId).map((row) => row.id),
      update: (ownerId, id) => {
        renameDashboard(actor(ownerId), { id, name: `Přejmenováno ${ownerId}` });
        return 1;
      },
      remove: (ownerId, id) => {
        deleteDashboard(actor(ownerId), { id });
        return 1;
      },
    });

    await assertIsolated({
      owners: owners(),
      create: (ownerId) => {
        const [home] = ensureDashboards(actor(ownerId));
        return addWidget(actor(ownerId), { dashboardId: home!.id, config: chart }).id;
      },
      find: (ownerId, id) => widgetOf(ownerId, id),
      update: (ownerId, id) => {
        updateWidget(actor(ownerId), { id, config: { ...chart, title: ownerId } });
        return 1;
      },
      remove: (ownerId, id) => {
        removeWidget(actor(ownerId), { id });
        return 1;
      },
    });

    const [mine, stranger] = owners();
    const [home] = ensureDashboards(actor(mine));
    ensureDashboards(actor(stranger));
    const before = getDashboard(mine, home!.id)!;
    const items = before.widgets.map(({ id, x, y, w, h }) => ({ id, x, y, w: w + 1, h }));
    const attempts = [
      () => duplicateDashboard(actor(stranger), { id: home!.id }),
      () => setDefaultDashboard(actor(stranger), { id: home!.id }),
      () => saveLayout(actor(stranger), { id: home!.id, revision: before.revision, items }),
      () => addWidget(actor(stranger), { dashboardId: home!.id, config: chart }),
    ];
    for (const attempt of attempts) expect(attempt).toThrow(new Error("Dashboard neexistuje"));
    expect(getDashboard(mine, home!.id)).toEqual(before);
    expect(listDashboards(stranger)).toHaveLength(1);
  });

  test("[TST-009] akce dashboardu odmítnou cizí ID a neplatnou session", async () => {
    const [mine, stranger] = owners();
    const [home] = ensureDashboards(actor(mine));
    ensureDashboards(actor(stranger));
    const { id: second } = createDashboard(actor(mine), { name: "Obchod" });
    const { id: widgetId } = addWidget(actor(mine), { dashboardId: second, config: chart });
    const snapshot = () => listDashboards(mine).map((row) => getDashboard(mine, row.id));
    const before = snapshot();
    const view = getDashboard(mine, second)!;
    const items = view.widgets.map(({ id, x, y, w, h }) => ({ id, x, y, w: w + 1, h }));
    const foreign = () => [
      renameDashboardAction({ id: second, name: "Cizí" }),
      duplicateDashboardAction({ id: second }),
      deleteDashboardAction({ id: second }),
      setDefaultDashboardAction({ id: second }),
      saveLayoutAction({ id: second, revision: view.revision, items }),
      addWidgetAction({ dashboardId: second, config: chart }),
      updateWidgetAction({ id: widgetId, config: { ...chart, title: "Cizí" } }),
      removeWidgetAction({ id: widgetId }),
    ];

    session.userId = stranger;
    for (const reply of await Promise.all(foreign())) {
      expect(reply).toMatchObject({ ok: false, error: expect.any(String) });
      expect(reply).not.toHaveProperty("expired");
    }
    expect(snapshot()).toEqual(before);
    expect(listDashboards(stranger)).toHaveLength(1);

    session.userId = "";
    const signedOut = await Promise.all([
      ...foreign(),
      createDashboardAction({ name: "Bez session" }),
      previewWidgetAction({ config: chart }),
      previewImportAction({ text: "{}" }),
      importDashboardAction({ text: "{}" }),
    ]);
    for (const reply of signedOut) expect(reply).toMatchObject({ ok: false, expired: true });
    expect(snapshot()).toEqual(before);

    session.userId = mine;
    expect(await renameDashboardAction({ id: second, name: "Prodej" })).toEqual({ ok: true });
    expect(await setDefaultDashboardAction({ id: second })).toEqual({ ok: true });
    expect(listDashboards(mine).find((row) => row.isDefault)?.id).toBe(second);
    expect(home).toBeDefined();
  });

  test("[TST-009] import ani export neprojde s cizím ID", async () => {
    const { POST: exportPost } = await import("@/app/(app)/dashboardy/[id]/export/route");
    const { POST: widgetPost } =
      await import("@/app/(app)/dashboardy/[id]/widget/[widgetId]/export/route");
    const [mine, stranger] = owners();
    const [home] = ensureDashboards(actor(mine));
    const [foreignHome] = ensureDashboards(actor(stranger));
    const now = new Date();
    const customerId = `cust-${mine}`;
    db.insert(customer)
      .values({ id: customerId, userId: mine, name: "Alfa", createdAt: now, updatedAt: now })
      .run();
    const filtered = { ...chart, filters: { customerIds: [customerId] } };
    const { id: widgetId } = addWidget(actor(mine), { dashboardId: home!.id, config: filtered });

    expect(() => exportDashboard(actor(stranger), home!.id)).toThrow("Dashboard neexistuje");
    expect(() => exportWidget(actor(stranger), home!.id, widgetId)).toThrow("Dashboard neexistuje");
    expect(() => exportWidget(actor(stranger), foreignHome!.id, widgetId)).toThrow(
      "Widget neexistuje",
    );

    const post = (url: string) =>
      new Request(`http://localhost:3000${url}`, {
        method: "POST",
        headers: { origin: "http://localhost:3000" },
      }) as never;
    const params = <T>(value: T) => ({ params: Promise.resolve(value) });
    session.userId = stranger;
    expect((await exportPost(post("/x"), params({ id: home!.id }))).status).toBe(404);
    expect((await widgetPost(post("/x"), params({ id: foreignHome!.id, widgetId }))).status).toBe(
      404,
    );

    session.userId = mine;
    const own = await exportPost(post("/x"), params({ id: home!.id }));
    expect(own.status).toBe(200);
    const text = await own.text();
    expect(text).not.toContain(customerId);
    expect(text).not.toContain(mine);
    const crossSite = new Request("http://localhost:3000/x", {
      method: "POST",
      headers: { origin: "https://evil.example" },
    }) as never;
    expect((await exportPost(crossSite, params({ id: home!.id }))).status).toBe(403);

    // A hand-made file naming the other account's customer imports without the filter.
    const file = JSON.stringify({
      format: "fakturan.dashboard",
      v: 1,
      name: "Cizí",
      widgets: [filtered],
    });
    session.userId = stranger;
    const before = listDashboards(mine).map((row) => getDashboard(mine, row.id));
    const preview = await previewImportAction({ text: file });
    if (!preview.ok) throw new Error(preview.error);
    expect(preview.preview.widgets.find((w) => w.config.title === chart.title)).toMatchObject({
      droppedCustomers: true,
    });
    const imported = await importDashboardAction({ text: file });
    if (!imported.ok) throw new Error(imported.error);
    expect(JSON.stringify(getDashboard(stranger, imported.id))).not.toContain(customerId);
    expect(getDashboard(mine, imported.id)).toBeNull();
    expect(listDashboards(mine).map((row) => getDashboard(mine, row.id))).toEqual(before);
    expect(await importDashboardAction({ text: 1 })).toEqual({
      ok: false,
      error: "Neplatná data",
    });
  });
});

describe("akce importu", () => {
  test("[SEC-002] akce importu odmítnou cizí dávku", async () => {
    const mine = seedOwner(db, new Date());
    const stranger = seedOwner(db, new Date());
    session.userId = mine;
    const created = await createImportBatchAction();
    if (!created.ok) throw new Error(created.error);
    const batchId = created.id;
    const notFound = { ok: false, error: TEXTS.importing.errors.notFound };

    session.userId = stranger;
    expect(await importStateAction({ batchId })).toEqual(notFound);
    expect(await startParseAction({ batchId })).toEqual(notFound);
    expect(
      await editPreviewAction({
        batchId,
        revision: 0,
        change: { kind: "skip", keys: ["r1"], skip: true },
      }),
    ).toEqual(notFound);
    expect(await confirmBatchAction({ batchId, revision: 0 })).toEqual(notFound);
    expect(await undoBatchAction({ batchId })).toEqual(notFound);
    expect(await discardBatchAction({ batchId })).toEqual(notFound);
    expect(await importStateAction({ batchId, extra: 1 })).toMatchObject({ ok: false });

    session.userId = mine;
    expect(await importStateAction({ batchId })).toMatchObject({
      ok: true,
      batch: { id: batchId, status: "uploading" },
    });
    expect(await discardBatchAction({ batchId })).toEqual({ ok: true });
    expect(await importStateAction({ batchId })).toMatchObject({ batch: { status: "failed" } });
  });

  test("[SEC-002] mapování a předlohy importu odmítnou cizí dávku i cizí předlohu", async () => {
    const mine = seedOwner(db, new Date());
    const stranger = seedOwner(db, new Date());
    session.userId = mine;
    const created = await createImportBatchAction({ kind: "tabular" });
    if (!created.ok) throw new Error(created.error);
    const batchId = created.id;
    const mapping = {
      target: "customers",
      columns: { name: "Název" },
      dateFormat: "dmy",
      decimal: ",",
      currency: "CZK",
      source: "",
    };
    const saved = await savePresetAction({ name: "Moje", mapping });
    if (!saved.ok) throw new Error(saved.error);
    const notFound = { ok: false, error: TEXTS.importing.errors.notFound };

    session.userId = stranger;
    expect(await submitMappingAction({ batchId, revision: 0, mapping })).toEqual(notFound);
    expect(await remapBatchAction({ batchId, revision: 0 })).toEqual(notFound);
    expect(await deletePresetAction({ id: saved.id })).toEqual({
      ok: false,
      error: TEXTS.importing.mapping.errors.presetNotFound,
    });
    const own = await savePresetAction({ name: "Moje", mapping });
    expect(own.ok && own.id).not.toBe(saved.id);
    expect(own.ok && own.presets.some((preset) => preset.id === saved.id)).toBe(false);
    expect(await createImportBatchAction({ kind: "jiny" })).toMatchObject({ ok: false });
    expect(await savePresetAction({ name: "X", mapping: { ...mapping, rows: [] } })).toMatchObject({
      ok: false,
    });

    session.userId = mine;
    expect(await importStateAction({ batchId })).toMatchObject({
      ok: true,
      batch: { id: batchId, kind: "tabular", status: "uploading" },
    });
    expect(await deletePresetAction({ id: saved.id })).toMatchObject({ ok: true });
  });
  test("stav běžící dávky se dotazuje bez náhledu a bez revalidace", async () => {
    const mine = seedOwner(db, new Date());
    session.userId = mine;
    const created = await createImportBatchAction();
    if (!created.ok) throw new Error(created.error);
    const batchId = created.id;
    const row = { key: "r1", source: "a.isdoc" } as never;
    writePreview(mine, batchId, { rows: [row] });
    db.update(importBatch).set({ status: "committing" }).where(eq(importBatch.id, batchId)).run();
    const before = cache.revalidated;
    expect(await importStateAction({ batchId })).toMatchObject({
      ok: true,
      batch: { status: "committing" },
      rows: [],
    });
    expect(cache.revalidated).toBe(before);
    db.update(importBatch).set({ status: "ready" }).where(eq(importBatch.id, batchId)).run();
    expect(await importStateAction({ batchId })).toMatchObject({ ok: true, rows: [row] });
  });
});

describe("akce exportu", () => {
  const download = async (id: string) => {
    const { GET } = await import("@/app/(app)/nastaveni/export/[id]/route");
    return GET(new Request("http://localhost/"), { params: Promise.resolve({ id }) });
  };

  test("[SEC-002] export, jeho seznam ani stažení neprojdou s cizím účtem nebo ID", async () => {
    registerJob("export.run", { run: runExport, recover: recoverExportJob });
    const mine = seedOwner(db, new Date());
    const stranger = seedOwner(db, new Date());
    const invoiceId = issuedInvoice(mine, seedCustomer(mine));

    session.userId = mine;
    const created = await createExportAction({ kind: "invoices", format: "csv" });
    if (!created.ok) throw new Error(created.error);
    await drainHeavy("w");
    const own = await download(created.id);
    expect(own.status).toBe(200);
    expect(own.headers.get("Content-Disposition")).toMatch(/^attachment/);
    expect(own.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(own.headers.get("Cache-Control")).toContain("no-store");
    expect(await own.text()).toContain(getInvoice(mine, invoiceId)!.number!);

    session.userId = stranger;
    expect((await download(created.id)).status).toBe(404);
    expect((await download("neexistuje")).status).toBe(404);
    expect(await exportListAction()).toEqual({ ok: true, rows: [] });
    expect(
      await createExportAction({ kind: "invoices", format: "csv", ownerId: mine }),
    ).toMatchObject({ ok: false });
    const foreign = await createExportAction({
      kind: "invoices",
      format: "pdf_zip",
      filter: { ids: [invoiceId] },
    });
    if (!foreign.ok) throw new Error(foreign.error);
    await drainHeavy("w");
    const listed = await exportListAction();
    expect(listed.ok && listed.rows).toMatchObject([
      { id: foreign.id, status: "failed", reason: TEXTS.exporting.errors.foreignIds },
    ]);
    expect((await download(foreign.id)).status).toBe(404);

    session.userId = mine;
    const rule = RATE_RULES.exportDownloadUser;
    db.insert(rateLimit)
      .values({ key: `${rule.name}:${mine}`, windowStart: new Date(), count: rule.limit })
      .onConflictDoUpdate({ target: rateLimit.key, set: { count: rule.limit } })
      .run();
    expect((await download(created.id)).status).toBe(429);
  });
});

describe("akce zálohy", () => {
  const download = async (id: string) => {
    const { GET } = await import("@/app/(app)/nastaveni/export/[id]/route");
    return GET(new Request("http://localhost/"), { params: Promise.resolve({ id }) });
  };

  test("[SEC-002] záloha, její seznam ani stažení neprojdou s cizím účtem", async () => {
    registerJob("backup.run", { run: runBackup, recover: recoverBackupJob });
    const mine = seedOwner(db, new Date());
    const stranger = seedOwner(db, new Date());
    const invoiceId = issuedInvoice(mine, seedCustomer(mine));

    session.userId = mine;
    const created = await createBackupAction();
    if (!created.ok) throw new Error(created.error);
    await drainHeavy("w");
    const listed = await backupListAction();
    expect(listed.ok && listed.rows).toMatchObject([{ id: created.id, downloadable: true }]);
    expect(await exportListAction()).toMatchObject({ ok: true, rows: [] });
    const own = await download(created.id);
    expect(own.status).toBe(200);
    expect(own.headers.get("Content-Type")).toBe("application/zip");
    expect(own.headers.get("Content-Disposition")).toMatch(/^attachment.*fakturan-zaloha-/);
    expect(own.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(own.headers.get("Cache-Control")).toContain("no-store");
    const archive = unzipSync(new Uint8Array(await own.arrayBuffer()));
    expect(strFromU8(archive["data/invoice.jsonl"]!)).toContain(invoiceId);

    session.userId = stranger;
    expect((await download(created.id)).status).toBe(404);
    expect(await backupListAction()).toEqual({ ok: true, rows: [] });
    const theirs = await createBackupAction();
    if (!theirs.ok) throw new Error(theirs.error);
    await drainHeavy("w");
    const foreign = unzipSync(new Uint8Array(await (await download(theirs.id)).arrayBuffer()));
    for (const bytes of Object.values(foreign)) {
      expect(strFromU8(bytes)).not.toContain(invoiceId);
      expect(strFromU8(bytes)).not.toContain(mine);
    }
  });
});

describe("matice izolace plánů 7 a 8", () => {
  const mapping = {
    target: "customers" as const,
    columns: { name: "Název" },
    dateFormat: "dmy" as const,
    decimal: "," as const,
    currency: "CZK" as const,
    source: "",
  };
  let round = 0;
  // Each subject is checked against a plain stranger and against an administrator: the admin role
  // reaches users and instance settings, never another account's data (TST-009).
  const pairs = (): [string, string][] => {
    round += 1;
    const owner = `matice-${round}`;
    const stranger = `matice-${round}-cizi`;
    const admin = `matice-${round}-admin`;
    for (const id of [owner, stranger, admin]) seed(id);
    db.update(user).set({ role: "admin" }).where(eq(user.id, admin)).run();
    return [
      [owner, stranger],
      [`${owner}-b`, admin],
    ].map(([a, b]) => {
      seed(a!);
      return [a!, b!] as [string, string];
    });
  };

  test("[TST-009] cizí uživatel i administrátor nedostanou entity plánů 7 a 8", async () => {
    registerJob("export.run", { run: runExport, recover: recoverExportJob });
    for (const owners of pairs()) {
      await assertIsolated({
        owners,
        create: (ownerId) => createBatch(actor(ownerId), "isdoc").id,
        find: (ownerId, id) => getBatch(ownerId, id),
        list: (ownerId) => listBatches(ownerId).map((row) => row.id),
        update: (ownerId, id) => {
          discardBatch(actor(ownerId), id);
          return 1;
        },
      });
      await assertIsolated({
        owners,
        create: (ownerId) => savePreset(actor(ownerId), { name: `Moje ${ownerId}`, mapping }).id,
        find: (ownerId, id) => listPresets(ownerId).find((preset) => preset.id === id),
        list: (ownerId) => listPresets(ownerId).map((preset) => preset.id),
        remove: (ownerId, id) => {
          deletePreset(actor(ownerId), id);
          return 1;
        },
      });
      await assertIsolated({
        owners,
        create: async (ownerId) => {
          const { id } = createExport(actor(ownerId), { kind: "customers", format: "csv" });
          await drainHeavy("w");
          return id;
        },
        find: (ownerId, id) => findExport(db, ownerId, id),
        list: (ownerId) => listExports(ownerId).map((row) => row.id),
      });
      const [owner, other] = owners;
      const [mine] = listExports(owner);
      expect(readOpened(openExport(actor(owner), mine!.id)).length).toBeGreaterThan(0);
      expect(() => openExport(actor(other), mine!.id)).toThrow(ExportNotFoundError);

      const [home] = ensureDashboards(actor(owner));
      ensureDashboards(actor(other));
      expect(getDashboard(other, home!.id)).toBeFalsy();
      expect(listDashboards(other).map((row) => row.id)).not.toContain(home!.id);
      const widget = home && getDashboard(owner, home.id)!.widgets[0];
      expect(() => removeWidget(actor(other), { id: widget!.id })).toThrow();
      expect(getDashboard(owner, home!.id)!.widgets.map((row) => row.id)).toContain(widget!.id);
    }

    // The instance audit an administrator reads names no entity of an account.
    const admin = `matice-${round}-admin`;
    const entities = listInstanceAudit(actor(admin), { pageSize: 500 }).rows.map(
      (row) => row.entity,
    );
    for (const entity of [
      "import_batch",
      "mapping_preset",
      "export_job",
      "account_backup",
      "account_restore",
      "dashboard",
      "dashboard_widget",
    ]) {
      expect(entities).not.toContain(entity);
    }
  });
});

describe("ruční PDF k cizímu dokladu", () => {
  test("[SEC-002] cizí doklad je 404 a nic nezapíše", async () => {
    const { POST } = await import("@/app/(app)/faktury/[id]/priloha/route");
    const mine = seedOwner(db, new Date());
    const stranger = seedOwner(db, new Date());
    const id = externalInvoice(db, mine);
    const files = () =>
      db.$client
        .prepare("SELECT count(*) AS n FROM file WHERE user_id IN (?, ?)")
        .get(mine, stranger);
    const before = files();
    session.userId = stranger;
    const body = new TextEncoder().encode("%PDF-1.4\n%%EOF");

    for (const target of [id, "11111111-1111-4111-8111-000000000000", "../x"]) {
      const response = await POST(
        new Request(`http://localhost:3000/faktury/${target}/priloha`, {
          method: "POST",
          body,
          headers: { origin: "http://localhost:3000", "x-file-name": "x.pdf" },
        }),
        { params: Promise.resolve({ id: target }) },
      );
      expect(response.status).toBe(404);
    }
    expect(files()).toEqual(before);
    expect(getInvoice(mine, id)!.importPdfFileId).toBeNull();
  });
});
