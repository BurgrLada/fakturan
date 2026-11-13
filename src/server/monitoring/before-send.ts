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
// Bearer tokens: invitation links, Better Auth's /reset-password/<token> (and its
// `reset-password:<token>` verification identifier), and ?token= / ?callbackURL= query values.
const PATH_TOKEN = /(\/(?:pozvanka|reset-password)\/)[^/?#\s"']+/g;
const ID_TOKEN = /(reset-password:)[^\s"'&?#/]+/g;
const QUERY_TOKEN = /([?&](?:token|callbackURL)=)[^&#\s"']*/gi;

function clean(text: string): string {
  return text
    .replace(EMAIL, "[e-mail]")
    .replace(PATH_TOKEN, "$1[token]")
    .replace(ID_TOKEN, "$1[token]")
    .replace(QUERY_TOKEN, "$1[token]");
}

// A mail server's reply (`550 5.1.1 ...`) can quote addresses and content (R-30).
const SERVER_REPLY = /\b[245]\d{2}(?:[ -]\d\.\d{1,3}\.\d{1,3})?[ -]\S[^\r\n]*/g;

export function scrubText(text: string): string {
  return clean(text).replace(SERVER_REPLY, "[odpověď serveru]");
}

function cleanUrl(raw: string): string {
  return clean(raw.split(/[?#]/)[0]);
}

type Frame = NonNullable<
  NonNullable<NonNullable<Event["exception"]>["values"]>[number]["stacktrace"]
>["frames"];

function cleanFrames(frames: Frame) {
  return frames?.map(({ filename, function: fn, module, lineno, colno, in_app, abs_path }) => ({
    filename: filename && clean(filename),
    function: fn,
    module,
    lineno,
    colno,
    in_app,
    abs_path: abs_path && clean(abs_path),
  }));
}

// Set by reportFailure from job metadata, the only tags that identify a failed job (R-30), and the
// name of a failed MCP tool, never its arguments (MCP-036).
const ALLOWED_TAGS = ["task", "kind", "job_id", "mcp.tool"] as const;

// Allowlist: a field not copied here (headers, cookies, bodies, extra, other tags, contexts, spans,
// breadcrumbs, frame variables) never leaves the instance (MON-004).
export function scrubEvent<T extends Event>(event: T): T {
  const out: Event = {};
  for (const key of [
    "event_id",
    "timestamp",
    "start_timestamp",
    "type",
    "level",
    "platform",
    "environment",
    "release",
    "sdk",
  ] as const) {
    if (event[key] !== undefined) (out as Record<string, unknown>)[key] = event[key];
  }
  const tags = ALLOWED_TAGS.filter((key) => event.tags?.[key] !== undefined);
  if (tags.length) out.tags = Object.fromEntries(tags.map((key) => [key, event.tags?.[key]]));
  if (event.user?.id !== undefined) out.user = { id: event.user.id };
  if (event.message) out.message = scrubText(event.message);
  if (event.transaction) out.transaction = cleanUrl(event.transaction);
  if (event.request) {
    const { method, url } = event.request;
    out.request = {
      ...(method === undefined ? {} : { method }),
      ...(url === undefined ? {} : { url: cleanUrl(url) }),
    };
  }
  const trace = event.contexts?.trace;
  if (trace) {
    const { trace_id, span_id, parent_span_id, op, status } = trace;
    out.contexts = { trace: { trace_id, span_id, parent_span_id, op, status } };
  }
  if (event.exception?.values) {
    out.exception = {
      values: event.exception.values.map(({ type, value, mechanism, stacktrace }) => ({
        type,
        value: value === undefined ? undefined : scrubText(value),
        mechanism,
        stacktrace: stacktrace && { frames: cleanFrames(stacktrace.frames) },
      })),
    };
  }
  return out as T;
}
