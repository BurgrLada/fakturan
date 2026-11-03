"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { PreviewChange, PreviewRow } from "@/lib/import-preview";
import { TEXTS } from "@/lib/texts";
import { actorFromRequest, requireSession } from "@/server/auth/session";
import type { ImportBatch } from "@/server/db/schema";
import { ServiceError } from "@/server/services/access";
import {
  confirmBatch,
  createBatch,
  editPreview,
  getPreview,
  startParse,
} from "@/server/services/import-batch";
import { undoBatch } from "@/server/services/import-undo";

type Failure = { ok: false; error: string };
type Outcome<T = object> = ({ ok: true } & T) | Failure;

const id = z.string().min(1).max(64);
const revision = z.number().int().min(0);

// Only known refusals become messages: requireSession's redirect must keep propagating.
async function guarded<T extends object>(work: () => T | Promise<T>): Promise<Outcome<T>> {
  try {
    const result = await work();
    revalidatePath("/nastaveni/import");
    return { ok: true, ...result };
  } catch (error) {
    if (error instanceof ServiceError) return { ok: false, error: error.message };
    throw error;
  }
}

function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ServiceError(TEXTS.importing.errors.invalidChange);
  return parsed.data;
}

export async function createImportBatchAction(): Promise<Outcome<{ id: string }>> {
  await requireSession();
  return guarded(async () => createBatch(await actorFromRequest(), "isdoc"));
}

export async function startParseAction(raw: unknown): Promise<Outcome> {
  await requireSession();
  return guarded(async () => {
    const input = parse(z.strictObject({ batchId: id }), raw);
    startParse(await actorFromRequest(), input.batchId);
    return {};
  });
}

export type ImportState = {
  batch: Pick<ImportBatch, "id" | "status" | "progress" | "revision" | "error" | "summary">;
  rows: PreviewRow[];
};

export async function importStateAction(raw: unknown): Promise<Outcome<ImportState>> {
  const { user } = await requireSession();
  return guarded(() => {
    const input = parse(z.strictObject({ batchId: id }), raw);
    const found = getPreview(user.id, input.batchId);
    if (!found) throw new ServiceError(TEXTS.importing.errors.notFound);
    const { id: batchId, status, progress, revision: rev, error, summary } = found.batch;
    return {
      batch: { id: batchId, status, progress, revision: rev, error, summary },
      rows: found.rows,
    };
  });
}

export async function editPreviewAction(raw: unknown): Promise<Outcome<{ revision: number }>> {
  await requireSession();
  return guarded(async () => {
    const input = parse(z.strictObject({ batchId: id, revision, change: z.unknown() }), raw);
    return editPreview(
      await actorFromRequest(),
      input.batchId,
      input.revision,
      input.change as PreviewChange,
    );
  });
}

export async function confirmBatchAction(raw: unknown): Promise<Outcome> {
  await requireSession();
  return guarded(async () => {
    const input = parse(z.strictObject({ batchId: id, revision }), raw);
    confirmBatch(await actorFromRequest(), input.batchId, input.revision);
    return {};
  });
}

export async function undoBatchAction(raw: unknown): Promise<Outcome> {
  await requireSession();
  return guarded(async () => {
    const input = parse(z.strictObject({ batchId: id }), raw);
    undoBatch(await actorFromRequest(), input.batchId);
    return {};
  });
}
