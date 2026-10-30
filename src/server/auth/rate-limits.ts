import "server-only";
import type { GenericEndpointContext } from "better-auth";
import { APIError } from "better-auth/api";
import type { Env } from "../env";
import { checkRateLimit, RATE_RULES, type RateRule } from "../rate-limit";
import { validEmail, recordAuthEvent } from "./audit-hooks";
import { clientIp } from "./request-actor";

type Check = { rule: RateRule; key: string };

// Without TRUST_PROXY every client shares one IP bucket: failing closed beats letting a spoofed
// header mint a fresh bucket per request.
function checksFor(ctx: GenericEndpointContext, env: Env): Check[] {
  const ip = (ctx.headers && clientIp(ctx.headers, env)) || "unknown";
  const body = (ctx.body ?? {}) as Record<string, unknown>;
  const email = validEmail(body.email);

  switch (ctx.path) {
    case "/sign-in/email":
      return [
        ...(email ? [{ rule: RATE_RULES.loginIpEmail, key: `${ip}|${email}` }] : []),
        { rule: RATE_RULES.loginIp, key: ip },
      ];
    case "/request-password-reset":
      return email ? [{ rule: RATE_RULES.resetPasswordEmail, key: email }] : [];
    case "/sign-up/email":
      return [{ rule: RATE_RULES.signupIp, key: ip }];
    default:
      return [];
  }
}

export function enforceAuthRateLimit(ctx: GenericEndpointContext, env: Env): void {
  for (const { rule, key } of checksFor(ctx, env)) {
    const result = checkRateLimit(key, rule);
    if (result.allowed) continue;
    recordAuthEvent(ctx, env, {
      action: "rate_limit.exceeded",
      ownerId: null,
      entity: "rate_limit",
      entityId: null,
      after: { rule: rule.name, path: ctx.path, retryAfterSeconds: result.retryAfterSeconds },
    });
    throw new APIError(
      "TOO_MANY_REQUESTS",
      { code: "RATE_LIMITED", message: "Příliš mnoho pokusů, zkuste to později" },
      { "Retry-After": String(result.retryAfterSeconds) },
    );
  }
}
