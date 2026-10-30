import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, test, vi } from "vitest";
import { setClockForTests } from "@/server/clock";
import { auditLog, numberSeries, numberSeriesCounter, user } from "@/server/db/schema";
import { mutate } from "@/server/services/mutation";
import {
  allocateNumber,
  defaultSeriesFor,
  deleteSeries,
  ensureDefaultSeries,
  listSeries,
  saveSeries,
  setDefaultSeries,
  setNextNumber,
  type SeriesInput,
} from "@/server/services/number-series";
import { deleteUser, USER_OWNED_TABLES } from "@/server/services/users";
import { assertIsolated } from "../helpers/isolation";
import { createTestDb } from "../helpers/db";

vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-series-")));

const db = createTestDb();
const actor = (userId: string) => ({ userId, source: "web" as const });

afterEach(() => setClockForTests(null));

function seed(id: string) {
  const now = new Date();
  db.insert(user)
    .values({ id, name: id, email: `${id}@example.cz`, createdAt: now, updatedAt: now })
    .onConflictDoNothing()
    .run();
}

const input = (over: Partial<SeriesInput> = {}): SeriesInput => ({
  name: "Vlastní",
  documentType: "invoice",
  template: "VF-{RRRR}-{NNN}",
  reset: "yearly",
  ...over,
});

function allocate(ownerId: string, seriesId: string, date: string) {
  return mutate(actor(ownerId), "number_series.test_allocate", (tx, audit) => {
    const result = allocateNumber(tx, ownerId, seriesId, date);
    audit({ entity: "number_series", entityId: seriesId, ownerId, scope: "user", after: result });
    return result;
  });
}

function newSeries(ownerId: string, over: Partial<SeriesInput> = {}) {
  seed(ownerId);
  return saveSeries(actor(ownerId), input(over));
}

describe("výchozí řady", () => {
  test("[NUM-003] pro každý typ dokladu vznikne výchozí řada", () => {
    seed("v1");

    ensureDefaultSeries(actor("v1"));

    const rows = listSeries("v1", "2026-10-30");
    expect(
      rows.map((r) => [r.documentType, r.template, r.reset, r.isDefault, r.next]).sort(),
    ).toEqual([
      ["advance", "Z{RRRR}-{NNN}", "yearly", true, 1],
      ["credit_note", "D{RRRR}-{NNN}", "yearly", true, 1],
      ["invoice", "{RRRR}-{NNN}", "yearly", true, 1],
    ]);
  });

  test("[NUM-003] opakované čtení nezaloží další řady ani auditní záznam", () => {
    seed("v2");
    ensureDefaultSeries(actor("v2"));
    const audits = () => db.select().from(auditLog).where(eq(auditLog.ownerId, "v2")).all().length;
    const before = audits();

    ensureDefaultSeries(actor("v2"));

    expect(listSeries("v2", "2026-10-30")).toHaveLength(3);
    expect(audits()).toBe(before);
  });

  test("[NUM-003] uživatel může mít víc řad a výchozí jde přepnout v rámci typu", () => {
    const second = newSeries("v3");
    ensureDefaultSeries(actor("v3"));
    const first = defaultSeriesFor("v3", "invoice")!;
    expect(first.id).not.toBe(second);

    setDefaultSeries(actor("v3"), second);

    expect(defaultSeriesFor("v3", "invoice")?.id).toBe(second);
    expect(defaultSeriesFor("v3", "advance")?.template).toBe("Z{RRRR}-{NNN}");
    expect(listSeries("v3", "2026-10-30").filter((r) => r.isDefault)).toHaveLength(3);
  });

  test("[NUM-003] uložení první vlastní řady založí a zaudituje i výchozí řady", () => {
    newSeries("v5");

    const actions = db
      .select()
      .from(auditLog)
      .where(eq(auditLog.ownerId, "v5"))
      .all()
      .map((row) => row.action);
    expect(actions).toContain("number_series.ensure_defaults");
    expect(listSeries("v5", "2026-10-30")).toHaveLength(4);
  });

  test("[NUM-003] výchozí řadu nejde smazat ani přesunout na jiný typ", () => {
    seed("v4");
    ensureDefaultSeries(actor("v4"));
    const row = defaultSeriesFor("v4", "invoice")!;

    expect(() => deleteSeries(actor("v4"), row.id)).toThrow("Výchozí");
    expect(() =>
      saveSeries(actor("v4"), {
        id: row.id,
        name: row.name,
        documentType: "advance",
        template: row.template,
        reset: row.reset,
      }),
    ).toThrow("typ");
  });
});

