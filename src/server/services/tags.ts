import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { foldText } from "@/lib/fold-text";
import { TEXTS } from "@/lib/texts";
import type { Actor } from "../audit/context";
import type { Tx } from "../db";
import { db } from "../db";
import { czech } from "../db/collation";
import { invoice, invoiceTag, tag } from "../db/schema";
import { scoped } from "../db/scoped";
import { ServiceError, type Reader } from "./access";
import { mutate } from "./mutation";

const V = TEXTS.invoices.validation;
const T = TEXTS.invoices.tags;
const MAX_TAGS = 20;

export type Tag = { id: string; name: string };

const tagNamesSchema = z
  .array(z.string(V.invalid).trim().min(1, T.name).max(40, T.tooLong), V.invalid)
  .transform((names) => {
    const unique = new Map<string, string>();
    for (const name of names) {
      const key = foldText(name);
      if (!unique.has(key)) unique.set(key, name);
    }
    return [...unique.entries()];
  })
  .refine((entries) => entries.length <= MAX_TAGS, T.tooMany);

export function assertTagNames(names: string[]): void {
  const parsed = tagNamesSchema.safeParse(names);
  if (!parsed.success) throw new ServiceError(parsed.error.issues[0]?.message ?? V.invalid);
}

function ownerOf(actor: Actor): string {
  if (!actor.userId) throw new ServiceError(V.forbidden);
  return actor.userId;
}

export function tagsOf(q: Reader, ownerId: string, invoiceId: string): Tag[] {
  return q
    .select({ id: tag.id, name: tag.name })
    .from(invoiceTag)
    .innerJoin(tag, eq(tag.id, invoiceTag.tagId))
    .where(scoped(ownerId).where(invoiceTag, (t, { eq }) => eq(t.invoiceId, invoiceId)))
    .orderBy(asc(czech(tag.name)), asc(tag.id))
    .all();
}

// Runs inside the caller's transaction, which also writes the audit entry.
export function linkTags(tx: Tx, ownerId: string, invoiceId: string, tagIds: string[]): void {
  for (const tagId of tagIds) {
    tx.insert(invoiceTag).values({ invoiceId, tagId, userId: ownerId }).run();
  }
}

class Unchanged extends Error {}

// Tags are organisational: they change on issued documents too and leave the revision alone, so
// a tag edit neither makes a version nor fails a running autosave as stale.
export function setInvoiceTags(actor: Actor, id: string, names: string[]): void {
  const userId = ownerOf(actor);
  const parsed = tagNamesSchema.safeParse(names);
  if (!parsed.success) throw new ServiceError(parsed.error.issues[0]?.message ?? V.invalid);
  const wanted = parsed.data;

  try {
    mutate(actor, "invoice.tags_set", (tx, audit) => {
      const owned = tx
        .select({ id: invoice.id })
        .from(invoice)
        .where(scoped(userId).where(invoice, (t, { eq }) => eq(t.id, id)))
        .get();
      if (!owned) throw new ServiceError(V.notFound);

      const before = tagsOf(tx, userId, id);
      const beforeKeys = new Set(before.map((row) => foldText(row.name)));
      // Thrown to roll back: mutate refuses a transaction without an audit entry.
      if (beforeKeys.size === wanted.length && wanted.every(([key]) => beforeKeys.has(key))) {
        throw new Unchanged();
      }

      const keys = wanted.map(([key]) => key);
      const existing = keys.length
        ? tx
            .select()
            .from(tag)
            .where(scoped(userId).where(tag, (t) => inArray(t.nameKey, keys)))
            .all()
        : [];
      const idByKey = new Map(existing.map((row) => [row.nameKey, row.id]));
      for (const [nameKey, name] of wanted) {
        if (idByKey.has(nameKey)) continue;
        const tagId = randomUUID();
        tx.insert(tag).values({ id: tagId, userId, name, nameKey }).run();
        idByKey.set(nameKey, tagId);
        audit({
          action: "tag.create",
          entity: "tag",
          entityId: tagId,
          ownerId: userId,
          scope: "user",
          after: { name },
        });
      }

      tx.delete(invoiceTag)
        .where(scoped(userId).where(invoiceTag, (t, { eq }) => eq(t.invoiceId, id)))
        .run();
      linkTags(
        tx,
        userId,
        id,
        keys.map((key) => idByKey.get(key)!),
      );
      audit({
        entity: "invoice",
        entityId: id,
        ownerId: userId,
        scope: "user",
        before: { tags: before.map((row) => row.name) },
        after: { tags: tagsOf(tx, userId, id).map((row) => row.name) },
      });
    });
  } catch (error) {
    if (!(error instanceof Unchanged)) throw error;
  }
}

export function listTags(ownerId: string): Tag[] {
  return db
    .select({ id: tag.id, name: tag.name })
    .from(tag)
    .where(scoped(ownerId).where(tag))
    .orderBy(asc(czech(tag.name)), asc(tag.id))
    .all();
}

export function deleteTag(actor: Actor, id: string): void {
  const userId = ownerOf(actor);
  mutate(actor, "tag.delete", (tx, audit) => {
    const row = tx
      .select()
      .from(tag)
      .where(scoped(userId).where(tag, (t, { eq }) => eq(t.id, id)))
      .get();
    if (!row) throw new ServiceError(T.notFound);
    tx.delete(tag)
      .where(and(eq(tag.id, id), eq(tag.userId, userId)))
      .run();
    audit({
      entity: "tag",
      entityId: id,
      ownerId: userId,
      scope: "user",
      before: { name: row.name },
    });
  });
}
