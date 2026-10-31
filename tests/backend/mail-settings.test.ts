import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { setClockForTests } from "@/server/clock";
import { encryptSecret } from "@/server/crypto";
import { auditLog, mailSettings, rateLimit, user } from "@/server/db/schema";
import { parseEnv } from "@/server/env";
import { BlockedHostError } from "@/server/mail/host-guard";
import { ServiceError } from "@/server/services/access";
import {
  clearOwnSmtp,
  getMailSettings,
  mailAvailability,
  resolveTransport,
  saveMailSettings,
  sendTestMail,
} from "@/server/services/mail-settings";
import { deleteUser, USER_OWNED_TABLES } from "@/server/services/users";
import { RATE_RULES } from "@/server/rate-limit";
import { createTestDb } from "../helpers/db";
import { assertIsolated } from "../helpers/isolation";
import { startSmtp, type TestSmtp } from "../helpers/smtp";

const dns = vi.hoisted(() => ({ records: new Map<string, string[]>() }));

vi.mock("node:dns/promises", () => ({
  lookup: async (host: string) =>
    (dns.records.get(host) ?? [host]).map((address) => ({ address, family: 4 })),
}));

vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-mail-settings-")));
vi.stubEnv("SMTP_HOST", "");
vi.stubEnv("SMTP_PORT", "");
vi.stubEnv("SMTP_FROM", "");
vi.stubEnv("SMTP_USER", "");
vi.stubEnv("SMTP_PASSWORD", "");

const db = createTestDb();
const T0 = new Date("2026-11-02T10:00:00Z");
const PASSWORD = "tajne-heslo-smtp-9f3a";
const actor = (userId: string) => ({ userId, source: "web" as const });
const envWith = (over: Record<string, string> = {}) => parseEnv({ ...process.env, ...over });
const allowPrivate = () => envWith({ ALLOW_PRIVATE_MAIL_HOSTS: "true" });

let smtp: TestSmtp;
let instance: TestSmtp;
const instanceEnv = (over: Record<string, string> = {}) =>
  envWith({
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: String(instance.port),
    SMTP_FROM: "fakturan@example.cz",
    ...over,
  });

beforeAll(async () => {
  smtp = await startSmtp();
  instance = await startSmtp();
});
afterAll(async () => {
  await smtp.stop();
  await instance.stop();
});
beforeEach(() => {
  dns.records.clear();
  smtp.messages.length = 0;
  instance.messages.length = 0;
  smtp.logins.length = 0;
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
  smtpHost: "127.0.0.1",
  smtpPort: String(smtp.port),
  smtpUser: "",
  smtpPassword: "",
  fromEmail: "jan@firma.cz",
  senderName: "",
  replyTo: "",
  cc: "",
  bcc: "",
  ...over,
});

const row = (id: string) => db.select().from(mailSettings).where(eq(mailSettings.userId, id)).get();
const audits = (ownerId: string) =>
  db.select().from(auditLog).where(eq(auditLog.ownerId, ownerId)).all();

async function sendSample(id: string, env = allowPrivate()) {
  const transport = await resolveTransport(id, env);
  if (!transport) throw new Error("transport chybí");
  return transport.send({
    ...transport.identity,
    to: "klient@example.cz",
    subject: "Předmět",
    text: "Text",
  });
}

