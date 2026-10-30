import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { decodeJwt, decodeProtectedHeader, exportPKCS8, generateKeyPair } from "jose";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { createAuth } from "@/server/auth";
import { appleClientSecret, enabledProviders } from "@/server/auth/providers";
import { canRegister, isSignupOpen } from "@/server/auth/signup-guard";
import { setClockForTests } from "@/server/clock";
import {
  auditLog,
  instanceMeta,
  invitation,
  session,
  user,
  verification,
} from "@/server/db/schema";
import { parseEnv, type Env } from "@/server/env";
import { isInstanceMailConfigured, sendInstanceMail } from "@/server/mail/instance";
import { createTestDb } from "../helpers/db";
import { startSmtp, type TestSmtp } from "../helpers/smtp";

const db = createTestDb();

const BASE = "http://localhost:3000";
const PASSWORD = "správné-kůň-baterie-sponka";
const dataDir = mkdtempSync(join(tmpdir(), "fakturan-auth-"));

function testEnv(extra: Record<string, string> = {}): Env {
  return parseEnv({
    DATA_DIR: dataDir,
    BETTER_AUTH_URL: BASE,
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
    ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    ...extra,
  });
}

type Auth = ReturnType<typeof createAuth>;

class Browser {
  cookies = new Map<string, string>();

  constructor(readonly auth: Auth) {}

  async request(path: string, init: { method?: string; body?: unknown; ua?: string } = {}) {
    const headers: Record<string, string> = {
      origin: BASE,
      cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
      "user-agent": init.ua ?? "vitest",
    };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    const res = await this.auth.handler(
      new Request(`${BASE}/api/auth${path}`, {
        method: init.method ?? (init.body === undefined ? "GET" : "POST"),
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        redirect: "manual",
      }),
    );
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const eq = pair.indexOf("=");
      const [name, value] = [pair.slice(0, eq), pair.slice(eq + 1)];
      if (value === "" || /max-age=0/i.test(line)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return res;
  }

  signUp(email: string, password = PASSWORD) {
    return this.request("/sign-up/email", { body: { name: "Jan", email, password } });
  }

  signIn(email: string, password = PASSWORD) {
    return this.request("/sign-in/email", { body: { email, password } });
  }

  async sessionUser(): Promise<{ id: string; email: string; role: string } | null> {
    const res = await this.request("/get-session");
    return ((await res.json()) as { user: never } | null)?.user ?? null;
  }
}

function auditRows(action: string) {
  return db.select().from(auditLog).where(eq(auditLog.action, action)).all();
}

function userCount(): number {
  return (
    db
      .select({ n: sql<number>`count(*)` })
      .from(user)
      .get()?.n ?? 0
  );
}

function roleOf(email: string) {
  return db.select().from(user).where(eq(user.email, email)).get()?.role;
}

function insertInvite(fields: Partial<typeof invitation.$inferInsert> = {}) {
  const token = crypto.randomUUID();
  const now = Date.now();
  db.insert(invitation)
    .values({
      id: crypto.randomUUID(),
      email: "pozvany@example.cz",
      tokenHash: createHash("sha256").update(token).digest("hex"),
      role: "user",
      createdAt: new Date(now),
      expiresAt: new Date(now + 7 * 86_400_000),
      ...fields,
    })
    .run();
  return token;
}

function fakeGithub(email: string, verified = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/login/oauth/access_token")) {
        return Response.json({
          access_token: "gh-token",
          token_type: "bearer",
          scope: "user:email",
        });
      }
      if (url.endsWith("/user/emails")) {
        return Response.json([{ email, primary: true, verified, visibility: "public" }]);
      }
      if (url.endsWith("/user")) {
        return Response.json({ id: 4242, login: "jan", name: "Jan", email, avatar_url: "" });
      }
      throw new Error(`Neočekávaný požadavek ${url}`);
    }),
  );
}

async function githubLogin(browser: Browser) {
  const start = await browser.request("/sign-in/social", {
    body: { provider: "github", callbackURL: "/" },
  });
  const { url } = (await start.json()) as { url: string };
  const state = new URL(url).searchParams.get("state")!;
  return browser.request(`/callback/github?code=kod&state=${encodeURIComponent(state)}`);
}

