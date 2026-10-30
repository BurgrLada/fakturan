import { vi } from "vitest";
import type { createAuth } from "@/server/auth";

export type Auth = ReturnType<typeof createAuth>;

export const BASE = "http://localhost:3000";
export const PASSWORD = "správné-kůň-baterie-sponka";

export class Browser {
  cookies = new Map<string, string>();

  constructor(readonly auth: Auth) {}

  cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  async request(path: string, init: { method?: string; body?: unknown; ua?: string } = {}) {
    const headers: Record<string, string> = {
      origin: BASE,
      cookie: this.cookieHeader(),
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

export function fakeGithub(email: string, verified = true) {
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

export async function githubLogin(browser: Browser) {
  const start = await browser.request("/sign-in/social", {
    body: { provider: "github", callbackURL: "/" },
  });
  const { url } = (await start.json()) as { url: string };
  const state = new URL(url).searchParams.get("state")!;
  return browser.request(`/callback/github?code=kod&state=${encodeURIComponent(state)}`);
}