describe("ukládání", () => {
  test("[SEC-006] neplatné vstupy odmítne schéma na serveru", async () => {
    const id = seed();
    for (const bad of [
      own({ fromEmail: "" }),
      own({ fromEmail: "neni-adresa" }),
      own({ smtpPort: "" }),
      own({ smtpPort: "70000" }),
      own({ replyTo: "x" }),
      own({ cc: "a@example.cz, nic" }),
      own({ senderName: "Jan\r\nBcc: a@example.cz" }),
      own({ smtpHost: "a\nb" }),
      "ne",
      null,
    ]) {
      await expect(saveMailSettings(actor(id), bad, allowPrivate())).rejects.toBeInstanceOf(
        ServiceError,
      );
    }
    expect(row(id)).toBeUndefined();
  });

  test("[SEC-007] privátní hostitel je při uložení odmítnutý", async () => {
    const id = seed();
    await expect(saveMailSettings(actor(id), own(), envWith())).rejects.toThrow(
      "Tento server pošty není povolený",
    );
    expect(row(id)).toBeUndefined();
  });

  test("[SEC-003] heslo je v databázi šifrované a neopouští službu", async () => {
    const id = seed();
    await saveMailSettings(
      actor(id),
      own({ smtpUser: "jan", smtpPassword: PASSWORD }),
      allowPrivate(),
    );

    const stored = row(id);
    expect(stored?.smtpPasswordEnc).toMatch(/^v1\./);
    expect(JSON.stringify(stored)).not.toContain(PASSWORD);

    const settings = getMailSettings(id);
    expect(settings.hasCredentials).toBe(true);
    expect(JSON.stringify(settings)).not.toContain(PASSWORD);
    expect(JSON.stringify(settings)).not.toContain(stored?.smtpPasswordEnc);
    expect(JSON.stringify(await resolveTransport(id, allowPrivate()))).not.toContain(PASSWORD);
  });

  test("prázdné heslo zachová stávající, účet bez jména heslo zahodí", async () => {
    const id = seed();
    const env = allowPrivate();
    await saveMailSettings(actor(id), own({ smtpUser: "jan", smtpPassword: PASSWORD }), env);
    const before = row(id)?.smtpPasswordEnc;

    await saveMailSettings(actor(id), own({ smtpUser: "jan", senderName: "Jan" }), env);
    expect(row(id)?.smtpPasswordEnc).toBe(before);

    await saveMailSettings(actor(id), own(), env);
    expect(row(id)?.smtpPasswordEnc).toBeNull();
    expect(getMailSettings(id).hasCredentials).toBe(false);
  });

  test("uživatel bez hesla a bez uloženého hesla je odmítnutý", async () => {
    const id = seed();
    await expect(
      saveMailSettings(actor(id), own({ smtpUser: "jan" }), allowPrivate()),
    ).rejects.toBeInstanceOf(ServiceError);
  });

  test("změna spojení zruší ověření, změna jména ne", async () => {
    const id = seed();
    const env = allowPrivate();
    await saveMailSettings(actor(id), own(), env);
    await sendTestMail(actor(id), env);
    expect(getMailSettings(id).verifiedAt).toBeInstanceOf(Date);

    await saveMailSettings(actor(id), own({ senderName: "Jan" }), env);
    expect(getMailSettings(id).verifiedAt).toBeInstanceOf(Date);

    await saveMailSettings(actor(id), own({ fromEmail: "jiny@firma.cz" }), env);
    expect(getMailSettings(id).verifiedAt).toBeNull();
  });

  test("[AUD-004] heslo SMTP se nedostane do auditu", async () => {
    const id = seed();
    const env = allowPrivate();
    await saveMailSettings(actor(id), own({ smtpUser: "jan", smtpPassword: PASSWORD }), env);
    await saveMailSettings(actor(id), own({ smtpUser: "jan", senderName: "Jan" }), env);
    await sendTestMail(actor(id), env);
    clearOwnSmtp(actor(id));

    const rows = audits(id).filter((item) => item.entity === "mail_settings");
    expect(rows.map((item) => item.action)).toEqual([
      "mail_settings.save",
      "mail_settings.save",
      "mail_settings.test",
      "mail_settings.clear",
    ]);
    const json = JSON.stringify(rows);
    expect(json).not.toContain(PASSWORD);
    expect(json).not.toContain("v1.");
    expect(JSON.parse(json)[0]).toMatchObject({
      after: { host: "127.0.0.1", port: smtp.port, hasCredentials: true },
    });
  });
});

