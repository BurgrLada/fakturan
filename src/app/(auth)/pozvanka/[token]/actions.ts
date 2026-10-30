"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { INVITE_COOKIE } from "@/server/auth/signup-guard";
import { clock } from "@/server/clock";
import { env } from "@/server/env";
import { inspectInvitation } from "@/server/services/invitations";

const tokenInput = z.string().min(1).max(128);

export async function acceptInvitationAction(raw: unknown): Promise<void> {
  const token = tokenInput.safeParse(raw);
  if (!token.success) redirect("/prihlaseni");
  const check = inspectInvitation(token.data);
  if (check.status !== "valid") redirect(`/pozvanka/${encodeURIComponent(token.data)}`);
  // Lax: the Apple callback arrives as a cross-site POST that Better Auth bounces into a GET, and
  // only a top-level GET carries this cookie.
  (await cookies()).set(INVITE_COOKIE, token.data, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.BETTER_AUTH_URL.startsWith("https://"),
    path: "/",
    maxAge: Math.floor((check.expiresAt.getTime() - clock.now().getTime()) / 1000),
  });
  redirect("/registrace");
}
