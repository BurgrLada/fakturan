"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { TEXTS } from "@/lib/texts";
import { actorFromRequest, requireSession } from "@/server/auth/session";
import { ServiceError } from "@/server/services/access";
import {
  archiveCatalogItem,
  catalogInputSchema,
  deleteUnit,
  restoreCatalogItem,
  saveCatalogItem,
  saveUnit,
  unitNameSchema,
} from "@/server/services/catalog";

type Failure = { ok: false; error: string };

const idInput = z.object({ id: z.string(TEXTS.catalog.validation.invalid).min(1) });
const unitInput = z.object({ name: unitNameSchema });

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
      error: parsed.error.issues[0]?.message ?? TEXTS.catalog.validation.invalid,
    };
  }
  try {
    const output = await work(parsed.data, await actorFromRequest());
    revalidatePath("/cenik", "layout");
    return { ok: true, ...output };
  } catch (error) {
    if (error instanceof ServiceError) return { ok: false, error: error.message };
    throw error;
  }
}

export async function saveCatalogItemAction(raw: unknown) {
  return run(catalogInputSchema, raw, (input, actor) => saveCatalogItem(actor, input));
}

export async function archiveCatalogItemAction(raw: unknown) {
  return run(idInput, raw, ({ id }, actor) => {
    archiveCatalogItem(actor, id);
    return {};
  });
}

export async function restoreCatalogItemAction(raw: unknown) {
  return run(idInput, raw, ({ id }, actor) => {
    restoreCatalogItem(actor, id);
    return {};
  });
}

export async function saveUnitAction(raw: unknown) {
  return run(unitInput, raw, ({ name }, actor) => saveUnit(actor, name));
}

export async function deleteUnitAction(raw: unknown) {
  return run(idInput, raw, ({ id }, actor) => {
    deleteUnit(actor, id);
    return {};
  });
}
