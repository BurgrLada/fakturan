import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, ne } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { emailHash } from "@/server/audit/email-hash";
import { createAuth } from "@/server/auth";
import { setClockForTests } from "@/server/clock";
import { auditLog, instanceMeta, invitation, rateLimit, user } from "@/server/db/schema";
import { parseEnv } from "@/server/env";
import { RATE_RULES } from "@/server/rate-limit";
import {
  createInvitation,
  inspectInvitation,
  listInvitations,
  resendInvitation,
  revokeInvitation,
} from "@/server/services/invitations";
import { deleteUser } from "@/server/services/users";
import { Browser, BASE, fakeGithub, githubLogin, PASSWORD } from "../helpers/auth-browser";
import { createTestDb } from "../helpers/db";

const mail = vi.hoisted(() => ({
  configured: false,
  send: vi.fn(async (_msg: { to: string; subject: string; text: string }) => {}),
}));

vi.mock("@/server/mail/instance", () => ({
  isInstanceMailConfigured: () => mail.configured,
  sendInstanceMail: mail.send,
}));

const db = createTestDb();

const envValues = {
  DATA_DIR: mkdtempSync(join(tmpdir(), "fakturan-invite-")),
  BETTER_AUTH_URL: BASE,
  BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
};
for (const [key, value] of Object.entries(envValues)) vi.stubEnv(key, value);

const socialAuth = createAuth(
  parseEnv({ ...envValues, GITHUB_CLIENT_ID: "gh-id", GITHUB_CLIENT_SECRET: "gh-secret" }),
);

const DAY_MS = 86_400_000;
const ADMIN_ID = "admin-1";
const admin = { userId: ADMIN_ID, source: "web" } as const;

function seedUser(id: string, email: string, role = "user") {
  const now = new Date();
  db.insert(user).values({ id, name: id, email, role, createdAt: now, updatedAt: now }).run();
}

function tokenOf(url: string): string {
  return new URL(url).pathname.split("/").at(-1)!;
}

function row(email: string) {
  return db.select().from(invitation).where(eq(invitation.email, email)).get()!;
}

function auditRows(action: string) {
  return db.select().from(auditLog).where(eq(auditLog.action, action)).all();
}

async function signUpWith(token: string, email: string) {
  const browser = new Browser(socialAuth);
  browser.cookies.set("fakturan_invite", token);
  const res = await browser.request("/sign-up/email", {
    body: { name: "Host", email, password: PASSWORD },
  });
  return { browser, res };
}

beforeEach(() => {
  db.delete(rateLimit).run();
  db.delete(user).run();
  db.delete(invitation).run();
  db.delete(instanceMeta).run();
  seedUser(ADMIN_ID, "admin@example.cz", "admin");
  mail.configured = false;
  mail.send.mockReset();
});

afterEach(() => {
  setClockForTests(null);
  vi.unstubAllGlobals();
  for (const [key, value] of Object.entries(envValues)) vi.stubEnv(key, value);
});

