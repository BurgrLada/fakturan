"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { CURRENCIES } from "@/lib/currency";
import { daysBetween, MAX_BULK_DOCUMENTS } from "@/lib/invoice";
import type { CustomerDefaults } from "@/lib/invoice-form";
import { sendInputSchema } from "@/lib/mail-send";
import { isCalendarDate } from "@/lib/number-format";
import { paymentInputSchema } from "@/lib/payments";
import { TEXTS } from "@/lib/texts";
import { actorFromRequest, getCurrentSession } from "@/server/auth/session";
import { ServiceError } from "@/server/services/access";
import { getAutomation } from "@/server/services/automation";
import { saveCatalogItem, searchCatalog } from "@/server/services/catalog";
import { customerInputSchema, saveCustomer, searchCustomers } from "@/server/services/customers";
import {
  cancelInvoice,
  checkIssuable,
  issueInvoice,
  markSent,
  markSentMany,
  NotIssuableError,
  previewIssue,
  restoreInvoice,
  type IssueProblem,
} from "@/server/services/invoice-lifecycle";
import {
  acknowledgeUnknown,
  bulkSend,
  bulkSendPreview,
  resendFromLog,
  sendInvoice,
  sendPrefill,
} from "@/server/services/invoice-mail";
import {
  refreshCustomerSnapshot,
  restoreVersion,
  updateIssuedInvoice,
} from "@/server/services/invoice-versions";
import {
  deleteDraft,
  draftInputSchema,
  duplicateInvoice,
  issuedInputSchema,
  newDraftDefaults,
  ownerOf,
  saveDraft,
} from "@/server/services/invoices";
import { ensureDefaultSeries } from "@/server/services/number-series";
import {
  addPayment,
  closeDifference,
  deletePayment,
  markPaid,
  markPaidMany,
  updatePayment,
} from "@/server/services/payments";
import {
  reminderPrefill,
  sendManualReminder,
  setPartialReminders,
  setRemindersOff,
  snoozeReminders,
} from "@/server/services/reminders";
import { assertTagNames, setInvoiceTags } from "@/server/services/tags";

type Failure = {
  ok: false;
  error: string;
  stale?: true;
  expired?: true;
  problems?: IssueProblem[];
};
type Actor = Awaited<ReturnType<typeof actorFromRequest>>;

const V = TEXTS.invoices.validation;
const PICKER_LIMIT = 8;

const id = z.string(V.invalid).min(1, V.invalid);
const tags = z.array(z.string(V.invalid), V.invalid);

const idInput = z.object({ id });
const idsInput = z.object({
  ids: z.array(id, V.invalid).min(1, V.invalid).max(MAX_BULK_DOCUMENTS, V.invalid),
});
const searchInput = z.object({ q: z.string(V.invalid).max(100, V.tooLong) });
const customerInput = z.object({ customerId: id });
const draftInput = z.object({ draft: draftInputSchema, tags });
const issueInput = z.object({
  id,
  revision: z.number(V.invalid).int(V.invalid),
  variableSymbol: z.string(V.invalid).optional(),
});
const updateInput = z.object({ id, tags, document: issuedInputSchema });
const requestId = z.uuid(TEXTS.invoiceMail.errors.invalid);
const prefillInput = z.object({ id, logId: id.optional() });
const sendInput = z.object({ id, message: sendInputSchema });
const resendInput = z.object({ id, requestId, confirmedUnknown: z.boolean(V.invalid) });
const addressList = z.array(z.string(V.invalid), V.invalid);
const bulkInput = idsInput.extend({
  requestId,
  previewed: z.record(z.string(V.invalid), z.object({ to: addressList, copies: addressList })),
});
const stageKey = id.nullable();
const reminderPrefillInput = z.object({ id, stageKey });
const reminderInput = z.object({
  id,
  stageKey,
  confirmedRepeat: z.boolean(V.invalid),
  message: sendInputSchema,
});
const snoozeInput = z.object({ id, until: z.string(V.invalid).nullable() });
const flagInput = z.object({ id, on: z.boolean(V.invalid) });
const revision = z.number(V.invalid).int(V.invalid);
const addPaymentInput = z.object({ id, payment: paymentInputSchema });
const markPaidInput = z.object({
  id,
  revision,
  paidOn: z.string(V.date).refine(isCalendarDate, V.date).optional(),
});
const deletePaymentInput = z.object({ id, revision });
const closeDifferenceInput = z.object({ id, revision, confirmed: z.boolean(V.invalid) });
const lineInput = z.object({
  name: z.string(V.invalid),
  description: z.string(V.invalid).optional(),
  unit: z.string(V.invalid),
  priceMinor: z.number(V.invalid),
  currency: z.enum(CURRENCIES, V.currency),
});

