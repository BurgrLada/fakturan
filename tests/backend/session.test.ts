import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { auth } from "@/server/auth";
import { clientIp, webActor } from "@/server/auth/request-actor";
import { actorFromRequest, requireAdmin, requireSession } from "@/server/auth/session";
import { user } from "@/server/db/schema";
import { parseEnv } from "@/server/env";
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

const db = createTestDb();

const envValues = {
  DATA_DIR: mkdtempSync(join(tmpdir(), "fakturan-session-")),
  BETTER_AUTH_URL: "http://localhost:3000",
  BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
};

let adminCookie = "";

beforeAll(async () => {
  for (const [key, value] of Object.entries(envValues)) vi.stubEnv(key, value);
  const res = await auth.handler(
    new Request("http://localhost:3000/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify({
        name: "Jan",
        email: "admin@example.cz",
        password: "správné-kůň-baterie-sponka",
      }),
    }),
  );
  adminCookie = res.headers.getSetCookie()[0].split(";")[0];
});

beforeEach(() => {
  db.update(user).set({ role: "admin" }).where(eq(user.email, "admin@example.cz")).run();
  requestHeaders.current = new Headers({ cookie: adminCookie, "user-agent": "UA/1" });
});

describe("relace v serverových komponentách", () => {
  test("[AUTH-013] requireSession bez relace přesměruje na přihlášení", async () => {
    requestHeaders.current = new Headers();

    await expect(requireSession()).rejects.toThrow("redirect:/prihlaseni");
  });

  test("[AUTH-003] requireSession vrátí relaci a actorFromRequest aktéra", async () => {
    const session = await requireSession();

    expect(session.user.email).toBe("admin@example.cz");
    await expect(actorFromRequest()).resolves.toMatchObject({
      userId: session.user.id,
      source: "web",
      userAgent: "UA/1",
    });
  });

  test("requireAdmin pustí admina, běžnému uživateli vrátí 404", async () => {
    await expect(requireAdmin()).resolves.toMatchObject({ user: { role: "admin" } });

    db.update(user).set({ role: "user" }).run();

    await expect(requireAdmin()).rejects.toThrow("notFound");
  });

  test("[AUD-003] IP se čte z x-forwarded-for jen za důvěryhodnou proxy", () => {
    const headers = new Headers({ "x-forwarded-for": "6.6.6.6, 10.0.0.1" });

    expect(clientIp(headers, parseEnv(envValues))).toBeUndefined();
    expect(clientIp(headers, parseEnv({ ...envValues, TRUST_PROXY: "1" }))).toBe("10.0.0.1");
  });

  test("[AUD-003] x-request-id se přijme jen za proxy a ve správném formátu", () => {
    const trusted = parseEnv({ ...envValues, TRUST_PROXY: "1" });
    const good = new Headers({ "x-request-id": "req-1.a_B" });
    const bad = new Headers({ "x-request-id": "x y<script>" });

    expect(webActor(good, null, trusted).requestId).toBe("req-1.a_B");
    expect(webActor(good, null, parseEnv(envValues)).requestId).not.toBe("req-1.a_B");
    expect(webActor(bad, null, trusted).requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("[AUD-003] jeden požadavek má jedno ID, jiný požadavek jiné", () => {
    const env = parseEnv(envValues);
    const request = new Headers();
    const other = new Headers();

    expect(webActor(request, null, env).requestId).toBe(webActor(request, "u1", env).requestId);
    expect(webActor(other, null, env).requestId).not.toBe(webActor(request, null, env).requestId);
    expect(webActor(undefined, null, env).requestId).not.toBe(
      webActor(undefined, null, env).requestId,
    );
  });
});