describe("kolize mezi řadami", () => {
  test("[NUM-004] dvě řady nesmí mít stejnou šablonu, ani s jinou šířkou pořadí", () => {
    const id = newSeries("k1");

    expect(() => saveSeries(actor("k1"), input())).toThrow("šablonu");
    expect(() => saveSeries(actor("k1"), input({ template: "VF-{RRRR}-{NNNN}" }))).toThrow(
      "šablonu",
    );
    expect(() => saveSeries(actor("k1"), input({ template: "{RRRR}-{NNN}" }))).toThrow("šablonu");
    expect(saveSeries(actor("k1"), { ...input({ name: "Jiný název" }), id })).toBe(id);
  });

  test("[NUM-004] shoda šablon cizího uživatele nevadí", () => {
    newSeries("k2");
    expect(newSeries("k3")).toBeTruthy();
  });

  test("[NUM-002] použité řadě nejde změnit reset, ale nepoužité ano", () => {
    const id = newSeries("k4", { template: "{RRRR}{MM}{NNN}" });

    saveSeries(actor("k4"), {
      ...input({ template: "{RRRR}{MM}{NNN}", reset: "monthly" }),
      id,
    });
    allocate("k4", id, "2026-10-01");

    expect(() =>
      saveSeries(actor("k4"), { ...input({ template: "{RRRR}{MM}{NNN}", reset: "yearly" }), id }),
    ).toThrow("reset");
  });
});

describe("reset počítadla", () => {
  test("[NUM-002] čtvrtletní reset začne v dubnu od 1", () => {
    const id = newSeries("r1", { template: "{RRRR}Q{Q}-{NNN}", reset: "quarterly" });

    expect(allocate("r1", id, "2026-01-15").number).toBe("2026Q1-001");
    expect(allocate("r1", id, "2026-03-31").number).toBe("2026Q1-002");
    expect(allocate("r1", id, "2026-04-01")).toEqual({ number: "2026Q2-001", n: 1 });
  });

  test("[NUM-002] roční reset začne v novém roce od 1 podle data dokladu", () => {
    const id = newSeries("r2");
    setClockForTests({ now: () => new Date("2027-01-03T10:00:00Z") });

    expect(allocate("r2", id, "2026-12-31").number).toBe("VF-2026-001");
    expect(allocate("r2", id, "2027-01-01").number).toBe("VF-2027-001");
    expect(allocate("r2", id, "2026-12-30").number).toBe("VF-2026-002");
  });

  test("[NUM-002] měsíční reset začne od 1 a nikdy se nezresetuje jen s resetem nikdy", () => {
    const monthly = newSeries("r3", { template: "{RRRR}{MM}{NNN}", reset: "monthly" });
    const never = newSeries("r3", { template: "T{NNN}", reset: "never" });

    expect(allocate("r3", monthly, "2026-05-31").n).toBe(1);
    expect(allocate("r3", monthly, "2026-06-01").n).toBe(1);
    expect(allocate("r3", never, "2026-05-31").n).toBe(1);
    expect(allocate("r3", never, "2031-01-01").n).toBe(2);
  });

  test("[NUM-002] řada s resetem nikdy nepřeteče přes konec roku", () => {
    const quarterly = newSeries("r4", { template: "{RR}Q{Q}-{NNN}", reset: "quarterly" });
    const monthly = newSeries("r4", { template: "{RR}{MM}-{NNN}", reset: "monthly" });

    expect(allocate("r4", quarterly, "2026-12-31").number).toBe("26Q4-001");
    expect(allocate("r4", quarterly, "2027-01-01").number).toBe("27Q1-001");
    allocate("r4", quarterly, "2026-01-05");
    expect(allocate("r4", quarterly, "2027-01-02").number).toBe("27Q1-002");

    expect(allocate("r4", monthly, "2026-12-31").number).toBe("2612-001");
    expect(allocate("r4", monthly, "2027-12-01").number).toBe("2712-001");
  });
});