describe("výběr transportu", () => {
  test("[SET-050] vlastní SMTP přebije instanční", async () => {
    const id = seed();
    const env = instanceEnv({ ALLOW_PRIVATE_MAIL_HOSTS: "true" });
    expect(mailAvailability(id, env)).toEqual({ available: true, source: "instance" });

    await saveMailSettings(actor(id), own(), env);

    expect(mailAvailability(id, env)).toEqual({ available: true, source: "user" });
    await sendSample(id, env);
    expect((await smtp.waitFor("klient@example.cz")).raw).toContain("jan@firma.cz");
    expect(instance.messages).toEqual([]);
  });

  test("bez vlastního i instančního SMTP není pošta dostupná", async () => {
    const id = seed();
    expect(mailAvailability(id, envWith())).toEqual({ available: false, source: null });
    expect(await resolveTransport(id, envWith())).toBeNull();
  });

  test("selhání dešifrování je null, ne pád", async () => {
    const id = seed();
    const env = instanceEnv({ ALLOW_PRIVATE_MAIL_HOSTS: "true" });
    await saveMailSettings(actor(id), own({ smtpUser: "jan", smtpPassword: PASSWORD }), env);
    db.update(mailSettings)
      .set({ smtpPasswordEnc: `${encryptSecret("x").slice(0, -4)}AAAA` })
      .where(eq(mailSettings.userId, id))
      .run();

    expect(await resolveTransport(id, env)).toBeNull();
    expect(mailAvailability(id, env)).toEqual({ available: false, source: null });
  });

  test("[SEC-007] změna DNS po uložení odmítne spojení, jde se na ověřenou IP", async () => {
    const id = seed();
    dns.records.set("smtp.firma.test", ["127.0.0.1"]);
    await saveMailSettings(actor(id), own({ smtpHost: "smtp.firma.test" }), allowPrivate());

    await sendSample(id);
    expect(smtp.messages).toHaveLength(1);

    const transport = await resolveTransport(id, envWith());
    dns.records.set("smtp.firma.test", ["8.8.8.8", "10.0.0.1"]);
    await expect(
      transport?.send({
        ...transport.identity,
        to: "klient@example.cz",
        subject: "s",
        text: "t",
      }),
    ).rejects.toBeInstanceOf(BlockedHostError);
    expect(smtp.messages).toHaveLength(1);
  });

  test("[SEC-003] heslo se dešifruje jen pro přihlášení k serveru", async () => {
    const id = seed();
    await saveMailSettings(
      actor(id),
      own({ smtpUser: "jan", smtpPassword: PASSWORD }),
      allowPrivate(),
    );

    await sendSample(id);

    expect(smtp.logins).toEqual([{ username: "jan", password: PASSWORD }]);
  });

  test("[SET-054] jméno, Reply-To, Cc a Bcc jsou ve zprávě", async () => {
    const id = seed();
    await saveMailSettings(
      actor(id),
      own({
        senderName: "Jan Novák",
        replyTo: "odpovedi@firma.cz",
        cc: "kopie@firma.cz",
        bcc: "archiv@firma.cz, ucetni@firma.cz",
      }),
      allowPrivate(),
    );

    await sendSample(id);

    const mail = await smtp.waitFor("klient@example.cz");
    expect(mail.to.toSorted()).toEqual([
      "archiv@firma.cz",
      "klient@example.cz",
      "kopie@firma.cz",
      "ucetni@firma.cz",
    ]);
    expect(mail.raw).toMatch(/^From: .*<jan@firma\.cz>/m);
    expect(mail.raw).toContain("Reply-To: odpovedi@firma.cz");
    expect(mail.raw).toContain("Cc: kopie@firma.cz");
    expect(mail.raw).not.toMatch(/^Bcc:/m);
    expect(mail.raw).not.toContain("archiv@firma.cz");
  });

  test("[SET-054] u instančního SMTP je adresa SMTP_FROM a jméno z účtu", async () => {
    const id = seed();
    await saveMailSettings(
      actor(id),
      own({ smtpHost: "", smtpPort: "", fromEmail: "", senderName: "Jan", replyTo: "o@firma.cz" }),
      envWith(),
    );
    const env = instanceEnv({ SMTP_FROM: "Fakturan <fakturan@example.cz>" });

    const transport = await resolveTransport(id, env);

    expect(transport?.source).toBe("instance");
    expect(transport?.identity).toEqual({
      from: { name: "Jan", address: "fakturan@example.cz" },
      replyTo: "o@firma.cz",
      cc: [],
      bcc: [],
    });
  });

  test("instanční SMTP se kontrole hostitele nepodrobuje", async () => {
    const id = seed();
    await sendSample(id, instanceEnv());
    expect(instance.messages).toHaveLength(1);
  });
});

