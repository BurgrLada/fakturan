import "server-only";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import type { Actor } from "../audit/context";
import { env } from "../env";
import { auth, type Auth } from "./index";
import { webActor } from "./request-actor";

export type Session = NonNullable<Awaited<ReturnType<Auth["api"]["getSession"]>>>;

// Server Components cannot set cookies, so renewal is left to the client's get-session call; a
// refresh here would extend the row while the browser cookie still expired on the old date.
export async function getCurrentSession(): Promise<Session | null> {
  const requestHeaders = await headers();
  return auth.api.getSession({ headers: requestHeaders, query: { disableRefresh: true } });
}

export async function requireSession(): Promise<Session> {
  const session = await getCurrentSession();
  if (!session) redirect("/prihlaseni");
  return session;
}

export async function requireAdmin(): Promise<Session> {
  const session = await requireSession();
  if (session.user.role !== "admin") notFound();
  return session;
}

export async function actorFromRequest(): Promise<Actor> {
  const session = await getCurrentSession();
  return webActor(await headers(), session?.user.id ?? null, env);
}
