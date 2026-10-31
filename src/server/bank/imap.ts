import "server-only";
import { isIP } from "node:net";
import { ImapFlow, type ImapFlowOptions } from "imapflow";
import type { BankFailureCode, BankTlsMode } from "@/lib/bank-mailbox";
import { env as defaultEnv, type Env } from "../env";
import { assertPublicHost, BlockedHostError, IMAP_PORTS } from "../mail/host-guard";

export type MailboxSettings = {
  host: string;
  port: number;
  tls: BankTlsMode;
  username: string;
  password: string;
  folder: string;
};

export type MessageRef = { uid: number };

export type MessageEnvelope = {
  from: string[];
  subject: string;
  messageId: string | null;
  date: Date | null;
};

export type MailboxSession = {
  uidValidity: number;
  listSince(cursor: number, opts: { limit: number; since?: Date }): Promise<MessageRef[]>;
  envelope(uid: number): Promise<MessageEnvelope | null>;
  download(uid: number, maxBytes: number): Promise<Buffer | null>;
  close(): Promise<void>;
};

export const IMAP_TIMEOUTS = {
  connectionTimeout: 15_000,
  greetingTimeout: 10_000,
  socketTimeout: 30_000,
};

const TLS_ERROR_CODES = new Set([
  "ClosedAfterConnectTLS",
  "UPGRADE_TIMEOUT",
  "STARTTLS_INJECTION",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_UNTRUSTED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_SSL_WRONG_VERSION_NUMBER",
]);

const TIMEOUT_ERROR_CODES = new Set([
  "CONNECT_TIMEOUT",
  "GREETING_TIMEOUT",
  "ETIMEOUT",
  "ETIMEDOUT",
  "EAI_AGAIN",
]);

type ImapError = {
  code?: string;
  tlsFailed?: boolean;
  authenticationFailed?: boolean;
  serverResponseCode?: string;
  mailboxMissing?: boolean;
};

// Only a code is derived: the server's own text may echo credentials or reveal internal hosts.
export function classifyImapError(error: unknown): BankFailureCode {
  if (error instanceof BlockedHostError) return error.temporary ? "timeout" : "blocked_host";
  const e = (typeof error === "object" && error !== null ? error : {}) as ImapError;
  if (e.authenticationFailed || e.serverResponseCode === "AUTHENTICATIONFAILED") return "auth";
  if (e.tlsFailed || (e.code && TLS_ERROR_CODES.has(e.code))) return "tls";
  if (e.code && TIMEOUT_ERROR_CODES.has(e.code)) return "timeout";
  if (e.mailboxMissing || e.serverResponseCode === "NONEXISTENT") return "folder";
  return "other";
}

function addressesOf(list: { address?: string | undefined }[] | undefined): string[] {
  return (list ?? []).flatMap((entry) => (entry.address ? [entry.address] : []));
}

async function read(stream: AsyncIterable<Buffer | string>, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    total += buffer.length;
    if (total > limit) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export function imapOptions(
  settings: MailboxSettings,
  target: { address: string; isPrivate: boolean },
): ImapFlowOptions {
  return {
    host: target.address,
    port: settings.port,
    secure: settings.tls === "implicit",
    ...(isIP(settings.host) ? {} : { servername: settings.host }),
    // Left unset for a private target so that it may stay in cleartext, as the SMTP exception does.
    ...(settings.tls === "starttls" && !target.isPrivate ? { doSTARTTLS: true } : {}),
    auth: { user: settings.username, pass: settings.password },
    // The default logger prints commands, which include the LOGIN line.
    logger: false,
    disableAutoIdle: true,
    disableCompression: true,
    ...IMAP_TIMEOUTS,
  };
}

// The check is repeated for every connection: DNS may have changed since the settings were saved.
export async function openMailbox(
  settings: MailboxSettings,
  env: Env = defaultEnv,
): Promise<MailboxSession> {
  const { address, isPrivate } = await assertPublicHost(settings.host, settings.port, {
    allowPrivate: env.ALLOW_PRIVATE_MAIL_HOSTS,
    ports: IMAP_PORTS,
  });
  const client = new ImapFlow(imapOptions(settings, { address, isPrivate }));
  // An unhandled 'error' event on a dropped socket would otherwise crash the process.
  client.on("error", () => {});

  let mailbox;
  try {
    await client.connect();
    mailbox = await client.mailboxOpen(settings.folder, { readOnly: true });
  } catch (error) {
    client.close();
    throw error;
  }

  return {
    uidValidity: Number(mailbox.uidValidity),
    async listSince(cursor, { limit, since }) {
      const found = await client.search(
        { uid: `${cursor + 1}:*`, ...(since ? { since } : {}) },
        { uid: true },
      );
      // `n:*` always matches the newest message, even when it is below the cursor.
      return (found || [])
        .filter((uid) => uid > cursor)
        .sort((a, b) => a - b)
        .slice(0, limit)
        .map((uid) => ({ uid }));
    },
    async envelope(uid) {
      const message = await client.fetchOne(String(uid), { envelope: true }, { uid: true });
      if (!message || !message.envelope) return null;
      const { envelope } = message;
      const date = envelope.date ? new Date(envelope.date) : null;
      return {
        from: addressesOf(envelope.from),
        subject: envelope.subject ?? "",
        messageId: envelope.messageId ?? null,
        date: date && !Number.isNaN(date.getTime()) ? date : null,
      };
    },
    async download(uid, maxBytes) {
      const result = await client.download(String(uid), undefined, {
        uid: true,
        maxBytes: maxBytes + 1,
      });
      return result.content ? read(result.content, maxBytes) : null;
    },
    async close() {
      try {
        await client.logout();
      } catch {
        client.close();
      }
    },
  };
}