async function createAdmin(auth: Auth, email = "admin@example.cz") {
  const browser = new Browser(auth);
  await browser.signUp(email);
  return browser;
}

const plainAuth = createAuth(testEnv());

beforeEach(() => {
  db.delete(user).run();
  db.delete(verification).run();
  db.delete(invitation).run();
  db.delete(instanceMeta).run();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setClockForTests(null);
});

describe("první účet a uzavřená registrace", () => {
  test("[AUTH-001] první účet je admin a registrace se zavře", async () => {
    const first = new Browser(plainAuth);
    expect(isSignupOpen(db)).toBe(true);

    const res = await first.signUp("prvni@example.cz");

    expect(res.status).toBe(200);
    expect(await first.sessionUser()).toMatchObject({ email: "prvni@example.cz", role: "admin" });
    expect(isSignupOpen(db)).toBe(false);
    expect((await new Browser(plainAuth).signUp("druhy@example.cz")).status).toBe(400);
    expect(userCount()).toBe(1);
  });

  test("[AUTH-001] dvě souběžné první registrace vytvoří jediného admina", async () => {
    // Without the delay the insert follows the guard within a microtask and the race never opens.
    // Plugin hooks run before ours, so only the insert itself can sit between guard and commit.
    const realInsert = db.insert.bind(db);
    const spy = vi.spyOn(db, "insert").mockImplementation(((table: typeof user) => {
      const builder = realInsert(table);
      if (table !== user) return builder;
      return {
        values: (row: typeof user.$inferInsert) => ({
          returning: async () => {
            await new Promise((resolve) => setTimeout(resolve, 400));
            return builder.values(row).returning();
          },
        }),
      };
    }) as unknown as typeof db.insert);

    const results = await Promise.all([
      new Browser(plainAuth).signUp("a@example.cz"),
      new Browser(plainAuth).signUp("b@example.cz"),
    ]);
    spy.mockRestore();

    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    expect(
      db
        .select()
        .from(user)
        .all()
        .map((u) => u.role),
    ).toEqual(["admin"]);
  });

  test("[AUTH-001] nárok bez vzniklého účtu po minutě propadne, čerstvý ne", () => {
    const now = new Date("2026-10-30T12:00:00.000Z");
    setClockForTests({ now: () => now });
    db.insert(instanceMeta).values({ key: "first_admin_claimed", value: now.toISOString() }).run();

    expect(db.transaction((tx) => canRegister(tx, "x@example.cz"))).toMatchObject({
      allowed: false,
    });

    const later = new Date(now.getTime() + 61_000);
    setClockForTests({ now: () => later });
    expect(db.transaction((tx) => canRegister(tx, "x@example.cz"))).toMatchObject({
      allowed: true,
      role: "admin",
    });
  });

  test("[AUTH-001] role nejde podstrčit v těle registrace", async () => {
    await createAdmin(plainAuth);
    const token = insertInvite({ email: "user@example.cz" });
    const browser = new Browser(plainAuth);
    browser.cookies.set("fakturan_invite", token);

    const res = await browser.request("/sign-up/email", {
      body: { name: "Jan", email: "user@example.cz", password: PASSWORD, role: "admin" },
    });

    expect(res.status).toBe(400);
    expect(roleOf("user@example.cz")).toBeUndefined();
  });

  test("[AUTH-002] registrace bez pozvánky přes API selže", async () => {
    await createAdmin(plainAuth);

    const res = await new Browser(plainAuth).signUp("cizi@example.cz");

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "INVITE_REQUIRED" });
    expect(userCount()).toBe(1);
    expect(auditRows("auth.signup_rejected").at(-1)).toMatchObject({
      scope: "instance",
      after: { email: "cizi@example.cz" },
    });
  });

  test("[AUTH-002] uzavřená registrace neprozradí, zda e-mail existuje", async () => {
    await createAdmin(plainAuth);

    const known = await new Browser(plainAuth).signUp("admin@example.cz");
    const unknown = await new Browser(plainAuth).signUp("nikdo@example.cz");

    expect(known.status).toBe(unknown.status);
    expect(await known.json()).toEqual(await unknown.json());
  });

  test("[AUTH-002] e-mail z pozvánky bez tokenu k registraci heslem nestačí", async () => {
    await createAdmin(plainAuth);
    insertInvite({ email: "pozvany@example.cz" });

    expect((await new Browser(plainAuth).signUp("pozvany@example.cz")).status).toBe(400);
    expect(roleOf("pozvany@example.cz")).toBeUndefined();
  });

  test("[AUTH-002] token pozvánky neplatí pro jiný e-mail při registraci heslem", async () => {
    await createAdmin(plainAuth);
    const browser = new Browser(plainAuth);
    browser.cookies.set("fakturan_invite", insertInvite({ email: "pozvany@example.cz" }));

    expect((await browser.signUp("jiny@example.cz")).status).toBe(400);
    expect(roleOf("jiny@example.cz")).toBeUndefined();
    expect(db.select().from(invitation).get()?.acceptedAt).toBeNull();
  });

  test("[AUTH-002] platný token založí účet s rolí z pozvánky a pozvánku spotřebuje", async () => {
    await createAdmin(plainAuth);
    const token = insertInvite({ email: "pozvany@example.cz", role: "admin" });
    const browser = new Browser(plainAuth);
    browser.cookies.set("fakturan_invite", token);

    expect((await browser.signUp("pozvany@example.cz")).status).toBe(200);
    expect(roleOf("pozvany@example.cz")).toBe("admin");
    expect(db.select().from(invitation).get()?.acceptedAt).toBeInstanceOf(Date);

    const again = new Browser(plainAuth);
    again.cookies.set("fakturan_invite", token);
    expect((await again.signUp("druhy@example.cz")).status).toBe(400);
  });

  test.each([
    ["vypršelá", { expiresAt: new Date(Date.now() - 1000) }],
    ["zrušená", { revokedAt: new Date() }],
    ["přijatá", { acceptedAt: new Date() }],
  ])("[AUTH-002] %s pozvánka je odmítnuta", async (_, fields) => {
    await createAdmin(plainAuth);
    const browser = new Browser(plainAuth);
    browser.cookies.set("fakturan_invite", insertInvite(fields));

    expect((await browser.signUp("pozvany@example.cz")).status).toBe(400);
  });
});

