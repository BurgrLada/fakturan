import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, test } from "vitest";
import { recordAudit } from "@/server/audit/record";
import { redact } from "@/server/audit/redact";
import type { Actor } from "@/server/audit/context";
import { setClockForTests } from "@/server/clock";
import { auditLog, auditPurge } from "@/server/db/schema";
import { mutate } from "@/server/services/mutation";
import { expectAudited, findWritesOutsideMutate } from "../helpers/audit-guard";
import { createTestDb } from "../helpers/db";

const db = createTestDb();
db.$client.exec("CREATE TABLE probe (id TEXT PRIMARY KEY, v TEXT)");

const actor: Actor = { userId: "u1", source: "web" };

function entry(ownerId: string | null = "u1", scope: "user" | "instance" = "user") {
  return { entity: "probe", entityId: "1", ownerId, scope };
}

function rowsOf(ownerId: string) {
  return db.select().from(auditLog).where(eq(auditLog.ownerId, ownerId)).all();
}

function probeCount(id: string): number {
  const row = db.$client.prepare("SELECT count(*) AS n FROM probe WHERE id = ?").get(id) as {
    n: number;
  };
  return row.n;
}

afterEach(() => {
  setClockForTests(null);
  db.$client.exec("DROP TRIGGER IF EXISTS fail_audit; DELETE FROM audit_purge");
});

