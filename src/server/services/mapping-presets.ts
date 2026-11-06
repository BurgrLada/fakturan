import "server-only";
import { randomUUID } from "node:crypto";
import { asc } from "drizzle-orm";
import { z } from "zod";
import { czech } from "../db/collation";
import { mappingSchema } from "@/lib/import-mapping";
import { BUILTIN_PRESETS, type PresetView } from "@/lib/import-presets";
import { TEXTS } from "@/lib/texts";
import type { Actor } from "../audit/context";
import { clock } from "../clock";
import { db } from "../db";
import { mappingPreset } from "../db/schema";
import { scoped } from "../db/scoped";
import { ServiceError } from "./access";
import { mutate } from "./mutation";

const M = TEXTS.importing.mapping;

// IMP-002: a preset is the mapping alone, never a cell of the file it was made on.
const presetInputSchema = z.strictObject(
  {
    name: z
      .string(M.errors.presetName)
      .trim()
      .min(1, M.errors.presetName)
      .max(80, M.errors.presetName),
    mapping: mappingSchema,
  },
  M.errors.invalid,
);

export type PresetInput = z.input<typeof presetInputSchema>;

function ownerOf(actor: Actor): string {
  if (!actor.userId) throw new ServiceError(TEXTS.invoices.validation.forbidden);
  return actor.userId;
}

export function listPresets(ownerId: string): PresetView[] {
  const own = db
    .select()
    .from(mappingPreset)
    .where(scoped(ownerId).where(mappingPreset))
    .orderBy(asc(czech(mappingPreset.name)), asc(mappingPreset.id))
    .all()
    .flatMap((row): PresetView[] => {
      const mapping = mappingSchema.safeParse(row.mapping);
      return mapping.success
        ? [
            {
              id: row.id,
              name: row.name,
              target: row.target,
              mapping: mapping.data,
              builtIn: false,
            },
          ]
        : [];
    });
  return [...BUILTIN_PRESETS, ...own];
}

// The same name for the same target replaces the earlier mapping instead of failing on the index.
export function savePreset(actor: Actor, raw: PresetInput): { id: string } {
  const userId = ownerOf(actor);
  const parsed = presetInputSchema.safeParse(raw);
  if (!parsed.success) throw new ServiceError(parsed.error.issues[0]?.message ?? M.errors.invalid);
  const { name, mapping } = parsed.data;
  return mutate(actor, "mapping_preset.save", (tx, audit) => {
    const before = tx
      .select()
      .from(mappingPreset)
      .where(
        scoped(userId).where(mappingPreset, (t, { and, eq }) =>
          and(eq(t.target, mapping.target), eq(t.name, name)),
        ),
      )
      .get();
    const now = clock.now();
    const id = before?.id ?? randomUUID();
    if (before) {
      tx.update(mappingPreset)
        .set({ mapping, updatedAt: now })
        .where(scoped(userId).where(mappingPreset, (t, { eq }) => eq(t.id, id)))
        .run();
    } else {
      tx.insert(mappingPreset)
        .values({
          id,
          userId,
          name,
          target: mapping.target,
          mapping,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }
    audit({
      entity: "mapping_preset",
      entityId: id,
      ownerId: userId,
      scope: "user",
      before: before ? { name: before.name, mapping: before.mapping } : null,
      after: { name, target: mapping.target, mapping },
    });
    return { id };
  });
}

export function deletePreset(actor: Actor, id: string): void {
  const userId = ownerOf(actor);
  mutate(actor, "mapping_preset.delete", (tx, audit) => {
    const removed = tx
      .delete(mappingPreset)
      .where(scoped(userId).where(mappingPreset, (t, { eq }) => eq(t.id, id)))
      .returning()
      .get();
    if (!removed) throw new ServiceError(M.errors.presetNotFound);
    audit({
      entity: "mapping_preset",
      entityId: id,
      ownerId: userId,
      scope: "user",
      before: { name: removed.name, target: removed.target },
    });
  });
}
