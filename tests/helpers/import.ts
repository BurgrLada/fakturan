import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { zipSync } from "fflate";
import type { Db } from "@/server/db";
import { importBatch, supplier } from "@/server/db/schema";
import { registerJob } from "@/server/jobs/registry";
import { drainHeavy } from "@/server/jobs/worker";
import {
  confirmBatch,
  createBatch,
  getPreview,
  recoverImportJob,
  startParse,
  storeUpload,
} from "@/server/services/import-batch";
import { runImportCommit } from "@/server/services/import-commit";
import { runImportParse } from "@/server/services/import-parse";
import { seedOwner, webActor } from "./fixtures-mail";

export const FIXTURE_SUPPLIER_ICO = "99900017";
const DIR = join("tests", "fixtures", "isdoc");
const encoder = new TextEncoder();

export function isdoc(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(DIR, name)));
}

export function editedIsdoc(name: string, from: string | RegExp, to: string): Uint8Array {
  return encoder.encode(new TextDecoder().decode(isdoc(name)).replace(from, to));
}

export function zipOf(entries: Record<string, Uint8Array>): Uint8Array {
  return zipSync(entries, { level: 6 });
}

export function registerImportJobs(): void {
  registerJob("import.parse", { run: runImportParse, recover: recoverImportJob });
  registerJob("import.commit", { run: runImportCommit, recover: recoverImportJob });
}

// The fixtures are issued by 99900017, so the account must be that supplier.
export function importOwner(db: Db, now: Date): string {
  const owner = seedOwner(db, now);
  db.update(supplier).set({ ico: FIXTURE_SUPPLIER_ICO }).where(eq(supplier.userId, owner)).run();
  return owner;
}

export function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 64 * 1024)
        controller.enqueue(bytes.subarray(i, i + 64 * 1024));
      controller.close();
    },
  });
}

export async function uploadBatch(
  owner: string,
  files: { name: string; bytes: Uint8Array }[],
): Promise<string> {
  const actor = webActor(owner);
  const { id } = createBatch(actor, "isdoc");
  for (const file of files) {
    await storeUpload(actor, id, streamOf(file.bytes), {
      name: file.name,
      declaredBytes: file.bytes.length,
    });
  }
  return id;
}

export async function parsed(owner: string, files: { name: string; bytes: Uint8Array }[]) {
  const id = await uploadBatch(owner, files);
  startParse(webActor(owner), id);
  await drainHeavy("w");
  return { id, ...getPreview(owner, id)! };
}

export async function committed(db: Db, owner: string, batchId: string) {
  const batch = db.select().from(importBatch).where(eq(importBatch.id, batchId)).get()!;
  confirmBatch(webActor(owner), batchId, batch.revision);
  await drainHeavy("w");
  return db.select().from(importBatch).where(eq(importBatch.id, batchId)).get()!;
}