describe("mutate", () => {
  test("[AUD-001] vytvoření, změna a smazání zapíšou záznam se stavem před a po", () => {
    mutate(actor, "probe.create", (tx, audit) => {
      tx.run(sql`INSERT INTO probe VALUES ('a1', 'x')`);
      audit({ ...entry("aud1"), after: { v: "x" } });
    });
    mutate(actor, "probe.update", (tx, audit) => {
      tx.run(sql`UPDATE probe SET v = 'y' WHERE id = 'a1'`);
      audit({ ...entry("aud1"), before: { v: "x" }, after: { v: "y" } });
    });
    mutate(actor, "probe.delete", (tx, audit) => {
      tx.run(sql`DELETE FROM probe WHERE id = 'a1'`);
      audit({ ...entry("aud1"), before: { v: "y" } });
    });

    expect(rowsOf("aud1").map(({ action, before, after }) => ({ action, before, after }))).toEqual([
      { action: "probe.create", before: null, after: { v: "x" } },
      { action: "probe.update", before: { v: "x" }, after: { v: "y" } },
      { action: "probe.delete", before: { v: "y" }, after: null },
    ]);
  });

  test("[AUD-001] jedna mutace může zapsat víc záznamů s vlastní akcí a vrací výsledek", () => {
    const result = mutate(actor, "probe.bulk", (_tx, audit) => {
      audit(entry("aud2"));
      audit({ ...entry("aud2"), action: "probe.extra" });
      return 42;
    });

    expect(result).toBe(42);
    expect(rowsOf("aud2").map((r) => r.action)).toEqual(["probe.bulk", "probe.extra"]);
  });

  test("[AUD-003] záznam obsahuje aktéra, zdroj, ip, user agent a request id", () => {
    const now = new Date("2026-10-30T12:00:00.000Z");
    setClockForTests({ now: () => now });

    mutate(
      { userId: "u9", source: "import", ip: "10.0.0.1", userAgent: "UA/1", requestId: "req-1" },
      "probe.create",
      (_tx, audit) => audit({ ...entry("aud3"), entity: "invoice", entityId: "inv-1" }),
    );

    expect(rowsOf("aud3")).toEqual([
      expect.objectContaining({
        at: now,
        actorId: "u9",
        ownerId: "aud3",
        source: "import",
        scope: "user",
        action: "probe.create",
        entity: "invoice",
        entityId: "inv-1",
        ip: "10.0.0.1",
        userAgent: "UA/1",
        requestId: "req-1",
      }),
    ]);
  });

  test("[AUD-003] systémový aktér bez uživatele a záznam instance bez účtu", () => {
    const before = db.select().from(auditLog).all().length;

    mutate({ userId: null, source: "scheduler" }, "job.run", (_tx, audit) =>
      audit(entry(null, "instance")),
    );

    const rows = db.select().from(auditLog).all();
    expect(rows).toHaveLength(before + 1);
    expect(rows.at(-1)).toMatchObject({
      actorId: null,
      ownerId: null,
      source: "scheduler",
      scope: "instance",
      ip: null,
      userAgent: null,
      requestId: null,
    });
  });

  test("[AUD-005] selhání zápisu auditu vrátí změnu zpět", () => {
    db.$client.exec(
      "CREATE TRIGGER fail_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit down'); END",
    );

    expect(() =>
      mutate(actor, "probe.create", (tx, audit) => {
        tx.run(sql`INSERT INTO probe VALUES ('b1', 'x')`);
        audit(entry("aud5"));
      }),
    ).toThrow("audit down");

    expect(probeCount("b1")).toBe(0);
  });

  test("[AUD-005] výjimka ve službě po zápisu auditu vrátí změnu i záznam", () => {
    expect(() =>
      mutate(actor, "probe.create", (tx, audit) => {
        tx.run(sql`INSERT INTO probe VALUES ('b2', 'x')`);
        audit(entry("aud5b"));
        throw new Error("boom");
      }),
    ).toThrow("boom");

    expect(probeCount("b2")).toBe(0);
    expect(rowsOf("aud5b")).toEqual([]);
  });

  test("[AUD-005] transakce drží zápisový zámek od začátku (immediate)", () => {
    const other = new Database(db.$client.name);
    other.pragma("busy_timeout = 0");
    try {
      mutate(actor, "probe.lock", (_tx, audit) => {
        expect(() => other.prepare("BEGIN IMMEDIATE").run()).toThrow(/locked|busy/i);
        audit(entry("aud5c"));
      });
    } finally {
      other.close();
    }
  });

  test("[AUD-005] asynchronní funkce se odmítne a změna se vrátí, protože by opustila transakci", () => {
    expect(() =>
      // @ts-expect-error async callbacks are excluded at compile time
      mutate(actor, "probe.create", async (tx, audit) => {
        tx.run(sql`INSERT INTO probe VALUES ('b3', 'x')`);
        audit(entry("aud5d"));
      }),
    ).toThrow(/asynchron/i);

    expect(probeCount("b3")).toBe(0);
    expect(rowsOf("aud5d")).toEqual([]);
  });

  test("[AUD-005] nespuštěný dotaz Drizzle jako výsledek se odmítne a nezanechá záznam", () => {
    expect(() =>
      // @ts-expect-error query builders are thenable and excluded at compile time
      mutate(actor, "probe.create", (tx, audit) => {
        audit(entry("aud5f"));
        return tx.insert(auditPurge).values({ ownerId: "aud5f" });
      }),
    ).toThrow(/asynchron/i);

    expect(rowsOf("aud5f")).toEqual([]);
    expect(db.select().from(auditPurge).all()).toEqual([]);
  });

  test("[AUD-005] audit po skončení transakce selže místo zápisu mimo ni", () => {
    let late: (() => void) | undefined;
    mutate(actor, "probe.create", (_tx, audit) => {
      audit(entry("aud5e"));
      late = () => audit(entry("aud5e"));
    });

    expect(late).toThrow(/transakc/i);
    expect(rowsOf("aud5e")).toHaveLength(1);
  });

  test("[AUD-011] mutace bez auditu vyhodí chybu a změnu vrátí", () => {
    expect(() =>
      mutate(actor, "probe.create", (tx) => {
        tx.run(sql`INSERT INTO probe VALUES ('c1', 'x')`);
      }),
    ).toThrow("probe.create");

    expect(probeCount("c1")).toBe(0);
  });
});

describe("recordAudit", () => {
  test("[AUD-003] mimo kontext mutace bez aktéra selže", () => {
    db.transaction((tx) => {
      expect(() => recordAudit(tx, { action: "probe.create", ...entry("aud3b") })).toThrow(
        /aktér/i,
      );
    });
  });
});

