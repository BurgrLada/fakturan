import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import { setClockForTests } from "@/server/clock";
import { job, schedulerState } from "@/server/db/schema";
import { checkHealth } from "@/server/health";
import { claimNext, completeJob, enqueue } from "@/server/jobs/queue";
import { jobDefinition, registerJob } from "@/server/jobs/registry";
import { runRateFetch } from "@/server/services/exchange-rates";
import { deliverMail, recoverMail } from "@/server/services/mail-delivery";
import { drainJobs, kickWorker } from "@/server/jobs/worker";
import { acquireLease, releaseLease } from "@/server/scheduler/lease";
import { reportFailure } from "@/server/scheduler/report";
import {
  cronPattern,
  jobCleanupTask,
  schedulerHealth,
  startScheduler,
  stopScheduler,
} from "@/server/scheduler/start";
import {
  registerTickTask,
  resetTickTasksForTests,
  tickTasksForTests,
  tick,
} from "@/server/scheduler/tick";
import { scrubEvent } from "@/server/monitoring/before-send";
import { createTestDb } from "../helpers/db";

const report = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock("@sentry/nextjs", () => ({ captureException: report.captureException }));

const db = createTestDb();
const T0 = new Date("2026-11-02T10:00:00Z");
const KIND = "mail.send";
const MINUTE = 60_000;

let at = T0;
function advance(ms: number) {
  at = new Date(at.getTime() + ms);
}

function put(runAt?: Date, key = "k") {
  return db.transaction((tx) => enqueue(tx, { kind: KIND, key, userId: null, payload: {}, runAt }));
}

function state() {
  return db.select().from(schedulerState).where(eq(schedulerState.id, 1)).get();
}

beforeEach(() => {
  db.delete(job).run();
  db.delete(schedulerState).run();
  resetTickTasksForTests();
  report.captureException.mockClear();
  at = T0;
  setClockForTests({ now: () => at });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  registerJob(KIND, { run: async () => {} });
});