describe("další číslo", () => {
  test("[NUM-004] další číslo pod již použitým je odmítnuto", () => {
    const id = newSeries("n1");
    allocate("n1", id, "2026-02-01");
    allocate("n1", id, "2026-02-02");

    expect(() => setNextNumber(actor("n1"), id, 2, "2026-03-01")).toThrow("použité");
    expect(() => setNextNumber(actor("n1"), id, 1, "2026-03-01")).toThrow("použité");
    setNextNumber(actor("n1"), id, 3, "2026-03-01");
    expect(allocate("n1", id, "2026-03-02").n).toBe(3);
  });

  test("[NUM-004] překlep nahoru jde vrátit, dokud z řady nikdo nečerpal", () => {
    const id = newSeries("n2");

    setNextNumber(actor("n2"), id, 4000, "2026-03-01");
    setNextNumber(actor("n2"), id, 40, "2026-03-01");

    expect(allocate("n2", id, "2026-03-02").number).toBe("VF-2026-040");
    expect(() => setNextNumber(actor("n2"), id, 39, "2026-03-01")).toThrow("použité");
    expect(allocate("n2", id, "2026-03-03").n).toBe(41);
  });

  test("[NUM-004] změna v jednom období se druhého nedotkne a výchozí datum je dnešek", () => {
    const id = newSeries("n3");
    allocate("n3", id, "2025-06-01");
    setClockForTests({ now: () => new Date("2026-12-31T23:30:00Z") });

    setNextNumber(actor("n3"), id, 10);

    expect(allocate("n3", id, "2027-01-01").n).toBe(10);
    expect(allocate("n3", id, "2025-06-02").n).toBe(2);
    expect(listSeries("n3", "2027-02-01").find((r) => r.id === id)?.next).toBe(11);
  });

  test("[NUM-004] změna se audituje pod vlastníkem", () => {
    const id = newSeries("n4");

    setNextNumber(actor("n4"), id, 12, "2026-03-01");

    const rows = db
      .select()
      .from(auditLog)
      .where(eq(auditLog.ownerId, "n4"))
      .all()
      .filter((row) => row.action === "number_series.set_next");
    expect(rows).toEqual([
      expect.objectContaining({ entity: "number_series", entityId: id, scope: "user" }),
    ]);
  });

  test("[NUM-004] neplatné další číslo se odmítne", () => {
    const id = newSeries("n5");

    expect(() => setNextNumber(actor("n5"), id, 0, "2026-03-01")).toThrow();
    expect(() => setNextNumber(actor("n5"), id, 1.5, "2026-03-01")).toThrow();
  });
});

describe("přidělení čísla", () => {
  test("[NUM-005] přerušená transakce číslo nespotřebuje", () => {
    const id = newSeries("a1");
    allocate("a1", id, "2026-02-01");

    expect(() =>
      mutate(actor("a1"), "number_series.test_allocate", (tx) => {
        allocateNumber(tx, "a1", id, "2026-02-02");
        throw new Error("vystavení selhalo");
      }),
    ).toThrow("vystavení selhalo");

    expect(allocate("a1", id, "2026-02-03").n).toBe(2);
  });

  test("[NUM-005] cizí řadu nejde použít", () => {
    const id = newSeries("a2");
    seed("a3");

    expect(() => allocate("a3", id, "2026-02-01")).toThrow("neexistuje");
    expect(allocate("a2", id, "2026-02-01").n).toBe(1);
  });

  test("[NUM-005] 50 souběžných přidělení dá 50 různých čísel bez mezery", async () => {
    const id = newSeries("a4", { template: "S{RRRR}-{NNNN}" });
    const databasePath = db.$client.name;
    const gate = new SharedArrayBuffer(4);
    const workerCount = 5;

    const workers = Array.from(
      { length: workerCount },
      () =>
        new Worker(new URL("../helpers/allocate-worker.mjs", import.meta.url), {
          execArgv: ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON"],
          workerData: {
            databasePath,
            ownerId: "a4",
            seriesId: id,
            date: "2026-05-05",
            count: 10,
            gate,
          },
        }),
    );
    const ready: Promise<void>[] = [];
    const results = workers.map(
      (worker, index) =>
        new Promise<{ number: string; n: number }[]>((resolve, reject) => {
          ready[index] = new Promise((markReady) => {
            worker.on("message", (message) => {
              if (message.ready) markReady();
              if (message.allocated) resolve(message.allocated);
            });
          });
          worker.once("error", reject);
        }),
    );
    await Promise.all(ready);
    const signal = new Int32Array(gate);
    Atomics.store(signal, 0, 1);
    Atomics.notify(signal, 0);

    const perWorker = await Promise.all(results);
    await Promise.all(workers.map((worker) => worker.terminate()));
    const all = perWorker.flat();

    expect(new Set(all.map((row) => row.number)).size).toBe(50);
    expect(all.map((row) => row.n).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 50 }, (_, i) => i + 1),
    );
    expect(all.map((row) => row.number)).toContain("S2026-0050");
    expect(perWorker.filter((rows) => rows.length === 10)).toHaveLength(workerCount);
    expect(allocate("a4", id, "2026-05-06").n).toBe(51);
  }, 30_000);
});

