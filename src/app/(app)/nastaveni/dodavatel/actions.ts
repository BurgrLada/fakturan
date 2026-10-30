"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { TEXTS } from "@/lib/texts";
import { lookupAres, type AresResult } from "@/server/external/ares";
import { actorFromRequest, requireSession } from "@/server/auth/session";
import { RATE_RULES } from "@/server/rate-limit";
import { enforceRateLimit, ServiceError } from "@/server/services/access";
import {
  clearSupplierImage,
  saveSupplier,
  setSupplierImage,
  supplierInputSchema,
} from "@/server/services/supplier";

type Failure = { ok: false; error: string };

const imageKind = z.enum(["logo", "qr_logo", "signature"]);
const icoInput = z.object({ ico: z.string().trim().max(20) });
const clearInput = z.object({ kind: imageKind });
const uploadInput = z.object({ kind: imageKind, file: z.instanceof(File) });

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
      error: parsed.error.issues[0]?.message ?? TEXTS.supplier.validation.invalid,
    };
  }
  try {
    const output = await work(parsed.data, await actorFromRequest());
    revalidatePath("/nastaveni/dodavatel");
    return { ok: true, ...output };
  } catch (error) {
    if (error instanceof ServiceError) return { ok: false, error: error.message };
    throw error;
  }
}

export async function saveSupplierAction(raw: unknown) {
  return run(supplierInputSchema, raw, (input, actor) => {
    saveSupplier(actor, input);
    return {};
  });
}

export async function lookupAresAction(
  raw: unknown,
): Promise<{ ok: true; result: AresResult | null } | Failure> {
  await requireSession();
  const parsed = icoInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: TEXTS.supplier.validation.invalid };
  try {
    enforceRateLimit(await actorFromRequest(), RATE_RULES.aresLookup);
  } catch (error) {
    if (error instanceof ServiceError) return { ok: false, error: error.message };
    throw error;
  }
  return { ok: true, result: await lookupAres(parsed.data.ico) };
}

export async function uploadSupplierImageAction(formData: FormData) {
  return run(uploadInput, Object.fromEntries(formData), async ({ kind, file }, actor) => {
    setSupplierImage(actor, kind, Buffer.from(await file.arrayBuffer()), file.name);
    return {};
  });
}

export async function removeSupplierImageAction(raw: unknown) {
  return run(clearInput, raw, ({ kind }, actor) => {
    clearSupplierImage(actor, kind);
    return {};
  });
}