afterEach(() => {
  stopScheduler();
  setClockForTests(null);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("hodiny", () => {
  test("[ARC-004] úloha s run_at v budoucnu neběží, po posunu hodin ano", async () => {
    const run = vi.fn(async () => {});
    registerJob(KIND, { run });
    put(new Date(T0.getTime() + 10 * MINUTE));
    await tick("a");
    expect(run).not.toHaveBeenCalled();
    advance(10 * MINUTE);
    await tick("a");
    expect(run).toHaveBeenCalledOnce();
  });

  test("[ARC-004] kód plánovače nepoužívá Date.now ani new Date() bez argumentu", () => {
    const dirs = ["src/server/jobs", "src/server/scheduler"];
    const files = dirs.flatMap((dir) =>
      readdirSync(join(process.cwd(), dir)).map((name) => join(process.cwd(), dir, name)),
    );
    expect(files.length).toBeGreaterThanOrEqual(7);
    for (const file of files) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/Date\.now\(|new Date\(\s*\)/);
    }
  });
});

describe("lease", () => {
  test("[ARC-008] druhý držitel při živém lease nespustí nic, po vypršení převezme", async () => {
    const run = vi.fn();
    registerTickTask({ name: "úkol", run });
    expect(await tick("a")).toEqual({ ran: true });
    expect(run).toHaveBeenCalledTimes(1);

    advance(MINUTE);
    expect(await tick("b")).toEqual({ ran: false });
    expect(run).toHaveBeenCalledTimes(1);

    advance(2 * MINUTE + 1);
    expect(await tick("b")).toEqual({ ran: true });
    expect(run).toHaveBeenCalledTimes(2);
    expect(state()?.holder).toBe("b");
  });

  test("[ARC-008] převzetí po cizím držiteli vrátí jeho běžící úlohu do fronty", async () => {
    const run = vi.fn(async () => {});
    acquireLease("a");
    put();
    claimNext("a");
    registerJob(KIND, { run });

    advance(3 * MINUTE);
    await tick("b");
    expect(run).toHaveBeenCalledOnce();
    expect(db.select().from(job).get()?.status).toBe("done");
  });

  test("[ARC-008] lease platí přesně 120 s, v tu chvíli už ho jiný držitel převezme", () => {
    expect(acquireLease("a")).toBe("taken_over");
    advance(2 * MINUTE - 1);
    expect(acquireLease("b")).toBe("busy");
    advance(1);
    expect(acquireLease("b")).toBe("taken_over");
  });

  test("acquireLease rozliší držení, převzetí a obsazeno; uvolnění dovolí převzít hned", () => {
    expect(acquireLease("a")).toBe("taken_over");
    expect(acquireLease("a")).toBe("held");
    expect(acquireLease("b")).toBe("busy");
    releaseLease("b");
    expect(acquireLease("b")).toBe("busy");
    releaseLease("a");
    expect(acquireLease("b")).toBe("taken_over");
  });

  test("[ARC-008] lease se obnovuje před každou úlohou", async () => {
    const seen: (Date | null | undefined)[] = [];
    registerJob(KIND, {
      run: async () => {
        seen.push(state()?.leaseUntil);
        advance(100_000);
      },
    });
    put(undefined, "1");
    put(undefined, "2");
    put(undefined, "3");
    await drainJobs("a");
    expect(seen).toEqual([
      new Date(T0.getTime() + 120_000),
      new Date(T0.getTime() + 220_000),
      new Date(T0.getTime() + 320_000),
    ]);
  });

  test("[ARC-008] cizí převzetí během úlohy zastaví další práci", async () => {
    const run = vi.fn(async () => {
      advance(3 * MINUTE);
      acquireLease("b");
    });
    registerJob(KIND, { run });
    put(undefined, "1");
    put(undefined, "2");
    await drainJobs("a");
    expect(run).toHaveBeenCalledOnce();
    expect(db.select().from(job).where(eq(job.key, "2")).get()?.status).toBe("pending");
  });

  test("[ARC-008] lease se obnovuje mezi tick úlohami a ztráta zastaví další", async () => {
    const next = vi.fn();
    registerTickTask({
      name: "pomalá",
      run: () => {
        advance(3 * MINUTE);
        acquireLease("b");
      },
    });
    registerTickTask({ name: "další", run: next });
    expect(await tick("a")).toEqual({ ran: true });
    expect(next).not.toHaveBeenCalled();
    expect(state()?.lastOkAt).toBeNull();

    const seen: unknown[] = [];
    resetTickTasksForTests();
    advance(3 * MINUTE);
    registerTickTask({ name: "první", run: () => advance(100_000) });
    registerTickTask({ name: "druhá", run: () => void seen.push(state()?.leaseUntil) });
    await tick("c");
    expect(seen).toEqual([new Date(at.getTime() + 120_000)]);
  });
});

describe("tick", () => {
  test("[ARC-007] tick spustí těžkou dráhu a nečeká, až doběhne", async () => {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => (open = resolve));
    const run = vi.fn(() => opened);
    registerJob("export.run", { run });
    const { id } = db.transaction((tx) =>
      enqueue(tx, { kind: "export.run", key: "export:tick", userId: null, payload: {} }),
    );
    const status = () => db.select().from(job).where(eq(job.id, id)).get()?.status;

    expect(await tick("a")).toEqual({ ran: true });
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    expect(status()).toBe("running");

    open();
    await vi.waitFor(() => expect(status()).toBe("done"));
  });

  test("zapíše last_tick_at před úlohami a last_ok_at až po frontě", async () => {
    const seen: unknown[] = [];
    registerTickTask({
      name: "úkol",
      run: () => {
        seen.push(state()?.lastTickAt, state()?.lastOkAt);
        advance(1_000);
      },
    });
    registerJob(KIND, {
      run: async () => {
        seen.push(state()?.lastOkAt);
        advance(1_000);
      },
    });
    put();
    await tick("a");
    expect(seen).toEqual([T0, null, null]);
    expect(state()?.lastOkAt).toEqual(new Date(T0.getTime() + 2_000));
  });

  test("[OPS-004] pomalá fronta nechá zbytek dalšímu ticku a health neshodí", async () => {
    db.insert(schedulerState).values({ id: 1, startedAt: at }).run();
    const run = vi.fn(async () => advance(20_000));
    registerJob(KIND, { run });
    for (let i = 0; i < 6; i += 1) put(undefined, String(i));

    await tick("a");
    expect(run).toHaveBeenCalledTimes(3);
    expect(state()?.lastOkAt).toEqual(at);
    expect(schedulerHealth(db)).toBe("running");

    await tick("a");
    expect(run).toHaveBeenCalledTimes(6);
  });

  test("last_ok_at nepřibude po selhané úloze ani když frontu drží jiný běh", async () => {
    registerTickTask({
      name: "padá",
      run: () => {
        throw new Error("pád");
      },
    });
    await tick("a");
    expect(state()?.lastTickAt).toEqual(at);
    expect(state()?.lastOkAt).toBeNull();

    resetTickTasksForTests();
    let finish = () => {};
    registerJob(KIND, { run: () => new Promise<void>((resolve) => (finish = resolve)) });
    put();
    const draining = drainJobs("a");
    await tick("a");
    expect(state()?.lastOkAt).toBeNull();
    finish();
    await draining;
    await tick("a");
    expect(state()?.lastOkAt).toEqual(at);
  });

  test("[MON-003] selhání jedné tick úlohy nezastaví další", async () => {
    vi.stubEnv("SENTRY_DSN", "https://k@errors.example.cz/1");
    const next = vi.fn();
    const run = vi.fn(async () => {});
    registerJob(KIND, { run });
    put();
    registerTickTask({
      name: "padá",
      run: () => {
        throw new Error("pád");
      },
    });
    registerTickTask({ name: "další", run: next });
    await tick("a");
    expect(next).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledOnce();
    expect(report.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { task: "padá" } }),
    );
  });

  test("denní údržba smaže hotovou úlohu po 90 dnech jednou za den", async () => {
    const { id } = put();
    claimNext("w");
    completeJob(id, "w");
    const fresh = put(undefined, "dnes");
    claimNext("w");
    completeJob(fresh.id, "w");
    const later = new Date(T0.getTime() + 91 * 86_400_000);
    const tooEarly = new Date("2027-02-01T01:00:00Z");
    jobCleanupTask.run(tooEarly);
    expect(db.select().from(job).all()).toHaveLength(2);

    jobCleanupTask.run(later);
    expect(db.select().from(job).all()).toEqual([]);

    const again = put(new Date(later.getTime() - 100 * 86_400_000), "znovu");
    claimNext("w");
    completeJob(again.id, "w");
    db.update(job)
      .set({ updatedAt: new Date(later.getTime() - 100 * 86_400_000) })
      .where(eq(job.id, again.id))
      .run();
    jobCleanupTask.run(later);
    expect(db.select().from(job).all()).toHaveLength(1);
  });
});

