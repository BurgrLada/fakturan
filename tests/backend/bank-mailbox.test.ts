import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { eq } from "drizzle-orm";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { auditActionLabel } from "@/lib/audit-labels";
import { TEXTS } from "@/lib/texts";
import { openMailbox } from "@/server/bank/imap";
import { setClockForTests } from "@/server/clock";
import { encryptSecret } from "@/server/crypto";
import { auditLog, bankMailbox, notification, rateLimit, user } from "@/server/db/schema";
import { parseEnv } from "@/server/env";
import { RATE_RULES } from "@/server/rate-limit";
import {
  clearBankMailbox,
  getBankMailbox,
  saveBankMailbox,
  testBankMailbox,
} from "@/server/services/bank-mailbox";
import { deleteUser, USER_OWNED_TABLES } from "@/server/services/users";
import { createTestDb } from "../helpers/db";
import { startImap, type TestImap } from "../helpers/imap";
import { assertIsolated } from "../helpers/isolation";

const dns = vi.hoisted(() => ({ records: new Map<string, string[]>() }));

vi.mock("node:dns/promises", () => ({
  lookup: async (host: string) =>
    (dns.records.get(host) ?? [host]).map((address) => ({ address, family: 4 })),
}));

vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-bank-mailbox-")));

const db = createTestDb();
const T0 = new Date("2026-11-02T10:00:00Z");
const PASSWORD = "tajne-heslo-imap-4c1d";
const actor = (userId: string) => ({ userId, source: "web" as const });
const envWith = (over: Record<string, string> = {}) => parseEnv({ ...process.env, ...over });
const allowPrivate = () => envWith({ ALLOW_PRIVATE_MAIL_HOSTS: "true" });
const strict = () => envWith({ ALLOW_PRIVATE_MAIL_HOSTS: "false" });

const GENERIC = "Připojení se nepodařilo, zkontrolujte nastavení serveru a přihlášení";
const BLOCKED = "Tento server pošty není povolený";

let imap: TestImap;

beforeAll(async () => {
  imap = await startImap();
});
afterAll(async () => {
  await imap.close();
});
beforeEach(() => {
  dns.records.clear();
  imap.messages.length = 0;
  imap.commands.length = 0;
  imap.logins.length = 0;
  imap.setUidValidity(1000);
  setClockForTests(null);
});

function seed(): string {
  const id = randomUUID();
  db.insert(user)
    .values({ id, name: id, email: `${id}@x.cz`, createdAt: T0, updatedAt: T0 })
    .run();
  return id;
}

const own = (over: Record<string, unknown> = {}) => ({
  host: "127.0.0.1",
  port: String(imap.port),
  tls: "starttls",
  username: "avizo",
  password: PASSWORD,
  folder: "",
  enabled: true,
  requireConfirmation: true,
  ...over,
});

