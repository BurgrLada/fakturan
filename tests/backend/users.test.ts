import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, getTableName } from "drizzle-orm";
import { getTableConfig, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { ACTION_LABELS, auditActionLabel } from "@/lib/audit-labels";
import { auth } from "@/server/auth";
import { requireAdmin, requireSession } from "@/server/auth/session";
import { setClockForTests } from "@/server/clock";
import * as schema from "@/server/db/schema";
import {
  account,
  auditLog,
  auditPurge,
  dashboard,
  dashboardWidget,
  invoice,
  instanceMeta,
  invitation,
  rateLimit,
  session,
  user,
  verification,
} from "@/server/db/schema";
import { createCreditNote } from "@/server/services/credit-notes";
import { createDashboard, ensureDashboards } from "@/server/services/dashboards";
import { issueInvoice } from "@/server/services/invoice-lifecycle";
import { mutate } from "@/server/services/mutation";
import { listInstanceAudit } from "@/server/services/instance-audit";
import { createInvitation } from "@/server/services/invitations";
import {
  deactivateUser,
  deleteOwnAccount,
  deleteUser,
  listUsers,
  reactivateUser,
  setRole,
  USER_OWNED_TABLES,
} from "@/server/services/users";
import { findUnregisteredOwnedTables } from "../helpers/audit-guard";
import { Browser, BASE, PASSWORD, type Auth } from "../helpers/auth-browser";
import { createTestDb } from "../helpers/db";
import {
  draftFor,
  issuedInvoice,
  seedCustomer,
  seedOwner,
  webActor,
} from "../helpers/fixtures-mail";

const requestHeaders = vi.hoisted(() => ({ current: new Headers() }));

vi.mock("next/headers", () => ({ headers: async () => requestHeaders.current }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirect:${url}`);
  },
  notFound: () => {
    throw new Error("notFound");
  },
}));

vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-users-")));
vi.stubEnv("BETTER_AUTH_URL", BASE);
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));

const db = createTestDb();
const ADMIN_ID = "admin-1";
const admin = { userId: ADMIN_ID, source: "web" } as const;

function seedUser(id: string, email: string, role = "user", banned = false) {
  const now = new Date();
  db.insert(user)
    .values({ id, name: id, email, role, banned, createdAt: now, updatedAt: now })
    .run();
}

function seedSession(userId: string, id = `s-${userId}`) {
  const now = new Date();
  db.insert(session)
    .values({
      id,
      userId,
      token: id,
      expiresAt: new Date(now.getTime() + 3_600_000),
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

function productionAuditActions(): string[] {
  const dir = join(process.cwd(), "src/server");
  const files = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) =>
    f.endsWith(".ts"),
  );
  const literals = files.flatMap((file) => [
    ...readFileSync(join(dir, file), "utf8").matchAll(
      /["'`]((?:access|account|auth|invitation|rate_limit|user)\.[a-z_]+)["'`]/g,
    ),
  ]);
  // A queue kind shares the shape of an action but never reaches the audit log.
  const jobKinds: readonly string[] = schema.JOB_KINDS;
  const actions = literals.map((match) => match[1]).filter((name) => !jobKinds.includes(name));
  const failed = ["password_change", "email_change_request", "profile_update", "account_unlink"];
  return [...new Set([...actions, ...failed.map((a) => `auth.${a}_failed`)])];
}

// purgeAccount handles these by hand: the audit tables have their own purge, and invitations are
// matched by e-mail as well as by id. OAuth tajemství, MCP-042: deleting the user cascades to its
// tokens and consents, and an instance-wide client only loses its owner.
const EXCEPTIONS = [
  "audit_log",
  "audit_purge",
  "invitation",
  "oauth_client",
  "oauth_access_token",
  "oauth_refresh_token",
  "oauth_consent",
];

function roleOf(id: string) {
  return db.select().from(user).where(eq(user.id, id)).get()?.role;
}

function find(id: string) {
  return db.select().from(user).where(eq(user.id, id)).get();
}

function auditRows(action: string) {
  return db.select().from(auditLog).where(eq(auditLog.action, action)).all();
}

function writeUserAudit(ownerId: string, action: `${string}.${string}` = "invoice.create") {
  mutate({ userId: ownerId, source: "web" }, action, (_tx, audit) =>
    audit({ entity: "invoice", entityId: "1", ownerId, scope: "user", after: { total: 100 } }),
  );
}

