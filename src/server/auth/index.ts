import "server-only";
import { randomUUID } from "node:crypto";
import { betterAuth, type GenericEndpointContext } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { admin } from "better-auth/plugins";
import { emailHash } from "../audit/email-hash";
import type { AuditAction } from "../audit/record";
import { db } from "../db";
import * as schema from "../db/schema";
import { env as defaultEnv, type Env } from "../env";
import { isInstanceMailConfigured, sendInstanceMail } from "../mail/instance";
import { mutate } from "../services/mutation";
import {
  auditAuthEndpoint,
  auditRevocations,
  auditSessionEnd,
  recordAuthEvent,
  SOCIAL_REJECTED_PATH,
  validEmail,
} from "./audit-hooks";
import { MIN_PASSWORD_LENGTH, passwordProblem } from "./passwords";
import { enabledProviders, socialProviders } from "./providers";
import { enforceAuthRateLimit } from "./rate-limits";
import { linkRequestHeaders, webActor } from "./request-actor";
import { canRegister, INVITE_COOKIE, isSignupOpen } from "./signup-guard";

const DAY_SECONDS = 86_400;

export const AUTH_ERROR_INVITE_REQUIRED = "INVITE_REQUIRED";

// Disabled over HTTP: these would bypass the invitation, last-admin and audit rules, and
// impersonation would let an admin read another account's data (ADM-007).
const ADMIN_PATHS = [
  "/admin/create-user",
  "/admin/set-role",
  "/admin/set-user-password",
  "/admin/update-user",
  "/admin/list-users",
  "/admin/get-user",
  "/admin/ban-user",
  "/admin/unban-user",
  "/admin/list-user-sessions",
  "/admin/revoke-user-session",
  "/admin/revoke-user-sessions",
  "/admin/remove-user",
  "/admin/has-permission",
  "/admin/impersonate-user",
  "/admin/stop-impersonating",
];

// Not 403: with mandatory email verification Better Auth turns a 403 from a user hook into a
// generic success response, which would tell a refused signup that it worked.
function inviteRequired(): APIError {
  return new APIError("BAD_REQUEST", {
    code: AUTH_ERROR_INVITE_REQUIRED,
    message: "Přístup je jen na pozvánku",
  });
}

const PASSWORD_MESSAGES = {
  PASSWORD_COMPROMISED: "Toto heslo je mezi známými uniklými hesly",
  PASSWORD_WEAK: "Toto heslo je příliš jednoduché",
};

type PasswordOwner = { id: string; email: string } | null;

function assertPasswordAllowed(
  ctx: GenericEndpointContext,
  env: Env,
  password: unknown,
  email: string | null,
  rejection?: { action: AuditAction; owner: PasswordOwner },
): void {
  if (typeof password !== "string") return;
  const problem = passwordProblem(password, email);
  if (!problem) return;
  if (rejection) {
    const ownerId = rejection.owner?.id ?? null;
    recordAuthEvent(ctx, env, {
      action: rejection.action,
      actorId: ownerId,
      ownerId,
      after: { reason: problem },
    });
  }
  throw new APIError("BAD_REQUEST", { code: problem, message: PASSWORD_MESSAGES[problem] });
}

async function auditRevocation(
  ctx: GenericEndpointContext,
  env: Env,
  userId: string,
  token: unknown,
): Promise<void> {
  const { internalAdapter } = ctx.context;
  if (ctx.path === "/revoke-sessions") {
    auditRevocations(ctx, env, userId, await internalAdapter.listSessions(userId));
    return;
  }
  const target = typeof token === "string" ? await internalAdapter.findSession(token) : null;
  if (target?.session.userId === userId) auditRevocations(ctx, env, userId, [target.session]);
}

async function resetTokenOwner(
  ctx: GenericEndpointContext,
  token: unknown,
): Promise<PasswordOwner> {
  if (typeof token !== "string") return null;
  const { internalAdapter } = ctx.context;
  const verification = await internalAdapter.findVerificationValue(`reset-password:${token}`);
  return verification ? internalAdapter.findUserById(verification.value) : null;
}

function rejectedSignupDetails(email: unknown, env: Env) {
  const valid = validEmail(email);
  return { emailHash: valid && emailHash(valid, env) };
}

function guardSignup(
  ctx: GenericEndpointContext | null,
  env: Env,
  newUser: { email: string; emailVerified: boolean },
) {
  const isSocial = ctx?.path === "/callback/:id";
  // Chosen here so the invitation and its audit row can name the user before Better Auth inserts it.
  const userId = randomUUID();
  const hashed = { emailHash: emailHash(newUser.email, env) };
  const decision = mutate(
    webActor(ctx?.headers, null, env),
    "auth.signup_rejected",
    (tx, audit) => {
      const result = canRegister(tx, newUser.email, ctx?.getCookie(INVITE_COOKIE) ?? undefined, {
        social: isSocial,
        verifiedEmail: newUser.emailVerified,
        userId,
      });
      const base = { entity: "user", entityId: null, ownerId: null, scope: "instance" } as const;
      if (!result.allowed) {
        audit({ ...base, after: hashed });
      } else if (result.invitationId) {
        audit({
          ...base,
          action: "invitation.accept",
          entity: "invitation",
          entityId: result.invitationId,
          ownerId: userId,
          after: { ...hashed, role: result.role },
        });
      } else {
        audit({ ...base, action: "auth.first_admin", ownerId: userId, after: hashed });
      }
      return result;
    },
  );
  if (decision.allowed) return { data: { id: userId, role: decision.role } };
  if (isSocial) throw ctx.redirect(new URL(SOCIAL_REJECTED_PATH, env.BETTER_AUTH_URL).href);
  throw inviteRequired();
}

