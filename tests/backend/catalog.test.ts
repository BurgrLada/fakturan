import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  archiveCatalogItemAction,
  deleteUnitAction,
  restoreCatalogItemAction,
  saveCatalogItemAction,
  saveUnitAction,
} from "@/app/(app)/cenik/actions";
import { auditLog, catalogItem, unit, user } from "@/server/db/schema";
import { db as appDb } from "@/server/db";
import {
  archiveCatalogItem,
  DEFAULT_UNITS,
  deleteUnit,
  getCatalogItem,
  listCatalog,
  listUnits,
  parseCatalogFilter,
  recordCatalogUse,
  restoreCatalogItem,
  saveCatalogItem,
  saveUnit,
  searchCatalog,
  type CatalogInput,
} from "@/server/services/catalog";
import { USER_OWNED_TABLES } from "@/server/services/users";
import { createTestDb } from "../helpers/db";
import { assertIsolated } from "../helpers/isolation";

const session = vi.hoisted(() => ({ userId: "k1" }));

vi.mock("@/server/auth/session", () => ({
  requireSession: async () => ({ user: { id: session.userId } }),
  actorFromRequest: async () => ({ userId: session.userId, source: "web" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-catalog-")));

const db = createTestDb();
const actor = (userId: string) => ({ userId, source: "web" as const });

function seed(id: string) {
  const now = new Date();
  db.insert(user)
    .values({ id, name: id, email: `${id}@example.cz`, createdAt: now, updatedAt: now })
    .onConflictDoNothing()
    .run();
}

const input = (over: Partial<CatalogInput> = {}): CatalogInput => ({
  name: "Konzultace",
  description: "Hodinová sazba",
  unit: "hod.",
  priceMinor: 123450,
  currency: "CZK",
  category: "Služby",
  tags: ["web", "poradenství"],
  ...over,
});

const seedEntries = () =>
  db.select().from(auditLog).where(eq(auditLog.action, "unit.seed")).all().length;

beforeEach(() => {
  session.userId = "k1";
  seed("k1");
  db.delete(catalogItem).run();
  db.delete(unit).run();
});

describe("ceník", () => {
  test("[CAT-001] položka se uloží a cena je v haléřích", () => {
    const { id } = saveCatalogItem(actor("k1"), input());

    expect(getCatalogItem("k1", id)).toMatchObject({
      name: "Konzultace",
      unit: "hod.",
      priceMinor: 123450,
      currency: "CZK",
      category: "Služby",
      tags: ["web", "poradenství"],
      useCount: 0,
      archivedAt: null,
    });
    const entry = db.select().from(auditLog).where(eq(auditLog.entityId, id)).get();
    expect(entry).toMatchObject({ action: "catalog_item.save", scope: "user", ownerId: "k1" });
  });

  test("[CAT-001] úprava změní položku a štítky se očistí", () => {
    const { id } = saveCatalogItem(actor("k1"), input());
    saveCatalogItem(
      actor("k1"),
      input({ id, name: "Revize", tags: [" a ", "a", "b"], priceMinor: 5 }),
    );

    expect(getCatalogItem("k1", id)).toMatchObject({
      name: "Revize",
      tags: ["a", "b"],
      priceMinor: 5,
    });
  });

  test("[CAT-001] neplatné údaje se odmítnou srozumitelnou zprávou", () => {
    expect(() => saveCatalogItem(actor("k1"), input({ name: " " }))).toThrow("Vyplňte název");
    expect(() => saveCatalogItem(actor("k1"), input({ priceMinor: 1.5 }))).toThrow("cenu");
    expect(() => saveCatalogItem(actor("k1"), input({ priceMinor: -1 }))).toThrow("cenu");
    expect(() => saveCatalogItem(actor("k1"), input({ currency: "XYZ" as "CZK" }))).toThrow("měna");
    expect(() => saveCatalogItem(actor("k1"), input({ unit: "" }))).toThrow("jednotku");
    expect(() => saveCatalogItem({ userId: null, source: "web" }, input())).toThrow("oprávnění");
    expect(listCatalog("k1", {}).rows).toEqual([]);
  });

  test("[CAT-001] archivovaná položka zmizí z výchozího výpisu a jde obnovit", () => {
    const { id } = saveCatalogItem(actor("k1"), input());
    archiveCatalogItem(actor("k1"), id);

    expect(listCatalog("k1", {}).rows).toEqual([]);
    expect(listCatalog("k1", { status: "archived" }).rows.map((r) => r.id)).toEqual([id]);
    expect(listCatalog("k1", { status: "all" }).rows).toHaveLength(1);
    expect(searchCatalog("k1", "konz", 10)).toEqual([]);

    restoreCatalogItem(actor("k1"), id);
    expect(listCatalog("k1", {}).rows).toHaveLength(1);
  });

  test("[CAT-002] hledání ignoruje diakritiku a velikost písmen", () => {
    saveCatalogItem(actor("k1"), input({ name: "Žlutý kůň", tags: [] }));
    saveCatalogItem(actor("k1"), input({ name: "Hosting", category: "Provoz", tags: ["server"] }));

    expect(listCatalog("k1", { q: "zluty KUN" }).rows.map((r) => r.name)).toEqual(["Žlutý kůň"]);
    expect(listCatalog("k1", { q: "provoz" }).rows.map((r) => r.name)).toEqual(["Hosting"]);
    expect(listCatalog("k1", { q: "server" }).rows.map((r) => r.name)).toEqual(["Hosting"]);
    expect(listCatalog("k1", { q: "100%" }).rows).toEqual([]);
    expect(searchCatalog("k1", "host", 5).map((r) => r.name)).toEqual(["Hosting"]);
  });

  test("[CAT-002] filtr podle kategorie", () => {
    saveCatalogItem(actor("k1"), input({ name: "A", category: "Služby" }));
    saveCatalogItem(actor("k1"), input({ name: "B", category: "Zboží" }));

    expect(listCatalog("k1", { category: "Zboží" }).rows.map((r) => r.name)).toEqual(["B"]);
  });

  test("[CAT-002] názvy se řadí podle české abecedy, takže Č následuje za C", () => {
    seed("k9");
    for (const name of ["Zeta", "Čaj", "Cukr", "šrouby", "Alfa", "Dort"])
      saveCatalogItem(actor("k9"), input({ name }));

    expect(listCatalog("k9", {}).rows.map((r) => r.name)).toEqual([
      "Alfa",
      "Cukr",
      "Čaj",
      "Dort",
      "šrouby",
      "Zeta",
    ]);
  });

  test("[CAT-002] řazení podle použití je sestupně, jinak podle názvu", () => {
    const a = saveCatalogItem(actor("k1"), input({ name: "A" })).id;
    const b = saveCatalogItem(actor("k1"), input({ name: "B" })).id;
    const c = saveCatalogItem(actor("k1"), input({ name: "C" })).id;
    db.transaction((tx) => {
      recordCatalogUse(tx, "k1", c);
      recordCatalogUse(tx, "k1", c);
      recordCatalogUse(tx, "k1", b);
    });

    expect(listCatalog("k1", {}).rows.map((r) => r.id)).toEqual([a, b, c]);
    expect(listCatalog("k1", { sort: "usage" }).rows.map((r) => r.id)).toEqual([c, b, a]);
    expect(searchCatalog("k1", "", 10).map((r) => r.id)).toEqual([c, b, a]);
    expect(getCatalogItem("k1", c)?.useCount).toBe(2);
  });

  test("[CAT-002] použití cizí položky se nezapočítá", () => {
    const { id } = saveCatalogItem(actor("k1"), input());
    expect(() => db.transaction((tx) => recordCatalogUse(tx, "k2", id))).toThrow("neexistuje");
    expect(getCatalogItem("k1", id)?.useCount).toBe(0);
  });

  test("[CAT-002] stránkování a filtr z adresy", () => {
    for (let i = 0; i < 3; i++) saveCatalogItem(actor("k1"), input({ name: `P${i}` }));
    const first = listCatalog("k1", { pageSize: 2 });
    const second = listCatalog("k1", { pageSize: 2, page: 2 });

    expect(first.rows).toHaveLength(2);
    expect(first.hasNext).toBe(true);
    expect(second.rows).toHaveLength(1);
    expect(second.hasNext).toBe(false);

    expect(
      parseCatalogFilter({
        q: " alfa ",
        kategorie: "Služby",
        stav: "archivovane",
        razeni: "pouziti",
        strana: "2",
      }),
    ).toEqual({ q: "alfa", category: "Služby", status: "archived", sort: "usage", page: 2 });
    expect(parseCatalogFilter({ stav: "x", razeni: "y", strana: "-4", q: ["a", "b"] })).toEqual({
      q: "a",
    });
    expect(parseCatalogFilter({})).toEqual({});
  });

  test("[CAT-001] izolace ceníku", async () => {
    await assertIsolated({
      owners: ["iso-a", "iso-b"],
      create: (owner) => {
        seed(owner);
        return saveCatalogItem(actor(owner), input()).id;
      },
      find: (owner, id) => getCatalogItem(owner, id),
      list: (owner) => listCatalog(owner, { status: "all" }).rows.map((r) => r.id),
      update: (owner, id) => {
        saveCatalogItem(actor(owner), input({ id, name: "Změna" }));
        return 1;
      },
    });
    expect(USER_OWNED_TABLES).toContain(catalogItem);
    expect(USER_OWNED_TABLES).toContain(unit);
  });
});

describe("jednotky", () => {
  test("[CAT-004] nový uživatel vidí výchozí jednotky a čtení nic nezapisuje", () => {
    const seededBefore = seedEntries();
    expect(listUnits("k1").map((u) => u.name)).toEqual([...DEFAULT_UNITS]);
    expect(DEFAULT_UNITS).toEqual(["hod.", "ks", "den", "měsíc", "projekt"]);
    expect(appDb.select().from(unit).all()).toEqual([]);
    expect(seedEntries()).toBe(seededBefore);
  });

  test("[CAT-004] uživatel přidá vlastní jednotku", () => {
    const seededBefore = seedEntries();
    const { id } = saveUnit(actor("k1"), " balení ");
    const names = listUnits("k1").map((u) => u.name);

    expect(names).toEqual([...DEFAULT_UNITS, "balení"]);
    expect(listUnits("k1").every((u) => u.id)).toBe(true);
    expect(appDb.select().from(unit).where(eq(unit.id, id)).get()).toMatchObject({
      name: "balení",
      userId: "k1",
    });
    expect(seedEntries()).toBe(seededBefore + 1);
  });

  test("[CAT-004] duplicitní a neplatná jednotka se odmítne", () => {
    saveUnit(actor("k1"), "balení");
    expect(() => saveUnit(actor("k1"), "BALENÍ")).toThrow("už existuje");
    expect(() => saveUnit(actor("k1"), "KS")).toThrow("už existuje");
    expect(() => saveUnit(actor("k1"), "  ")).toThrow("jednotku");
    expect(() => saveUnit(actor("k1"), "x".repeat(21))).toThrow("dlouhá");
    expect(() => saveUnit({ userId: null, source: "web" }, "ks")).toThrow("oprávnění");
  });

  test("[CAT-004] jednotku jde smazat a uložená položka si název ponechá", () => {
    const { id } = saveUnit(actor("k1"), "balení");
    const item = saveCatalogItem(actor("k1"), input({ unit: "balení" })).id;
    deleteUnit(actor("k1"), id);

    expect(listUnits("k1").map((u) => u.name)).not.toContain("balení");
    expect(getCatalogItem("k1", item)?.unit).toBe("balení");
    expect(() => deleteUnit(actor("k1"), id)).toThrow("neexistuje");
    seed("k2");
    const foreign = saveUnit(actor("k2"), "cizí");
    expect(() => deleteUnit(actor("k1"), foreign.id)).toThrow("neexistuje");
  });

  test("[CAT-004] první uložení položky založí výchozí jednotky jednou", () => {
    saveCatalogItem(actor("k1"), input());
    saveCatalogItem(actor("k1"), input({ name: "Druhá" }));

    expect(appDb.select().from(unit).all()).toHaveLength(DEFAULT_UNITS.length);
  });

  test("[CAT-004] izolace jednotek", async () => {
    await assertIsolated({
      owners: ["iso-c", "iso-d"],
      create: (owner) => {
        seed(owner);
        return saveUnit(actor(owner), "vlastní").id;
      },
      find: (owner, id) => listUnits(owner).filter((u) => u.id === id),
      list: (owner) => listUnits(owner).flatMap((u) => (u.id ? [u.id] : [])),
      remove: (owner, id) => {
        deleteUnit(actor(owner), id);
        return 1;
      },
    });
  });
});

describe("akce ceníku", () => {
  test("[CAT-001] akce uloží položku a archivuje ji", async () => {
    const saved = await saveCatalogItemAction(input());
    expect(saved).toMatchObject({ ok: true });
    const id = (saved as { id: string }).id;

    expect(await archiveCatalogItemAction({ id })).toEqual({ ok: true });
    expect(getCatalogItem("k1", id)?.archivedAt).not.toBeNull();
    expect(await restoreCatalogItemAction({ id })).toEqual({ ok: true });
    expect(await archiveCatalogItemAction({ id: "nope" })).toEqual({
      ok: false,
      error: "Položka neexistuje",
    });
    expect(await saveCatalogItemAction({ ...input(), name: "" })).toMatchObject({ ok: false });
  });

  test("[CAT-004] akce přidá a smaže jednotku", async () => {
    const saved = await saveUnitAction({ name: "balení" });
    expect(saved).toMatchObject({ ok: true });
    expect(await deleteUnitAction({ id: (saved as { id: string }).id })).toEqual({ ok: true });
    expect(await saveUnitAction({ name: "" })).toMatchObject({ ok: false });
  });
});