async function invitedBrowser(email: string): Promise<Browser> {
  const { url } = await createInvitation(admin, email);
  const browser = new Browser(auth as unknown as Auth);
  browser.cookies.set("fakturan_invite", url.split("/").at(-1)!);
  await browser.signUp(email);
  return browser;
}

beforeEach(() => {
  setClockForTests(null);
  db.delete(rateLimit).run();
  db.delete(user).run();
  db.delete(invitation).run();
  db.delete(instanceMeta).run();
  seedUser(ADMIN_ID, "admin@example.cz", "admin");
  requestHeaders.current = new Headers();
});

describe("seznam uživatelů", () => {
  test("[ADM-002] seznam vrací jméno, e-mail, roli, stav, vznik a poslední přihlášení", () => {
    seedUser("u1", "u1@example.cz", "user", true);
    const at = new Date("2026-10-01T08:00:00Z");
    setClockForTests({ now: () => at });
    mutate({ userId: "u1", source: "web" }, "auth.login", (_tx, audit) =>
      audit({ entity: "user", entityId: "u1", ownerId: "u1", scope: "instance" }),
    );
    setClockForTests(null);

    const row = listUsers(admin).find((u) => u.id === "u1")!;

    expect(Object.keys(row).sort()).toEqual([
      "createdAt",
      "email",
      "id",
      "lastLoginAt",
      "name",
      "role",
      "status",
    ]);
    expect(row).toMatchObject({
      name: "u1",
      email: "u1@example.cz",
      role: "user",
      status: "deactivated",
      lastLoginAt: at,
    });
    expect(listUsers(admin).find((u) => u.id === ADMIN_ID)).toMatchObject({
      status: "active",
      lastLoginAt: null,
    });
  });

  test("[ADM-001] běžný uživatel seznam ani správu nedostane", () => {
    seedUser("u1", "u1@example.cz");
    const plain = { userId: "u1", source: "web" } as const;

    expect(() => listUsers(plain)).toThrow("oprávnění");
    expect(() => setRole(plain, "u1", "admin")).toThrow("oprávnění");
    expect(roleOf("u1")).toBe("user");
  });

  test("[ADM-001] deaktivovaný administrátor nic nespravuje", () => {
    seedUser("a2", "a2@example.cz", "admin", true);

    expect(() => listUsers({ userId: "a2", source: "web" })).toThrow("oprávnění");
  });

  test("[ADM-001] běžný uživatel dostane 404 v administraci", async () => {
    const browser = await invitedBrowser("user@example.cz");
    requestHeaders.current = new Headers({ cookie: browser.cookieHeader() });

    await expect(requireSession()).resolves.toMatchObject({ user: { email: "user@example.cz" } });
    await expect(requireAdmin()).rejects.toThrow("notFound");
    expect(auditRows("access.denied").at(-1)).toMatchObject({ scope: "instance" });
  });
});

