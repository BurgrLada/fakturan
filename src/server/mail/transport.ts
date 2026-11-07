import "server-only";
import { isIP } from "node:net";
import { createTransport } from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";

export type MailAddress = string | { name: string; address: string };

// `cid` makes it an inline image the HTML refers to as cid:<cid>.
export type MailAttachment = {
  filename: string;
  content: Buffer;
  contentType?: string;
  cid?: string;
};

export type MailMessage = {
  messageId?: string;
  from: MailAddress;
  replyTo?: string;
  to: string | string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  html?: string;
  attachments?: MailAttachment[];
};

export type MailIdentity = {
  from: MailAddress;
  replyTo?: string;
  cc: string[];
  bcc: string[];
};

export type SendResult = { accepted: string[]; rejected: string[] };

export type MailTransport = {
  source: "user" | "instance";
  identity: MailIdentity;
  send(msg: MailMessage): Promise<SendResult>;
};

export type SmtpTarget = {
  host: string;
  port: number;
  auth?: { user: string; pass: string | undefined };
};

// Set only for a user's server: `servername` is the name typed in, `target.host` the checked IP.
export type VerifiedHost = { servername: string; isPrivate: boolean };

// nodemailer's defaults allow 2 min to connect and 10 min of silence, far past the job lease.
export const SEND_TIMEOUTS = {
  connectionTimeout: 15_000,
  greetingTimeout: 10_000,
  socketTimeout: 30_000,
};

export function smtpOptions(target: SmtpTarget, verified?: VerifiedHost): SMTPTransport.Options {
  const secure = target.port === 465;
  return {
    host: target.host,
    port: target.port,
    secure,
    auth: target.auth,
    logger: false,
    debug: false,
    ...(verified && {
      requireTLS: !secure && !verified.isPrivate,
      ...SEND_TIMEOUTS,
      ...(isIP(verified.servername) ? {} : { tls: { servername: verified.servername } }),
    }),
  };
}

export function buildTransport(target: SmtpTarget, verified?: VerifiedHost) {
  return createTransport(smtpOptions(target, verified));
}

const addressOf = (entry: string | { address: string }) =>
  typeof entry === "string" ? entry : entry.address;

const quiet = () => {};

export async function deliver(
  target: SmtpTarget,
  verified: VerifiedHost | undefined,
  msg: MailMessage,
  timeouts = SEND_TIMEOUTS,
): Promise<SendResult> {
  // The transaction log is the only place nodemailer reveals the phase: every lost connection is
  // reported as command CONN. tests/unit/smtp-errors.test.ts pins this against the real package.
  let reachedData = false;
  const logger = {
    level: quiet,
    trace: quiet,
    info: quiet,
    warn: quiet,
    error: quiet,
    fatal: quiet,
    debug(entry: object, message?: unknown) {
      if ((entry as { tnx?: string }).tnx === "client" && message === "DATA") reachedData = true;
    },
  };
  const transport = createTransport({
    ...smtpOptions(target, verified),
    ...timeouts,
    logger,
    debug: true,
  });
  try {
    const info = await transport.sendMail(msg);
    return { accepted: info.accepted.map(addressOf), rejected: info.rejected.map(addressOf) };
  } catch (error) {
    throw Object.assign(error as Error, { reachedData });
  }
}
