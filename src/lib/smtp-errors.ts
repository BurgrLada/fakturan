export type SmtpClass = "retry" | "permanent" | "ambiguous";

type Failure = {
  name?: unknown;
  temporary?: unknown;
  code?: unknown;
  response?: unknown;
  responseCode?: unknown;
  reachedData?: unknown;
};

const MAX_REASON_CHARS = 200;

const REFUSED_BEFORE_SENDING = new Set(["EENVELOPE", "EMESSAGE", "EAUTH", "ENOAUTH"]);
const CONNECTION_LOST = new Set([
  "ECONNECTION",
  "ESOCKET",
  "ETIMEDOUT",
  "EDNS",
  "ETLS",
  "EPROTOCOL",
]);

// A retry can duplicate a message, so everything not proven safe is ambiguous (R-1). nodemailer
// reports every lost connection as command CONN, whatever phase it was in, so only `reachedData`
// from `deliver` tells the phases apart. Any reply from the server is its verdict on the message.
export function classifySmtpError(error: unknown): SmtpClass {
  const failure = (error ?? {}) as Failure;
  if (failure.name === "BlockedHostError") return failure.temporary ? "retry" : "permanent";
  const reply = typeof failure.responseCode === "number" ? failure.responseCode : 0;
  if (reply >= 500 && reply < 600) return "permanent";
  if (reply >= 400 && reply < 500) return "retry";
  if (failure.reachedData !== false) return "ambiguous";
  const code = String(failure.code);
  if (REFUSED_BEFORE_SENDING.has(code)) return "permanent";
  return CONNECTION_LOST.has(code) ? "retry" : "ambiguous";
}

export function smtpFailureText(error: unknown): string | null {
  const { response } = (error ?? {}) as Failure;
  if (typeof response !== "string" || !response) return null;
  return response
    .replace(/\s*[\r\n]+\s*/g, " ")
    .trim()
    .slice(0, MAX_REASON_CHARS);
}
