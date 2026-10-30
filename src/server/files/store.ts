import "server-only";
import { mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
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

export function writeBlob(userId: string, id: string, data: Buffer): void {
  mkdirSync(userDir(userId), { recursive: true });
  writeFileSync(filePath(userId, id), data, { flag: "wx" });
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
