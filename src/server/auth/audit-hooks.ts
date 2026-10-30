import "server-only";
import type { GenericEndpointContext } from "better-auth";
import { isAPIError } from "better-auth/api";
import { z } from "zod";
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

const LOGIN_PATHS = new Set(["/sign-in/email", "/sign-up/email"]);

// Paths that act on the signed-in user; sign-out and revocations are audited per deleted session.
const USER_EVENTS: Record<string, AuditAction> = {
  "/change-password": "auth.password_change",
  "/change-email": "auth.email_change_request",
  "/update-user": "auth.profile_update",
  "/unlink-account": "auth.account_unlink",
};

const SESSION_END_PATHS = new Set([
  "/sign-out",
  "/revoke-session",
  "/revoke-sessions",
  "/revoke-other-sessions",
  "/change-password",
  "/reset-password",
]);

export function validEmail(value: unknown): string | null {
  return z.email().safeParse(value).success ? (value as string).toLowerCase() : null;
}

export function recordAuthEvent(
  ctx: Ctx | null | undefined,
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

  if (newSession && (LOGIN_PATHS.has(ctx.path) || isOAuthCallback)) {
    recordAuthEvent(ctx, env, {
      action: "auth.login",
      actorId: newSession.user.id,
      ownerId: newSession.user.id,
      after: { method: isOAuthCallback ? ctx.params?.id : "password" },
    });
    return;
  }

  if (ctx.path === "/sign-in/email" && failed) {
    const email = validEmail(body.email);
    recordAuthEvent(ctx, env, {
      action: "auth.login_failed",
      ownerId: await ownerOfEmail(ctx, email),
      after: { email, reason: failed.code },
    });
    return;
  }

  if (ctx.path === "/request-password-reset") {
    const email = validEmail(body.email);
    recordAuthEvent(ctx, env, {
      action: "auth.password_reset_request",
      ownerId: await ownerOfEmail(ctx, email),
      after: { email },
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

export function auditSessionEnd(
  ctx: Ctx | null | undefined,
  env: Env,
  session: { id: string; userId: string },
): void {
  if (!ctx || !SESSION_END_PATHS.has(ctx.path)) return;
  recordAuthEvent(ctx, env, {
    action: ctx.path === "/sign-out" ? "auth.logout" : "auth.session_revoke",
    actorId: session.userId,
    ownerId: session.userId,
    entity: "session",
    entityId: session.id,
    after: { path: ctx.path },
  });
}
