import "server-only";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import type { Actor } from "../audit/context";
import { env } from "../env";
import { mutate } from "../services/mutation";
import { auth, type Auth } from "./index";
import { setMonitoringUser } from "../monitoring/user";
import { webActor } from "./request-actor";

export type Session = NonNullable<Awaited<ReturnType<Auth["api"]["getSession"]>>>;

// Server Components cannot set cookies, so renewal is left to the client's get-session call; a
// refresh here would extend the row while the browser cookie still expired on the old date.
export async function getCurrentSession(): Promise<Session | null> {
  const requestHeaders = await headers();
  const session = await auth.api.getSession({
    headers: requestHeaders,
    query: { disableRefresh: true },
  });
  // Deactivation deletes sessions, but a login racing it can still leave a row behind (ADM-005).
  if (!session || session.user.banned) return null;
  await setMonitoringUser(session.user.id);
  return session;
}

export function recordAdminDenial(requestHeaders: Headers, userId: string): void {
  mutate(webActor(requestHeaders, userId, env), "access.denied", (_tx, audit) =>
    audit({ entity: "route", entityId: "/administrace", ownerId: userId, scope: "instance" }),
  );
}

export async function requireSession(): Promise<Session> {
  const session = await getCurrentSession();
  if (!session) redirect("/prihlaseni");
  return session;
}

export async function requireAdmin(): Promise<Session> {
  const session = await requireSession();
  if (session.user.role !== "admin") {
    recordAdminDenial(await headers(), session.user.id);
    notFound();
  }
  return session;
}

export async function actorFromRequest(): Promise<Actor> {
  const session = await getCurrentSession();
  return webActor(await headers(), session?.user.id ?? null, env);
}
