import "server-only";
import { randomUUID } from "node:crypto";
import { isNull } from "drizzle-orm";
import { TEXTS } from "@/lib/texts";
import type { Actor } from "../audit/context";
import { clock } from "../clock";
import { db } from "../db";
import { emailLog, FILE_KINDS, file, type FileKind } from "../db/schema";
import { scoped } from "../db/scoped";
import { readBlob, removeBlob, writeBlob } from "../files/store";
import { InvalidFileError, validateImage } from "../files/validate";
import { logger } from "../logger";
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
  if (!FILE_KINDS.includes(kind)) throw new ServiceError("Neplatný druh souboru");
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

const E = TEXTS.invoiceMail.errors;

class AlreadyArchived extends Error {
  fileId: string;

  constructor(fileId: string) {
    super("Archiv už existuje");
    this.fileId = fileId;
  }
}

type SentKind = "sent_pdf" | "sent_isdoc";

const SENT_ARCHIVES = {
  sent_pdf: { mimeType: "application/pdf", column: "fileId" },
  sent_isdoc: { mimeType: "application/xml", column: "isdocFileId" },
} as const satisfies Record<SentKind, { mimeType: string; column: "fileId" | "isdocFileId" }>;

// Blob, row and link commit together. The check sits inside the transaction, so a recovered job
// and the late attempt it replaced cannot both attach a file.
function archiveSent(
  actor: Actor,
  logId: string,
  kind: SentKind,
  data: Buffer,
  name: string,
): { id: string } {
  const userId = ownerOf(actor);
  const { mimeType, column } = SENT_ARCHIVES[kind];
  const id = randomUUID();
  try {
    mutate(actor, "file.create", (tx, audit) => {
      const log = tx
        .select({ linked: emailLog[column] })
        .from(emailLog)
        .where(scoped(userId).where(emailLog, (t, { eq: is }) => is(t.id, logId)))
        .get();
      if (!log) throw new ServiceError(E.logNotFound);
      if (log.linked) throw new AlreadyArchived(log.linked);
      tx.insert(file)
        .values({
          id,
          userId,
          kind,
          mimeType,
          name: displayName(name),
          size: data.length,
          createdAt: clock.now(),
        })
        .run();
      writeBlob(userId, id, data);
      tx.update(emailLog)
        .set({ [column]: id, updatedAt: clock.now() })
        .where(
          scoped(userId).where(emailLog, (t, { and, eq: is }) =>
            and(is(t.id, logId), isNull(t[column])),
          ),
        )
        .run();
      audit({
        entity: "file",
        entityId: id,
        ownerId: userId,
        scope: "user",
        after: { kind, mimeType, size: data.length, logId },
      });
    });
  } catch (error) {
    if (error instanceof AlreadyArchived) return { id: error.fileId };
    removeBlob(userId, id);
    throw error;
  }
  return { id };
}

export function archiveSentPdf(
  actor: Actor,
  logId: string,
  data: Buffer,
  name: string,
): { id: string } {
  if (data.subarray(0, 5).toString("latin1") !== "%PDF-") throw new ServiceError(E.notPdf);
  return archiveSent(actor, logId, "sent_pdf", data, name);
}

// Kept like the PDF, so another attempt of the same record sends the very same file (R-25).
export function archiveSentIsdoc(
  actor: Actor,
  logId: string,
  data: Buffer,
  name: string,
): { id: string } {
  return archiveSent(actor, logId, "sent_isdoc", data, name);
}

export function readOwnedFile(
  actor: Actor,
  id: string,
): { data: Buffer; mimeType: string; name: string; kind: FileKind } {
  const userId = ownerOf(actor);
  const row = db
    .select()
    .from(file)
    .where(scoped(userId).where(file, (t, { eq: is }) => is(t.id, id)))
    .get();
  if (!row) throw new FileNotFoundError();
  try {
    return { data: readBlob(userId, id), mimeType: row.mimeType, name: row.name, kind: row.kind };
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
    if (row.kind === "sent_pdf" || row.kind === "sent_isdoc") {
      throw new ServiceError(E.archiveLocked);
    }
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
  try {
    removeBlob(userId, id);
  } catch (error) {
    logger.warn("Soubor se nepodařilo odstranit z disku", { fileId: id, error });
  }
}
