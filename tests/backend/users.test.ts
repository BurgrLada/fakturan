import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { auth } from "@/server/auth";
import { requireAdmin, requireSession } from "@/server/auth/session";
import { setClockForTests } from "@/server/clock";
import {
  account,
  auditLog,
  auditPurge,
  instanceMeta,
  invitation,
  rateLimit,
  session,
  user,
} from "@/server/db/schema";
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
import { Browser, BASE, PASSWORD, type Auth } from "../helpers/auth-browser";
import { createTestDb } from "../helpers/db";

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

function roleOf(id: string) {
  return db.select().from(user).where(eq(user.id, id)).get()?.role;
}

function find(id: string) {
  return db.select().from(user).where(eq(user.id, id)).get();
}

function userRows(ownerId: string) {
  return db.select().from(auditLog).where(eq(auditLog.ownerId, ownerId)).all();
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

  test("[ADM-004] poslední admin nejde degradovat, deaktivovat ani smazat", () => {
    seedUser("u1", "u1@example.cz");
    const other = { userId: "a2", source: "web" } as const;
    seedUser("a2", "a2@example.cz", "admin", true);

    expect(() => setRole(admin, ADMIN_ID, "user")).toThrow("Poslední administrátor");
    expect(roleOf(ADMIN_ID)).toBe("admin");
    db.update(user).set({ banned: false }).where(eq(user.id, "a2")).run();
    setRole(other, ADMIN_ID, "user");
    expect(() => deactivateUser(other, "a2")).toThrow();
    expect(() => setRole(other, "a2", "user")).toThrow("Poslední administrátor");
    expect(roleOf("a2")).toBe("admin");
  });

  test("[ADM-004] deaktivovaný kolega se jako náhradní administrátor nepočítá", () => {
    seedUser("a2", "a2@example.cz", "admin", true);
    seedUser("a3", "a3@example.cz", "admin");
    const third = { userId: "a3", source: "web" } as const;

    deactivateUser(admin, "a3");

    expect(() => setRole(third, ADMIN_ID, "user")).toThrow("oprávnění");
    expect(() => setRole(admin, ADMIN_ID, "user")).toThrow("Poslední administrátor");
  });

  test("[ADM-004] admin nesmaže ani nedeaktivuje sám sebe přes administraci", () => {
    seedUser("a2", "a2@example.cz", "admin");

    expect(() => deactivateUser(admin, ADMIN_ID)).toThrow("Vlastní účet");
    expect(() => deleteUser(admin, ADMIN_ID, "admin@example.cz")).toThrow("Vlastní účet");
    expect(find(ADMIN_ID)?.banned).toBe(false);
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

  test("[ADM-006] seznam dat účtu pokrývá relace a propojené účty", () => {
    expect(USER_OWNED_TABLES).toEqual(expect.arrayContaining([session, account]));
  });

  test("[AUD-010] smazání odstraní audit účtu a nechá jediný záznam bez e-mailu", () => {
    seedUser("purged-1", "smazany@example.cz");
    writeUserAudit("purged-1");
    writeUserAudit("purged-1", "invoice.update");
    writeUserAudit(ADMIN_ID);

    deleteUser(admin, "purged-1", "smazany@example.cz");

    expect(userRows("purged-1").filter((r) => r.scope === "user")).toEqual([]);
    expect(userRows(ADMIN_ID).filter((r) => r.scope === "user")).toHaveLength(1);
    expect(db.select().from(auditPurge).all()).toEqual([]);
    const rows = auditRows("user.delete").filter((r) => r.entityId === "purged-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      scope: "instance",
      entityId: "purged-1",
      ownerId: null,
      actorId: ADMIN_ID,
    });
    expect(JSON.stringify(rows[0])).not.toContain("smazany@example.cz");
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
    expect(auditRows("user.delete").at(-1)).toMatchObject({ actorId: me.id, ownerId: null });

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

    const rows = listInstanceAudit(admin);

    expect(rows.some((r) => r.action === "user.role_change")).toBe(true);
    expect(rows.some((r) => r.action === "invoice.create")).toBe(false);
    expect(() => listInstanceAudit({ userId: "nikdo", source: "web" })).toThrow("oprávnění");
  });

  test("[ADM-007] admin nemá přístup k datům jiného uživatele", async () => {
    seedUser("u1", "u1@example.cz");
    writeUserAudit("u1");
    setRole(admin, "u1", "user");

    const [row] = listInstanceAudit(admin);

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
