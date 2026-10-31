"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { TEXTS } from "@/lib/texts";
import { actorFromRequest, requireSession } from "@/server/auth/session";
import { ServiceError } from "@/server/services/access";
import {
  deleteTemplate,
  draftFromTemplate,
  templateFromInvoice,
} from "@/server/services/invoice-templates";

type Failure = { ok: false; error: string };

const V = TEXTS.invoices.templates.validation;
const id = z.string(V.invalid).min(1, V.invalid);
const idInput = z.object({ id });
const fromInvoiceInput = z.object({ id, name: z.string(V.invalid) });

// Only known refusals become messages: requireSession's redirect must keep propagating.
async function run<Input, Output extends object>(
  schema: z.ZodType<Input>,
  raw: unknown,
  work: (
    input: Input,
    actor: Awaited<ReturnType<typeof actorFromRequest>>,
  ) => Output | Promise<Output>,
): Promise<({ ok: true } & Output) | Failure> {
  await requireSession();
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? V.invalid };
  try {
    return { ok: true, ...(await work(parsed.data, await actorFromRequest())) };
  } catch (error) {
    if (error instanceof ServiceError) return { ok: false, error: error.message };
    throw error;
  }
}

export async function saveInvoiceAsTemplateAction(raw: unknown) {
  return run(fromInvoiceInput, raw, ({ id: invoiceId, name }, actor) => {
    const saved = templateFromInvoice(actor, invoiceId, name);
    revalidatePath("/faktury/sablony");
    return saved;
  });
}

export async function draftFromTemplateAction(raw: unknown) {
  return run(idInput, raw, ({ id: templateId }, actor) => {
    const draft = draftFromTemplate(actor, templateId);
    revalidatePath("/faktury", "layout");
    return draft;
  });
}

export async function deleteTemplateAction(raw: unknown) {
  return run(idInput, raw, ({ id: templateId }, actor) => {
    deleteTemplate(actor, templateId);
    revalidatePath("/faktury/sablony");
    return {};
  });
}