describe("přihlášení", () => {
  test("[AUTH-003] přihlášení e-mailem a heslem založí relaci, špatné heslo ne", async () => {
    await createAdmin(plainAuth);
    const browser = new Browser(plainAuth);

    expect((await browser.signIn("admin@example.cz", "spatne-heslo-spatne")).status).toBe(401);
    expect(await browser.sessionUser()).toBeNull();
    expect((await browser.signIn("admin@example.cz")).status).toBe(200);
    expect(await browser.sessionUser()).toMatchObject({ email: "admin@example.cz" });
  });

  test("[AUTH-004] poskytovatel bez klíčů není v enabledProviders", () => {
    expect(enabledProviders(testEnv())).toEqual([]);
    expect(
      enabledProviders(testEnv({ GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" })),
    ).toEqual(["google"]);
    expect(enabledProviders(testEnv({ GITHUB_CLIENT_ID: "jen-id" }))).toEqual([]);
    expect(
      enabledProviders(
        testEnv({
          GITHUB_CLIENT_ID: "id",
          GITHUB_CLIENT_SECRET: "s",
          MICROSOFT_CLIENT_ID: "id",
          MICROSOFT_CLIENT_SECRET: "s",
          APPLE_CLIENT_ID: "id",
          APPLE_TEAM_ID: "team",
          APPLE_KEY_ID: "key",
          APPLE_PRIVATE_KEY: "pem",
        }),
      ),
    ).toEqual(["github", "microsoft", "apple"]);
    expect(enabledProviders(testEnv({ APPLE_CLIENT_ID: "id", APPLE_TEAM_ID: "team" }))).toEqual([]);
  });

  describe("sociální přihlášení", () => {
    const socialAuth = createAuth(
      testEnv({ GITHUB_CLIENT_ID: "gh-id", GITHUB_CLIENT_SECRET: "gh-secret" }),
    );

    test("[AUTH-005] sociální přihlášení bez pozvánky nezaloží účet", async () => {
      await createAdmin(socialAuth);
      fakeGithub("cizi@example.cz");

      const res = await githubLogin(new Browser(socialAuth));

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(`${BASE}/prihlaseni?chyba=pozvanka`);
      expect(roleOf("cizi@example.cz")).toBeUndefined();
      expect(auditRows("auth.signup_rejected").at(-1)).toMatchObject({
        after: { email: "cizi@example.cz" },
      });
    });

    test("[AUTH-005] e-mail existujícího ověřeného účtu se sociálně přihlásí", async () => {
      await createAdmin(socialAuth);
      db.update(user).set({ emailVerified: true }).run();
      fakeGithub("admin@example.cz");
      const browser = new Browser(socialAuth);

      const res = await githubLogin(browser);

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/");
      expect(await browser.sessionUser()).toMatchObject({ email: "admin@example.cz" });
    });

    test("[AUTH-005] ověřený e-mail z platné pozvánky účet založí", async () => {
      await createAdmin(socialAuth);
      insertInvite({ email: "pozvany@example.cz" });
      fakeGithub("POZVANY@example.cz");
      const browser = new Browser(socialAuth);

      await githubLogin(browser);

      expect(await browser.sessionUser()).toMatchObject({
        email: "pozvany@example.cz",
        role: "user",
      });
      expect(db.select().from(invitation).get()?.acceptedAt).toBeInstanceOf(Date);
    });

    test("[AUTH-005] neověřený e-mail z pozvánky bez tokenu účet nezaloží", async () => {
      await createAdmin(socialAuth);
      insertInvite({ email: "pozvany@example.cz" });
      fakeGithub("pozvany@example.cz", false);

      const res = await githubLogin(new Browser(socialAuth));

      expect(res.headers.get("location")).toBe(`${BASE}/prihlaseni?chyba=pozvanka`);
      expect(roleOf("pozvany@example.cz")).toBeUndefined();
    });

    test("[AUTH-005] selhání u existujícího účtu vypadá stejně jako bez účtu", async () => {
      await createAdmin(socialAuth);
      fakeGithub("admin@example.cz", false);

      const existing = await githubLogin(new Browser(socialAuth));
      fakeGithub("nikdo@example.cz", false);
      const unknown = await githubLogin(new Browser(socialAuth));

      expect(existing.headers.get("location")).toBe(`${BASE}/prihlaseni?chyba=pozvanka`);
      expect(unknown.headers.get("location")).toBe(existing.headers.get("location"));
      expect(auditRows("auth.login_failed").at(-1)).toMatchObject({
        after: { method: "github", reason: "account_not_linked" },
      });
    });

    test("[AUTH-005] token pozvánky v cookie projde i s jiným e-mailem poskytovatele", async () => {
      await createAdmin(socialAuth);
      const browser = new Browser(socialAuth);
      browser.cookies.set("fakturan_invite", insertInvite({ email: "pozvany@example.cz" }));
      fakeGithub("skryty@relay.example");

      await githubLogin(browser);

      expect(roleOf("skryty@relay.example")).toBe("user");
    });

    test("[AUTH-001] první účet na prázdné instanci může vzniknout i sociálně", async () => {
      fakeGithub("prvni@example.cz");

      await githubLogin(new Browser(socialAuth));

      expect(roleOf("prvni@example.cz")).toBe("admin");
    });
  });

  test("[AUTH-015] tajemství Apple je ES256 JWT s platností nejvýš 6 měsíců", async () => {
    const { privateKey } = await generateKeyPair("ES256", { extractable: true });
    const pem = await exportPKCS8(privateKey);
    const now = new Date("2026-10-30T12:00:00.000Z");
    setClockForTests({ now: () => now });

    const secret = await appleClientSecret(
      testEnv({
        APPLE_CLIENT_ID: "cz.fakturan",
        APPLE_TEAM_ID: "TEAM",
        APPLE_KEY_ID: "KEY",
        APPLE_PRIVATE_KEY: pem.replaceAll("\n", "\\n"),
      }),
    );

    expect(decodeProtectedHeader(secret)).toMatchObject({ alg: "ES256", kid: "KEY" });
    const claims = decodeJwt(secret);
    expect(claims).toMatchObject({
      iss: "TEAM",
      sub: "cz.fakturan",
      aud: "https://appleid.apple.com",
    });
    expect(claims.exp! - claims.iat!).toBeLessThanOrEqual(183 * 86_400);
    expect(claims.iat).toBe(now.getTime() / 1000);
  });
});

describe("hesla a relace", () => {
  let smtp: TestSmtp;
  let mailAuth: Auth;
  let mailEnv: Env;

  beforeAll(async () => {
    smtp = await startSmtp();
    mailEnv = testEnv({
      SMTP_HOST: "127.0.0.1",
      SMTP_PORT: String(smtp.port),
      SMTP_FROM: "fakturan@example.cz",
    });
    mailAuth = createAuth(mailEnv);
  });

  afterAll(() => smtp.stop());

  function linkFrom(text: string): string {
    const match = /https?:\/\/\S+/.exec(text.slice(text.indexOf("\r\n\r\n")));
    if (!match) throw new Error("Zpráva neobsahuje odkaz");
    return match[0];
  }

  async function createVerifiedAdmin(email: string) {
    await new Browser(mailAuth).signUp(email);
    const link = linkFrom((await smtp.waitFor(email)).text);
    const browser = new Browser(mailAuth);
    await browser.request(link.slice(`${BASE}/api/auth`.length));
    return browser;
  }

  async function requestReset(email: string) {
    smtp.messages.length = 0;
    await new Browser(mailAuth).request("/request-password-reset", {
      body: { email, redirectTo: "/reset-hesla" },
    });
    const link = new URL(linkFrom((await smtp.waitFor(email)).text));
    const token = link.pathname.split("/").at(-1)!;
    const landing = await new Browser(mailAuth).request(link.href.slice(`${BASE}/api/auth`.length));
    expect(landing.headers.get("location")).toBe(`${BASE}/reset-hesla?token=${token}`);
    return token;
  }

  test("[AUTH-008] odkaz na reset je jednorázový a po hodině neplatí", async () => {
    await createVerifiedAdmin("reset@example.cz");

    const token = await requestReset("reset@example.cz");
    const browser = new Browser(mailAuth);
    const body = { token, newPassword: "nove-silne-heslo-kolo-strom" };
    expect((await browser.request("/reset-password", { body })).status).toBe(200);
    expect((await browser.request("/reset-password", { body })).status).toBe(400);
    expect((await browser.signIn("reset@example.cz", body.newPassword)).status).toBe(200);

    const late = await requestReset("reset@example.cz");
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 3_601_000 });
    const expired = await new Browser(mailAuth).request("/reset-password", {
      body: { token: late, newPassword: "jine-silne-heslo-kolo-strom" },
    });
    expect(expired.status).toBe(400);
  });

  test("[AUTH-008] reset ukončí všechny relace a je v auditu bez tokenu", async () => {
    const owner = await createVerifiedAdmin("reset2@example.cz");
    expect(await owner.sessionUser()).not.toBeNull();

    const token = await requestReset("reset2@example.cz");
    await new Browser(mailAuth).request("/reset-password", {
      body: { token, newPassword: "nove-silne-heslo-kolo-strom" },
    });

    expect(await owner.sessionUser()).toBeNull();
    const row = auditRows("auth.password_reset").at(-1);
    expect(row).toMatchObject({ scope: "instance", userAgent: "vitest" });
    expect(JSON.stringify(row)).not.toContain(token);
  });

  test("[AUTH-009] první účet bez SMTP nepotřebuje ověření e-mailu", async () => {
    expect(isInstanceMailConfigured(testEnv())).toBe(false);
    const browser = new Browser(plainAuth);

    await browser.signUp("prvni@example.cz");

    expect(await browser.sessionUser()).toMatchObject({ email: "prvni@example.cz" });
    expect((await new Browser(plainAuth).signIn("prvni@example.cz")).status).toBe(200);
  });

  test("[AUTH-009] se SMTP se účet s heslem musí ověřit odkazem z e-mailu", async () => {
    expect(isInstanceMailConfigured(mailEnv)).toBe(true);
    const browser = new Browser(mailAuth);

    const res = await browser.signUp("over@example.cz");

    expect(res.status).toBe(200);
    expect(await browser.sessionUser()).toBeNull();
    expect((await browser.signIn("over@example.cz")).status).toBe(403);

    const link = linkFrom((await smtp.waitFor("over@example.cz")).text);
    await browser.request(link.slice(`${BASE}/api/auth`.length));
    expect((await browser.signIn("over@example.cz")).status).toBe(200);
  });

  test("[AUTH-002] se SMTP odmítnutá registrace také selže, ne falešným úspěchem", async () => {
    await createVerifiedAdmin("admin2@example.cz");

    expect((await new Browser(mailAuth).signUp("cizi@example.cz")).status).toBe(400);
  });

  test.each([
    ["krátké", "kratke-hesl", "PASSWORD_TOO_SHORT"],
    ["uniklé", "unbelievable", "PASSWORD_COMPROMISED"],
    ["uniklé s velkými písmeny", "Scandinavian", "PASSWORD_COMPROMISED"],
    ["z 1M seznamu", "qwertyuiop123", "PASSWORD_COMPROMISED"],
    ["málo různých znaků", "abcdabcdabcd", "PASSWORD_WEAK"],
    ["místní část e-mailu", "heslo.prijmeni-dlouhe", "PASSWORD_WEAK"],
  ])(
    "[AUTH-010] heslo pod 12 znaků a známé uniklé heslo jsou odmítnuty: %s",
    async (_, password, code) => {
      const res = await new Browser(plainAuth).signUp("heslo.prijmeni-dlouhe@example.cz", password);

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code });
      expect(userCount()).toBe(0);
    },
  );

  test("[AUTH-010] uniklé heslo neprojde ani změnou, ani resetem", async () => {
    const owner = await createVerifiedAdmin("zmena@example.cz");
    await owner.signIn("zmena@example.cz");

    const change = await owner.request("/change-password", {
      body: { currentPassword: PASSWORD, newPassword: "unbelievable" },
    });
    expect(change.status).toBe(400);

    const token = await requestReset("zmena@example.cz");
    const reset = await new Browser(mailAuth).request("/reset-password", {
      body: { token, newPassword: "unbelievable" },
    });
    expect(reset.status).toBe(400);
    expect(auditRows("auth.password_reset_failed").at(-1)).toMatchObject({
      after: { reason: "PASSWORD_COMPROMISED" },
    });
    const zmena = db.select().from(user).where(eq(user.email, "zmena@example.cz")).get()!;
    expect(auditRows("auth.password_reset_failed").at(-1)?.ownerId).toBe(zmena.id);
  });

  test("[AUTH-010] reset nepřijme místní část e-mailu účtu", async () => {
    await createVerifiedAdmin("dlouha.mistni.cast@example.cz");
    const token = await requestReset("dlouha.mistni.cast@example.cz");

    const res = await new Browser(mailAuth).request("/reset-password", {
      body: { token, newPassword: "dlouha.mistni.cast" },
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "PASSWORD_WEAK" });
  });

  test("[AUTH-008] žádost o reset se při selhání koncového bodu nezapíše jako provedená", async () => {
    const before = auditRows("auth.password_reset_request").length;

    const res = await new Browser(plainAuth).request("/request-password-reset", {
      body: { email: "kdokoli@example.cz" },
    });

    expect(res.status).toBe(400);
    expect(auditRows("auth.password_reset_request")).toHaveLength(before);
  });

  test("[AUTH-011] ukončení ostatních relací", async () => {
    const a = await createAdmin(plainAuth);
    const b = new Browser(plainAuth);
    await b.signIn("admin@example.cz");

    const list = await a.request("/list-sessions");
    expect((await list.json()) as unknown[]).toHaveLength(2);
    const revokesBefore = auditRows("auth.session_revoke").length;

    expect((await a.request("/revoke-other-sessions", { body: {} })).status).toBe(200);

    expect(await a.sessionUser()).not.toBeNull();
    expect(await b.sessionUser()).toBeNull();
    expect(auditRows("auth.session_revoke").length).toBe(revokesBefore + 1);
  });

  test("[AUTH-012] změna hesla ukončí ostatní relace i bez žádosti klienta", async () => {
    const a = await createAdmin(plainAuth);
    const b = new Browser(plainAuth);
    await b.signIn("admin@example.cz");

    const res = await a.request("/change-password", {
      body: {
        currentPassword: PASSWORD,
        newPassword: "nove-silne-heslo-kolo-strom",
        revokeOtherSessions: false,
      },
    });

    expect(res.status).toBe(200);
    expect(await a.sessionUser()).not.toBeNull();
    expect(await b.sessionUser()).toBeNull();
    expect(auditRows("auth.password_change").at(-1)).toMatchObject({ scope: "instance" });
  });

  test("[AUTH-012] změna e-mailu vyžaduje potvrzení na novou adresu", async () => {
    const owner = await createVerifiedAdmin("stary@example.cz");
    await owner.signIn("stary@example.cz");

    await owner.request("/change-email", { body: { newEmail: "novy@example.cz" } });

    expect((await owner.sessionUser())?.email).toBe("stary@example.cz");
    const link = linkFrom((await smtp.waitFor("novy@example.cz")).text);
    await owner.request(link.slice(`${BASE}/api/auth`.length));
    expect((await owner.sessionUser())?.email).toBe("novy@example.cz");
  });

  test("[AUTH-012] bez SMTP změnu e-mailu nejde potvrdit, proto je vypnutá", async () => {
    const owner = await createAdmin(plainAuth);

    const res = await owner.request("/change-email", { body: { newEmail: "novy@example.cz" } });

    expect(res.status).toBe(400);
    expect(await owner.sessionUser()).toMatchObject({ email: "admin@example.cz" });
  });

  test("[AUTH-013] odhlášení zneplatní relaci", async () => {
    const browser = await createAdmin(plainAuth);
    const stolen = new Browser(plainAuth);
    stolen.cookies = new Map(browser.cookies);

    expect((await browser.request("/sign-out", { body: {} })).status).toBe(200);

    expect(await stolen.sessionUser()).toBeNull();
    expect(db.select().from(session).all()).toEqual([]);
  });

  test("[AUTH-014] relace platí 30 dní a obnoví se při aktivitě", async () => {
    const browser = await createAdmin(plainAuth);
    const created = db.select().from(session).get()!;
    const day = 86_400_000;
    expect(created.expiresAt.getTime() - created.createdAt.getTime()).toBe(30 * day);

    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 29 * day });
    expect(await browser.sessionUser()).not.toBeNull();

    const renewed = db.select().from(session).get()!;
    expect(renewed.expiresAt.getTime() - Date.now()).toBeGreaterThan(29 * day);
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 31 * day });
    expect(await browser.sessionUser()).toBeNull();
  });

  test("[AUTH-014] cookie je HttpOnly, SameSite=Lax a na https Secure", async () => {
    const secure = createAuth(testEnv({ BETTER_AUTH_URL: "https://fakturan.example.cz" }));
    const res = await secure.handler(
      new Request("https://fakturan.example.cz/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://fakturan.example.cz" },
        body: JSON.stringify({ name: "Jan", email: "a@example.cz", password: PASSWORD }),
      }),
    );

    const cookie = res.headers.getSetCookie().find((c) => c.includes("session_token"));
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/Max-Age=2592000/i);
  });

  test("[AUTH-001] plugin admin nevystavuje impersonaci ani obejití pravidel", async () => {
    const admin = await createAdmin(plainAuth);

    for (const path of [
      "/admin/impersonate-user",
      "/admin/set-role",
      "/admin/create-user",
      "/admin/set-user-password",
    ]) {
      const res = await admin.request(path, { body: { userId: "x" } });
      expect(res.status).toBe(404);
    }
  });
});

