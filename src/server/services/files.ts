import "server-only";
import { randomUUID } from "node:crypto";
import type { Actor } from "../audit/context";
import { clock } from "../clock";
import { db } from "../db";
import { file, type FileKind } from "../db/schema";
import { scoped } from "../db/scoped";
import { readBlob, removeBlob, writeBlob } from "../files/store";
import { InvalidFileError, validateImage } from "../files/validate";
import { ServiceError } from "./access";
import { mutate } from "./mutation";

export type { FileKind };

export class FileNotFoundError extends Error {}

function ownerOf(actor: Actor): string {
  if (!actor.userId) throw new ServiceError("Na tuto akci nemáte oprávnění");
  return actor.userId;
}

// Only the final path segment, bounded, so it is safe to echo in Content-Disposition.
function displayName(name: string): string {
  const base = name.split(/[\\/]/).at(-1) ?? "";
  // oxlint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f"]/g, "").trim();
  return cleaned.slice(0, 120) || "soubor";
}

export function storeFile(
  actor: Actor,
  kind: FileKind,
  data: Buffer,
  name: string,
): { id: string } {
  const userId = ownerOf(actor);
  let valid;
  try {
    valid = validateImage(data);
  } catch (error) {
    if (error instanceof InvalidFileError) throw new ServiceError(error.message);
    throw error;
  }
  const id = randomUUID();
  const label = displayName(name);
  try {
    mutate(actor, "file.create", (tx, audit) => {
      tx.insert(file)
        .values({
          id,
          userId,
          kind,
          mimeType: valid.mimeType,
          name: label,
          size: valid.data.length,
          createdAt: clock.now(),
        })
        .run();
      writeBlob(userId, id, valid.data);
      audit({
        entity: "file",
        entityId: id,
        ownerId: userId,
        scope: "user",
        after: { kind, mimeType: valid.mimeType, size: valid.data.length },
      });
    });
  } catch (error) {
    removeBlob(userId, id);
    throw error;
  }
  return { id };
}

export function readOwnedFile(
  actor: Actor,
  id: string,
): { data: Buffer; mimeType: string; name: string } {
  const userId = ownerOf(actor);
  const row = db
    .select()
    .from(file)
    .where(scoped(userId).where(file, (t, { eq: is }) => is(t.id, id)))
    .get();
  if (!row) throw new FileNotFoundError();
  try {
    return { data: readBlob(userId, id), mimeType: row.mimeType, name: row.name };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new FileNotFoundError();
    throw error;
  }
}

export function deleteFile(actor: Actor, id: string): void {
  const userId = ownerOf(actor);
  mutate(actor, "file.delete", (tx, audit) => {
    const row = tx
      .select()
      .from(file)
      .where(scoped(userId).where(file, (t, { eq: is }) => is(t.id, id)))
      .get();
    if (!row) throw new FileNotFoundError();
    tx.delete(file)
      .where(scoped(userId).where(file, (t, { eq: is }) => is(t.id, id)))
      .run();
    audit({
      entity: "file",
      entityId: id,
      ownerId: userId,
      scope: "user",
      before: { kind: row.kind, mimeType: row.mimeType, size: row.size },
    });
  });
  removeBlob(userId, id);
}