describe("hlášení", () => {
  test("[MON-003] selhání úlohy zavolá Sentry s druhem a ID, bez adres a textu odpovědi", async () => {
    vi.stubEnv("SENTRY_DSN", "https://k@errors.example.cz/1");
    const write = vi.mocked(process.stdout.write);
    const failure = Object.assign(new Error("Doručení pro jan@example.cz: 550 mailbox full"), {
      response: "550 mailbox full",
    });
    registerJob(KIND, {
      run: async () => {
        throw failure;
      },
    });
    const { id } = put();
    await tick("a");

    const [error, context] = report.captureException.mock.calls[0];
    expect(error).toBe(failure);
    expect(context.tags).toEqual({ task: "job", kind: KIND, job_id: id });
    const log = write.mock.calls.map(([line]) => String(line)).join("");
    expect(log).toContain(id);
    expect(log).not.toContain("jan@example.cz");
    expect(log).not.toContain("mailbox full");

    const sent = scrubEvent({
      tags: context.tags,
      exception: { values: [{ type: "Error", value: failure.message }] },
    });
    expect(sent.tags).toEqual(context.tags);
    expect(JSON.stringify(sent)).not.toContain("jan@example.cz");
    expect(JSON.stringify(sent)).not.toContain("mailbox full");
  });

  test("[MON-003] bez SENTRY_DSN jde selhání jen do logu, s ID účtu v události", () => {
    reportFailure(new Error("x"), { task: "t" });
    expect(report.captureException).not.toHaveBeenCalled();
    vi.stubEnv("SENTRY_DSN", "https://k@errors.example.cz/1");
    reportFailure("řetězec", { task: "t", userId: "u1" });
    expect(report.captureException).toHaveBeenCalledWith(
      "řetězec",
      expect.objectContaining({ user: { id: "u1" } }),
    );
  });
});