const row = (id: string) => db.select().from(bankMailbox).where(eq(bankMailbox.userId, id)).get();
const audits = (ownerId: string) =>
  db.select().from(auditLog).where(eq(auditLog.ownerId, ownerId)).all();

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("ochrana před spojením", () => {
  test.each([
    ["privátní adresa", "10.0.0.5"],
    ["IPv4 v IPv6", "::ffff:127.0.0.1"],
    ["IPv4 v IPv6 hexadecimálně", "::ffff:7f00:1"],
    ["metadata cloudu", "169.254.169.254"],
    ["loopback", "127.0.0.1"],
  ])("[SEC-007] %s je pro IMAP odmítnutá při uložení i při testu", async (_name, address) => {
    const id = seed();
    dns.records.set("imap.example.test", ["8.8.8.8", address]);

    await expect(
      saveBankMailbox(
        actor(id),
        own({ host: "imap.example.test", port: "993", tls: "implicit" }),
        strict(),
      ),
    ).rejects.toThrow(BLOCKED);
    expect(row(id)).toBeUndefined();

    dns.records.set("imap.example.test", ["127.0.0.1"]);
    await saveBankMailbox(
      actor(id),
      own({ host: "imap.example.test", port: String(imap.port) }),
      allowPrivate(),
    );
    await expect(testBankMailbox(actor(id), strict())).rejects.toThrow(BLOCKED);
    expect(imap.logins).toEqual([]);
  });

  test("[SEC-007] port 22 je pro IMAP odmítnutý, 993 a 143 projdou, SMTP porty ne", async () => {
    dns.records.set("imap.example.test", ["8.8.8.8"]);
    const attempt = (port: string, tls = "implicit") =>
      saveBankMailbox(actor(seed()), own({ host: "imap.example.test", port, tls }), strict());

    await expect(attempt("22")).rejects.toThrow(BLOCKED);
    await expect(attempt("587")).rejects.toThrow(BLOCKED);
    await expect(attempt("465")).rejects.toThrow(BLOCKED);
    await expect(attempt("993")).resolves.toBeUndefined();
    await expect(attempt("143", "starttls")).resolves.toBeUndefined();
  });

  test("[SEC-007] změna DNS po uložení odmítne spojení a jde se na ověřenou IP", async () => {
    const id = seed();
    dns.records.set("imap.example.test", ["127.0.0.1"]);
    await saveBankMailbox(
      actor(id),
      own({ host: "imap.example.test", port: String(imap.port) }),
      allowPrivate(),
    );

    await testBankMailbox(actor(id), allowPrivate());
    expect(imap.logins).toHaveLength(1);

    dns.records.set("imap.example.test", ["8.8.8.8", "10.0.0.5"]);
    const connections = imap.connections();
    await expect(testBankMailbox(actor(id), strict())).rejects.toThrow(BLOCKED);
    expect(imap.connections()).toBe(connections);
  });

  test("[SEC-007] ALLOW_PRIVATE_MAIL_HOSTS povolí privátní cíl a jen pro něj nevyžaduje TLS", async () => {
    const id = seed();
    await expect(saveBankMailbox(actor(id), own(), strict())).rejects.toThrow(BLOCKED);

    await saveBankMailbox(actor(id), own(), allowPrivate());
    await testBankMailbox(actor(id), allowPrivate());
    expect(imap.logins).toEqual([{ username: "avizo", password: PASSWORD }]);

    dns.records.set("imap.example.test", ["8.8.8.8"]);
    await expect(
      saveBankMailbox(actor(id), own({ host: "imap.example.test", port: "1143" }), allowPrivate()),
    ).rejects.toThrow(BLOCKED);
  });

  test("dočasná chyba DNS se uživateli ukáže stejně jako trvalé zablokování", async () => {
    const id = seed();
    await saveBankMailbox(actor(id), own(), allowPrivate());
    const lookup = vi.spyOn(await import("node:dns/promises"), "lookup");
    lookup.mockRejectedValueOnce(Object.assign(new Error("DNS"), { code: "EAI_AGAIN" }));
    await expect(testBankMailbox(actor(id), allowPrivate())).rejects.toThrow(BLOCKED);
    lookup.mockRestore();
  });
});