describe("role a poslední administrátor", () => {
  test("[ADM-004] role se mění a zapíše do auditu", () => {
    seedUser("u1", "u1@example.cz");

    setRole(admin, "u1", "admin");

    expect(roleOf("u1")).toBe("admin");
    expect(auditRows("user.role_change").at(-1)).toMatchObject({
      actorId: ADMIN_ID,
      entityId: "u1",
      scope: "instance",
      before: { role: "user" },
      after: { role: "admin" },
    });
  });

  test("[ADM-004] poslední admin nejde degradovat, deaktivovat ani smazat", async () => {
    seedUser("u1", "u1@example.cz");
    seedUser("a2", "a2@example.cz", "admin", true);

    expect(() => setRole(admin, ADMIN_ID, "user")).toThrow("Vlastní účet");
    expect(() => deactivateUser(admin, ADMIN_ID)).toThrow("Vlastní účet");
    expect(() => deleteUser(admin, ADMIN_ID, "admin@example.cz")).toThrow("Vlastní účet");
    await expect(deleteOwnAccount(admin, { createdAt: new Date() }, undefined)).rejects.toThrow(
      "Poslední administrátor",
    );
    expect(find(ADMIN_ID)).toMatchObject({ role: "admin", banned: false });
  });

  test("[ADM-004] změna role na stejnou nic nezapíše", () => {
    seedUser("u1", "u1@example.cz");
    const before = auditRows("user.role_change").length;

    setRole(admin, "u1", "user");

    expect(auditRows("user.role_change")).toHaveLength(before);
  });

  test("[ADM-004] deaktivovaný kolega se jako náhradní administrátor nepočítá", async () => {
    seedUser("a2", "a2@example.cz", "admin", true);
    seedUser("a3", "a3@example.cz", "admin");
    const third = { userId: "a3", source: "web" } as const;

    deactivateUser(admin, "a3");

    expect(() => setRole(third, ADMIN_ID, "user")).toThrow("oprávnění");
    await expect(deleteOwnAccount(admin, { createdAt: new Date() }, undefined)).rejects.toThrow(
      "Poslední administrátor",
    );
  });

  test("[ADM-004] admin si neodebere správu sám, i když je tu druhý", () => {
    seedUser("a2", "a2@example.cz", "admin");
    const before = auditRows("user.role_change").length;

    expect(() => setRole(admin, ADMIN_ID, "user")).toThrow("Vlastní účet");

    expect(roleOf(ADMIN_ID)).toBe("admin");
    expect(auditRows("user.role_change")).toHaveLength(before);
  });

  test("[ADM-004] admin nesmaže ani nedeaktivuje sám sebe přes administraci", () => {
    seedUser("a2", "a2@example.cz", "admin");

    expect(() => deactivateUser(admin, ADMIN_ID)).toThrow("Vlastní účet");
    expect(() => deleteUser(admin, ADMIN_ID, "admin@example.cz")).toThrow("Vlastní účet");
    expect(find(ADMIN_ID)?.banned).toBe(false);
  });
});

describe("smazání účtu s navázanými doklady", () => {
  test("[ADM-006] smazání účtu s opravou a zálohou projde", () => {
    const owner = seedOwner(db, new Date());
    const actor = webActor(owner);
    const customerId = seedCustomer(owner);
    const original = issuedInvoice(owner, customerId);
    const note = createCreditNote(actor, original);
    issueInvoice(actor, note.id, { revision: 1 });
    const advance = draftFor(owner, customerId, { type: "advance", seriesId: null });
    issueInvoice(actor, advance.id, { revision: advance.revision });
    const final = issuedInvoice(owner, customerId);
    db.update(invoice).set({ relatedInvoiceId: advance.id }).where(eq(invoice.id, final)).run();

    deleteUser(admin, owner, `${owner}@example.cz`);

    expect(db.select().from(invoice).where(eq(invoice.userId, owner)).all()).toEqual([]);
    expect(find(owner)).toBeUndefined();
  });
});

describe("smazání účtu s dashboardy", () => {
  test("[ADM-006] smazání účtu odstraní dashboardy a widgety", () => {
    const owner = seedOwner(db, new Date());
    const keep = seedOwner(db, new Date());
    ensureDashboards(webActor(owner));
    createDashboard(webActor(owner), { name: "Druhý" });
    ensureDashboards(webActor(keep));
    expect(
      db.select().from(dashboardWidget).where(eq(dashboardWidget.userId, owner)).all(),
    ).not.toEqual([]);

    deleteUser(admin, owner, `${owner}@example.cz`);

    expect(db.select().from(dashboard).where(eq(dashboard.userId, owner)).all()).toEqual([]);
    expect(
      db.select().from(dashboardWidget).where(eq(dashboardWidget.userId, owner)).all(),
    ).toEqual([]);
    expect(db.select().from(dashboard).where(eq(dashboard.userId, keep)).all()).toHaveLength(1);
    expect(USER_OWNED_TABLES.indexOf(dashboardWidget)).toBe(
      USER_OWNED_TABLES.indexOf(dashboard) - 1,
    );
  });
});

