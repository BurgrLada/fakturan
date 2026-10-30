import "server-only";
import { randomUUID } from "node:crypto";
import type { Actor } from "../audit/context";
import type { Env } from "../env";

// The last entry is the one our own proxy appended; anything before it is client-supplied.
export function clientIp(headers: Headers, env: Env): string | undefined {
  if (!env.TRUST_PROXY) return undefined;
  return headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() || undefined;
}

export function webActor(headers: Headers | undefined, userId: string | null, env: Env): Actor {
  return {
    userId,
    source: "web",
    ip: headers && clientIp(headers, env),
    userAgent: headers?.get("user-agent") ?? undefined,
    requestId: headers?.get("x-request-id") ?? randomUUID(),
  };
}
