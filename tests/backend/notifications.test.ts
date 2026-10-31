import { randomUUID } from "node:crypto";
import { eq, ne } from "drizzle-orm";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { setClockForTests } from "@/server/clock";
import { auditLog, notification, user } from "@/server/db/schema";
import {
  derivedAlerts,
  listNotifications,
  markAllRead,
  markRead,
  notificationFeed,
  notify,
  registerDerivedAlerts,
  resolveNotification,
  unreadCount,
} from "@/server/services/notifications";
import { deleteUser, USER_OWNED_TABLES } from "@/server/services/users";
import { createTestDb } from "../helpers/db";
import { assertIsolated } from "../helpers/isolation";

vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-notifications-")));

const db = createTestDb();
const T0 = new Date("2026-11-02T10:00:00Z");
const actor = (userId: string) => ({ userId, source: "web" as const });

afterEach(() => setClockForTests(null));

function seed(role: "admin" | "user" = "user"): string {
  const id = randomUUID();
  db.insert(user)
    .values({ id, name: id, email: `${id}@x.cz`, role, createdAt: T0, updatedAt: T0 })
    .run();
  return id;
}

function add(userId: string, dedupeKey: string = randomUUID()) {
  db.transaction((tx) =>
    notify(tx, {
      userId,
      kind: "mail_failed",
      dedupeKey,
      params: { invoice: "2026001" },
      entity: { type: "invoice", id: "i1" },
    }),
  );
  return dedupeKey;
}

const stored = (userId: string) =>
  db.select().from(notification).where(eq(notification.userId, userId)).all();

describe("zakládání", () => {
  test("stejný dedupeKey založí jedno upozornění", () => {
    const id = seed();

    add(id, "mail:1");
    add(id, "mail:1");

    expect(stored(id)).toHaveLength(1);
    expect(stored(id)[0]).toMatchObject({
      kind: "mail_failed",
      params: { invoice: "2026001" },
      entityType: "invoice",
      entityId: "i1",
      readAt: null,
      resolvedAt: null,
    });
  });

  test("stejný klíč u dvou účtů jsou dvě upozornění", () => {
    const a = seed();
    const b = seed();

    add(a, "same");
    add(b, "same");

    expect(stored(a)).toHaveLength(1);
    expect(stored(b)).toHaveLength(1);
  });

  test("upozornění vzniká ve stejné transakci jako zápis, který selže", () => {
    const id = seed();

    expect(() =>
      db.transaction((tx) => {
        notify(tx, { userId: id, kind: "mail_failed", dedupeKey: "x", params: {} });
        throw new Error("rollback");
      }),
    ).toThrow("rollback");

    expect(stored(id)).toEqual([]);
  });
});

describe("zvonek", () => {
  test("zvonek ukáže počet a přečtení ho sníží", () => {
    const id = seed();
    const first = add(id);
    add(id);
    add(id);
    expect(unreadCount(id)).toBe(3);

    const target = stored(id).find((row) => row.dedupeKey === first)!;
    markRead(actor(id), target.id);
    expect(unreadCount(id)).toBe(2);

    markAllRead(actor(id));
    expect(unreadCount(id)).toBe(0);
    expect(stored(id).every((row) => row.readAt !== null)).toBe(true);
  });

  test("přečtení jednou přečteného nic nezmění a nic nezapíše", () => {
    const id = seed();
    setClockForTests({ now: () => T0 });
    add(id);
    const target = stored(id)[0]!;
    markRead(actor(id), target.id);
    const before = db.select().from(auditLog).all().length;

    setClockForTests({ now: () => new Date("2026-11-03T10:00:00Z") });
    markRead(actor(id), target.id);
    markAllRead(actor(id));

    expect(stored(id)[0]!.readAt).toEqual(T0);
    expect(db.select().from(auditLog).all()).toHaveLength(before);
  });

  test("vyřešené upozornění se do počtu nepočítá, ale zůstane v seznamu", () => {
    const id = seed();
    add(id, "mail:2");
    expect(unreadCount(id)).toBe(1);

    db.transaction((tx) => resolveNotification(tx, id, "mail:2"));

    expect(unreadCount(id)).toBe(0);
    const page = listNotifications(id, 1);
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]!.resolvedAt).not.toBeNull();
  });

  test("vyřešení nezná cizí klíč a neschová cizí upozornění", () => {
    const a = seed();
    const b = seed();
    add(a, "k");
    add(b, "k");

    db.transaction((tx) => resolveNotification(tx, a, "k"));

    expect(stored(a)[0]!.resolvedAt).not.toBeNull();
    expect(stored(b)[0]!.resolvedAt).toBeNull();
  });

  test("přečtení zapíše do auditu vlastníka", () => {
    const id = seed();
    add(id);
    add(id);

    markRead(actor(id), stored(id)[0]!.id);
    markAllRead(actor(id));

    expect(
      db
        .select()
        .from(auditLog)
        .where(eq(auditLog.ownerId, id))
        .all()
        .filter((row) => row.entity === "notification")
        .map((row) => row.action),
    ).toEqual(["notification.read", "notification.read_all"]);
  });
});

