import type { Event } from "@sentry/nextjs";

// First line of defence: the SDK does not collect these. scrubEvent is the second.
export const DATA_COLLECTION = {
  userInfo: false,
  cookies: false,
  httpHeaders: false,
  httpBodies: [],
  urlQueryParams: false,
  databaseQueryData: false,
  queues: false,
  stackFrameVariables: false,
} as const;

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
// Invitation links carry a bearer token in the path.
const PATH_TOKEN = /(\/pozvanka\/)[^/?#]+/;

function redact(text: string): string {
  return text.replace(EMAIL, "[e-mail]");
}

function safeUrl(raw: string): string {
  const withoutQuery = raw.split(/[?#]/)[0];
  return withoutQuery.replace(PATH_TOKEN, "$1[token]");
}

// Whitelist by construction: anything not copied here (headers, cookies, bodies, extra data,
// breadcrumbs) never leaves the instance (MON-004).
export function scrubEvent<T extends Event>(event: T): T {
  const out: Event = { ...event };
  out.user = event.user?.id === undefined ? undefined : { id: event.user.id };
  if (event.request) {
    const { method, url } = event.request;
    out.request = {
      ...(method === undefined ? {} : { method }),
      ...(url === undefined ? {} : { url: safeUrl(url) }),
    };
  }
  delete out.extra;
  delete out.breadcrumbs;
  delete out.server_name;
  if (out.message) out.message = redact(out.message);
  if (event.exception?.values) {
    out.exception = {
      values: event.exception.values.map((v) =>
        v.value === undefined ? v : { ...v, value: redact(v.value) },
      ),
    };
  }
  return out as T;
}
