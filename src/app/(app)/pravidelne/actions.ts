"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { TEXTS } from "@/lib/texts";
import { actorFromRequest, requireSession } from "@/server/auth/session";
import { ServiceError } from "@/server/services/access";
import {
  deleteRecurring,
  previewRecurring,
  recurringFromTemplate,
  recurringInputSchema,
  saveRecurring,
} from "@/server/services/recurring";
import { getAutomation } from "@/server/services/automation";
import { getCustomer } from "@/server/services/customers";
import { pauseRecurring, resolveMissed, resumeRecurring } from "@/server/services/recurring-run";

type Failure = { ok: false; error: string };

const V = TEXTS.recurring.validation;
const id = z.string(V.invalid).min(1, V.invalid);
const idInput = z.object({ id });
const resolveInput = z.object({ runId: id, action: z.enum(["draft", "skip"], V.invalid) });

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

function refresh() {
  revalidatePath("/pravidelne", "layout");
  revalidatePath("/faktury", "layout");
}

export async function saveRecurringAction(raw: unknown) {
  return run(recurringInputSchema, raw, (input, actor) => {
    const saved = saveRecurring(actor, input);
    refresh();
    return saved;
  });
}

export async function previewRecurringAction(raw: unknown) {
  const { user } = await requireSession();
  const parsed = recurringInputSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? V.invalid } as Failure;
  }
  try {
    return { ok: true, rows: previewRecurring(user.id, parsed.data) } as const;
  } catch (error) {
    if (error instanceof ServiceError) return { ok: false, error: error.message } as Failure;
    throw error;
  }
}

export async function pauseRecurringAction(raw: unknown) {
  return run(idInput, raw, ({ id: planId }, actor) => {
    pauseRecurring(actor, planId);
    refresh();
    return {};
  });
}

// Also reactivates a finished plan whose end or count was extended.
export async function resumeRecurringAction(raw: unknown) {
  return run(idInput, raw, ({ id: planId }, actor) => {
    resumeRecurring(actor, planId);
    refresh();
    return {};
  });
}

export async function deleteRecurringAction(raw: unknown) {
  return run(idInput, raw, ({ id: planId }, actor) => {
    deleteRecurring(actor, planId);
    refresh();
    return {};
  });
}

export async function resolveMissedAction(raw: unknown) {
  return run(resolveInput, raw, ({ runId, action }, actor) => {
    const result = resolveMissed(actor, runId, action);
    refresh();
    return result;
  });
}

export async function recurringFromTemplateAction(raw: unknown) {
  return run(idInput, raw, ({ id: templateId }, actor) => {
    const created = recurringFromTemplate(actor, templateId);
    refresh();
    return created;
  });
}

// What the confirmation dialog tells the person before an invoice leaves without a click.
export async function sendSummaryAction(raw: unknown) {
  return run(z.object({ customerId: id }), raw, ({ customerId }, actor) => {
    const owner = actor.userId!;
    const customer = getCustomer(owner, customerId);
    if (!customer) throw new ServiceError(V.invalid);
    return { email: customer.email.trim(), sendTime: getAutomation(owner).sendTime };
  });
}