describe("append-only", () => {
  function seed(ownerId: string, scope: "user" | "instance" = "user") {
    mutate(actor, "probe.seed", (_tx, audit) => audit(entry(ownerId, scope)));
    return rowsOf(ownerId)[0].id;
  }

  test("[AUD-006] UPDATE a DELETE audit_log selžou", () => {
    const id = seed("aud6");

    expect(() =>
      db.$client.prepare("UPDATE audit_log SET action = 'x' WHERE id = ?").run(id),
    ).toThrow(/append-only/);
    expect(() => db.$client.prepare("DELETE FROM audit_log WHERE id = ?").run(id)).toThrow(
      /append-only/,
    );
    expect(() => db.$client.prepare("DELETE FROM audit_log").run()).toThrow(/append-only/);

    expect(rowsOf("aud6")).toMatchObject([{ action: "probe.seed" }]);
  });

  test("[AUD-006] INSERT OR REPLACE nepřepíše existující záznam", () => {
    const id = seed("aud6b");

    expect(() =>
      db.$client
        .prepare(
          "INSERT OR REPLACE INTO audit_log (id, at, source, scope, action, entity) VALUES (?, 0, 'web', 'user', 'x.y', 'z')",
        )
        .run(id),
    ).toThrow(/append-only/);

    expect(rowsOf("aud6b")).toMatchObject([{ id, action: "probe.seed" }]);
  });

  test("[AUD-006] DELETE respektuje povolení v audit_purge jen pro daný účet", () => {
    const permitted = seed("aud6c");
    const foreign = seed("aud6d");
    db.$client.prepare("INSERT INTO audit_purge (owner_id) VALUES ('aud6c')").run();

    db.$client.prepare("DELETE FROM audit_log WHERE id = ?").run(permitted);
    expect(rowsOf("aud6c")).toEqual([]);

    expect(() => db.$client.prepare("DELETE FROM audit_log WHERE id = ?").run(foreign)).toThrow(
      /append-only/,
    );
  });

  test("[AUD-006] UPDATE selže i s povolením v audit_purge", () => {
    const id = seed("aud6f");
    db.$client.prepare("INSERT INTO audit_purge (owner_id) VALUES ('aud6f')").run();

    expect(() =>
      db.$client.prepare("UPDATE audit_log SET action = 'x.y' WHERE id = ?").run(id),
    ).toThrow(/append-only/);

    expect(rowsOf("aud6f")).toMatchObject([{ action: "probe.seed" }]);
  });

  test("[AUD-006] povolení v audit_purge neotevře záznamy instance", () => {
    const id = seed("aud6e", "instance");
    db.$client.prepare("INSERT INTO audit_purge (owner_id) VALUES ('aud6e')").run();

    expect(() => db.$client.prepare("DELETE FROM audit_log WHERE id = ?").run(id)).toThrow(
      /append-only/,
    );
  });
});