export function createAuth(env: Env) {
  const mailEnabled = isInstanceMailConfigured(env);

  const mail = (to: string, subject: string, text: string) =>
    sendInstanceMail({ to, subject, text }, env);

  return betterAuth({
    appName: "Fakturan",
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, { provider: "sqlite", schema }),
    telemetry: { enabled: false },
    disabledPaths: ADMIN_PATHS,
    rateLimit: { enabled: false },
    advanced: {
      useSecureCookies: env.BETTER_AUTH_URL.startsWith("https://"),
      ipAddress: env.TRUST_PROXY
        ? { ipAddressHeaders: ["x-forwarded-for"] }
        : { disableIpTracking: true },
    },
    trustedOrigins: enabledProviders(env).includes("apple") ? ["https://appleid.apple.com"] : [],
    onAPIError: { errorURL: "/prihlaseni" },
    socialProviders: socialProviders(env),
    plugins: [admin({ defaultRole: "user", adminRoles: ["admin"] })],
    account: { encryptOAuthTokens: true },
    session: { expiresIn: 30 * DAY_SECONDS, updateAge: DAY_SECONDS },
    user: {
      changeEmail: { enabled: mailEnabled },
      additionalFields: {
        theme: { type: "string", required: false, defaultValue: "system", input: false },
      },
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      requireEmailVerification: mailEnabled,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: 3600,
      sendResetPassword: mailEnabled
        ? ({ user, url }) =>
            mail(
              user.email,
              "Obnova hesla ve Fakturanu",
              `Heslo obnovíte na této adrese, odkaz platí 1 hodinu:\n\n${url}\n`,
            )
        : undefined,
      onPasswordReset: async ({ user }, request) => {
        recordAuthEvent({ headers: request?.headers }, env, {
          action: "auth.password_reset",
          actorId: user.id,
          ownerId: user.id,
        });
      },
    },
    emailVerification: {
      sendOnSignUp: mailEnabled,
      sendOnSignIn: mailEnabled,
      autoSignInAfterVerification: true,
      sendVerificationEmail: mailEnabled
        ? ({ user, url }) =>
            mail(
              user.email,
              "Potvrzení e-mailu ve Fakturanu",
              `Adresu potvrdíte kliknutím na tento odkaz:\n\n${url}\n`,
            )
        : undefined,
    },
    databaseHooks: {
      user: {
        create: {
          before: async (newUser, ctx) => guardSignup(ctx, env, newUser),
          after: async (created, ctx) => {
            recordAuthEvent(ctx, env, {
              action: "user.create",
              actorId: created.id,
              ownerId: created.id,
              after: { email: created.email, name: created.name, role: created.role },
            });
          },
        },
        update: {
          after: async (updated, ctx) => {
            recordAuthEvent(ctx, env, {
              action: "user.update",
              actorId: ctx?.context.session?.user.id ?? null,
              ownerId: updated.id,
              after: {
                email: updated.email,
                emailVerified: updated.emailVerified,
                name: updated.name,
                role: updated.role,
                banned: updated.banned,
              },
            });
          },
        },
      },
      account: {
        create: {
          after: async (created, ctx) => {
            recordAuthEvent(ctx, env, {
              action: "account.link",
              actorId: created.userId,
              ownerId: created.userId,
              entity: "account",
              entityId: created.id,
              after: { providerId: created.providerId },
            });
          },
        },
      },
      session: {
        delete: { after: async (deleted, ctx) => auditSessionEnd(ctx, env, deleted) },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        linkRequestHeaders(ctx.headers, ctx.request?.headers);
        const body = (ctx.body ?? {}) as Record<string, unknown>;
        enforceAuthRateLimit(ctx, env);
        if (ctx.path === "/sign-up/email") {
          if (!isSignupOpen(db, ctx.getCookie(INVITE_COOKIE) ?? undefined)) {
            recordAuthEvent(ctx, env, {
              action: "auth.signup_rejected",
              ownerId: null,
              after: rejectedSignupDetails(body.email, env),
            });
            throw inviteRequired();
          }
          assertPasswordAllowed(ctx, env, body.password, validEmail(body.email));
        }
        if (ctx.path === "/sign-out") {
          const current = await getSessionFromCtx(ctx, { disableRefresh: true });
          if (current) {
            recordAuthEvent(ctx, env, {
              action: "auth.logout",
              actorId: current.user.id,
              ownerId: current.user.id,
              entity: "session",
              entityId: current.session.id,
            });
          }
        }
        if (ctx.path === "/revoke-session" || ctx.path === "/revoke-sessions") {
          const current = await getSessionFromCtx(ctx, { disableRefresh: true });
          if (current) await auditRevocation(ctx, env, current.user.id, body.token);
        }
        if (ctx.path === "/reset-password") {
          const owner = await resetTokenOwner(ctx, body.token ?? ctx.query?.token);
          assertPasswordAllowed(ctx, env, body.newPassword, owner?.email ?? null, {
            action: "auth.password_reset_failed",
            owner,
          });
        }
        if (ctx.path === "/change-password") {
          const owner = (await getSessionFromCtx(ctx, { disableRefresh: true }))?.user ?? null;
          assertPasswordAllowed(ctx, env, body.newPassword, owner?.email ?? null, {
            action: "auth.password_change_failed",
            owner,
          });
          return { context: { body: { ...body, revokeOtherSessions: true } } };
        }
      }),
      after: createAuthMiddleware(async (ctx) => auditAuthEndpoint(ctx, env)),
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

let cached: Auth | undefined;

// Lazy, so `next build` does not need secrets.
export const auth: Auth = new Proxy({} as Auth, {
  get(_, prop) {
    cached ??= createAuth(defaultEnv);
    return cached[prop as keyof Auth];
  },
});