describe("audit přihlašování", () => {
  test("úspěšné i neúspěšné přihlášení je v auditu", async () => {
    await createAdmin(plainAuth);
    const admin = db.select().from(user).get()!;
    const browser = new Browser(plainAuth);

    await browser.request("/sign-in/email", {
      body: { email: "admin@example.cz", password: "spatne-heslo-spatne" },
      ua: "UA/ok",
    });
    await browser.request("/sign-in/email", {
      body: { email: "neznamy@example.cz", password: "spatne-heslo-spatne" },
    });
    await browser.signIn("admin@example.cz");

    const failed = auditRows("auth.login_failed").slice(-2);
    expect(failed[0]).toMatchObject({
      actorId: null,
      ownerId: admin.id,
      source: "web",
      scope: "instance",
      userAgent: "UA/ok",
      after: { email: "admin@example.cz" },
    });
    expect(failed[1]).toMatchObject({ ownerId: null, after: { email: "neznamy@example.cz" } });
    expect(auditRows("auth.login").at(-1)).toMatchObject({
      actorId: admin.id,
      ownerId: admin.id,
      scope: "instance",
      entity: "user",
      entityId: admin.id,
    });
    expect(JSON.stringify(failed)).not.toContain("spatne-heslo");
  });

  test("odhlášení, vznik účtu a odmítnutá hesla jsou v auditu bez hesla", async () => {
    const browser = await createAdmin(plainAuth);
    const admin = db.select().from(user).get()!;
    const rejected = "unbelievable";

    const change = await browser.request("/change-password", {
      body: { currentPassword: PASSWORD, newPassword: rejected },
    });
    expect(change.status).toBe(400);
    await browser.request("/sign-out", { body: {} });

    expect(auditRows("user.create").at(-1)).toMatchObject({
      entityId: admin.id,
      scope: "instance",
      after: { email: "admin@example.cz", role: "admin" },
    });
    expect(auditRows("auth.first_admin").at(-1)).toMatchObject({ scope: "instance" });
    expect(auditRows("auth.logout").at(-1)).toMatchObject({ actorId: admin.id, ownerId: admin.id });
    expect(auditRows("auth.password_change_failed").at(-1)).toMatchObject({
      actorId: admin.id,
      after: { reason: "PASSWORD_COMPROMISED" },
    });
    const everything = JSON.stringify(db.select().from(auditLog).all());
    expect(everything).not.toContain(PASSWORD);
    expect(everything).not.toContain(rejected);
  });

  test("selhání zápisu auditu odhlášení se dostane ke klientovi a relace zůstane", async () => {
    const browser = await createAdmin(plainAuth);
    db.$client.exec(
      "CREATE TRIGGER fail_logout BEFORE INSERT ON audit_log WHEN NEW.action = 'auth.logout' BEGIN SELECT RAISE(ABORT, 'audit down'); END",
    );
    try {
      expect((await browser.request("/sign-out", { body: {} })).status).toBe(500);
      expect(await browser.sessionUser()).not.toBeNull();
    } finally {
      db.$client.exec("DROP TRIGGER fail_logout");
    }
  });

  test("automatické přihlášení po ověření e-mailu je v auditu", async () => {
    const smtp = await startSmtp();
    try {
      const auth = createAuth(
        testEnv({
          SMTP_HOST: "127.0.0.1",
          SMTP_PORT: String(smtp.port),
          SMTP_FROM: "fakturan@example.cz",
        }),
      );
      const browser = new Browser(auth);
      await browser.signUp("over2@example.cz");
      const { text } = await smtp.waitFor("over2@example.cz");
      const link = /https?:\/\/\S+/.exec(text.slice(text.indexOf("\r\n\r\n")))![0];
      await browser.request(link.slice(`${BASE}/api/auth`.length));

      expect(auditRows("auth.login").at(-1)).toMatchObject({ after: { method: "email-link" } });
    } finally {
      await smtp.stop();
    }
  });

  test("selhání zápisu auditu přihlášení shodí požadavek", async () => {
    await createAdmin(plainAuth);
    db.$client.exec(
      "CREATE TRIGGER fail_login BEFORE INSERT ON audit_log WHEN NEW.action = 'auth.login' BEGIN SELECT RAISE(ABORT, 'audit down'); END",
    );
    try {
      const browser = new Browser(plainAuth);
      expect((await browser.signIn("admin@example.cz")).status).toBe(500);
      expect(await browser.sessionUser()).toBeNull();
    } finally {
      db.$client.exec("DROP TRIGGER fail_login");
    }
  });
});

describe("instanční pošta", () => {
  test("[AUTH-009] sendInstanceMail bez SMTP selže, se SMTP doručí", async () => {
    await expect(
      sendInstanceMail({ to: "a@example.cz", subject: "s", text: "t" }, testEnv()),
    ).rejects.toThrow(/SMTP/);

    const smtp = await startSmtp();
    try {
      const env = testEnv({
        SMTP_HOST: "127.0.0.1",
        SMTP_PORT: String(smtp.port),
        SMTP_FROM: "fakturan@example.cz",
      });
      await sendInstanceMail({ to: "a@example.cz", subject: "Předmět", text: "Text" }, env);
      expect((await smtp.waitFor("a@example.cz")).text).toContain("Text");
    } finally {
      await smtp.stop();
    }
  });
});
