import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  archiveCustomerAction,
  deleteCustomerAction,
  restoreCustomerAction,
  saveCustomerAction,
  verifyVatAction,
} from "@/app/(app)/zakaznici/actions";
import { DEFAULT_PREFERENCES } from "@/lib/preferences";
import { auditLog, customer, rateLimit, user } from "@/server/db/schema";
import { RATE_RULES } from "@/server/rate-limit";
import { setClockForTests } from "@/server/clock";
import {
  archiveCustomer,
  customerDefaults,
  deleteCustomer,
  getCustomer,
  listCustomers,
  parseCustomerFilter,
  restoreCustomer,
  saveCustomer,
  searchCustomers,
  verifyVat,
  type CustomerInput,
} from "@/server/services/customers";
import { USER_OWNED_TABLES } from "@/server/services/users";
import { createTestDb } from "../helpers/db";
import { assertIsolated } from "../helpers/isolation";

const reply = (body: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

const session = vi.hoisted(() => ({ userId: "c1" }));

vi.mock("@/server/auth/session", () => ({
  requireSession: async () => ({ user: { id: session.userId } }),
  actorFromRequest: async () => ({ userId: session.userId, source: "web" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-customers-")));

const db = createTestDb();
const actor = (userId: string) => ({ userId, source: "web" as const });

function seed(id: string) {
  const now = new Date();
  db.insert(user)
    .values({ id, name: id, email: `${id}@example.cz`, createdAt: now, updatedAt: now })
    .onConflictDoNothing()
    .run();
}

const input = (over: Partial<CustomerInput> = {}): CustomerInput => ({
  name: "Alza.cz a.s.",
  street: "Jankovcova 1522/53",
  city: "Praha",
  zip: "170 00",
  country: "Česká republika",
  ico: "27082440",
  dic: "CZ27082440",
  email: "fakturace@alza.cz",
  extraEmails: [],
  phone: "",
  note: "",
  dueDays: null,
  language: null,
  currency: null,
  designId: null,
  remindersEnabled: null,
  ...over,
});

beforeEach(() => {
  seed("c1");
  seed("c2");
  session.userId = "c1";
  db.delete(customer).run();
  db.delete(rateLimit).run();
});

afterEach(() => {
  setClockForTests(null);
  vi.unstubAllGlobals();
});

describe("seznam zákazníků", () => {
  test("[CUS-001] jména se řadí podle české abecedy, takže Č následuje za C", () => {
    seed("c9");
    for (const name of ["Zeman", "Čech", "Novák", "Cibulka", "Šimek", "alfa"])
      saveCustomer(actor("c9"), input({ name, ico: "", dic: "" }));

    expect(listCustomers("c9", {}).rows.map((c) => c.name)).toEqual([
      "alfa",
      "Cibulka",
      "Čech",
      "Novák",
      "Šimek",
      "Zeman",
    ]);
  });

  test("[CUS-001] seznam stránkuje, hledá a filtruje", () => {
    saveCustomer(actor("c1"), input({ name: "Alfa s.r.o.", ico: "", dic: "", email: "a@alfa.cz" }));
    saveCustomer(actor("c1"), input({ name: "Beta s.r.o.", ico: "", dic: "" }));
    saveCustomer(actor("c1"), input({ name: "Gama GmbH", ico: "", dic: "", country: "Německo" }));
    saveCustomer(actor("c1"), input({ name: "Delta a.s.", ico: "45274649", dic: "CZ45274649" }));
    saveCustomer(actor("c1"), input({ name: "Epsilon", ico: "", dic: "" }));

    const first = listCustomers("c1", { pageSize: 2 });
    const third = listCustomers("c1", { pageSize: 2, page: 3 });
    expect(first.rows.map((c) => c.name)).toEqual(["Alfa s.r.o.", "Beta s.r.o."]);
    expect(first.hasNext).toBe(true);
    expect(third.rows.map((c) => c.name)).toEqual(["Gama GmbH"]);
    expect(third.hasNext).toBe(false);

    expect(listCustomers("c1", { q: "alf" }).rows.map((c) => c.name)).toEqual(["Alfa s.r.o."]);
    expect(listCustomers("c1", { q: "45274649" }).rows.map((c) => c.name)).toEqual(["Delta a.s."]);
    expect(listCustomers("c1", { q: "a@alfa" }).rows.map((c) => c.name)).toEqual(["Alfa s.r.o."]);
    expect(listCustomers("c1", { q: "%" }).rows).toEqual([]);
    expect(listCustomers("c1", { foreign: true }).rows.map((c) => c.name)).toEqual(["Gama GmbH"]);
    expect(searchCustomers("c1", "ta", 1).map((c) => c.name)).toEqual(["Beta s.r.o."]);
  });

  test("[CUS-001] hledání nerozlišuje diakritiku ani velikost písmen", () => {
    saveCustomer(actor("c1"), input({ name: "Škoda Auto a.s.", ico: "", dic: "", email: "" }));
    saveCustomer(actor("c1"), input({ name: "ŘEZNÍK Novák", ico: "", dic: "", email: "" }));
    const names = (q: string) => listCustomers("c1", { q }).rows.map((c) => c.name);

    for (const q of ["škoda", "skoda", "ŠKODA", "SKODA"])
      expect(names(q)).toEqual(["Škoda Auto a.s."]);
    expect(names("reznik")).toEqual(["ŘEZNÍK Novák"]);
    expect(names("řezník")).toEqual(["ŘEZNÍK Novák"]);
    expect(searchCustomers("c1", "skoda", 5)).toHaveLength(1);
  });

  test("[CUS-001] úprava zákazníka přepočítá text pro hledání", () => {
    const { id } = saveCustomer(actor("c1"), input({ name: "Stará", ico: "", dic: "" }));
    saveCustomer(actor("c1"), input({ id, name: "Čerstvá", ico: "", dic: "" }));

    expect(listCustomers("c1", { q: "stara" }).rows).toEqual([]);
    expect(listCustomers("c1", { q: "cerstva" }).rows).toHaveLength(1);
  });

  test("[AUD-009] audit uložení má před i po stejný tvar", () => {
    const { id } = saveCustomer(actor("c1"), input({ ico: "" }));
    saveCustomer(actor("c1"), input({ id, ico: "", note: "nově" }));

    const [, second] = db.select().from(auditLog).where(eq(auditLog.entityId, id)).all();
    const before = second.before as Record<string, unknown>;
    const after = second.after as Record<string, unknown>;
    expect(Object.keys(before).sort()).toEqual(Object.keys(after).sort());
    expect(before.note).toBe("");
    expect(after.note).toBe("nově");
  });

  test("[CUS-001] adresa v URL se čte tolerantně a neplatné hodnoty se zahodí", () => {
    expect(
      parseCustomerFilter({ q: " alfa ", zahranici: "1", stav: "archivovani", strana: "2" }),
    ).toEqual({ q: "alfa", foreign: true, status: "archived", page: 2 });
    expect(
      parseCustomerFilter({ q: ["a", "b"], zahranici: "ano", stav: "x", strana: "-4" }),
    ).toEqual({ q: "a" });
    expect(parseCustomerFilter({})).toEqual({});
  });

  test("[CUS-001] izolace zákazníků", async () => {
    await assertIsolated({
      owners: ["iso-a", "iso-b"],
      create: (owner) => {
        seed(owner);
        return saveCustomer(actor(owner), input({ ico: "" })).id;
      },
      find: (owner, id) => getCustomer(owner, id),
      list: (owner) => listCustomers(owner, {}).rows.map((c) => c.id),
      update: (owner, id) => {
        saveCustomer(actor(owner), input({ id, ico: "", name: "Změna" }));
        return 1;
      },
      remove: (owner, id) => {
        deleteCustomer(actor(owner), id);
        return 1;
      },
    });
    expect(USER_OWNED_TABLES).toContain(customer);
  });
});

describe("údaje zákazníka", () => {
  test("[CUS-002] údaje se uloží, DIČ a e-maily se upraví a změna jde do auditu", () => {
    const { id } = saveCustomer(
      actor("c1"),
      input({
        dic: " cz 270 82440 ",
        extraEmails: ["a@b.cz", " c@d.cz "],
        phone: "+420 111",
        note: "VIP",
      }),
    );

    expect(getCustomer("c1", id)).toMatchObject({
      name: "Alza.cz a.s.",
      dic: "CZ27082440",
      extraEmails: ["a@b.cz", "c@d.cz"],
      phone: "+420 111",
      note: "VIP",
    });
    const entry = db.select().from(auditLog).where(eq(auditLog.entityId, id)).get();
    expect(entry).toMatchObject({ action: "customer.save", scope: "user", ownerId: "c1" });
  });

  test("[CUS-002] neplatné údaje se odmítnou srozumitelnou zprávou", () => {
    expect(() => saveCustomer(actor("c1"), input({ name: " " }))).toThrow("Vyplňte název");
    expect(() => saveCustomer(actor("c1"), input({ email: "neni-email" }))).toThrow("e-mail");
    expect(() => saveCustomer(actor("c1"), input({ extraEmails: ["x"] }))).toThrow("e-mail");
    expect(() => saveCustomer(actor("c1"), input({ ico: "12345678" }))).toThrow("IČO");
    expect(() => saveCustomer({ userId: null, source: "web" }, input())).toThrow("oprávnění");
    expect(listCustomers("c1", {}).rows).toEqual([]);
  });

  test("[CUS-002] tuzemská země se sjednotí a cizí IČO nemusí mít české kontrolní číslo", () => {
    const home = saveCustomer(actor("c1"), input({ ico: "", country: "czechia" })).id;
    const abroad = saveCustomer(actor("c1"), input({ ico: "HRB 12345", country: "Německo" })).id;

    expect(getCustomer("c1", home)?.country).toBe("Česká republika");
    expect(getCustomer("c1", abroad)?.ico).toBe("HRB12345");
  });

  test("[CUS-003] výjimka zákazníka přebije výchozí splatnost", () => {
    const withException = saveCustomer(
      actor("c1"),
      input({
        ico: "",
        dueDays: 30,
        language: "en",
        currency: "EUR",
        designId: "cisty",
        remindersEnabled: false,
      }),
    ).id;
    const plain = saveCustomer(actor("c1"), input({ ico: "" })).id;
    const prefs = { ...DEFAULT_PREFERENCES, dueDays: 14 };

    expect(customerDefaults("c1", withException, prefs)).toEqual({
      ...prefs,
      dueDays: 30,
      language: "en",
      currency: "EUR",
      remindersEnabled: false,
    });
    expect(customerDefaults("c1", plain, prefs)).toEqual({ ...prefs, remindersEnabled: null });
    expect(() => customerDefaults("c2", plain, prefs)).toThrow("neexistuje");
  });

  test("[CUS-003] neplatná výjimka se odmítne", () => {
    expect(() => saveCustomer(actor("c1"), input({ dueDays: 400 }))).toThrow("Splatnost");
    expect(() => saveCustomer(actor("c1"), input({ language: "de" as "cs" }))).toThrow("jazyk");
    expect(() => saveCustomer(actor("c1"), input({ currency: "XYZ" as "CZK" }))).toThrow("měna");
    expect(() => saveCustomer(actor("c1"), input({ designId: "neexistuje" }))).toThrow("design");
  });

  test("[CUS-009] duplicitní IČO vrátí upozornění a uloží se", () => {
    const first = saveCustomer(actor("c1"), input());
    const second = saveCustomer(actor("c1"), input({ name: "Alza pobočka" }));
    seed("c2");
    const foreign = saveCustomer(actor("c2"), input());

    expect(first.duplicateOfIco).toBeNull();
    expect(second.duplicateOfIco).toBe("27082440");
    expect(foreign.duplicateOfIco).toBeNull();
    expect(listCustomers("c1", {}).rows).toHaveLength(2);
    expect(saveCustomer(actor("c1"), input({ id: first.id })).duplicateOfIco).toBe("27082440");
    expect(
      saveCustomer(actor("c1"), input({ ico: "", name: "Bez IČO" })).duplicateOfIco,
    ).toBeNull();
  });
});

describe("archivace", () => {
  test("[CUS-007] archivovaný zákazník není ve výchozím seznamu", () => {
    const { id } = saveCustomer(actor("c1"), input());
    saveCustomer(actor("c1"), input({ name: "Aktivní", ico: "", email: "" }));

    archiveCustomer(actor("c1"), id);

    expect(listCustomers("c1", {}).rows.map((c) => c.name)).toEqual(["Aktivní"]);
    expect(listCustomers("c1", { status: "archived" }).rows.map((c) => c.id)).toEqual([id]);
    expect(listCustomers("c1", { status: "all" }).rows).toHaveLength(2);
    expect(searchCustomers("c1", "alza", 10)).toEqual([]);
    expect(getCustomer("c1", id)?.archivedAt).toBeInstanceOf(Date);

    restoreCustomer(actor("c1"), id);
    expect(listCustomers("c1", {}).rows).toHaveLength(2);
    expect(getCustomer("c1", id)?.archivedAt).toBeNull();
  });

  test("[CUS-007] zákazník bez dokladů jde smazat a zůstane záznam v auditu", () => {
    const { id } = saveCustomer(actor("c1"), input());

    deleteCustomer(actor("c1"), id);

    expect(getCustomer("c1", id)).toBeNull();
    const actions = db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.entityId, id))
      .all()
      .map((r) => r.action);
    expect(actions).toEqual(["customer.save", "customer.delete"]);
    expect(() => deleteCustomer(actor("c1"), id)).toThrow("neexistuje");
  });
});

describe("VIES", () => {
  test("[CUS-005] ověření uloží datum", async () => {
    const at = new Date("2026-03-01T10:00:00Z");
    setClockForTests({ now: () => at });
    vi.stubGlobal("fetch", reply({ isValid: true }));
    const { id } = saveCustomer(actor("c1"), input());

    const status = await verifyVat(actor("c1"), id);

    expect(status).toEqual({ state: "valid", verifiedAt: at });
    expect(getCustomer("c1", id)).toMatchObject({ vatVerifiedAt: at, vatValid: true });
  });

  test("[CUS-005] neplatné DIČ se uloží jako neplatné a změna DIČ ověření zruší", async () => {
    vi.stubGlobal("fetch", reply({ isValid: false }));
    const { id } = saveCustomer(actor("c1"), input());

    await expect(verifyVat(actor("c1"), id)).resolves.toMatchObject({ state: "invalid" });
    expect(getCustomer("c1", id)).toMatchObject({ vatValid: false });

    saveCustomer(actor("c1"), input({ id, dic: "CZ45274649" }));
    expect(getCustomer("c1", id)).toMatchObject({ vatVerifiedAt: null, vatValid: null });
  });

  test("[CUS-005] výpadek VIES nebrání uložení", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNREFUSED");
    });
    const { id } = saveCustomer(actor("c1"), input());

    await expect(verifyVat(actor("c1"), id)).resolves.toEqual({
      state: "unavailable",
      verifiedAt: null,
    });
    expect(saveCustomer(actor("c1"), input({ id, note: "po výpadku" })).id).toBe(id);
    expect(getCustomer("c1", id)).toMatchObject({ vatVerifiedAt: null, vatValid: null });
  });

  test("[CUS-005] bez DIČ se ověření odmítne a cizí zákazník se neověří", async () => {
    const fetcher = reply({ isValid: true });
    vi.stubGlobal("fetch", fetcher);
    const noVat = saveCustomer(actor("c1"), input({ dic: "" })).id;
    const mine = saveCustomer(actor("c1"), input({ ico: "" })).id;

    await expect(verifyVat(actor("c1"), noVat)).rejects.toThrow("DIČ");
    await expect(verifyVat(actor("c2"), mine)).rejects.toThrow("neexistuje");
    expect(fetcher).not.toHaveBeenCalled();
  });

  test("[CUS-005] dotazy na VIES jsou omezené na 30 za minutu", async () => {
    setClockForTests({ now: () => new Date("2026-03-01T10:00:00Z") });
    vi.stubGlobal("fetch", reply({ isValid: true }));
    const { id } = saveCustomer(actor("c1"), input());

    expect(RATE_RULES.viesLookup).toMatchObject({ limit: 30, windowSeconds: 60 });
    for (let i = 0; i < 30; i += 1) await verifyVat(actor("c1"), id);

    await expect(verifyVat(actor("c1"), id)).rejects.toThrow("Příliš mnoho");
  });
});

describe("server actions", () => {
  test("[SEC-002] cizí zákazník není dostupný přes server action", async () => {
    vi.stubGlobal("fetch", reply({ isValid: true }));
    const mine = saveCustomer(actor("c1"), input()).id;
    session.userId = "c2";

    const results = [
      await saveCustomerAction({ ...input({ name: "Přepsáno" }), id: mine }),
      await archiveCustomerAction({ id: mine }),
      await restoreCustomerAction({ id: mine }),
      await deleteCustomerAction({ id: mine }),
      await verifyVatAction({ id: mine }),
    ];

    for (const result of results) expect(result).toMatchObject({ ok: false });
    expect(getCustomer("c1", mine)).toMatchObject({ name: "Alza.cz a.s.", archivedAt: null });
    expect(listCustomers("c2", {}).rows).toEqual([]);
  });

  test("[SEC-006] neplatný vstup server action je odmítnut", async () => {
    const bad: unknown[] = [
      null,
      "text",
      {},
      { ...input(), name: 42 },
      { ...input(), email: "neni-email" },
      { ...input(), dueDays: "30" },
      { ...input(), extraEmails: "a@b.cz" },
      { ...input(), currency: "XYZ" },
      { ...input(), name: "x".repeat(500) },
    ];

    for (const raw of bad)
      await expect(saveCustomerAction(raw)).resolves.toMatchObject({ ok: false });
    await expect(archiveCustomerAction({ id: 7 })).resolves.toMatchObject({ ok: false });
    await expect(deleteCustomerAction(undefined)).resolves.toMatchObject({ ok: false });
    await expect(verifyVatAction({})).resolves.toMatchObject({ ok: false });
    expect(listCustomers("c1", {}).rows).toEqual([]);
  });

  test("[CUS-009] akce vrátí upozornění na duplicitní IČO", async () => {
    await saveCustomerAction(input());

    const result = await saveCustomerAction(input({ name: "Kopie" }));

    expect(result).toMatchObject({ ok: true, duplicateOfIco: "27082440" });
  });
});