describe("deaktivace", () => {
  test("[ADM-005] deaktivace okamžitě ukončí relace, otevřená záložka i server action selžou", async () => {
    const browser = await invitedBrowser("user@example.cz");
    const target = (await browser.sessionUser())!;
    requestHeaders.current = new Headers({ cookie: browser.cookieHeader() });
    await expect(requireSession()).resolves.toBeTruthy();

    deactivateUser(admin, target.id);

    expect(await browser.sessionUser()).toBeNull();
    await expect(requireSession()).rejects.toThrow("redirect:/prihlaseni");
    expect(db.select().from(session).where(eq(session.userId, target.id)).all()).toEqual([]);
    expect(auditRows("user.deactivate").at(-1)).toMatchObject({
      actorId: ADMIN_ID,
      entityId: target.id,
      after: { banned: true, revokedSessions: 1 },
    });
  });

  test("[ADM-005] relace vzniklá souběžně s deaktivací neprojde requireSession", async () => {
    const browser = await invitedBrowser("user@example.cz");
    const target = (await browser.sessionUser())!;
    db.update(user).set({ banned: true }).where(eq(user.id, target.id)).run();
    requestHeaders.current = new Headers({ cookie: browser.cookieHeader() });

    await expect(requireSession()).rejects.toThrow("redirect:/prihlaseni");
  });

  test("[ADM-005] deaktivovaný se nepřihlásí, po reaktivaci ano", async () => {
    const browser = await invitedBrowser("user@example.cz");
    const target = (await browser.sessionUser())!;

    deactivateUser(admin, target.id);
    const denied = await browser.signIn("user@example.cz");

    expect(denied.status).toBe(403);
    expect(await browser.sessionUser()).toBeNull();

    reactivateUser(admin, target.id);
    const allowed = await browser.signIn("user@example.cz", PASSWORD);

    expect(allowed.status).toBe(200);
    expect(await browser.sessionUser()).toMatchObject({ email: "user@example.cz" });
    expect(auditRows("user.reactivate").at(-1)).toMatchObject({ actorId: ADMIN_ID });
  });
});

describe("reaktivace aktivního účtu", () => {
  test("[ADM-005] účet bez deaktivace nic nezmění a nic nezapíše do auditu", () => {
    seedUser("active", "active@example.cz");
    const opened = "2026-01-05";
    db.insert(schema.automationSettings)
      .values({
        userId: "active",
        reminders: true,
        remindersOpenSince: opened,
        updatedAt: new Date(),
      })
      .run();
    const before = auditRows("user.reactivate").length;

    reactivateUser(admin, "active");

    expect(auditRows("user.reactivate")).toHaveLength(before);
    const row = db
      .select()
      .from(schema.automationSettings)
      .where(eq(schema.automationSettings.userId, "active"))
      .get();
    expect(row?.remindersOpenSince).toBe(opened);
  });
});

