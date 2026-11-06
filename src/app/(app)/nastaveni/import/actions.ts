"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { PreviewChange, PreviewRow } from "@/lib/import-preview";
import { TEXTS } from "@/lib/texts";
import { actorFromRequest, requireSession } from "@/server/auth/session";
import { IMPORT_KINDS, type ImportBatch } from "@/server/db/schema";
import type { PresetView } from "@/lib/import-presets";
import { ServiceError } from "@/server/services/access";
import {
  confirmBatch,
  createBatch,
  editPreview,
  getPreview,
  startParse,
} from "@/server/services/import-batch";
import { remapBatch, submitMapping } from "@/server/services/import-tabular";
import { undoBatch } from "@/server/services/import-undo";
import {
  deletePreset,
  listPresets,
  type PresetInput,
  savePreset,
} from "@/server/services/mapping-presets";

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

export async function createImportBatchAction(raw?: unknown): Promise<Outcome<{ id: string }>> {
  await requireSession();
  return guarded(async () => {
    const input = parse(z.strictObject({ kind: z.enum(IMPORT_KINDS) }).optional(), raw);
    return createBatch(await actorFromRequest(), input?.kind ?? "isdoc");
  });
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
  batch: Pick<
    ImportBatch,
    "id" | "kind" | "target" | "status" | "progress" | "revision" | "error" | "summary"
  >;
  rows: PreviewRow[];
};

function stateOf(batch: ImportBatch): ImportState["batch"] {
  const { id: batchId, kind, target, status, progress, revision: rev, error, summary } = batch;
  return { id: batchId, kind, target, status, progress, revision: rev, error, summary };
}

export async function importStateAction(raw: unknown): Promise<Outcome<ImportState>> {
  const { user } = await requireSession();
  return guarded(() => {
    const input = parse(z.strictObject({ batchId: id }), raw);
    const found = getPreview(user.id, input.batchId);
    if (!found) throw new ServiceError(TEXTS.importing.errors.notFound);
    return {
      batch: stateOf(found.batch),
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

export async function submitMappingAction(raw: unknown): Promise<Outcome> {
  await requireSession();
  return guarded(async () => {
    const input = parse(z.strictObject({ batchId: id, revision, mapping: z.unknown() }), raw);
    submitMapping(await actorFromRequest(), input.batchId, input.revision, input.mapping);
    return {};
  });
}

export async function remapBatchAction(raw: unknown): Promise<Outcome> {
  await requireSession();
  return guarded(async () => {
    const input = parse(z.strictObject({ batchId: id, revision }), raw);
    remapBatch(await actorFromRequest(), input.batchId, input.revision);
    return {};
  });
}

export async function savePresetAction(
  raw: unknown,
): Promise<Outcome<{ id: string; presets: PresetView[] }>> {
  const { user } = await requireSession();
  return guarded(async () => {
    const input = parse(z.strictObject({ name: z.string().max(200), mapping: z.unknown() }), raw);
    const { id: presetId } = savePreset(await actorFromRequest(), {
      name: input.name,
      mapping: input.mapping as PresetInput["mapping"],
    });
    return { id: presetId, presets: listPresets(user.id) };
  });
}

export async function deletePresetAction(
  raw: unknown,
): Promise<Outcome<{ presets: PresetView[] }>> {
  const { user } = await requireSession();
  return guarded(async () => {
    const input = parse(z.strictObject({ id }), raw);
    deletePreset(await actorFromRequest(), input.id);
    return { presets: listPresets(user.id) };
  });
}