describe("health", () => {
  test("[OPS-004] health: running, po 5 min bez ticku stale a status error", async () => {
    expect(checkHealth(db)).toEqual({ status: "ok", database: "ok", scheduler: "not_started" });
    db.insert(schedulerState).values({ id: 1, startedAt: at }).run();
    await tick("a");
    advance(5 * MINUTE);
    expect(checkHealth(db)).toEqual({ status: "ok", database: "ok", scheduler: "running" });
    advance(1);
    expect(checkHealth(db)).toEqual({ status: "error", database: "ok", scheduler: "stale" });
  });

  test("[OPS-004] nedostupná tabulka plánovače health neshodí", () => {
    const broken = {
      $client: {
        prepare: () => {
          throw new Error("no such table");
        },
      },
    } as unknown as Parameters<typeof schedulerHealth>[0];
    expect(schedulerHealth(broken)).toBe("not_started");
  });
});

describe("start", () => {
  function stubEnv(seconds?: string) {
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
    vi.stubEnv("BETTER_AUTH_SECRET", "x".repeat(32));
    vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
    if (seconds) vi.stubEnv("SCHEDULER_TICK_SECONDS", seconds);
  }

  test("vzor cronu vychází z intervalu", () => {
    expect(cronPattern(5)).toBe("*/5 * * * * *");
    expect(cronPattern(60)).toBe("*/60 * * * * *");
  });

  test("[OPS-004] start zapíše řádek synchronně, restart smaže starý tick a stop uvolní lease", async () => {
    stubEnv();
    db.insert(schedulerState).values({ id: 1, lastTickAt: T0 }).run();
    advance(60 * MINUTE);
    startScheduler();
    expect(state()?.startedAt).toEqual(at);
    expect(schedulerHealth(db)).toBe("starting");
    expect(checkHealth(db).status).toBe("ok");

    advance(5 * MINUTE + 1);
    expect(schedulerHealth(db)).toBe("stale");

    const first = state()?.startedAt;
    advance(1_000);
    startScheduler();
    expect(state()?.startedAt).toEqual(first);
  });

  test("start zaregistruje doručení pošty i s obnovou", () => {
    stubEnv();
    startScheduler();
    expect(jobDefinition("mail.send")).toEqual({ run: deliverMail, recover: recoverMail });
    expect(tickTasksForTests()).toContain("dead-mail");
    expect(tickTasksForTests()).toContain("bank-poll");
  });

  test("start zaregistruje stahování kurzů i jeho plánovač", () => {
    stubEnv();
    startScheduler();
    expect(jobDefinition("fx.fetch")).toEqual({ run: runRateFetch });
    expect(tickTasksForTests()).toContain("fx-plan");
  });

  test("[R-5] SIGTERM s běžící úlohou lease neuvolní a nechá ho vypršet", async () => {
    stubEnv();
    let finish = () => {};
    startScheduler();
    registerJob(KIND, { run: () => new Promise<void>((resolve) => (finish = resolve)) });
    put();
    kickWorker();
    const holder = state()?.holder;
    expect(holder).toEqual(expect.any(String));

    stopScheduler();
    expect(state()?.holder).toBe(holder);
    expect(acquireLease("nový")).toBe("busy");

    finish();
    await vi.waitFor(() => expect(db.select().from(job).get()?.status).toBe("done"));
  });

  test("[OPS-004] stopScheduler uvolní lease a kickWorker pak nic nedělá", async () => {
    stubEnv();
    const run = vi.fn(async () => {});
    startScheduler();
    registerJob(KIND, { run });
    put();
    kickWorker();
    await vi.waitFor(() => expect(db.select().from(job).get()?.status).toBe("done"));
    expect(state()?.holder).toEqual(expect.any(String));
    stopScheduler();
    expect(state()?.holder).toBeNull();

    put(undefined, "další");
    kickWorker();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(run).toHaveBeenCalledOnce();
  });
});
