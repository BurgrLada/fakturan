"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { TEXTS } from "@/lib/texts";
import { actorFromRequest, requireSession } from "@/server/auth/session";
import { ServiceError } from "@/server/services/access";
import {
  archiveCustomer,
  customerInputSchema,
  deleteCustomer,
  restoreCustomer,
  saveCustomer,
  verifyVat,
  type VatStatus,
} from "@/server/services/customers";

type Failure = { ok: false; error: string };

const idInput = z.object({ id: z.string(TEXTS.customers.validation.invalid).min(1) });

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
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? TEXTS.customers.validation.invalid,
    };
  }
  try {
    const output = await work(parsed.data, await actorFromRequest());
    revalidatePath("/zakaznici", "layout");
    return { ok: true, ...output };
  } catch (error) {
    if (error instanceof ServiceError) return { ok: false, error: error.message };
    throw error;
  }
}

export async function saveCustomerAction(raw: unknown) {
  return run(customerInputSchema, raw, (input, actor) => saveCustomer(actor, input));
}

export async function archiveCustomerAction(raw: unknown) {
  return run(idInput, raw, ({ id }, actor) => {
    archiveCustomer(actor, id);
    return {};
  });
}

export async function restoreCustomerAction(raw: unknown) {
  return run(idInput, raw, ({ id }, actor) => {
    restoreCustomer(actor, id);
    return {};
  });
}

export async function deleteCustomerAction(raw: unknown) {
  return run(idInput, raw, ({ id }, actor) => {
    deleteCustomer(actor, id);
    return {};
  });
}

export async function verifyVatAction(
  raw: unknown,
): Promise<
  ({ ok: true } & { status: Pick<VatStatus, "state"> & { verifiedAt: string | null } }) | Failure
> {
  return run(idInput, raw, async ({ id }, actor) => {
    const { state, verifiedAt } = await verifyVat(actor, id);
    return { status: { state, verifiedAt: verifiedAt?.toISOString() ?? null } };
  });
}
