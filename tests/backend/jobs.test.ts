import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { job, schedulerState, user } from "@/server/db/schema";
import { scoped } from "@/server/db/scoped";
import { setClockForTests } from "@/server/clock";
import {
  cancelUserJobs,
  claimNext,
  completeJob,
  enqueue,
  failJob,
  purgeFinishedJobs,
  retryJob,
} from "@/server/jobs/queue";
import { registerJob, RetryLater } from "@/server/jobs/registry";
import { drainJobs, recoverInterrupted } from "@/server/jobs/worker";
import { deactivateUser, deleteUser } from "@/server/services/users";
import { createTestDb } from "../helpers/db";
import { assertIsolated } from "../helpers/isolation";

const report = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock("@sentry/nextjs", () => ({ captureException: report.captureException }));

const db = createTestDb();
const T0 = new Date("2026-11-02T10:00:00Z");
const KIND = "mail.send";

function now(at: Date) {
  setClockForTests({ now: () => at });
}

function createUser(role: "admin" | "user" = "user"): string {
  const id = randomUUID();
  db.insert(user)
    .values({ id, name: id, email: `${id}@x.cz`, role, createdAt: T0, updatedAt: T0 })
    .run();
  return id;
}

function put(input: Partial<Parameters<typeof enqueue>[1]> = {}) {
  return db.transaction((tx) =>
    enqueue(tx, { kind: KIND, key: randomUUID(), userId: null, payload: { id: "1" }, ...input }),
  );
}

function row(id: string) {
  return db.select().from(job).where(eq(job.id, id)).get()!;
}

beforeEach(() => {
  db.delete(job).run();
  db.delete(schedulerState).run();
  report.captureException.mockClear();
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  now(T0);
  registerJob(KIND, { run: async () => {} });
});