describe("pozvánky", () => {
  test("[ADM-003] pozvánka platí 7 dní a odkaz funguje bez SMTP", async () => {
    const now = new Date("2026-11-01T10:00:00Z");
    setClockForTests({ now: () => now });

    const { url, mailSent } = await createInvitation(admin, "Host@Example.cz");

    expect(mailSent).toBe(false);
    expect(mail.send).not.toHaveBeenCalled();
    expect(url.startsWith(`${BASE}/pozvanka/`)).toBe(true);
    expect(row("host@example.cz").expiresAt.getTime()).toBe(now.getTime() + 7 * DAY_MS);
    expect(inspectInvitation(tokenOf(url))).toEqual({
      status: "valid",
      email: "host@example.cz",
      expiresAt: new Date(now.getTime() + 7 * DAY_MS),
    });
  });

  test("[ADM-003] v databázi ani auditu není token, jen jeho otisk", async () => {
    const { url } = await createInvitation(admin, "host@example.cz");
    const token = tokenOf(url);

    expect(row("host@example.cz").tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row("host@example.cz").tokenHash).not.toContain(token);
    expect(JSON.stringify(db.select().from(invitation).all())).not.toContain(token);
    expect(JSON.stringify(db.select().from(auditLog).all())).not.toContain(token);
    expect(auditRows("invitation.create").at(-1)).toMatchObject({
      actorId: ADMIN_ID,
      scope: "instance",
      after: { emailHash: emailHash("host@example.cz", parseEnv(envValues)), role: "user" },
    });
  });

  test("[ADM-003] se SMTP odejde e-mail s odkazem", async () => {
    mail.configured = true;

    const { url, mailSent } = await createInvitation(admin, "host@example.cz");

    expect(mailSent).toBe(true);
    expect(mail.send.mock.calls[0][0]).toMatchObject({ to: "host@example.cz" });
    expect(mail.send.mock.calls[0][0].text).toContain(url);
  });

  test("[ADM-003] selhání e-mailu pozvánku zachová a zapíše se do auditu", async () => {
    mail.configured = true;
    mail.send.mockRejectedValueOnce(new Error("smtp down"));

    const { url, mailSent } = await createInvitation(admin, "host@example.cz");

    expect(mailSent).toBe(false);
    expect(inspectInvitation(tokenOf(url)).status).toBe("valid");
    expect(auditRows("invitation.mail_failed").length).toBeGreaterThan(0);
  });

  test("[ADM-003] použitá a vypršelá pozvánka je odmítnuta s vysvětlením", async () => {
    const used = tokenOf((await createInvitation(admin, "pouzita@example.cz")).url);
    const { res } = await signUpWith(used, "pouzita@example.cz");
    expect(res.status).toBe(200);

    const expired = tokenOf((await createInvitation(admin, "stara@example.cz")).url);
    setClockForTests({ now: () => new Date(Date.now() + 8 * DAY_MS) });

    expect(inspectInvitation(used)).toEqual({ status: "used" });
    expect(inspectInvitation(expired)).toEqual({ status: "expired" });
    expect(inspectInvitation("neexistuje")).toEqual({ status: "unknown" });
    expect((await signUpWith(expired, "stara@example.cz")).res.status).toBe(400);
  });

  test("[ADM-003] zrušená pozvánka přestane platit", async () => {
    const token = tokenOf((await createInvitation(admin, "host@example.cz")).url);

    revokeInvitation(admin, row("host@example.cz").id);

    expect(inspectInvitation(token)).toEqual({ status: "revoked" });
    expect((await signUpWith(token, "host@example.cz")).res.status).toBe(400);
    expect(auditRows("invitation.revoke").at(-1)).toMatchObject({ actorId: ADMIN_ID });
  });

  test("[ADM-003] opětovné odeslání vydá nový odkaz a starý zneplatní", async () => {
    const first = await createInvitation(admin, "host@example.cz");
    setClockForTests({ now: () => new Date(Date.now() + 8 * DAY_MS) });

    const second = await resendInvitation(admin, row("host@example.cz").id);

    expect(second.url).not.toBe(first.url);
    expect(inspectInvitation(tokenOf(first.url)).status).toBe("unknown");
    expect(inspectInvitation(tokenOf(second.url)).status).toBe("valid");
    expect(auditRows("invitation.resend").at(-1)).toMatchObject({ actorId: ADMIN_ID });
  });

  test("[ADM-003] přijatou ani zrušenou pozvánku nejde znovu odeslat", async () => {
    await createInvitation(admin, "host@example.cz");
    const { id } = row("host@example.cz");
    revokeInvitation(admin, id);

    await expect(resendInvitation(admin, id)).rejects.toThrow("už neplatí");
    expect(() => revokeInvitation(admin, id)).toThrow("už neplatí");
  });

  test("[ADM-003] druhá pozvánka na stejný e-mail ani pozvánka člena neprojde", async () => {
    await createInvitation(admin, "host@example.cz");

    await expect(createInvitation(admin, "HOST@example.cz")).rejects.toThrow("už má");
    await expect(createInvitation(admin, "admin@example.cz")).rejects.toThrow("už existuje");
  });

  test("[ADM-003] opětovné odeslání neobejde člena ani jinou platnou pozvánku", async () => {
    await createInvitation(admin, "host@example.cz");
    const { id: staleId } = row("host@example.cz");
    const later = new Date(Date.now() + 8 * DAY_MS);
    setClockForTests({ now: () => later });
    await createInvitation(admin, "HOST@example.cz");

    await expect(resendInvitation(admin, staleId)).rejects.toThrow("už má");

    db.delete(invitation).where(ne(invitation.id, staleId)).run();
    seedUser("user-2", "host@example.cz");
    await expect(resendInvitation(admin, staleId)).rejects.toThrow("už existuje");
  });

  test("[ADM-003] přehled ukáže čekající pozvánky bez otisku tokenu", async () => {
    await createInvitation(admin, "host@example.cz");

    const rows = listInvitations(admin);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: "host@example.cz", expired: false });
    expect(rows[0]).not.toHaveProperty("tokenHash");
  });

  test("[SEC-001] pozvánky jsou omezené na administrátora a hodinu", async () => {
    for (let i = 0; i < RATE_RULES.invitationsUser.limit; i += 1) {
      await createInvitation(admin, `host${i}@example.cz`);
    }

    await expect(createInvitation(admin, "dalsi@example.cz")).rejects.toThrow("Příliš mnoho");
    await expect(createInvitation(admin, "treti@example.cz")).rejects.toThrow("Příliš mnoho");
    expect(row("host0@example.cz")).toBeDefined();
    expect(
      auditRows("rate_limit.exceeded").filter(
        (r) => (r.after as { rule?: string }).rule === "invitationsUser",
      ),
    ).toHaveLength(1);
  });

  test("[ADM-001] pozvánky spravuje jen administrátor", async () => {
    seedUser("user-1", "user@example.cz");
    const plain = { userId: "user-1", source: "web" } as const;

    await expect(createInvitation(plain, "host@example.cz")).rejects.toThrow("oprávnění");
    expect(() => listInvitations(plain)).toThrow("oprávnění");
    expect(db.select().from(invitation).all()).toHaveLength(0);
  });

  test("[AUTH-007] pozvánka přes odkaz propojí účet s jiným e-mailem", async () => {
    const token = tokenOf((await createInvitation(admin, "skutecny@example.cz")).url);
    fakeGithub("abc123@privaterelay.appleid.com");
    const browser = new Browser(socialAuth);
    browser.cookies.set("fakturan_invite", token);

    await githubLogin(browser);

    expect(await browser.sessionUser()).toMatchObject({
      email: "abc123@privaterelay.appleid.com",
      role: "user",
    });
    expect(inspectInvitation(token)).toEqual({ status: "used" });
  });

  test("[AUTH-007] pozvánka zná přijatý účet a smaže se i při jiném e-mailu", async () => {
    await createInvitation(admin, "skutecny@example.cz");
    const token = tokenOf((await resendInvitation(admin, row("skutecny@example.cz").id)).url);
    fakeGithub("relay@privaterelay.appleid.com");
    const browser = new Browser(socialAuth);
    browser.cookies.set("fakturan_invite", token);
    await githubLogin(browser);
    const created = (await browser.sessionUser())!;

    expect(row("skutecny@example.cz").acceptedUserId).toBe(created.id);
    expect(auditRows("invitation.accept").at(-1)).toMatchObject({ ownerId: created.id });

    deleteUser(admin, created.id, "relay@privaterelay.appleid.com");

    expect(db.select().from(invitation).all()).toEqual([]);
  });

  test("[AUD-010] audit pozvánek drží klíčovaný otisk místo e-mailu", async () => {
    const { url } = await createInvitation(admin, "host@example.cz");
    await signUpWith(tokenOf(url), "host@example.cz");

    for (const action of ["invitation.create", "invitation.accept"]) {
      const last = auditRows(action).at(-1)!;
      expect(last.after).toMatchObject({
        emailHash: emailHash("host@example.cz", parseEnv(envValues)),
      });
      expect(JSON.stringify(last.after)).not.toContain("host@example.cz");
    }
  });
});