describe("seznam", () => {
  test("řadí od nejnovějšího a stránkuje", () => {
    const id = seed();
    for (let n = 0; n < 30; n += 1) {
      setClockForTests({ now: () => new Date(T0.getTime() + n * 1000) });
      add(id, `k${n}`);
    }

    const first = listNotifications(id, 1);
    const second = listNotifications(id, 2);

    expect(first.rows).toHaveLength(25);
    expect(first.hasNext).toBe(true);
    expect(first.rows[0]!.dedupeKey).toBe("k29");
    expect(second.rows).toHaveLength(5);
    expect(second.hasNext).toBe(false);
    expect(second.rows.at(-1)!.dedupeKey).toBe("k0");
  });

  test("neplatné číslo stránky je první stránka", () => {
    const id = seed();
    add(id);

    expect(listNotifications(id, -3).rows).toHaveLength(1);
    expect(listNotifications(id, Number.NaN).rows).toHaveLength(1);
  });
});

describe("odvozená upozornění", () => {
  test("zdroje se sčítají a dostávají vlastníka a dnešek", () => {
    const id = seed();
    const calls: [string, string][] = [];
    registerDerivedAlerts((ownerId, today) => {
      calls.push([ownerId, today]);
      return [{ dedupeKey: "overdue:1", kind: "mail_failed", params: { n: 1 } }];
    });
    setClockForTests({ now: () => new Date("2026-11-02T23:30:00Z") });

    const alerts = derivedAlerts(id);

    expect(alerts).toEqual([{ dedupeKey: "overdue:1", kind: "mail_failed", params: { n: 1 } }]);
    expect(calls).toEqual([[id, "2026-11-03"]]);
  });
});

describe("izolace", () => {
  test("[TST-009] izolace upozornění včetně update a remove", async () => {
    await assertIsolated<string>({
      create: (ownerId) => {
        db.insert(user)
          .values({
            id: ownerId,
            name: ownerId,
            email: `${ownerId}@x.cz`,
            createdAt: T0,
            updatedAt: T0,
          })
          .onConflictDoNothing()
          .run();
        add(ownerId, "iso");
        return stored(ownerId)[0]!.id;
      },
      find: (ownerId, notificationId) =>
        listNotifications(ownerId, 1).rows.filter(
          (row) => row.id === notificationId && row.resolvedAt === null,
        ),
      list: (ownerId) => listNotifications(ownerId, 1).rows.map((row) => row.id),
      update: (ownerId, notificationId) => {
        markRead(actor(ownerId), notificationId);
        return stored(ownerId).find((row) => row.id === notificationId)?.readAt ? 1 : 0;
      },
      remove: (ownerId, notificationId) => {
        db.transaction((tx) => resolveNotification(tx, ownerId, "iso"));
        const row = stored(ownerId).find((item) => item.id === notificationId);
        return row?.resolvedAt ? 1 : 0;
      },
    });
  });

  test("[TST-009] cizí upozornění nejde přečíst", () => {
    const a = seed();
    const b = seed();
    add(a);

    markRead(actor(b), stored(a)[0]!.id);

    expect(unreadCount(a)).toBe(1);
  });

  test("[ADM-006] upozornění se smažou s účtem", () => {
    const admin = seed("admin");
    const id = seed();
    add(id);
    expect(USER_OWNED_TABLES).toContain(notification);

    deleteUser(actor(admin), id, `${id}@x.cz`);

    expect(stored(id)).toEqual([]);
  });
});

describe("stránky upozornění", () => {
  test("označit vše platí pro celý účet, i když je nepřečtené až na další straně", () => {
    const id = seed();
    setClockForTests({ now: () => T0 });
    add(id, "stare");
    setClockForTests({ now: () => new Date(T0.getTime() + 1000) });
    for (let i = 0; i < 25; i += 1) add(id);
    db.update(notification).set({ readAt: T0 }).where(ne(notification.dedupeKey, "stare")).run();

    const first = notificationFeed(id, 1);
    expect(first.rows.every((row) => row.readAt !== null)).toBe(true);
    expect(first.canMarkAll).toBe(true);

    markAllRead(actor(id));
    expect(notificationFeed(id, 1).canMarkAll).toBe(false);
  });

  test("odvozená upozornění jsou jen na první straně", () => {
    const id = seed();
    registerDerivedAlerts((ownerId) =>
      ownerId === id
        ? [{ dedupeKey: "odvozene", kind: "invoices_overdue", params: { count: 1 } }]
        : [],
    );
    expect(notificationFeed(id, 1).derived.map((alert) => alert.dedupeKey)).toContain("odvozene");
    expect(notificationFeed(id, 2).derived).toEqual([]);
  });
});