describe("ukládání", () => {
  test("[BNK-001] uložení a test připojení proti testovacímu serveru", async () => {
    const id = seed();
    await saveBankMailbox(actor(id), own(), allowPrivate());

    expect(getBankMailbox(id)).toMatchObject({
      host: "127.0.0.1",
      port: imap.port,
      tls: "starttls",
      username: "avizo",
      folder: "INBOX",
      enabled: true,
      requireConfirmation: true,
      hasCredentials: true,
      verifiedAt: null,
      failureCode: null,
    });

    setClockForTests({ now: () => T0 });
    await testBankMailbox(actor(id), allowPrivate());

    expect(getBankMailbox(id)?.verifiedAt).toEqual(T0);
    expect(imap.logins).toEqual([{ username: "avizo", password: PASSWORD }]);
  });

  test("test otevře složku jen ke čtení a cizí zprávu nestáhne", async () => {
    const id = seed();
    imap.addMessage("From: jiny@example.cz\r\nSubject: s\r\n\r\ntelo\r\n");
    await saveBankMailbox(actor(id), own(), allowPrivate());

    await testBankMailbox(actor(id), allowPrivate());

    const verbs = imap.commands.map((command) => command.split(" ")[0]);
    expect(verbs).toContain("EXAMINE");
    expect(verbs).not.toContain("SELECT");
    expect(verbs).not.toContain("STORE");
    expect(imap.commands.join("\n")).not.toMatch(/BODY/i);
  });

  test("[BNK-001] chybná složka se uloží prázdná jako INBOX a cizí složka projde testem jen když existuje", async () => {
    const id = seed();
    await saveBankMailbox(actor(id), own({ folder: "Neexistuje" }), allowPrivate());
    await expect(testBankMailbox(actor(id), allowPrivate())).rejects.toThrow(GENERIC);

    await saveBankMailbox(actor(id), own({ folder: "" }), allowPrivate());
    expect(row(id)?.folder).toBe("INBOX");
    await testBankMailbox(actor(id), allowPrivate());
  });

  test.each([
    ["hostitele", { host: "localhost" }],
    ["portu", { port: "1144" }],
    ["šifrování", { tls: "implicit" }],
    ["uživatele", { username: "jiny" }],
  ])("[BNK-001] změna %s bez nového hesla je odmítnutá a heslo zůstane", async (_name, change) => {
    const id = seed();
    const env = allowPrivate();
    await saveBankMailbox(actor(id), own(), env);
    const before = row(id);

    await expect(saveBankMailbox(actor(id), own({ ...change, password: "" }), env)).rejects.toThrow(
      "Při změně serveru, portu, šifrování nebo uživatele zadejte heslo znovu",
    );
    expect(row(id)).toEqual(before);

    await saveBankMailbox(actor(id), own(change), env);
    expect(row(id)?.passwordEnc).not.toBe(before?.passwordEnc);
  });

  test("prázdné heslo zachová stávající a nastavení bez hesla se neuloží", async () => {
    const id = seed();
    const env = allowPrivate();
    await expect(saveBankMailbox(actor(id), own({ password: "" }), env)).rejects.toThrow(
      "Zadejte heslo",
    );
    expect(row(id)).toBeUndefined();

    await saveBankMailbox(actor(id), own(), env);
    const before = row(id)?.passwordEnc;
    await saveBankMailbox(actor(id), own({ password: "", enabled: false }), env);
    expect(row(id)?.passwordEnc).toBe(before);
    expect(row(id)?.enabled).toBe(false);
  });

  test("neplatné vstupy odmítne schéma na serveru", async () => {
    const id = seed();
    for (const bad of [
      own({ host: "" }),
      own({ port: "" }),
      own({ port: "70000" }),
      own({ tls: "none" }),
      own({ username: "" }),
      own({ username: "a\r\nb" }),
      own({ folder: "a\r\nb" }),
      own({ enabled: "ano" }),
    ]) {
      await expect(saveBankMailbox(actor(id), bad, allowPrivate())).rejects.toThrow();
    }
    expect(row(id)).toBeUndefined();
  });

  test("změna složky nebo hostitele smaže pozici čtení, změna příznaků ne", async () => {
    const id = seed();
    const env = allowPrivate();
    await saveBankMailbox(actor(id), own(), env);
    db.update(bankMailbox)
      .set({ uidValidity: 7, lastUid: 42, firstReadAt: T0, failureCode: "auth", failures: 3 })
      .where(eq(bankMailbox.userId, id))
      .run();

    await saveBankMailbox(actor(id), own({ password: "", requireConfirmation: false }), env);
    expect(row(id)).toMatchObject({
      uidValidity: 7,
      lastUid: 42,
      failureCode: "auth",
      failures: 3,
    });

    await saveBankMailbox(actor(id), own({ folder: "Jina" }), env);
    expect(row(id)).toMatchObject({
      uidValidity: null,
      lastUid: null,
      firstReadAt: null,
      failureCode: null,
      failures: 0,
    });
  });

  test("výchozí potvrzení je zapnuté", async () => {
    const id = seed();
    db.insert(bankMailbox)
      .values({
        userId: id,
        host: "h",
        port: 993,
        tls: "implicit",
        username: "u",
        passwordEnc: encryptSecret("x"),
        updatedAt: T0,
      })
      .run();
    expect(row(id)).toMatchObject({ requireConfirmation: true, enabled: true, folder: "INBOX" });
  });
});

