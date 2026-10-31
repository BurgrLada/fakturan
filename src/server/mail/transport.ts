import "server-only";
import { isIP } from "node:net";
import { createTransport } from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";

export type MailAddress = string | { name: string; address: string };

export type MailAttachment = { filename: string; content: Buffer; contentType?: string };

export type MailMessage = {
  messageId?: string;
  from: MailAddress;
  replyTo?: string;
  to: string | string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
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
      connectionTimeout: 15_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
      ...(isIP(verified.servername) ? {} : { tls: { servername: verified.servername } }),
    }),
  };
}

export function buildTransport(target: SmtpTarget, verified?: VerifiedHost) {
  return createTransport(smtpOptions(target, verified));
}

const addressOf = (entry: string | { address: string }) =>
  typeof entry === "string" ? entry : entry.address;

export async function deliver(
  transport: ReturnType<typeof buildTransport>,
  msg: MailMessage,
): Promise<SendResult> {
  const info = await transport.sendMail(msg);
  return { accepted: info.accepted.map(addressOf), rejected: info.rejected.map(addressOf) };
}
