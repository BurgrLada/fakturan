import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  createInvitationAction,
  deleteUserAction,
  setRoleAction,
} from "@/app/(app)/administrace/actions";
import { acceptInvitationAction } from "@/app/(auth)/pozvanka/[token]/actions";
import { auth } from "@/server/auth";
import { INVITE_COOKIE } from "@/server/auth/signup-guard";
import { instanceMeta, invitation, rateLimit, user } from "@/server/db/schema";
import { createInvitation } from "@/server/services/invitations";
import { deactivateUser } from "@/server/services/users";
import { Browser, BASE, type Auth } from "../helpers/auth-browser";
import { createTestDb } from "../helpers/db";

const next = vi.hoisted(() => ({
  headers: new Headers(),
  setCookie: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: async () => next.headers,
  cookies: async () => ({ set: next.setCookie }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirect:${url}`);
  },
  notFound: () => {
    throw new Error("notFound");
  },
}));

vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-actions-")));
vi.stubEnv("BETTER_AUTH_URL", BASE);
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));

const db = createTestDb();

async function browsers() {
  const adminBrowser = new Browser(auth as unknown as Auth);
  await adminBrowser.signUp("admin@example.cz");
  const adminUser = (await adminBrowser.sessionUser())!;
  const { url } = await createInvitation(
    { userId: adminUser.id, source: "web" },
    "user@example.cz",
  );
  const userBrowser = new Browser(auth as unknown as Auth);
  userBrowser.cookies.set("fakturan_invite", url.split("/").at(-1)!);
  await userBrowser.signUp("user@example.cz");
  return { adminBrowser, adminUser, userBrowser, plainUser: (await userBrowser.sessionUser())! };
}

function as(browser: Browser) {
  next.headers = new Headers({ cookie: browser.cookieHeader(), "user-agent": "vitest" });
}

beforeEach(() => {
  db.delete(rateLimit).run();
  db.delete(user).run();
  db.delete(invitation).run();
  db.delete(instanceMeta).run();
  next.setCookie.mockReset();
});

describe("akce administrace", () => {
  test("[ADM-001] akce běžného uživatele skončí jako 404", async () => {
    const { userBrowser, plainUser } = await browsers();
    as(userBrowser);

    await expect(createInvitationAction({ email: "x@example.cz" })).rejects.toThrow("notFound");
    await expect(setRoleAction({ userId: plainUser.id, role: "admin" })).rejects.toThrow(
      "notFound",
    );
    expect(db.select().from(user).where(eq(user.id, plainUser.id)).get()?.role).toBe("user");
  });

  test("[ADM-005] server action deaktivovaného administrátora selže", async () => {
    const { adminBrowser, adminUser, plainUser } = await browsers();
    db.update(user).set({ role: "admin" }).where(eq(user.id, plainUser.id)).run();
    deactivateUser({ userId: plainUser.id, source: "web" }, adminUser.id);
    as(adminBrowser);

    await expect(createInvitationAction({ email: "x@example.cz" })).rejects.toThrow(
      "redirect:/prihlaseni",
    );
  });

  test("[ADM-003] akce odmítne neplatný vstup a službu nevolá", async () => {
    const { adminBrowser, plainUser } = await browsers();
    as(adminBrowser);

    await expect(createInvitationAction({ email: "neni-email" })).resolves.toMatchObject({
      ok: false,
    });
    await expect(
      setRoleAction({ userId: plainUser.id, role: "root" as "admin" }),
    ).resolves.toMatchObject({ ok: false });
    await expect(deleteUserAction({ userId: 1 as unknown as string })).resolves.toMatchObject({
      ok: false,
    });
  });

  test("[ADM-003] akce vrátí kopírovatelný odkaz", async () => {
    const { adminBrowser } = await browsers();
    as(adminBrowser);

    const result = await createInvitationAction({ email: "novy@example.cz" });

    expect(result).toMatchObject({ ok: true, mailSent: false });
    expect(result.ok && result.url).toContain("/pozvanka/");
  });

  test("[ADM-006] akce vrátí chybu při neshodě e-mailu", async () => {
    const { adminBrowser, plainUser } = await browsers();
    as(adminBrowser);

    await expect(
      deleteUserAction({ userId: plainUser.id, confirmEmail: "jiny@example.cz" }),
    ).resolves.toEqual({ ok: false, error: "Opsaný e-mail nesouhlasí" });
  });
});

describe("přijetí pozvánky", () => {
  test("[AUTH-007] platná pozvánka nastaví cookie, kterou čte registrace", async () => {
    const { adminUser } = await browsers();
    const { url } = await createInvitation(
      { userId: adminUser.id, source: "web" },
      "host@example.cz",
    );
    const token = url.split("/").at(-1)!;

    await expect(acceptInvitationAction(token)).rejects.toThrow("redirect:/registrace");

    expect(next.setCookie).toHaveBeenCalledWith(
      INVITE_COOKIE,
      token,
      expect.objectContaining({ httpOnly: true, sameSite: "lax", path: "/" }),
    );
  });

  test("[ADM-003] neplatná pozvánka cookie nenastaví", async () => {
    await expect(acceptInvitationAction("neplatny")).rejects.toThrow("redirect:/pozvanka/neplatny");

    expect(next.setCookie).not.toHaveBeenCalled();
  });
});
