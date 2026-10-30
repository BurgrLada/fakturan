import "server-only";
import { randomUUID } from "node:crypto";
import type { Actor } from "../audit/context";
import type { Env } from "../env";

const REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

// One Headers object stands for one request: next/headers returns the same one throughout, and
// Better Auth keeps one ctx.headers per endpoint call. Each endpoint call gets its own copy though,
// so a server action making two auth.api calls yields two ids.
const generatedIds = new WeakMap<Headers, string>();

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

function requestId(headers: Headers | undefined, env: Env): string {
  const trusted = trustedRequestId(headers, env);
  if (trusted) return trusted;
  if (!headers) return randomUUID();
  const id = generatedIds.get(headers) ?? randomUUID();
  generatedIds.set(headers, id);
  return id;
}

// Better Auth hands callbacks ctx.request, whose headers are not the ctx.headers copy.
export function linkRequestHeaders(headers?: Headers, requestHeaders?: Headers): void {
  if (!headers || !requestHeaders) return;
  const id = generatedIds.get(headers) ?? randomUUID();
  generatedIds.set(headers, id);
  generatedIds.set(requestHeaders, id);
}

export function webActor(headers: Headers | undefined, userId: string | null, env: Env): Actor {
  return {
    userId,
    source: "web",
    ip: headers && clientIp(headers, env),
    userAgent: headers?.get("user-agent") ?? undefined,
    requestId: requestId(headers, env),
  };
}