describe("zkušební zpráva", () => {
  test("[SET-051] test odejde na e-mail účtu a klient nic nedostane", async () => {
    const id = seed();
    const env = allowPrivate();
    await saveMailSettings(
      actor(id),
      own({ cc: "klient@example.cz", bcc: "jiny-klient@example.cz" }),
      env,
    );

    await sendTestMail(actor(id), env);

    expect(smtp.messages.flatMap((mail) => mail.to)).toEqual([`${id}@x.cz`]);
    expect(row(id)?.verifiedAt).toBeInstanceOf(Date);
  });

  test("[SET-051] selhání má obecnou hlášku bez odpovědi serveru a zablokovaný hostitel vlastní", async () => {
    const id = seed();
    const env = allowPrivate();
    await saveMailSettings(actor(id), own(), env);

    smtp.rejectNext(550);
    await expect(sendTestMail(actor(id), env)).rejects.toThrow(
      "Zkušební e-mail se nepodařilo odeslat",
    );
    expect(row(id)?.verifiedAt).toBeNull();

    await expect(sendTestMail(actor(id), envWith())).rejects.toThrow(
      "Tento server pošty není povolený",
    );
  });

  test("[SET-052] smazání vrátí instanční SMTP a jméno odesílatele zůstane", async () => {
    const id = seed();
    const env = instanceEnv({ ALLOW_PRIVATE_MAIL_HOSTS: "true" });
    await saveMailSettings(
      actor(id),
      own({ smtpUser: "jan", smtpPassword: PASSWORD, senderName: "Jan Novák" }),
      env,
    );

    clearOwnSmtp(actor(id));

    expect(row(id)).toMatchObject({
      smtpHost: null,
      smtpPort: null,
      smtpUser: null,
      smtpPasswordEnc: null,
      fromEmail: null,
      verifiedAt: null,
      senderName: "Jan Novák",
    });
    expect(mailAvailability(id, env)).toEqual({ available: true, source: "instance" });
    expect((await resolveTransport(id, env))?.identity.from).toEqual({
      name: "Jan Novák",
      address: "fakturan@example.cz",
    });
  });

  test("[SEC-001] test SMTP je omezený a překročení je v auditu", async () => {
    const id = seed();
    const env = allowPrivate();
    await saveMailSettings(actor(id), own(), env);
    db.insert(rateLimit)
      .values({
        key: `${RATE_RULES.sendUser.name}:${id}`,
        windowStart: new Date(),
        count: RATE_RULES.sendUser.limit,
      })
      .run();

    await expect(sendTestMail(actor(id), env)).rejects.toThrow("Příliš mnoho pokusů");

    expect(smtp.messages).toEqual([]);
    expect(audits(id).filter((item) => item.action === "rate_limit.exceeded")).toHaveLength(1);
  });

  test("hromadné odesílání má vlastní limit", () => {
    expect(RATE_RULES.sendBulkUser).toEqual({
      name: "sendBulkUser",
      limit: 5,
      windowSeconds: 3600,
    });
  });
});

describe("izolace a účet", () => {
  test("[TST-009] izolace nastavení pošty", async () => {
    const env = allowPrivate();
    await assertIsolated<string>({
      owners: [seed(), seed()],
      create: async (ownerId) => {
        await saveMailSettings(actor(ownerId), own({ fromEmail: `${ownerId}@firma.cz` }), env);
        return ownerId;
      },
      find: (ownerId, id) => {
        const settings = getMailSettings(ownerId);
        return settings.fromEmail === `${id}@firma.cz` ? settings : null;
      },
      update: async (ownerId, id) => {
        const marker = randomUUID();
        await saveMailSettings(
          actor(ownerId),
          own({ fromEmail: `${ownerId}@firma.cz`, senderName: marker }),
          env,
        );
        return getMailSettings(id).senderName === marker ? 1 : 0;
      },
      remove: (ownerId, id) => {
        clearOwnSmtp(actor(ownerId));
        return getMailSettings(id).smtpHost === null ? 1 : 0;
      },
    });
  });

  test("[TST-009] smazání účtu odstraní nastavení pošty", async () => {
    expect(USER_OWNED_TABLES).toContain(mailSettings);
    const admin = seed();
    db.update(user).set({ role: "admin" }).where(eq(user.id, admin)).run();
    const id = seed();
    await saveMailSettings(actor(id), own(), allowPrivate());

    deleteUser(actor(admin), id, `${id}@x.cz`);

    expect(row(id)).toBeUndefined();
  });

  test("akce bez uživatele je odmítnutá", async () => {
    const nobody = { userId: null, source: "web" as const };
    await expect(saveMailSettings(nobody, own(), allowPrivate())).rejects.toBeInstanceOf(
      ServiceError,
    );
    await expect(sendTestMail(nobody, allowPrivate())).rejects.toBeInstanceOf(ServiceError);
    expect(() => clearOwnSmtp(nobody)).toThrow(ServiceError);
  });
});