// An expired session is reported instead of redirected: a redirect would take the unsaved form away
// before the person can see what was lost.
async function run<Input, Output extends object>(
  schema: z.ZodType<Input>,
  raw: unknown,
  work: (input: Input, actor: Actor) => Output | Promise<Output>,
): Promise<({ ok: true } & Output) | Failure> {
  if (!(await getCurrentSession())) {
    return { ok: false, expired: true, error: TEXTS.invoices.form.sessionExpired };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? V.invalid };
  }
  try {
    const output = await work(parsed.data, await actorFromRequest());
    return { ok: true, ...output };
  } catch (error) {
    if (error instanceof NotIssuableError) {
      return { ok: false, error: error.message, problems: error.problems };
    }
    if (error instanceof ServiceError) {
      return error.message === TEXTS.invoices.stale
        ? { ok: false, stale: true, error: error.message }
        : { ok: false, error: error.message };
    }
    throw error;
  }
}

// No revalidation here: a save after every pause in typing would re-render the page for nothing.
export async function saveDraftAction(raw: unknown) {
  return run(draftInput, raw, ({ draft, tags: names }, actor) => {
    assertTagNames(names);
    ensureDefaultSeries(actor);
    const saved = saveDraft(actor, draft);
    setInvoiceTags(actor, saved.id, names);
    return {
      id: saved.id,
      revision: saved.revision,
      problems: checkIssuable(ownerOf(actor), saved.id),
    };
  });
}

export async function issuePreviewAction(raw: unknown) {
  return run(idInput, raw, ({ id: invoiceId }, actor) => previewIssue(ownerOf(actor), invoiceId));
}

export async function issueAction(raw: unknown) {
  return run(issueInput, raw, ({ id: invoiceId, revision, variableSymbol }, actor) => {
    const issued = issueInvoice(actor, invoiceId, { revision, variableSymbol });
    changedInvoices();
    return issued;
  });
}

export async function updateIssuedAction(raw: unknown) {
  return run(updateInput, raw, ({ id: invoiceId, tags: names, document }, actor) => {
    assertTagNames(names);
    const result = updateIssuedInvoice(actor, invoiceId, document);
    setInvoiceTags(actor, invoiceId, names);
    changedInvoices();
    return result;
  });
}

export async function saveLineToCatalogAction(raw: unknown) {
  return run(lineInput, raw, ({ description = "", priceMinor, ...line }, actor) =>
    saveCatalogItem(actor, { ...line, description, priceMinor, category: "", tags: [] }),
  );
}

export async function createCustomerAction(raw: unknown) {
  return run(customerInputSchema, raw, (input, actor) => {
    const saved = saveCustomer(actor, input);
    revalidatePath("/zakaznici", "layout");
    return saved;
  });
}

export async function customerDefaultsAction(raw: unknown) {
  return run(customerInput, raw, ({ customerId }, actor) => {
    const draft = newDraftDefaults(ownerOf(actor), customerId);
    const defaults: CustomerDefaults = {
      dueDays: daysBetween(draft.issueDate!, draft.dueDate!),
      language: draft.language,
      currency: draft.currency,
      paymentMethod: draft.paymentMethod,
      appearance: draft.appearance,
    };
    return { defaults };
  });
}

export async function searchCustomersAction(raw: unknown) {
  return run(searchInput, raw, ({ q }, actor) => ({
    customers: searchCustomers(ownerOf(actor), q, PICKER_LIMIT).map(
      ({ id: customerId, name, ico, city }) => ({ id: customerId, name, ico, city }),
    ),
  }));
}

export async function searchCatalogAction(raw: unknown) {
  return run(searchInput, raw, ({ q }, actor) => ({
    items: searchCatalog(ownerOf(actor), q, PICKER_LIMIT).map((item) => ({
      id: item.id,
      name: item.name,
      description: item.description,
      unit: item.unit,
      priceMinor: item.priceMinor,
      currency: item.currency,
    })),
  }));
}

function changedInvoices() {
  revalidatePath("/faktury", "layout");
  revalidatePath("/zakaznici", "layout");
}

export async function markSentAction(raw: unknown) {
  return run(idInput, raw, ({ id: invoiceId }, actor) => {
    markSent(actor, invoiceId);
    changedInvoices();
    return {};
  });
}

export async function acknowledgeUnknownAction(raw: unknown) {
  return run(idInput, raw, ({ id: logId }, actor) => {
    acknowledgeUnknown(actor, logId);
    changedInvoices();
    return {};
  });
}

export async function markSentManyAction(raw: unknown) {
  return run(idsInput, raw, ({ ids }, actor) => {
    const result = markSentMany(actor, ids);
    changedInvoices();
    return result;
  });
}

export async function cancelInvoiceAction(raw: unknown) {
  return run(idInput, raw, ({ id: invoiceId }, actor) => {
    cancelInvoice(actor, invoiceId);
    changedInvoices();
    return {};
  });
}

export async function restoreInvoiceAction(raw: unknown) {
  return run(idInput, raw, ({ id: invoiceId }, actor) => {
    restoreInvoice(actor, invoiceId);
    changedInvoices();
    return {};
  });
}

