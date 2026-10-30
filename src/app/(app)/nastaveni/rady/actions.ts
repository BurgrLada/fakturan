"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { TEXTS } from "@/lib/texts";
import { actorFromRequest, requireSession } from "@/server/auth/session";
import { ServiceError } from "@/server/services/access";
import {
  deleteSeries,
  nextNumberInputSchema,
  saveSeries,
  seriesInputSchema,
  setDefaultSeries,
  setNextNumber,
} from "@/server/services/number-series";

type Failure = { ok: false; error: string };

const idInput = z.object({ id: z.string().min(1) });

// Only known refusals become messages: requireSession's redirect must keep propagating.
async function run<Input>(
  schema: z.ZodType<Input>,
  raw: unknown,
  work: (input: Input, actor: Awaited<ReturnType<typeof actorFromRequest>>) => void,
): Promise<{ ok: true } | Failure> {
  await requireSession();
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? TEXTS.numberSeries.errors.invalid,
    };
  }
  try {
    work(parsed.data, await actorFromRequest());
    revalidatePath("/nastaveni/rady");
    return { ok: true };
  } catch (error) {
    if (error instanceof ServiceError) return { ok: false, error: error.message };
    throw error;
  }
}

export async function saveSeriesAction(raw: unknown) {
  return run(seriesInputSchema, raw, (input, actor) => {
    saveSeries(actor, input);
  });
}

export async function setNextNumberAction(raw: unknown) {
  return run(nextNumberInputSchema, raw, ({ id, next, date }, actor) => {
    setNextNumber(actor, id, next, date);
  });
}

export async function setDefaultSeriesAction(raw: unknown) {
  return run(idInput, raw, ({ id }, actor) => {
    setDefaultSeries(actor, id);
  });
}

export async function deleteSeriesAction(raw: unknown) {
  return run(idInput, raw, ({ id }, actor) => {
    deleteSeries(actor, id);
  });
}