describe("chyby spojení", () => {
  test("[BNK-001] chyba přihlášení, sonda portu i chybějící složka mají jednu obecnou hlášku", async () => {
    const id = seed();
    const env = allowPrivate();
    await saveBankMailbox(actor(id), own(), env);

    imap.failNext("auth");
    const failures: string[] = [];
    const run = async () => {
      try {
        await testBankMailbox(actor(id), env);
      } catch (error) {
        failures.push((error as Error).message);
      }
    };
    await run();

    db.update(bankMailbox)
      .set({ passwordEnc: encryptSecret("spatne-heslo") })
      .where(eq(bankMailbox.userId, id))
      .run();
    await run();

    db.update(bankMailbox)
      .set({ passwordEnc: encryptSecret(PASSWORD), folder: "Neexistuje" })
      .where(eq(bankMailbox.userId, id))
      .run();
    await run();

    db.update(bankMailbox)
      .set({ folder: "INBOX", port: await freePort() })
      .where(eq(bankMailbox.userId, id))
      .run();
    await run();

    db.update(bankMailbox).set({ port: imap.port }).where(eq(bankMailbox.userId, id)).run();
    imap.failNext("drop");
    await run();

    expect(failures).toEqual([GENERIC, GENERIC, GENERIC, GENERIC, GENERIC]);
    expect(getBankMailbox(id)?.verifiedAt).toBeNull();
  });

  test("nečitelné uložené heslo skončí obecnou hláškou, ne výjimkou", async () => {
    const id = seed();
    await saveBankMailbox(actor(id), own(), allowPrivate());
    db.update(bankMailbox)
      .set({ passwordEnc: "v1.neplatne" })
      .where(eq(bankMailbox.userId, id))
      .run();

    await expect(testBankMailbox(actor(id), allowPrivate())).rejects.toThrow(GENERIC);
  });

  test("test bez nastavené schránky je odmítnutý", async () => {
    await expect(testBankMailbox(actor(seed()), allowPrivate())).rejects.toThrow(
      "Schránka není nastavená",
    );
  });
});

describe("tajemství a audit", () => {
  test("[SEC-003] heslo IMAP je v databázi šifrované a neopouští službu", async () => {
    const id = seed();
    await saveBankMailbox(actor(id), own(), allowPrivate());

    const stored = row(id);
    expect(stored?.passwordEnc).toMatch(/^v1\./);
    expect(JSON.stringify(stored)).not.toContain(PASSWORD);

    const view = getBankMailbox(id);
    expect(view?.hasCredentials).toBe(true);
    expect(JSON.stringify(view)).not.toContain(PASSWORD);
    expect(JSON.stringify(view)).not.toContain(stored?.passwordEnc);
  });

  test("[AUD-004] změna vyžadování potvrzení má vlastní auditní záznam", async () => {
    const id = seed();
    const env = allowPrivate();
    await saveBankMailbox(actor(id), own(), env);
    await saveBankMailbox(actor(id), own({ password: "", folder: "INBOX" }), env);
    const changes = () => audits(id).filter((item) => item.action === "bank_mailbox.confirmation");
    expect(changes()).toEqual([]);

    await saveBankMailbox(actor(id), own({ password: "", requireConfirmation: false }), env);
    expect(changes()).toMatchObject([
      { entity: "bank_mailbox", before: { requireConfirmation: true } },
    ]);
    expect(changes()[0]).toMatchObject({ after: { requireConfirmation: false } });

    await saveBankMailbox(actor(id), own({ password: "", requireConfirmation: false }), env);
    expect(changes()).toHaveLength(1);
    await saveBankMailbox(actor(id), own({ password: "", requireConfirmation: true }), env);
    expect(changes()).toHaveLength(2);
    expect(auditActionLabel("bank_mailbox.confirmation")).toBe(
      "Změna vyžadování potvrzení plateb z avíz",
    );
  });

  test("[AUD-004] nová schránka bez potvrzení se audituje jako změna výchozího stavu", async () => {
    const id = seed();
    await saveBankMailbox(actor(id), own({ requireConfirmation: false }), allowPrivate());
    expect(audits(id).map((item) => item.action)).toContain("bank_mailbox.confirmation");
  });

  test("test připojení neověří cíl, který se mezitím změnil", async () => {
    const id = seed();
    const env = allowPrivate();
    await saveBankMailbox(actor(id), own(), env);
    const login = imap.holdLogin();
    const testing = testBankMailbox(actor(id), env);
    await vi.waitFor(() => expect(imap.logins).toHaveLength(1));

    const other = await startImap();
    try {
      await saveBankMailbox(actor(id), own({ port: String(other.port) }), env);
      login.release();
      await expect(testing).rejects.toThrow(TEXTS.bankMailbox.errors.testFailed);
    } finally {
      await other.close();
    }
    expect(row(id)?.verifiedAt).toBeNull();
    expect(audits(id).map((item) => item.action)).not.toContain("bank_mailbox.test");
  });

  test("[AUD-004] heslo IMAP se nedostane do auditu", async () => {
    const id = seed();
    const env = allowPrivate();
    await saveBankMailbox(actor(id), own(), env);
    await saveBankMailbox(actor(id), own({ password: "", folder: "INBOX" }), env);
    await testBankMailbox(actor(id), env);
    clearBankMailbox(actor(id));

    const rows = audits(id).filter((item) => item.entity === "bank_mailbox");
    expect(rows.map((item) => item.action)).toEqual([
      "bank_mailbox.save",
      "bank_mailbox.save",
      "bank_mailbox.test",
      "bank_mailbox.clear",
    ]);
    const json = JSON.stringify(rows);
    expect(json).not.toContain(PASSWORD);
    expect(json).not.toContain("v1.");
    expect(JSON.parse(json)[0]).toMatchObject({
      before: { hasCredentials: false },
      after: {
        host: "127.0.0.1",
        port: imap.port,
        username: "avizo",
        hasCredentials: true,
        credentialsChanged: true,
      },
    });
    expect(JSON.parse(json)[1]).toMatchObject({
      after: { hasCredentials: true, credentialsChanged: false },
    });
    expect(JSON.parse(json)[3]).toMatchObject({
      before: { hasCredentials: true },
      after: { hasCredentials: false, credentialsChanged: false },
    });
  });

  test("klientovi nikdy nejde text serveru", async () => {
    const id = seed();
    await saveBankMailbox(actor(id), own({ password: "spatne" }), allowPrivate());
    const error = await testBankMailbox(actor(id), allowPrivate()).catch((e: unknown) => e);
    expect(String((error as Error).message)).not.toMatch(
      /AUTHENTICATIONFAILED|Authentication failed/,
    );
  });
});

