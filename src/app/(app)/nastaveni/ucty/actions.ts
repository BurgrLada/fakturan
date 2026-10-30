"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { actorFromRequest, requireSession } from "@/server/auth/session";
import { ServiceError } from "@/server/services/access";
import {
  bankAccountInputSchema,
  currencySchema,
  deleteBankAccount,
  hideBankAccount,
  saveBankAccount,
  setDefaultForCurrency,
} from "@/server/services/bank-accounts";

type Failure = { ok: false; error: string };

const idInput = z.object({ id: z.string().min(1) });
const defaultInput = z.object({ id: z.string().min(1), currency: currencySchema });

// Only known refusals become messages: requireSession's redirect must keep propagating.
async function run<Input>(
  schema: z.ZodType<Input>,
  raw: unknown,
  work: (input: Input, actor: Awaited<ReturnType<typeof actorFromRequest>>) => void,
): Promise<{ ok: true } | Failure> {
  await requireSession();
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Neplatné údaje" };
  }
  try {
    work(parsed.data, await actorFromRequest());
    revalidatePath("/nastaveni/ucty");
    return { ok: true };
  } catch (error) {
    if (error instanceof ServiceError) return { ok: false, error: error.message };
    throw error;
  }
}

export async function saveBankAccountAction(raw: unknown) {
  return run(bankAccountInputSchema, raw, (input, actor) => {
    saveBankAccount(actor, input);
  });
}

export async function setDefaultAccountAction(raw: unknown) {
  return run(defaultInput, raw, ({ id, currency }, actor) => {
    setDefaultForCurrency(actor, currency, id);
  });
}

export async function hideBankAccountAction(raw: unknown) {
  return run(idInput, raw, ({ id }, actor) => {
    hideBankAccount(actor, id);
  });
}

export async function deleteBankAccountAction(raw: unknown) {
  return run(idInput, raw, ({ id }, actor) => {
    deleteBankAccount(actor, id);
  });
}
