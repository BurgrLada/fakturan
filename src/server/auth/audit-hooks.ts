import "server-only";
import type { GenericEndpointContext } from "better-auth";
import { isAPIError } from "better-auth/api";
import { z } from "zod";
import { emailHash } from "../audit/email-hash";
import type { AuditAction } from "../audit/record";
import type { Env } from "../env";
import { mutate } from "../services/mutation";
import { webActor } from "./request-actor";

type Ctx = GenericEndpointContext;

type AuthEvent = {
  action: AuditAction;
  actorId?: string | null;
  ownerId: string | null;
  entity?: string;
  entityId?: string | null;
  after?: unknown;
};

const LOGIN_METHODS: Record<string, string> = {
  "/sign-in/email": "password",
  "/sign-up/email": "password",
  "/verify-email": "email-link",
};

// Every failed social login ends here: a distinct reason would reveal whether an account exists.
export const SOCIAL_REJECTED_PATH = "/prihlaseni?chyba=pozvanka";

// Paths that act on the signed-in user; revocations are audited per deleted session. Sign-out and
// single revocations are audited in the before hook, as those endpoints swallow session-delete errors.
const USER_EVENTS: Record<string, AuditAction> = {
  "/change-password": "auth.password_change",
  "/change-email": "auth.email_change_request",
  "/update-user": "auth.profile_update",
  "/unlink-account": "auth.account_unlink",
};

const SESSION_END_PATHS = new Set([
  "/revoke-other-sessions",
  "/change-password",
  "/reset-password",
]);

export function validEmail(value: unknown): string | null {
  return z.email().safeParse(value).success ? (value as string).toLowerCase() : null;
}

export function recordAuthEvent(
  ctx: { headers?: Headers } | null | undefined,
  env: Env,
  { action, actorId = null, ownerId, entity = "user", entityId = ownerId, after }: AuthEvent,
): void {
  mutate(webActor(ctx?.headers, actorId, env), action, (_tx, audit) =>
    audit({ entity, entityId, ownerId, scope: "instance", after }),
  );
}

async function ownerOfEmail(ctx: Ctx, email: string | null): Promise<string | null> {
  if (!email) return null;
  return (await ctx.context.internalAdapter.findUserByEmail(email))?.user.id ?? null;
}

function oauthError(ctx: Ctx, env: Env): { location: string; reason: string } | null {
  const { returned } = ctx.context as { returned?: unknown };
  if (!isAPIError(returned)) return null;
  const location = new Headers(returned.headers).get("location");
  if (!location) return null;
  const reason = new URL(location, env.BETTER_AUTH_URL).searchParams.get("error");
  return reason ? { location, reason } : null;
}

// An ownerless row outlives account deletion, so it must not hold the plain address (AUD-010).
function emailFields(email: string | null, ownerId: string | null, env: Env) {
  if (ownerId || !email) return { email };
  return { emailHash: emailHash(email, env) };
}

function failure(ctx: Ctx): { code: string | undefined } | null {
  const { returned } = ctx.context as { returned?: unknown };
  if (!isAPIError(returned) || returned.statusCode < 400) return null;
  return { code: returned.body?.code };
}

export async function auditAuthEndpoint(ctx: Ctx, env: Env): Promise<void> {
  const body = (ctx.body ?? {}) as Record<string, unknown>;
  const newSession = ctx.context.newSession;
  const failed = failure(ctx);
  const isOAuthCallback = ctx.path === "/callback/:id";

  const loginMethod = isOAuthCallback ? ctx.params?.id : LOGIN_METHODS[ctx.path];
  if (newSession && loginMethod) {
    recordAuthEvent(ctx, env, {
      action: "auth.login",
      actorId: newSession.user.id,
      ownerId: newSession.user.id,
      after: { method: loginMethod },
    });
    return;
  }

  if (isOAuthCallback) {
    const rejected = oauthError(ctx, env);
    if (!rejected) return;
    recordAuthEvent(ctx, env, {
      action: "auth.login_failed",
      ownerId: null,
      after: { method: ctx.params?.id, reason: rejected.reason },
    });
    throw ctx.redirect(new URL(SOCIAL_REJECTED_PATH, env.BETTER_AUTH_URL).href);
  }

  if (ctx.path === "/sign-in/email" && failed) {
    const email = validEmail(body.email);
    const ownerId = await ownerOfEmail(ctx, email);
    recordAuthEvent(ctx, env, {
      action: "auth.login_failed",
      ownerId,
      after: { ...emailFields(email, ownerId, env), reason: failed.code },
    });
    return;
  }

  if (ctx.path === "/request-password-reset" && !failed) {
    const email = validEmail(body.email);
    const ownerId = await ownerOfEmail(ctx, email);
    recordAuthEvent(ctx, env, {
      action: "auth.password_reset_request",
      ownerId,
      after: emailFields(email, ownerId, env),
    });
    return;
  }

  if (ctx.path === "/reset-password" && failed) {
    recordAuthEvent(ctx, env, {
      action: "auth.password_reset_failed",
      ownerId: null,
      after: { reason: failed.code },
    });
    return;
  }

  const action = USER_EVENTS[ctx.path];
  if (!action) return;
  const userId = newSession?.user.id ?? ctx.context.session?.user.id ?? null;
  recordAuthEvent(ctx, env, {
    action: failed ? `${action}_failed` : action,
    actorId: userId,
    ownerId: userId,
    after: failed ? { reason: failed.code } : undefined,
  });
}

export function auditRevocations(
  ctx: Ctx,
  env: Env,
  userId: string,
  sessions: { id: string }[],
): void {
  for (const { id } of sessions) {
    recordAuthEvent(ctx, env, {
      action: "auth.session_revoke",
      actorId: userId,
      ownerId: userId,
      entity: "session",
      entityId: id,
      after: { path: ctx.path },
    });
  }
}

export function auditSessionEnd(
  ctx: Ctx | null | undefined,
  env: Env,
  session: { id: string; userId: string },
): void {
  if (!ctx || !SESSION_END_PATHS.has(ctx.path)) return;
  recordAuthEvent(ctx, env, {
    action: "auth.session_revoke",
    actorId: session.userId,
    ownerId: session.userId,
    entity: "session",
    entityId: session.id,
    after: { path: ctx.path },
  });
}