describe("omezení", () => {
  test("[SEC-001] test schránky je omezený a překročení je v auditu", async () => {
    const id = seed();
    await saveBankMailbox(actor(id), own(), allowPrivate());
    db.insert(rateLimit)
      .values({
        key: `${RATE_RULES.bankTestUser.name}:${id}`,
        windowStart: new Date(),
        count: RATE_RULES.bankTestUser.limit,
      })
      .run();

    await expect(testBankMailbox(actor(id), allowPrivate())).rejects.toThrow("Příliš mnoho pokusů");

    expect(imap.logins).toEqual([]);
    expect(audits(id).filter((item) => item.action === "rate_limit.exceeded")).toHaveLength(1);
  });

  test("[SEC-001] ukládání a mazání schránky je omezené a překročení je v auditu", async () => {
    const id = seed();
    db.insert(rateLimit)
      .values({
        key: `${RATE_RULES.bankSaveUser.name}:${id}`,
        windowStart: new Date(),
        count: RATE_RULES.bankSaveUser.limit,
      })
      .run();

    await expect(saveBankMailbox(actor(id), own(), allowPrivate())).rejects.toThrow(
      "Příliš mnoho pokusů",
    );
    expect(() => clearBankMailbox(actor(id))).toThrow("Příliš mnoho pokusů");

    expect(row(id)).toBeUndefined();
    expect(audits(id).filter((item) => item.action === "rate_limit.exceeded")).toHaveLength(1);
  });

  test("akce mají vlastní limity", () => {
    expect(RATE_RULES.bankTestUser).toEqual({
      name: "bankTestUser",
      limit: 10,
      windowSeconds: 3600,
    });
    expect(RATE_RULES.bankCheckUser).toEqual({
      name: "bankCheckUser",
      limit: 10,
      windowSeconds: 60,
    });
    expect(RATE_RULES.bankSaveUser).toEqual({
      name: "bankSaveUser",
      limit: 30,
      windowSeconds: 3600,
    });
  });

  test("akce bez uživatele je odmítnutá", async () => {
    const nobody = { userId: null, source: "web" as const };
    await expect(saveBankMailbox(nobody, own(), allowPrivate())).rejects.toThrow(
      "Na tuto akci nemáte oprávnění",
    );
    await expect(testBankMailbox(nobody, allowPrivate())).rejects.toThrow(
      "Na tuto akci nemáte oprávnění",
    );
    expect(() => clearBankMailbox(nobody)).toThrow("Na tuto akci nemáte oprávnění");
  });
});

