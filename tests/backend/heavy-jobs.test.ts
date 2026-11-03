import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { setClockForTests } from "@/server/clock";
import { file, importBatch, job, schedulerState, user, type Job } from "@/server/db/schema";
import { userDir, writeBlob } from "@/server/files/store";
import { claimNext, enqueue } from "@/server/jobs/queue";
import { registerJob } from "@/server/jobs/registry";
import {
  drainHeavy,
  drainJobs,
  jobInFlight,
  recoverInterrupted,
  yieldHeavy,
} from "@/server/jobs/worker";
import { recoverImportJob } from "@/server/services/import-batch";
import { createTestDb } from "../helpers/db";

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-heavy-")));

const db = createTestDb();
const T0 = new Date("2026-11-02T10:00:00Z");
let current = T0;

function put(kind: Job["kind"], input: Partial<Parameters<typeof enqueue>[1]> = {}) {
  return db.transaction((tx) =>
    enqueue(tx, { kind, key: randomUUID(), userId: null, payload: {}, ...input }),
  );
}

const row = (id: string) => db.select().from(job).where(eq(job.id, id)).get()!;

function gate() {
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

beforeEach(() => {
  db.delete(job).run();
  db.delete(schedulerState).run();
  current = T0;
  setClockForTests({ now: () => current });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  setClockForTests(null);
  vi.restoreAllMocks();
});

describe("těžká dráha", () => {
  test("[ARC-007] běžící export nezdrží mail.send a druhá těžká úloha čeká", async () => {
    const events: string[] = [];
    const first = gate();
    registerJob("export.run", {
      run: async (running) => {
        events.push(`start ${running.key}`);
        if (running.key === "export:1") await first.opened;
        events.push(`end ${running.key}`);
      },
    });
    registerJob("mail.send", { run: async () => void events.push("mail") });
    const one = put("export.run", { key: "export:1", maxAttempts: 3 });
    const two = put("export.run", { key: "export:2" });

    const heavy = drainHeavy("w");
    expect(row(one.id).status).toBe("running");
    expect(jobInFlight()).toBe(true);

    const mail = put("mail.send");
    expect(await drainJobs("w")).toBe(1);
    expect(row(mail.id).status).toBe("done");
    expect(await drainHeavy("w")).toEqual({ done: 0, ok: false });
    expect(row(two.id).status).toBe("pending");

    first.open();
    expect(await heavy).toEqual({ done: 2, ok: true });
    expect(events).toEqual([
      "start export:1",
      "mail",
      "end export:1",
      "start export:2",
      "end export:2",
    ]);
    expect(row(one.id)).toMatchObject({ status: "done", maxAttempts: 1 });
    expect(jobInFlight()).toBe(false);
  });

  test("[ARC-007] lehká dráha těžkou úlohu nevezme a těžká nevezme poštu", async () => {
    const heavyRun = vi.fn(async () => {});
    const mailRun = vi.fn(async () => {});
    registerJob("import.parse", { run: heavyRun });
    registerJob("mail.send", { run: mailRun });
    const heavy = put("import.parse");
    const mail = put("mail.send");

    expect(await drainJobs("w")).toBe(1);
    expect(row(heavy.id).status).toBe("pending");
    expect(await drainHeavy("w")).toEqual({ done: 1, ok: true });
    expect(heavyRun).toHaveBeenCalledOnce();
    expect(mailRun).toHaveBeenCalledOnce();
    expect(row(mail.id).status).toBe("done");
  });

  test("[ARC-007] dlouhá úloha obnovuje lease a po převzetí jiným procesem skončí", async () => {
    let blocks = 0;
    registerJob("backup.run", {
      run: async (running) => {
        for (;;) {
          blocks += 1;
          current = new Date(current.getTime() + 31_000);
          if (blocks === 3) {
            db.update(schedulerState)
              .set({ holder: "jiný", leaseUntil: new Date(current.getTime() + 120_000) })
              .run();
          }
          await yieldHeavy(running);
        }
      },
    });
    const { id } = put("backup.run");

    await drainHeavy("w");

    expect(blocks).toBe(3);
    expect(row(id).status).toBe("dead");
  });
});

describe("přerušený běh", () => {
  test("[TST-017] přerušená těžká úloha skončí failed a uklidí dočasný soubor", () => {
    const owner = randomUUID();
    db.insert(user)
      .values({ id: owner, name: owner, email: `${owner}@x.cz`, createdAt: T0, updatedAt: T0 })
      .run();
    const batchId = randomUUID();
    db.insert(importBatch)
      .values({
        id: batchId,
        userId: owner,
        kind: "isdoc",
        status: "parsing",
        createdAt: T0,
        updatedAt: T0,
      })
      .run();
    const upload = randomUUID();
    db.insert(file)
      .values({
        id: upload,
        userId: owner,
        kind: "import_upload",
        mimeType: "application/zip",
        name: "faktury.zip",
        size: 4,
        importBatchId: batchId,
        createdAt: T0,
      })
      .run();
    writeBlob(owner, upload, Buffer.from("PK.."));
    registerJob("import.parse", { run: async () => {}, recover: recoverImportJob });
    const { id } = put("import.parse", { userId: owner, payload: { batchId } });
    claimNext("mrtvý", "heavy");

    recoverInterrupted("nový");

    expect(row(id).status).toBe("dead");
    const batch = db.select().from(importBatch).where(eq(importBatch.id, batchId)).get()!;
    expect(batch.status).toBe("failed");
    expect(batch.error).toBeTruthy();
    expect(db.select().from(file).where(eq(file.importBatchId, batchId)).all()).toEqual([]);
    expect(existsSync(join(userDir(owner), upload))).toBe(false);
  });

  test("[TST-017] obnova nesáhne na dávku, která už doběhla", () => {
    const owner = randomUUID();
    db.insert(user)
      .values({ id: owner, name: owner, email: `${owner}@x.cz`, createdAt: T0, updatedAt: T0 })
      .run();
    const batchId = randomUUID();
    db.insert(importBatch)
      .values({
        id: batchId,
        userId: owner,
        kind: "isdoc",
        status: "done",
        createdAt: T0,
        updatedAt: T0,
      })
      .run();
    registerJob("import.commit", { run: async () => {}, recover: recoverImportJob });
    const { id } = put("import.commit", { userId: owner, payload: { batchId } });
    claimNext("mrtvý", "heavy");

    recoverInterrupted("nový");

    expect(row(id).status).toBe("dead");
    expect(db.select().from(importBatch).where(eq(importBatch.id, batchId)).get()!.status).toBe(
      "done",
    );
  });
});