describe("smazání účtu", () => {
  test("[ADM-006] smazání vyžaduje shodný e-mail a odstraní data", () => {
    seedUser("u1", "Mixed@Example.cz");
    seedSession("u1");
    db.insert(invitation)
      .values({
        id: "i1",
        email: "mixed@example.cz",
        tokenHash: "x",
        role: "user",
        createdAt: new Date(),
        expiresAt: new Date(),
      })
      .run();

    expect(() => deleteUser(admin, "u1", "jiny@example.cz")).toThrow("nesouhlasí");
    expect(find("u1")).toBeDefined();

    deleteUser(admin, "u1", " mixed@example.CZ ");

    expect(find("u1")).toBeUndefined();
    expect(db.select().from(session).where(eq(session.userId, "u1")).all()).toEqual([]);
    expect(db.select().from(invitation).all()).toEqual([]);
  });

  test("[ADM-006] každá tabulka s vlastníkem je v seznamu dat účtu nebo ve výjimkách", () => {
    expect(USER_OWNED_TABLES).toEqual(expect.arrayContaining([session, account]));
    expect(findUnregisteredOwnedTables(schema, USER_OWNED_TABLES, EXCEPTIONS)).toEqual([]);
  });

  test("[ADM-006] tabulka s nekaskádovým odkazem na jinou tabulku účtu se maže před ní", () => {
    const order: string[] = USER_OWNED_TABLES.map((table) => getTableName(table));
    const late = USER_OWNED_TABLES.flatMap((table) =>
      getTableConfig(table).foreignKeys.flatMap((key) => {
        const target = getTableName(key.reference().foreignTable);
        const cascades = key.onDelete === "cascade" || key.onDelete === "set null";
        const name = getTableName(table);
        return !cascades && target !== name && order.indexOf(target) < order.indexOf(name)
          ? [`${name} -> ${target}`]
          : [];
      }),
    );
    expect(late).toEqual([]);
    expect(order.indexOf("import_batch")).toBeGreaterThan(order.indexOf("invoice"));
    expect(order.indexOf("import_batch")).toBeGreaterThan(order.indexOf("customer"));
    expect(order.indexOf("import_batch")).toBeGreaterThan(order.indexOf("catalog_item"));
  });

  test("[ADM-006] výjimka platí jen pro tabulku, která vlastníka opravdu má", () => {
    const owned = findUnregisteredOwnedTables(schema, [], []);
    expect(owned).toEqual(expect.arrayContaining(EXCEPTIONS));
  });

  test("[ADM-006] kontrola najde novou tabulku podle sloupce i cizího klíče", () => {
    const byOwner = sqliteTable("t_by_owner", { ownerId: text("owner_id") });
    const byUser = sqliteTable("t_by_user", { userId: text("user_id") });
    const byForeignKey = sqliteTable("t_by_fk", { author: text().references(() => user.id) });
    const unrelated = sqliteTable("t_unrelated", { id: text() });

    expect(
      findUnregisteredOwnedTables({ user, byOwner, byUser, byForeignKey, unrelated }, [byUser], []),
    ).toEqual(["t_by_owner", "t_by_fk"]);
  });

  async function auditTrailAfterDeletion(
    email: string,
    remove: (id: string, browser: Browser) => Promise<void> | void,
  ) {
    const name = `Zdenka ${email.split("@")[0]}`;
    const browser = new Browser(auth as unknown as Auth);
    await browser.signIn(email);
    const { url } = await createInvitation(admin, email);
    browser.cookies.set("fakturan_invite", url.split("/").at(-1)!);
    await browser.request("/sign-up/email", { body: { name, email, password: PASSWORD } });
    const { id } = (await browser.sessionUser())!;
    await browser.signIn(email, "spatne-heslo-spatne");
    await browser.signIn(email);
    expect(listUsers(admin).find((u) => u.id === id)?.lastLoginAt).toBeInstanceOf(Date);
    writeUserAudit(id);

    await remove(id, browser);

    const rows = db.select().from(auditLog).all();
    const closing = rows.filter((r) => r.action === "user.delete" && r.entityId === id);
    const others = rows.filter((r) => !closing.includes(r));
    const text = JSON.stringify(others);
    expect(text).not.toContain(email);
    expect(text).not.toContain(name);
    expect(text).not.toContain(id);
    expect(db.select().from(auditPurge).all()).toEqual([]);
    expect(closing).toHaveLength(1);
    expect(JSON.stringify(closing)).not.toContain(email);
    expect(JSON.stringify(closing)).not.toContain(name);
    return { id, closing: closing[0] };
  }

  test("[AUD-010] smazání adminem nenechá v auditu nic o účtu kromě ID v závěrečném záznamu", async () => {
    const { closing } = await auditTrailAfterDeletion("purge-admin@example.cz", (id) =>
      deleteUser(admin, id, "purge-admin@example.cz"),
    );

    expect(closing).toMatchObject({ scope: "instance", ownerId: null, actorId: ADMIN_ID });
  });

  test("[AUD-010] vlastní smazání nenechá v závěrečném záznamu aktéra, IP ani prohlížeč", async () => {
    const { id, closing } = await auditTrailAfterDeletion("purge-self@example.cz", (userId) =>
      deleteOwnAccount(
        { userId, source: "web", ip: "1.2.3.4", userAgent: "UA/x" },
        {
          createdAt: new Date(),
        },
        PASSWORD,
      ),
    );

    expect(closing).toMatchObject({
      entityId: id,
      ownerId: null,
      actorId: null,
      ip: null,
      userAgent: null,
    });
  });

  test("[AUD-010] smazání odstraní i limity a ověření s e-mailem nebo ID účtu", () => {
    seedUser("purged-3", "limit@example.cz");
    const now = new Date();
    db.insert(rateLimit)
      .values([
        { key: "loginEmail:limit@example.cz", windowStart: now, count: 1 },
        { key: "accountDeleteUser:purged-3", windowStart: now, count: 1 },
        { key: "loginEmail:jiny@example.cz", windowStart: now, count: 1 },
      ])
      .run();
    db.insert(verification)
      .values({
        id: "v1",
        identifier: "reset-password:x",
        value: "purged-3",
        expiresAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    deleteUser(admin, "purged-3", "limit@example.cz");

    expect(
      db
        .select()
        .from(rateLimit)
        .all()
        .map((r) => r.key),
    ).toEqual(["loginEmail:jiny@example.cz"]);
    expect(db.select().from(verification).all()).toEqual([]);
  });

  test("[AUD-010] po smazání zůstane audit dál chráněný proti mazání", () => {
    seedUser("purged-2", "smazany@example.cz");
    deleteUser(admin, "purged-2", "smazany@example.cz");
    writeUserAudit("purged-2");

    expect(() => db.delete(auditLog).where(eq(auditLog.ownerId, "purged-2")).run()).toThrow(
      "append-only",
    );
  });
});

describe("smazání vlastního účtu", () => {
  test("[ADM-009] uživatel smaže vlastní účet, poslední admin s dalšími uživateli ne", async () => {
    const browser = await invitedBrowser("user@example.cz");
    const me = (await browser.sessionUser())!;
    const self = { userId: me.id, source: "web" } as const;
    const current = { createdAt: new Date() };

    await expect(deleteOwnAccount(self, current, "spatne-heslo-spatne")).rejects.toThrow(
      "Nesprávné heslo",
    );
    expect(find(me.id)).toBeDefined();

    await deleteOwnAccount(self, current, PASSWORD);
    expect(find(me.id)).toBeUndefined();
    expect(auditRows("user.delete").at(-1)).toMatchObject({ actorId: null, ownerId: null });

    seedUser("u2", "u2@example.cz");
    await expect(deleteOwnAccount(admin, current, undefined)).rejects.toThrow(
      "Poslední administrátor",
    );
    expect(find(ADMIN_ID)).toBeDefined();
  });

  test("[ADM-009] poslední admin bez dalších uživatelů účet smazat smí", async () => {
    await deleteOwnAccount(admin, { createdAt: new Date() }, undefined);

    expect(find(ADMIN_ID)).toBeUndefined();
  });

  test("[ADM-009] účet bez hesla vyžaduje čerstvé přihlášení", async () => {
    const stale = { createdAt: new Date(Date.now() - 3_600_000) };
    seedUser("u1", "u1@example.cz");
    const self = { userId: "u1", source: "web" } as const;

    await expect(deleteOwnAccount(self, stale, undefined)).rejects.toThrow("znovu přihlaste");
    expect(find("u1")).toBeDefined();
    await deleteOwnAccount(self, { createdAt: new Date() }, undefined);
    expect(find("u1")).toBeUndefined();
  });
});

describe("oddělení administrátora od dat uživatelů", () => {
  test("[AUD-008] admin vidí jen události instance", () => {
    seedUser("u1", "u1@example.cz");
    writeUserAudit("u1");
    setRole(admin, "u1", "admin");

    const { rows } = listInstanceAudit(admin);

    expect(rows.some((r) => r.action === "user.role_change")).toBe(true);
    expect(rows.some((r) => r.action === "invoice.create")).toBe(false);
    expect(() => listInstanceAudit({ userId: "nikdo", source: "web" })).toThrow("oprávnění");
  });

  test("[AUD-008] události instance se stránkují", () => {
    seedUser("u1", "u1@example.cz");
    setRole(admin, "u1", "admin");
    setRole(admin, "u1", "user");
    setRole(admin, "u1", "admin");

    const first = listInstanceAudit(admin, { page: 1, pageSize: 2 });
    const second = listInstanceAudit(admin, { page: 2, pageSize: 2 });

    expect(first.rows).toHaveLength(2);
    expect(first.hasNext).toBe(true);
    expect(second.rows[0].id).toBeLessThan(first.rows[1].id);
  });

  test("[AUD-008] každá akce ze serveru má český popisek a neznámá obecný", () => {
    const missing = productionAuditActions().filter((action) => !(action in ACTION_LABELS));

    expect(missing).toEqual([]);
    expect(auditActionLabel("nova.akce")).toBe("Jiná událost");
  });

  test("[ADM-007] admin nemá přístup k datům jiného uživatele", async () => {
    seedUser("u1", "u1@example.cz");
    writeUserAudit("u1");
    setRole(admin, "u1", "user");

    const [row] = listInstanceAudit(admin).rows;

    expect(Object.keys(row).sort()).toEqual([
      "action",
      "actorEmail",
      "at",
      "entity",
      "entityId",
      "id",
      "source",
    ]);
    const res = await auth.handler(
      new Request(`${BASE}/api/auth/admin/impersonate-user`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE },
        body: JSON.stringify({ userId: "u1" }),
      }),
    );
    expect(res.status).toBe(404);
  });
});