describe("izolace a účet", () => {
  test("[TST-009] izolace schránky včetně update a remove", async () => {
    const env = allowPrivate();
    await assertIsolated<string>({
      owners: [seed(), seed()],
      create: async (ownerId) => {
        await saveBankMailbox(actor(ownerId), own({ username: "avizo" }), env);
        return ownerId;
      },
      find: (ownerId, id) => {
        const view = getBankMailbox(ownerId);
        return view && id === ownerId ? view : null;
      },
      update: async (ownerId, id) => {
        await saveBankMailbox(
          actor(ownerId),
          own({ password: "", folder: "INBOX", enabled: false }),
          env,
        );
        return getBankMailbox(id)?.enabled === false ? 1 : 0;
      },
      remove: (ownerId, id) => {
        clearBankMailbox(actor(ownerId));
        return getBankMailbox(id) === null ? 1 : 0;
      },
    });
  });

  test("[TST-009] smazání účtu odstraní schránku", async () => {
    expect(USER_OWNED_TABLES).toContain(bankMailbox);
    const admin = seed();
    db.update(user).set({ role: "admin" }).where(eq(user.id, admin)).run();
    const id = seed();
    await saveBankMailbox(actor(id), own(), allowPrivate());

    deleteUser(actor(admin), id, `${id}@x.cz`);

    expect(row(id)).toBeUndefined();
  });
});

describe("sezení", () => {
  const settings = () => ({
    host: "127.0.0.1",
    port: imap.port,
    tls: "starttls" as const,
    username: "avizo",
    password: PASSWORD,
    folder: "INBOX",
  });

  function raw(subject: string, from = "automat@fio.cz") {
    return `From: Fio <${from}>\r\nTo: a@b.cz\r\nSubject: ${subject}\r\nMessage-ID: <${subject}@fio.cz>\r\nDate: Mon, 02 Nov 2026 10:00:00 +0000\r\n\r\ntelo ${subject}\r\n`;
  }

  test("čte přes EXAMINE a UID FETCH s PEEK a nic nezapisuje", async () => {
    imap.addMessage(raw("a"));
    imap.addMessage(raw("b"));
    const session = await openMailbox(settings(), allowPrivate());

    expect(session.uidValidity).toBe(1000);
    expect(await session.envelope(1)).toEqual({
      from: ["automat@fio.cz"],
      subject: "a",
      messageId: "<a@fio.cz>",
      date: new Date("2026-11-02T10:00:00Z"),
    });
    expect((await session.download(2, 10_000))?.toString()).toContain("telo b");
    await session.close();

    const text = imap.commands.join("\n");
    expect(text).toMatch(/^EXAMINE /m);
    expect(text).toContain("BODY.PEEK[]");
    for (const forbidden of [
      "SELECT",
      "STORE",
      "COPY",
      "MOVE",
      "EXPUNGE",
      "APPEND",
      "DELETE",
      "CREATE",
      "RENAME",
      "IDLE",
    ]) {
      expect(text, forbidden).not.toMatch(new RegExp(`(^|\\s)${forbidden}(\\s|$)`, "m"));
    }
    expect(text).not.toContain("\\Seen");
  });

  test("výpis od kurzoru vynechá starší zprávy, seřadí a respektuje limit a datum", async () => {
    imap.addMessage(raw("a"), new Date("2026-09-01T10:00:00Z"));
    imap.addMessage(raw("b"), new Date("2026-10-20T10:00:00Z"));
    imap.addMessage(raw("c"), new Date("2026-10-25T10:00:00Z"));
    const session = await openMailbox(settings(), allowPrivate());

    expect(await session.listSince(0, { limit: 10 })).toEqual([{ uid: 1 }, { uid: 2 }, { uid: 3 }]);
    expect(await session.listSince(0, { limit: 2 })).toEqual([{ uid: 1 }, { uid: 2 }]);
    expect(await session.listSince(1, { limit: 10 })).toEqual([{ uid: 2 }, { uid: 3 }]);
    expect(await session.listSince(3, { limit: 10 })).toEqual([]);
    expect(
      await session.listSince(0, { limit: 10, since: new Date("2026-10-01T00:00:00Z") }),
    ).toEqual([{ uid: 2 }, { uid: 3 }]);
    await session.close();
  });

  test("zpráva nad limit se nestáhne a neznámá zpráva vrátí null", async () => {
    imap.addMessage(raw("a") + "x".repeat(5000));
    const session = await openMailbox(settings(), allowPrivate());

    expect(await session.download(1, 1000)).toBeNull();
    expect((await session.download(1, 100_000))?.length).toBeGreaterThan(5000);
    expect(await session.download(99, 1000)).toBeNull();
    expect(await session.envelope(99)).toBeNull();
    await session.close();
  });

  test("změna UIDVALIDITY je vidět na sezení", async () => {
    imap.setUidValidity(2000);
    const session = await openMailbox(settings(), allowPrivate());
    expect(session.uidValidity).toBe(2000);
    await session.close();
  });
});