describe("správa řad", () => {
  test("[NUM-001] neplatná šablona se při uložení odmítne", () => {
    seed("s1");

    expect(() => saveSeries(actor("s1"), input({ template: "{RRRR}" }))).toThrow();
    expect(() => saveSeries(actor("s1"), input({ template: "{NNN}" }))).toThrow("rok");
  });

  test("[NUM-001] uložení se audituje pod vlastníkem", () => {
    const id = newSeries("s2");

    const rows = db.select().from(auditLog).where(eq(auditLog.ownerId, "s2")).all();

    expect(rows.filter((row) => row.action === "number_series.save")).toEqual([
      expect.objectContaining({ entity: "number_series", entityId: id, scope: "user" }),
    ]);
  });

  test("[NUM-003] použitou řadu nejde smazat, nepoužitou ano i s nastaveným číslem", () => {
    const used = newSeries("s3");
    const unused = newSeries("s3", { template: "X-{RRRR}-{NNN}" });
    allocate("s3", used, "2026-01-01");
    setNextNumber(actor("s3"), unused, 10, "2026-01-01");

    expect(() => deleteSeries(actor("s3"), used)).toThrow("Použitou");
    deleteSeries(actor("s3"), unused);

    expect(listSeries("s3", "2026-01-01").map((row) => row.id)).not.toContain(unused);
    expect(
      db.select().from(numberSeriesCounter).where(eq(numberSeriesCounter.seriesId, unused)).all(),
    ).toEqual([]);
  });

  test("[NUM-003] izolace řad", async () => {
    await assertIsolated<string>({
      create: (ownerId) => newSeries(ownerId),
      find: (ownerId, id) => listSeries(ownerId, "2026-01-01").filter((row) => row.id === id),
      list: (ownerId) => listSeries(ownerId, "2026-01-01").map((row) => row.id),
      update: (ownerId, id) => {
        saveSeries(actor(ownerId), { ...input({ name: "Změna" }), id });
        return 1;
      },
      remove: (ownerId, id) => {
        deleteSeries(actor(ownerId), id);
        return 1;
      },
    });
  });

  test("[NUM-005] cizí uživatel nezmění další číslo ani výchozí řadu", () => {
    const id = newSeries("s5");
    seed("s6");

    expect(() => setNextNumber(actor("s6"), id, 77, "2026-01-01")).toThrow("neexistuje");
    expect(() => setDefaultSeries(actor("s6"), id)).toThrow("neexistuje");

    expect(listSeries("s5", "2026-01-01").find((row) => row.id === id)).toMatchObject({
      next: 1,
      isDefault: false,
    });
  });

  test("[NUM-003] obě tabulky jsou v seznamu dat účtu a počítadlo je před řadou", () => {
    const counter = USER_OWNED_TABLES.indexOf(numberSeriesCounter);
    expect(counter).toBeGreaterThanOrEqual(0);
    expect(USER_OWNED_TABLES.indexOf(numberSeries)).toBeGreaterThan(counter);
  });

  test("[NUM-003] smazání účtu odstraní řady i počítadla", () => {
    const admin = "admin-1";
    seed(admin);
    db.update(user).set({ role: "admin" }).where(eq(user.id, admin)).run();
    const id = newSeries("s4");
    allocate("s4", id, "2026-01-01");

    deleteUser(actor(admin), "s4", "s4@example.cz");

    expect(db.select().from(numberSeries).where(eq(numberSeries.userId, "s4")).all()).toEqual([]);
    expect(
      db.select().from(numberSeriesCounter).where(eq(numberSeriesCounter.userId, "s4")).all(),
    ).toEqual([]);
  });
});
