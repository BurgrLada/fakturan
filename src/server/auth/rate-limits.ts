import "server-only";
import { isIPv4, isIPv6 } from "node:net";
import type { GenericEndpointContext } from "better-auth";
import { APIError } from "better-auth/api";
import type { Env } from "../env";
import { checkRateLimit, RATE_RULES, type RateRule } from "../rate-limit";
import { validEmail, recordAuthEvent } from "./audit-hooks";
import { clientIp } from "./request-actor";

function ipv6Groups(ip: string): number[] {
  let text = ip.toLowerCase().split("%")[0];
  const tail = text.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (tail) {
    const [a, b, c, d] = tail.slice(1).map(Number);
    text =
      text.slice(0, tail.index) + ((a << 8) | b).toString(16) + ":" + ((c << 8) | d).toString(16);
  }
  const [head, rest] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = rest ? rest.split(":") : [];
  const zeros = text.includes("::") ? Array<string>(8 - left.length - right.length).fill("0") : [];
  return [...left, ...zeros, ...right].map((g) => parseInt(g, 16));
}

// One subscriber typically owns a whole /64, so a per-address key would let them rotate freely;
// IPv4-mapped addresses are the same client as the plain IPv4 form.
export function normalizeIp(ip: string): string {
  if (isIPv4(ip) || !isIPv6(ip)) return ip.toLowerCase();
  const g = ipv6Groups(ip);
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  }
  return `${g
    .slice(0, 4)
    .map((x) => x.toString(16))
    .join(":")}::/64`;
}

type Check = { rule: RateRule; key: string };

// Every demo visitor signs in with the same published e-mail, so an e-mail bucket would let one
// visitor lock the demo for everyone; its password is public anyway.
function isSharedDemoLogin(email: string, env: Env): boolean {
  return env.DEMO_MODE && email === env.DEMO_EMAIL?.toLowerCase();
}

// Without TRUST_PROXY every client shares one IP bucket: failing closed beats letting a spoofed
// header mint a fresh bucket per request.
function checksFor(ctx: GenericEndpointContext, env: Env): Check[] {
  const rawIp = ctx.headers && clientIp(ctx.headers, env);
  const ip = rawIp ? normalizeIp(rawIp) : "unknown";
  const body = (ctx.body ?? {}) as Record<string, unknown>;
  const email = validEmail(body.email);

  switch (ctx.path) {
    case "/sign-in/email":
      return [
        { rule: RATE_RULES.loginIp, key: ip },
        ...(email && !isSharedDemoLogin(email, env)
          ? [
              { rule: RATE_RULES.loginIpEmail, key: `${ip}|${email}` },
              { rule: RATE_RULES.loginEmail, key: email },
            ]
          : []),
      ];
    case "/request-password-reset":
      return [
        { rule: RATE_RULES.resetPasswordIp, key: ip },
        ...(email ? [{ rule: RATE_RULES.resetPasswordIpEmail, key: `${ip}|${email}` }] : []),
      ];
    // Both write an audit row per failure, and that row can never be deleted.
    case "/reset-password":
      return [{ rule: RATE_RULES.resetPasswordSubmitIp, key: ip }];
    case "/callback/:id":
      return [{ rule: RATE_RULES.socialCallbackIp, key: ip }];
    case "/send-verification-email":
      return [{ rule: RATE_RULES.verificationMailIp, key: ip }];
    case "/sign-in/social":
      return [{ rule: RATE_RULES.socialLoginIp, key: ip }];
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
    if (result.firstDenial) {
      recordAuthEvent(ctx, env, {
        action: "rate_limit.exceeded",
        ownerId: null,
        entity: "rate_limit",
        entityId: null,
        after: { rule: rule.name, path: ctx.path, retryAfterSeconds: result.retryAfterSeconds },
      });
    }
    throw new APIError(
      "TOO_MANY_REQUESTS",
      { code: "RATE_LIMITED", message: "Příliš mnoho pokusů, zkuste to později" },
      { "Retry-After": String(result.retryAfterSeconds) },
    );
  }
}
