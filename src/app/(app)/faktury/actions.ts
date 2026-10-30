"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { CURRENCIES } from "@/lib/currency";
import { daysBetween } from "@/lib/invoice";
import type { CustomerDefaults } from "@/lib/invoice-form";
import { TEXTS } from "@/lib/texts";
import { actorFromRequest, requireSession } from "@/server/auth/session";
import { ServiceError } from "@/server/services/access";
import { saveCatalogItem, searchCatalog } from "@/server/services/catalog";
import { searchCustomers } from "@/server/services/customers";
import {
  checkIssuable,
  issueInvoice,
  NotIssuableError,
  previewIssue,
  type IssueProblem,
} from "@/server/services/invoice-lifecycle";
import { updateIssuedInvoice } from "@/server/services/invoice-versions";
import {
  draftInputSchema,
  issuedInputSchema,
  newDraftDefaults,
  ownerOf,
  saveDraft,
} from "@/server/services/invoices";
import { ensureDefaultSeries } from "@/server/services/number-series";
import { assertTagNames, setInvoiceTags } from "@/server/services/tags";

type Failure = { ok: false; error: string; stale?: true; problems?: IssueProblem[] };
type Actor = Awaited<ReturnType<typeof actorFromRequest>>;

const V = TEXTS.invoices.validation;
const PICKER_LIMIT = 8;

const id = z.string(V.invalid).min(1, V.invalid);
const tags = z.array(z.string(V.invalid), V.invalid);

const idInput = z.object({ id });
const searchInput = z.object({ q: z.string(V.invalid).max(100, V.tooLong) });
const customerInput = z.object({ customerId: id });
const draftInput = z.object({ draft: draftInputSchema, tags });
const issueInput = z.object({
  id,
  revision: z.number(V.invalid).int(V.invalid),
  variableSymbol: z.string(V.invalid).optional(),
});
const updateInput = z.object({ id, tags, document: issuedInputSchema });
const lineInput = z.object({
  name: z.string(V.invalid),
  description: z.string(V.invalid).optional(),
  unit: z.string(V.invalid),
  priceMinor: z.number(V.invalid),
  currency: z.enum(CURRENCIES, V.currency),
});

// Only known refusals become messages: requireSession's redirect must keep propagating.
async function run<Input, Output extends object>(
  schema: z.ZodType<Input>,
  raw: unknown,
  work: (input: Input, actor: Actor) => Output | Promise<Output>,
): Promise<({ ok: true } & Output) | Failure> {
  await requireSession();
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
    revalidatePath("/faktury", "layout");
    return issued;
  });
}

export async function updateIssuedAction(raw: unknown) {
  return run(updateInput, raw, ({ id: invoiceId, tags: names, document }, actor) => {
    assertTagNames(names);
    const result = updateIssuedInvoice(actor, invoiceId, document);
    setInvoiceTags(actor, invoiceId, names);
    revalidatePath("/faktury", "layout");
    return result;
  });
}

export async function saveLineToCatalogAction(raw: unknown) {
  return run(lineInput, raw, ({ description = "", priceMinor, ...line }, actor) =>
    saveCatalogItem(actor, { ...line, description, priceMinor, category: "", tags: [] }),
  );
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