export async function duplicateInvoiceAction(raw: unknown) {
  return run(idInput, raw, ({ id: invoiceId }, actor) => {
    const copy = duplicateInvoice(actor, invoiceId);
    changedInvoices();
    return copy;
  });
}

export async function deleteDraftAction(raw: unknown) {
  return run(idInput, raw, ({ id: invoiceId }, actor) => {
    deleteDraft(actor, invoiceId);
    changedInvoices();
    return {};
  });
}

export async function refreshCustomerAction(raw: unknown) {
  return run(idInput, raw, ({ id: invoiceId }, actor) => {
    const result = refreshCustomerSnapshot(actor, invoiceId);
    changedInvoices();
    return result;
  });
}

export async function restoreVersionAction(raw: unknown) {
  return run(idInput, raw, ({ id: versionId }, actor) => {
    const result = restoreVersion(actor, versionId);
    changedInvoices();
    return result;
  });
}

export async function sendPrefillAction(raw: unknown) {
  return run(prefillInput, raw, ({ id: invoiceId, logId }, actor) => ({
    draft: sendPrefill(ownerOf(actor), invoiceId, logId),
  }));
}

export async function sendInvoiceAction(raw: unknown) {
  return run(sendInput, raw, ({ id: invoiceId, message }, actor) => {
    const queued = sendInvoice(actor, invoiceId, message);
    changedInvoices();
    return queued;
  });
}

export async function resendFromLogAction(raw: unknown) {
  return run(resendInput, raw, ({ id: logId, ...opts }, actor) => {
    const queued = resendFromLog(actor, logId, opts);
    changedInvoices();
    return queued;
  });
}

export async function bulkSendPreviewAction(raw: unknown) {
  return run(idsInput, raw, ({ ids }, actor) => {
    const owner = ownerOf(actor);
    return {
      ...bulkSendPreview(owner, ids),
      paused: getAutomation(owner).paused,
      requestId: randomUUID(),
    };
  });
}

export async function bulkSendAction(raw: unknown) {
  return run(bulkInput, raw, ({ ids, requestId: request, previewed }, actor) => {
    const result = bulkSend(actor, ids, request, previewed);
    changedInvoices();
    return result;
  });
}

export async function reminderPrefillAction(raw: unknown) {
  return run(reminderPrefillInput, raw, ({ id: invoiceId, stageKey: stage }, actor) => ({
    draft: reminderPrefill(ownerOf(actor), invoiceId, stage),
  }));
}

export async function sendReminderAction(raw: unknown) {
  return run(reminderInput, raw, ({ id: invoiceId, message, ...choice }, actor) => {
    const queued = sendManualReminder(actor, invoiceId, { ...message, ...choice });
    changedInvoices();
    return queued;
  });
}

export async function snoozeRemindersAction(raw: unknown) {
  return run(snoozeInput, raw, ({ id: invoiceId, until }, actor) => {
    snoozeReminders(actor, invoiceId, until);
    changedInvoices();
    return {};
  });
}

export async function setRemindersOffAction(raw: unknown) {
  return run(flagInput, raw, ({ id: invoiceId, on }, actor) => {
    setRemindersOff(actor, invoiceId, on);
    changedInvoices();
    return {};
  });
}

export async function setPartialRemindersAction(raw: unknown) {
  return run(flagInput, raw, ({ id: invoiceId, on }, actor) => {
    setPartialReminders(actor, invoiceId, on);
    changedInvoices();
    return {};
  });
}

export async function addPaymentAction(raw: unknown) {
  return run(addPaymentInput, raw, ({ id: invoiceId, payment }, actor) => {
    const added = addPayment(actor, invoiceId, payment);
    changedInvoices();
    return added;
  });
}

export async function updatePaymentAction(raw: unknown) {
  return run(addPaymentInput, raw, ({ id: paymentId, payment }, actor) => {
    const saved = updatePayment(actor, paymentId, payment);
    changedInvoices();
    return saved;
  });
}

export async function deletePaymentAction(raw: unknown) {
  return run(deletePaymentInput, raw, ({ id: paymentId, revision: current }, actor) => {
    deletePayment(actor, paymentId, current);
    changedInvoices();
    return {};
  });
}

export async function markPaidAction(raw: unknown) {
  return run(markPaidInput, raw, ({ id: invoiceId, ...opts }, actor) => {
    const paid = markPaid(actor, invoiceId, opts);
    changedInvoices();
    return paid;
  });
}

export async function markPaidManyAction(raw: unknown) {
  return run(idsInput, raw, ({ ids }, actor) => {
    const result = markPaidMany(actor, ids);
    changedInvoices();
    return result;
  });
}

export async function closeDifferenceAction(raw: unknown) {
  return run(closeDifferenceInput, raw, ({ id: invoiceId, ...opts }, actor) => {
    const closed = closeDifference(actor, invoiceId, opts);
    changedInvoices();
    return closed;
  });
}
