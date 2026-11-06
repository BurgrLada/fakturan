import "server-only";
import {
  createWriteStream,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  type WriteStream,
} from "node:fs";
import { join } from "node:path";
import { env } from "../env";

const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;

function segment(value: string): string {
  if (!SAFE_SEGMENT.test(value)) throw new Error("Neplatný identifikátor souboru");
  return value;
}

export function userDir(userId: string): string {
  return join(env.DATA_DIR, "files", segment(userId));
}

function filePath(userId: string, id: string): string {
  return join(userDir(userId), segment(id));
}

// For writers and readers that stream instead of holding the whole blob in memory.
export function blobPath(userId: string, id: string): string {
  mkdirSync(userDir(userId), { recursive: true });
  return filePath(userId, id);
}

export function writeBlob(userId: string, id: string, data: Buffer): void {
  mkdirSync(userDir(userId), { recursive: true });
  writeFileSync(filePath(userId, id), data, { flag: "wx" });
}

// For a file rewritten in place: readers see the old or the new content, never half of it.
export function replaceBlob(userId: string, id: string, data: Buffer): void {
  mkdirSync(userDir(userId), { recursive: true });
  const temporary = filePath(userId, `${id}-tmp`);
  writeFileSync(temporary, data);
  renameSync(temporary, filePath(userId, id));
}

export function blobWriter(userId: string, id: string): WriteStream {
  mkdirSync(userDir(userId), { recursive: true });
  return createWriteStream(filePath(userId, id), { flags: "wx" });
}

// Inside the account folder, so removeUserDir takes a leftover with the account.
export function tempDir(userId: string, id: string): string {
  return join(userDir(userId), segment(`tmp-${id}`));
}

export function removeTempDir(userId: string, id: string): void {
  rmSync(tempDir(userId, id), { recursive: true, force: true });
}

export function readBlob(userId: string, id: string): Buffer {
  return readFileSync(filePath(userId, id));
}

export function removeBlob(userId: string, id: string): void {
  try {
    unlinkSync(filePath(userId, id));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function removeUserDir(userId: string): void {
  rmSync(userDir(userId), { recursive: true, force: true });
}
