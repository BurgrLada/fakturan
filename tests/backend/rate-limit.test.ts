import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desc, eq, like } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createAuth } from "@/server/auth";
import { setClockForTests } from "@/server/clock";
import { createDb, setDbForTests } from "@/server/db";
import { auditLog, instanceMeta, rateLimit, user } from "@/server/db/schema";
import { parseEnv, type Env } from "@/server/env";
import { checkRateLimit, RATE_RULES } from "@/server/rate-limit";
import { createTestDb } from "../helpers/db";

const db = createTestDb();

const BASE = "http://localhost:3000";
const PASSWORD = "správné-kůň-baterie-sponka";
const dataDir = mkdtempSync(join(tmpdir(), "fakturan-rl-"));

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

function post(auth: Auth, path: string, body: unknown, headers: Record<string, string> = {}) {
  return auth.handler(
    new Request(`${BASE}/api/auth${path}`, {
      method: "POST",
      headers: { origin: BASE, "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

const signIn = (auth: Auth, email: string, headers?: Record<string, string>) =>
  post(auth, "/sign-in/email", { email, password: "špatné-heslo-špatné" }, headers);

function auditRows(action: string) {
  return db
    .select()
    .from(auditLog)
    .where(eq(auditLog.action, action))
    .orderBy(desc(auditLog.id))
    .all();
}

const auth = createAuth(testEnv());
const proxied = createAuth(testEnv({ TRUST_PROXY: "1" }));

beforeEach(() => {
  db.delete(rateLimit).run();
  db.delete(user).run();
  db.delete(instanceMeta).run();
  setClockForTests({ now: () => new Date("2026-11-02T10:00:00.000Z") });
});

afterEach(() => setClockForTests(null));

describe("checkRateLimit", () => {
  const rule = { name: "test", limit: 2, windowSeconds: 60 };

  test("[SEC-001] po vyčerpání limitu odmítne a řekne, za jak dlouho to jde znovu", () => {
    expect(checkRateLimit("k", rule)).toEqual({
      allowed: true,
      retryAfterSeconds: 0,
      firstDenial: false,
    });
    expect(checkRateLimit("k", rule).allowed).toBe(true);
    expect(checkRateLimit("k", rule)).toEqual({
      allowed: false,
      retryAfterSeconds: 60,
      firstDenial: true,
    });
    expect(checkRateLimit("k", rule).firstDenial).toBe(false);
  });

  test("[SEC-001] okno se po uplynutí obnoví a klíče jsou nezávislé", () => {
    let now = new Date("2026-11-02T10:00:00.000Z");
    setClockForTests({ now: () => now });
    checkRateLimit("a", rule);
    checkRateLimit("a", rule);
    expect(checkRateLimit("b", rule).allowed).toBe(true);

    now = new Date("2026-11-02T10:00:30.000Z");
    expect(checkRateLimit("a", rule)).toMatchObject({ allowed: false, retryAfterSeconds: 30 });
    now = new Date("2026-11-02T10:01:00.000Z");
    expect(checkRateLimit("a", rule).allowed).toBe(true);
  });

  test("[SEC-001] odmítnutý pokus počítadlo dál nezvyšuje", () => {
    let now = new Date("2026-11-02T10:00:00.000Z");
    setClockForTests({ now: () => now });
    for (let i = 0; i < 50; i++) checkRateLimit("k", rule);
    now = new Date("2026-11-02T10:01:00.000Z");
    expect(checkRateLimit("k", rule).allowed).toBe(true);
  });

  test("[SEC-001] limit přežije restart procesu", () => {
    checkRateLimit("k", rule);
    checkRateLimit("k", rule);

    const reopened = createDb(db.$client.name);
    setDbForTests(reopened);
    try {
      expect(checkRateLimit("k", rule).allowed).toBe(false);
    } finally {
      setDbForTests(db);
      reopened.$client.close();
    }
  });

  test("[SEC-001] pravidla odpovídají hodnotám z plánu", () => {
    expect(RATE_RULES.loginIpEmail).toMatchObject({ limit: 5, windowSeconds: 60 });
    expect(RATE_RULES.fileDownloadUser).toMatchObject({ limit: 30, windowSeconds: 3600 });
    expect(RATE_RULES.loginIp).toMatchObject({ limit: 20, windowSeconds: 60 });
    expect(RATE_RULES.loginEmail).toMatchObject({ limit: 50, windowSeconds: 3600 });
    expect(RATE_RULES.resetPasswordIpEmail).toMatchObject({ limit: 3, windowSeconds: 3600 });
    expect(RATE_RULES.resetPasswordSubmitIp).toMatchObject({ limit: 10, windowSeconds: 3600 });
    expect(RATE_RULES.socialCallbackIp).toMatchObject({ limit: 30, windowSeconds: 60 });
    expect(RATE_RULES.signupIp).toMatchObject({ limit: 5, windowSeconds: 3600 });
    expect(RATE_RULES.invitationsUser).toMatchObject({ limit: 20, windowSeconds: 3600 });
    for (const name of ["sendUser", "importUser", "exportUser"] as const) {
      expect(RATE_RULES[name]).toMatchObject({ limit: 60, windowSeconds: 60 });
    }
  });
});

// Every non-limited attempt runs a real scrypt (~75 ms), and some tests make 50 of them.
describe("rate limiting přihlášení", { timeout: 30_000 }, () => {
  test("[SEC-001] [AUD-002] šesté přihlášení za minutu vrátí 429 a zapíše audit", async () => {
    const before = auditRows("rate_limit.exceeded").length;
    for (let i = 0; i < 5; i++) expect((await signIn(auth, "jan@example.cz")).status).toBe(401);

    const res = await signIn(auth, "jan@example.cz");

    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    const rows = auditRows("rate_limit.exceeded");
    expect(rows).toHaveLength(before + 1);
    expect(rows[0]).toMatchObject({ scope: "instance", source: "web" });
    expect(rows[0].after).toMatchObject({ rule: "loginIpEmail", retryAfterSeconds: 60 });
  });

  test("[SEC-001] po uplynutí minuty jde přihlášení znovu", async () => {
    for (let i = 0; i < 6; i++) await signIn(auth, "jan@example.cz");
    setClockForTests({ now: () => new Date("2026-11-02T10:01:00.000Z") });
    expect((await signIn(auth, "jan@example.cz")).status).toBe(401);
  });

  test("[SEC-001] odmítnutí nezapíše navíc záznam o neúspěšném přihlášení", async () => {
    const before = auditRows("auth.login_failed").length;
    for (let i = 0; i < 7; i++) await signIn(auth, "jan@example.cz");
    expect(auditRows("auth.login_failed")).toHaveLength(before + 5);
  });

  test("[SEC-001] limit na IP platí napříč e-maily", async () => {
    for (let i = 0; i < 20; i++) {
      expect((await signIn(auth, `u${i}@example.cz`)).status).toBe(401);
    }
    expect((await signIn(auth, "dalsi@example.cz")).status).toBe(429);
  });

  test("[SEC-001] velikost písmen v e-mailu limit neobejde", async () => {
    for (let i = 0; i < 5; i++) await signIn(auth, "Jan@Example.cz");
    expect((await signIn(auth, "jan@example.cz")).status).toBe(429);
  });

  test("[SEC-001] bez TRUST_PROXY podvržené X-Forwarded-For limit neobejde", async () => {
    for (let i = 0; i < 20; i++) {
      await signIn(auth, `u${i}@example.cz`, { "x-forwarded-for": `203.0.113.${i}` });
    }
    const res = await signIn(auth, "dalsi@example.cz", { "x-forwarded-for": "198.51.100.9" });
    expect(res.status).toBe(429);
  });

  test("[SEC-001] s TRUST_PROXY se bucket řídí posledním záznamem X-Forwarded-For", async () => {
    for (let i = 0; i < 20; i++) {
      await signIn(proxied, `u${i}@example.cz`, { "x-forwarded-for": `1.2.3.${i}, 10.0.0.1` });
    }
    const spoofedFirst = await signIn(proxied, "a@example.cz", {
      "x-forwarded-for": "9.9.9.9, 10.0.0.1",
    });
    const otherClient = await signIn(proxied, "b@example.cz", {
      "x-forwarded-for": "9.9.9.9, 10.0.0.2",
    });
    expect(spoofedFirst.status).toBe(429);
    expect(otherClient.status).toBe(401);
  });

  test("[SEC-001] odmítnutí přiřadí k auditu IP jen při TRUST_PROXY", async () => {
    for (let i = 0; i < 6; i++) {
      await signIn(proxied, "jan@example.cz", { "x-forwarded-for": "7.7.7.7" });
    }
    expect(auditRows("rate_limit.exceeded")[0]?.ip).toBe("7.7.7.7");

    db.delete(rateLimit).run();
    for (let i = 0; i < 6; i++) {
      await signIn(auth, "jan@example.cz", { "x-forwarded-for": "8.8.8.8" });
    }
    expect(auditRows("rate_limit.exceeded")[0]?.ip).toBeNull();
  });

  test("[SEC-001] deset odmítnutí v jednom okně zapíše jediný audit", async () => {
    const before = auditRows("rate_limit.exceeded").length;
    for (let i = 0; i < 15; i++) await signIn(auth, "jan@example.cz");
    expect(auditRows("rate_limit.exceeded")).toHaveLength(before + 1);

    setClockForTests({ now: () => new Date("2026-11-02T10:01:00.000Z") });
    for (let i = 0; i < 6; i++) await signIn(auth, "jan@example.cz");
    expect(auditRows("rate_limit.exceeded")).toHaveLength(before + 2);
  });

  test("[SEC-001] zablokovaná IP nezakládá záznamy pro jednotlivé e-maily", async () => {
    for (let i = 0; i < 20; i++) await signIn(auth, `u${i}@example.cz`);
    const rows = () => db.select().from(rateLimit).all().length;
    const before = rows();
    await signIn(auth, "novy@example.cz");
    expect(rows()).toBe(before);
  });

  test("[SEC-001] IPv6 adresy ze stejné /64 sdílejí bucket, IPv4-mapped je IPv4", async () => {
    for (let i = 0; i < 20; i++) {
      await signIn(proxied, `u${i}@example.cz`, {
        "x-forwarded-for": `2001:db8:1:2:${i}::${i + 1}`,
      });
    }
    const sameSubnet = await signIn(proxied, "a@example.cz", {
      "x-forwarded-for": "2001:db8:1:2:ffff::1",
    });
    const otherSubnet = await signIn(proxied, "b@example.cz", {
      "x-forwarded-for": "2001:db8:1:3::1",
    });
    expect(sameSubnet.status).toBe(429);
    expect(otherSubnet.status).toBe(401);

    for (let i = 0; i < 20; i++) {
      await signIn(proxied, `v${i}@example.cz`, { "x-forwarded-for": "::ffff:192.0.2.5" });
    }
    const plain = await signIn(proxied, "c@example.cz", { "x-forwarded-for": "192.0.2.5" });
    expect(plain.status).toBe(429);
  });

  test("[SEC-001] hádání jednoho účtu je omezené bez ohledu na IP", async () => {
    for (let i = 0; i < 50; i++) {
      const ip = `10.${i >> 8}.${i % 256}.1`;
      await signIn(proxied, "obet@example.cz", { "x-forwarded-for": ip });
      db.delete(rateLimit).where(like(rateLimit.key, "login%Ip%")).run();
    }
    const res = await signIn(proxied, "obet@example.cz", { "x-forwarded-for": "10.9.9.9" });
    expect(res.status).toBe(429);
  });
});

describe("rate limiting reset hesla a registrace", () => {
  test("[SEC-001] čtvrtá žádost o obnovu hesla za hodinu vrátí 429 i pro neexistující účet", async () => {
    const reset = () =>
      post(auth, "/request-password-reset", { email: "nikdo@example.cz", redirectTo: "/reset" });
    for (let i = 0; i < 3; i++) expect((await reset()).status).not.toBe(429);
    const res = await reset();
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("3600");
  });

  test("[SEC-001] cizí klient nezablokuje obnovu hesla oběti, jen vlastní IP", async () => {
    const reset = (ip: string) =>
      post(
        proxied,
        "/request-password-reset",
        { email: "obet@example.cz", redirectTo: "/reset" },
        { "x-forwarded-for": ip },
      );
    for (let i = 0; i < 4; i++) await reset("1.1.1.1");
    expect((await reset("1.1.1.1")).status).toBe(429);
    expect((await reset("2.2.2.2")).status).not.toBe(429);
  });

  test("[SEC-001] ověřovací e-maily a sociální přihlášení mají limit na IP", async () => {
    const verify = () => post(auth, "/send-verification-email", { email: "a@example.cz" });
    for (let i = 0; i < 10; i++) expect((await verify()).status).not.toBe(429);
    expect((await verify()).status).toBe(429);

    const social = () => post(auth, "/sign-in/social", { provider: "github" });
    for (let i = 0; i < 30; i++) expect((await social()).status).not.toBe(429);
    expect((await social()).status).toBe(429);
  });

  test("[SEC-001] šestá registrace za hodinu z jedné IP vrátí 429", async () => {
    const signUp = (i: number) =>
      post(auth, "/sign-up/email", { name: "Jan", email: `s${i}@example.cz`, password: PASSWORD });
    for (let i = 0; i < 5; i++) expect((await signUp(i)).status).not.toBe(429);
    expect((await signUp(5)).status).toBe(429);
  });
});

describe("anonymní koncové body zapisující audit", () => {
  const github = createAuth(
    testEnv({ GITHUB_CLIENT_ID: "gh-id", GITHUB_CLIENT_SECRET: "gh-secret" }),
  );
  const forgedCallback = () =>
    github.handler(new Request(`${BASE}/api/auth/callback/github?state=podvrzeny`));
  const forgedReset = (client: Auth = auth, headers?: Record<string, string>) =>
    post(client, "/reset-password", { token: "neexistuje", newPassword: PASSWORD }, headers);

  test("[SEC-001] [AUD-006] smyčka s neplatným tokenem obnovy nezaplní audit", async () => {
    const failed = auditRows("auth.password_reset_failed").length;
    const exceeded = auditRows("rate_limit.exceeded").length;
    const { limit } = RATE_RULES.resetPasswordSubmitIp;

    for (let i = 0; i < limit; i++) expect((await forgedReset()).status).not.toBe(429);
    for (let i = 0; i < 5; i++) expect((await forgedReset()).status).toBe(429);

    expect(auditRows("auth.password_reset_failed")).toHaveLength(failed + limit);
    expect(auditRows("rate_limit.exceeded")).toHaveLength(exceeded + 1);
    expect(auditRows("rate_limit.exceeded")[0].after).toMatchObject({
      rule: "resetPasswordSubmitIp",
      path: "/reset-password",
    });
  });

  test("[SEC-001] limit obnovy hesla platí pro každou IP zvlášť", async () => {
    const { limit } = RATE_RULES.resetPasswordSubmitIp;
    for (let i = 0; i < limit; i++) {
      await forgedReset(proxied, { "x-forwarded-for": "1.1.1.1" });
    }
    expect((await forgedReset(proxied, { "x-forwarded-for": "1.1.1.1" })).status).toBe(429);
    expect((await forgedReset(proxied, { "x-forwarded-for": "2.2.2.2" })).status).not.toBe(429);
  });

  test("[SEC-001] [AUD-006] podvržený návrat od poskytovatele audit nezaplní", async () => {
    const failed = auditRows("auth.login_failed").length;
    const exceeded = auditRows("rate_limit.exceeded").length;
    const { limit } = RATE_RULES.socialCallbackIp;

    for (let i = 0; i < limit; i++) expect((await forgedCallback()).status).not.toBe(429);
    for (let i = 0; i < 5; i++) expect((await forgedCallback()).status).toBe(429);

    expect(auditRows("auth.login_failed")).toHaveLength(failed + limit);
    expect(auditRows("rate_limit.exceeded")).toHaveLength(exceeded + 1);
    expect(auditRows("rate_limit.exceeded")[0].after).toMatchObject({ rule: "socialCallbackIp" });
  });
});

describe("chyby přihlášení", () => {
  test("[SEC-008] neexistující účet a špatné heslo vrátí stejnou chybu", async () => {
    await post(auth, "/sign-up/email", {
      name: "Jan",
      email: "jan@example.cz",
      password: PASSWORD,
    });

    const wrongPassword = await signIn(auth, "jan@example.cz");
    const unknown = await signIn(auth, "nikdo@example.cz");

    expect(unknown.status).toBe(wrongPassword.status);
    expect(await unknown.json()).toEqual(await wrongPassword.json());
  });
});

describe("cookies relace", () => {
  test("[SEC-010] cookie relace je HttpOnly, Secure a SameSite=Lax", async () => {
    const secureBase = "https://fakturan.example.cz";
    const secure = createAuth(testEnv({ BETTER_AUTH_URL: secureBase }));
    const res = await secure.handler(
      new Request(`${secureBase}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { origin: secureBase, "content-type": "application/json" },
        body: JSON.stringify({ name: "Jan", email: "jan@example.cz", password: PASSWORD }),
      }),
    );
    expect(res.status).toBe(200);
    const line = res.headers.getSetCookie().find((c) => c.includes("session_token"));
    expect(line).toMatch(/HttpOnly/i);
    expect(line).toMatch(/Secure/i);
    expect(line).toMatch(/SameSite=Lax/i);
  });
});

test("[SEC-001] dotaz za více pokusů spotřebuje svou cenu a nepřetáhne limit", () => {
  const rule = { name: "costTest", limit: 10, windowSeconds: 60 };
  const key = `cost-${Date.now()}`;
  expect(checkRateLimit(key, rule, 6).allowed).toBe(true);
  expect(checkRateLimit(key, rule, 5).allowed).toBe(false);
  expect(checkRateLimit(key, rule, 4).allowed).toBe(true);
  expect(checkRateLimit(key, rule).allowed).toBe(false);
});