describe("redact", () => {
  test("[AUD-004] redact skryje klíče password, secret, token, smtpPassword, imapPassword i vnořené a v polích", () => {
    expect(redact({ a: { smtpPassword: "x" }, b: [{ token: "y" }] })).toEqual({
      a: { smtpPassword: "[skryto]" },
      b: [{ token: "[skryto]" }],
    });
  });

  test.each([
    "password",
    "secret",
    "token",
    "apikey",
    "privatekey",
    "smtpPassword",
    "imapPassword",
    "passwordHash",
    "clientSecret",
    "accessToken",
    "apiKey",
    "API_KEY",
    "privateKey",
    "APPLE_PRIVATE_KEY",
    "PASSWORD",
    "pass",
    "smtpPass",
    "pwd",
    "cookie",
    "sessionCookie",
    "authorization",
    "Authorization",
    "heslo",
    "noveHeslo",
    "totp",
    "totpUri",
  ])("[AUD-004] klíč %s se skryje v úložišti", (key) => {
    const ownerId = `aud4-${key}`;
    mutate(actor, "probe.update", (_tx, audit) =>
      audit({
        ...entry(ownerId),
        before: { [key]: "tajne-a", nested: [{ [key]: { deep: "tajne-b" } }] },
        after: { [key]: "tajne-c" },
      }),
    );

    const [row] = rowsOf(ownerId);
    expect(row.before).toEqual({ [key]: "[skryto]", nested: [{ [key]: "[skryto]" }] });
    expect(row.after).toEqual({ [key]: "[skryto]" });
    expect(JSON.stringify(row)).not.toContain("tajne");
  });

  test("[AUD-004] neškodné hodnoty zůstanou beze změny a vstup se nemění", () => {
    const at = new Date("2026-01-01T00:00:00.000Z");
    const input = { name: "Jan", n: 1, ok: true, none: null, at, list: [1, "a"], password: "x" };

    expect(redact(input)).toEqual({ ...input, password: "[skryto]" });
    expect(input.password).toBe("x");
    expect(redact("text")).toBe("text");
    expect(redact(null)).toBe(null);
    expect(redact(undefined)).toBe(undefined);
  });

  test("[AUD-004] instance třídy se projde jako objekt", () => {
    class Credentials {
      password = "x";
      name = "n";
    }
    expect(redact({ creds: new Credentials() })).toEqual({
      creds: { password: "[skryto]", name: "n" },
    });
  });

  test("[AUD-004] toJSON na prototypu nevyhne redakci a výstup se maskuje", () => {
    class Credentials {
      #password = "x";
      toJSON() {
        return { password: this.#password, name: "n" };
      }
    }
    expect(redact({ creds: new Credentials() })).toEqual({
      creds: { password: "[skryto]", name: "n" },
    });
  });

  test("[AUD-004] vlastní toJSON nevyhne redakci ani po serializaci záznamu", () => {
    const leaky = {
      password: "tajne-a",
      toJSON: () => ({ password: "tajne-b", name: "n" }),
    };
    const ownerId = "aud4-tojson";

    expect(redact(leaky)).toEqual({ password: "[skryto]", name: "n" });

    mutate(actor, "probe.update", (_tx, audit) => audit({ ...entry(ownerId), after: leaky }));
    const [row] = rowsOf(ownerId);
    expect(row.after).toEqual({ password: "[skryto]", name: "n" });
    expect(JSON.stringify(row)).not.toContain("tajne");
  });

  test("[AUD-004] funkce se do záznamu nedostanou", () => {
    expect(redact({ a: 1, fn: () => "tajne" })).toEqual({ a: 1 });
  });

  test("[AUD-004] Map a Set neztratí data a jejich obsah se maskuje", () => {
    const value = {
      map: new Map<unknown, unknown>([
        ["smtpPassword", "x"],
        ["name", "n"],
        [1, { token: "y" }],
      ]),
      set: new Set([{ secret: "z" }, "a"]),
    };

    expect(redact(value)).toEqual({
      map: { smtpPassword: "[skryto]", name: "n", "1": { token: "[skryto]" } },
      set: [{ secret: "[skryto]" }, "a"],
    });
  });

  test("[AUD-004] Buffer a Uint8Array se nerozepíšou", () => {
    expect(
      redact({
        buffer: Buffer.from("abc"),
        bytes: new Uint8Array([1, 2]),
        raw: new ArrayBuffer(2),
      }),
    ).toEqual({ buffer: "[binární data]", bytes: "[binární data]", raw: "[binární data]" });
  });
});

describe("audit guard", () => {
  test("[AUD-011] expectAudited propustí mutaci se záznamem a odmítne změnu bez něj", () => {
    expect(
      expectAudited(db, () =>
        mutate(actor, "probe.create", (_tx, audit) => {
          audit(entry("aud11"));
          return "ok";
        }),
      ),
    ).toBe("ok");

    expect(() =>
      expectAudited(db, () => db.$client.exec("INSERT INTO probe VALUES ('d1', 'x')")),
    ).toThrow("nevytvořila auditní záznam");
  });

  test("[AUD-011] služby nezapisují do databáze mimo mutate", () => {
    expect(findWritesOutsideMutate()).toEqual([]);
  });

  test("[AUD-011] kontrola služeb najde přímý zápis i víceřádkový a v podsložce", () => {
    const dir = mkdtempSync(join(tmpdir(), "fakturan-guard-"));
    try {
      mkdirSync(join(dir, "sub"));
      writeFileSync(join(dir, "mutation.ts"), "db.transaction(fn);");
      writeFileSync(join(dir, "clean.ts"), 'mutate(actor, "a.b", (tx) => tx.insert(t));');
      writeFileSync(join(dir, "read.ts"), "db.select().from(t);");
      writeFileSync(join(dir, "bad.ts"), "db.insert(t).values({});");
      writeFileSync(join(dir, "sub", "bad2.ts"), "db\n  .update(t);");

      expect(findWritesOutsideMutate(dir).sort()).toEqual(["bad.ts", "sub/bad2.ts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
