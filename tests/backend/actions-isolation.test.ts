import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
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
  bulkSendAction,
  closeDifferenceAction,
  deletePaymentAction,
  markPaidAction,
  markPaidManyAction,
  updatePaymentAction,
  bulkSendPreviewAction,
  reminderPrefillAction,
  resendFromLogAction,
  sendInvoiceAction,
  sendPrefillAction,
  sendReminderAction,
  setPartialRemindersAction,
  setRemindersOffAction,
  snoozeRemindersAction,
} from "@/app/(app)/faktury/actions";
import { emailLog, recurringInvoice, user } from "@/server/db/schema";
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
import { getRecurring } from "@/server/services/recurring";
import { listPayments } from "@/server/services/payments";
import { listReminderRules, saveReminderRule } from "@/server/services/reminders";
import { pauseRecurring, processOccurrence } from "@/server/services/recurring-run";
import { createTestDb } from "../helpers/db";
import { planInput, savePlan } from "../helpers/fixtures-recurring";

const session = vi.hoisted(() => ({ userId: "a1" }));

vi.mock("@/server/auth/session", () => ({
  requireSession: async () => ({ user: { id: session.userId } }),
  getCurrentSession: async () => ({ user: { id: session.userId } }),
  actorFromRequest: async () => ({ userId: session.userId, source: "web" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
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

    session.userId = stranger.owner;
    const replies = [
      await sendPrefillAction({ id: mine.invoiceId }),
      await sendPrefillAction({ id: stranger.invoiceId, logId: sent.logId }),
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
});
