import "server-only";
import { randomUUID } from "node:crypto";
import type { Actor } from "../audit/context";
import type { Env } from "../env";

const REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

// The last entry is the one our own proxy appended; anything before it is client-supplied.
export function clientIp(headers: Headers, env: Env): string | undefined {
  if (!env.TRUST_PROXY) return undefined;
  return headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() || undefined;
}

function trustedRequestId(headers: Headers | undefined, env: Env): string | undefined {
  if (!env.TRUST_PROXY) return undefined;
  const id = headers?.get("x-request-id");
  return id && REQUEST_ID.test(id) ? id : undefined;
}

export function webActor(headers: Headers | undefined, userId: string | null, env: Env): Actor {
  return {
    userId,
    source: "web",
    ip: headers && clientIp(headers, env),
    userAgent: headers?.get("user-agent") ?? undefined,
    requestId: trustedRequestId(headers, env) ?? randomUUID(),
  };
}