afterEach(() => {
  setClockForTests(null);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("fronta", () => {
  test("[ARC-007] stejný klíč založí jednu úlohu a druhý enqueue vrátí created: false", () => {
    const first = put({ key: "invoice:1" });
    const second = put({ key: "invoice:1" });
    expect(first.created).toBe(true);
    expect(second).toEqual({ id: first.id, created: false });
    expect(db.select().from(job).all()).toHaveLength(1);
  });

  test("[ARC-007] selhaná transakce úlohu nezaloží", () => {
    expect(() =>
      db.transaction((tx) => {
        enqueue(tx, { kind: KIND, key: "k", userId: null, payload: {} });
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    expect(db.select().from(job).all()).toEqual([]);
  });

  test("claim vezme nejstarší splatnou úlohu, zvýší attempts a zapíše držitele", () => {
    const later = put({ runAt: new Date(T0.getTime() - 1_000) });
    const older = put({ runAt: new Date(T0.getTime() - 5_000) });
    const claimed = claimNext("w1")!;
    expect(claimed.id).toBe(older.id);
    expect(claimed).toMatchObject({ status: "running", attempts: 1, lockedBy: "w1" });
    expect(claimNext("w2")!.id).toBe(later.id);
    expect(claimNext("w3")).toBeNull();
  });

  test("completeJob, retryJob a failJob nastaví koncový stav a uvolní držitele", () => {
    const a = put();
    claimNext("w");
    completeJob(a.id);
    expect(row(a.id)).toMatchObject({ status: "done", lockedBy: null });

    const b = put();
    claimNext("w");
    const runAt = new Date(T0.getTime() + 60_000);
    retryJob(b.id, { runAt, reason: "později" });
    expect(row(b.id)).toMatchObject({
      status: "pending",
      lockedBy: null,
      reason: "později",
      runAt,
    });

    now(runAt);
    claimNext("w");
    failJob(b.id, "konec");
    expect(row(b.id)).toMatchObject({ status: "dead", lockedBy: null, reason: "konec" });
  });

  test("zpožděný výsledek neoživí úlohu, kterou mezitím převzala obnova", () => {
    const { id } = put();
    claimNext("w");
    retryJob(id, { runAt: T0, reason: "obnova" });
    completeJob(id);
    expect(row(id).status).toBe("pending");
  });
});

describe("obnova", () => {
  test("[ARC-007] běžící úloha po pádu projde recover a doběhne", async () => {
    const run = vi.fn(async () => {});
    registerJob(KIND, { run });
    const { id } = put();
    claimNext("mrtvý");

    recoverInterrupted("nový");
    expect(row(id)).toMatchObject({ status: "pending", lockedBy: null });
    expect(await drainJobs("nový")).toBe(1);
    expect(run).toHaveBeenCalledOnce();
    expect(row(id).status).toBe("done");
  });

  test("[ARC-007] vlastní recover rozhodne místo výchozího návratu do fronty", () => {
    const recover = vi.fn((running: { id: string }) => failJob(running.id, "nejisté"));
    registerJob(KIND, { run: async () => {}, recover });
    const { id } = put();
    claimNext("mrtvý");
    recoverInterrupted("nový");
    expect(recover).toHaveBeenCalledOnce();
    expect(row(id)).toMatchObject({ status: "dead", reason: "nejisté" });
  });

  test("obnova nesáhne na vlastní běžící úlohu držitele", () => {
    const { id } = put();
    claimNext("nový");
    recoverInterrupted("nový");
    expect(row(id).status).toBe("running");
  });

  test("úloha bez zbývajících pokusů po pádu skončí jako dead a nahlášená", () => {
    vi.stubEnv("SENTRY_DSN", "https://k@errors.example.cz/1");
    const { id } = put({ maxAttempts: 1 });
    claimNext("mrtvý");
    recoverInterrupted("nový");
    expect(row(id).status).toBe("dead");
    expect(report.captureException).toHaveBeenCalledOnce();
  });

  test("výjimka z recover úlohu neuvězní ve stavu running", () => {
    registerJob(KIND, {
      run: async () => {},
      recover: () => {
        throw new Error("recover selhal");
      },
    });
    const { id } = put();
    claimNext("mrtvý");
    recoverInterrupted("nový");
    expect(row(id).status).toBe("dead");
  });
});

describe("selhání", () => {
  test("[ARC-007] po max_attempts je úloha dead a hlášená", async () => {
    vi.stubEnv("SENTRY_DSN", "https://k@errors.example.cz/1");
    registerJob(KIND, {
      run: async () => {
        throw new Error("pád");
      },
    });
    const { id } = put({ maxAttempts: 2 });
    await drainJobs("w");
    expect(row(id)).toMatchObject({ status: "pending", attempts: 1 });
    now(new Date(row(id).runAt.getTime()));
    await drainJobs("w");
    expect(row(id)).toMatchObject({ status: "dead", attempts: 2 });
    expect(report.captureException).toHaveBeenCalledTimes(2);
  });

  test("RetryLater spotřebuje pokus, posune run_at a není hlášený", async () => {
    vi.stubEnv("SENTRY_DSN", "https://k@errors.example.cz/1");
    registerJob(KIND, {
      run: async () => {
        throw new RetryLater("server nedostupný", 90_000);
      },
    });
    const { id } = put({ maxAttempts: 2 });
    await drainJobs("w");
    expect(row(id)).toMatchObject({ status: "pending", attempts: 1 });
    expect(row(id).runAt).toEqual(new Date(T0.getTime() + 90_000));
    expect(report.captureException).not.toHaveBeenCalled();

    now(row(id).runAt);
    await drainJobs("w");
    expect(row(id)).toMatchObject({ status: "dead", attempts: 2 });
    expect(report.captureException).toHaveBeenCalledOnce();
  });

  test("druh bez registrace selže jako kterákoli jiná úloha", async () => {
    const { id } = put({ kind: "neznámý" as typeof KIND, maxAttempts: 1 });
    await drainJobs("w");
    expect(row(id).status).toBe("dead");
  });
});

describe("údržba", () => {
  test("po 90 dnech zmizí hotové a zrušené úlohy, mrtvé a čekající zůstanou", () => {
    const done = put();
    claimNext("w");
    completeJob(done.id);
    const dead = put();
    claimNext("w");
    failJob(dead.id, "x");
    const waiting = put({ runAt: new Date(T0.getTime() + 1_000) });

    const day = 86_400_000;
    purgeFinishedJobs(new Date(T0.getTime() + 89 * day));
    expect(db.select().from(job).all()).toHaveLength(3);
    purgeFinishedJobs(new Date(T0.getTime() + 91 * day));
    expect(
      db
        .select({ id: job.id })
        .from(job)
        .all()
        .map((r) => r.id)
        .sort(),
    ).toEqual([dead.id, waiting.id].sort());
  });
});

describe("účty", () => {
  test("[ADM-005] deaktivace zruší čekající úlohy, claim je nepřevezme", () => {
    const admin = createUser("admin");
    const owner = createUser();
    const cancelled = put({ userId: owner });
    const other = put({ userId: admin });
    deactivateUser({ userId: admin, source: "web" }, owner);
    expect(row(cancelled.id).status).toBe("cancelled");
    expect(row(other.id).status).toBe("pending");
  });

  test("[ADM-005] claim přeskočí účet deaktivovaný mimo frontu, instanční úlohu ne", () => {
    const owner = createUser();
    const skipped = put({ userId: owner });
    const instance = put();
    db.update(user).set({ banned: true }).where(eq(user.id, owner)).run();
    expect(claimNext("w")!.id).toBe(instance.id);
    expect(claimNext("w")).toBeNull();
    expect(row(skipped.id).status).toBe("pending");
  });

  test("cancelUserJobs vrátí ID zrušených a běžící pokus nechá doběhnout", () => {
    const owner = createUser();
    const running = put({ userId: owner });
    claimNext("w");
    const waiting = put({ userId: owner });
    const ids = db.transaction((tx) => cancelUserJobs(tx, owner));
    expect(ids).toEqual([waiting.id]);
    expect(row(running.id).status).toBe("running");
  });

  test("[TST-009] úlohy cizího účtu nejsou v jeho výpisu a mizí se smazáním účtu", async () => {
    const owners = [createUser(), createUser()] as const;
    const list = (ownerId: string) => db.select().from(job).where(scoped(ownerId).where(job)).all();
    await assertIsolated<string>({
      owners,
      create: (ownerId) => put({ userId: ownerId }).id,
      find: (ownerId, id) =>
        db
          .select()
          .from(job)
          .where(and(scoped(ownerId).where(job), eq(job.id, id)))
          .get(),
      list: (ownerId) => list(ownerId).map((r) => r.id),
      update: (ownerId, id) =>
        db
          .update(job)
          .set({ reason: "změna" })
          .where(and(scoped(ownerId).where(job), eq(job.id, id)))
          .run().changes,
      remove: (ownerId, id) =>
        db
          .delete(job)
          .where(and(scoped(ownerId).where(job), eq(job.id, id)))
          .run().changes,
    });

    const admin = createUser("admin");
    const leaver = createUser();
    put({ userId: leaver });
    const instance = put();
    deleteUser({ userId: admin, source: "web" }, leaver, `${leaver}@x.cz`);
    expect(list(leaver)).toEqual([]);
    expect(row(instance.id).status).toBe("pending");
  });
});