describe("server ověření", () => {
  const fioMail = (header: string) =>
    [
      header,
      "From: Fio banka <automat@fio.cz>",
      "Subject: Fio banka - new income on account",
      "",
      "Text",
    ].join("\r\n");

  test("[BNK-013] test připojení nabídne server z posledního avíza a nic neuloží", async () => {
    const id = seed();
    await saveBankMailbox(actor(id), own(), allowPrivate());
    imap.addMessage(fioMail("Authentication-Results: starsi.example.cz; none"));
    imap.addMessage(fioMail("Authentication-Results: MX.Example.cz; dkim=pass header.d=fio.cz"));
    imap.addMessage(
      "From: jiny@example.cz\r\nSubject: Ahoj\r\nAuthentication-Results: cizi.cz; none\r\n\r\nx",
    );

    await expect(testBankMailbox(actor(id), allowPrivate())).resolves.toEqual({
      suggestedAuthServId: "mx.example.cz",
    });
    expect(row(id)!.authServId).toBeNull();
    expect(imap.commands.filter((command) => /BODY/i.test(command))).toHaveLength(1);
  });

  test("[BNK-013] bez avíza se nic nenabízí", async () => {
    const id = seed();
    await saveBankMailbox(actor(id), own(), allowPrivate());
    await expect(testBankMailbox(actor(id), allowPrivate())).resolves.toEqual({
      suggestedAuthServId: null,
    });
  });

  test("[BNK-013] server se uloží malými písmeny, prázdný je null a jeden název", async () => {
    const id = seed();
    await saveBankMailbox(actor(id), own({ authServId: " MX.Example.cz " }), allowPrivate());
    expect(row(id)!.authServId).toBe("mx.example.cz");
    expect(getBankMailbox(id)!.authServId).toBe("mx.example.cz");

    await saveBankMailbox(actor(id), own({ authServId: "" }), allowPrivate());
    expect(row(id)!.authServId).toBeNull();
    expect(getBankMailbox(id)!.authServId).toBe("");

    await expect(
      saveBankMailbox(actor(id), own({ authServId: "a b" }), allowPrivate()),
    ).rejects.toThrow("jeden název");
  });

  function outage(id: string) {
    db.insert(notification)
      .values({
        id: randomUUID(),
        userId: id,
        kind: "bank_connection_failed",
        dedupeKey: `bank_connection:${randomUUID()}`,
        params: {},
        createdAt: T0,
      })
      .run();
    db.update(bankMailbox)
      .set({ failures: 4, failureCode: "auth" })
      .where(eq(bankMailbox.userId, id))
      .run();
  }
  const open = (id: string) =>
    db
      .select()
      .from(notification)
      .where(eq(notification.userId, id))
      .all()
      .filter((item) => item.resolvedAt === null);

  test("[BNK-015] vypnutí schránky vyřeší upozornění a vynuluje selhání", async () => {
    const id = seed();
    await saveBankMailbox(actor(id), own(), allowPrivate());
    outage(id);

    await saveBankMailbox(actor(id), own({ password: "", enabled: true }), allowPrivate());
    expect(open(id)).toHaveLength(1);
    expect(row(id)!.failures).toBe(4);

    await saveBankMailbox(actor(id), own({ password: "", enabled: false }), allowPrivate());
    expect(open(id)).toEqual([]);
    expect(row(id)).toMatchObject({ failures: 0, failureCode: null });
  });

  test("[BNK-015] smazání schránky vyřeší upozornění", async () => {
    const id = seed();
    await saveBankMailbox(actor(id), own(), allowPrivate());
    outage(id);

    clearBankMailbox(actor(id));

    expect(open(id)).toEqual([]);
  });
});
