import "server-only";
import { createHash } from "node:crypto";
import { eq, getTableColumns } from "drizzle-orm";
import { simpleParser } from "mailparser";
import { TEXTS } from "@/lib/texts";
import { checkAuthResults, type AuthResult } from "@/lib/bank-notices/auth";
import { BANK_PARSERS, parserFor } from "@/lib/bank-notices";
import type { BankNoticeParser, NoticeMeta } from "@/lib/bank-notices/types";
import type { BankFailureCode } from "@/lib/bank-mailbox";
import type { Actor } from "../audit/context";
import {
  classifyImapError,
  openMailbox,
  type MailboxSession,
  type MessageEnvelope,
} from "../bank/imap";
import {
  enqueueDuePolls,
  moveCursor,
  recordFailure,
  recordSuccess,
  startCursor,
} from "../bank/mailbox-state";
import { clock } from "../clock";
import { decryptSecret } from "../crypto";
import { db } from "../db";
import { bankMailbox, user, type Job } from "../db/schema";
import { scoped } from "../db/scoped";
import { env as defaultEnv, type Env } from "../env";
import { enqueue } from "../jobs/queue";
import { kickWorker } from "../jobs/worker";
import { RATE_RULES } from "../rate-limit";
import { reportFailure } from "../scheduler/report";
import { enforceRateLimit, ServiceError } from "./access";
import { ingestNotice, type IngestInput } from "./bank-notices";
import { mutate } from "./mutation";

const E = TEXTS.bankMailbox.errors;

const RUN_CAP_MS = 60_000;
const CLOSE_GRACE_MS = 5_000;
const MAX_MESSAGES = 50;
const MAX_MESSAGE_BYTES = 256 * 1024;
const FIRST_READ_DAYS = 30;
const DAY_MS = 86_400_000;

const MAIL_OPTIONS = {
  maxHtmlLengthToParse: MAX_MESSAGE_BYTES,
  skipImageLinks: true,
  skipTextToHtml: true,
  skipTextLinks: true,
};

export type PollOptions = {
  env?: Env;
  deadlineMs?: number;
  parsers?: readonly BankNoticeParser[];
};

type Mailbox = typeof bankMailbox.$inferSelect;

class DeadlineExceeded extends Error {}

// The message was not stored, so the cursor must stay where it is.
class WriteFailed extends Error {}

type Deadline = {
  within<T>(work: Promise<T>): Promise<T>;
  clear(): void;
};

function startDeadline(ms: number): Deadline {
  let timer: NodeJS.Timeout;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineExceeded()), ms);
  });
  expired.catch(() => {});
  return {
    within: (work) => Promise.race([work, expired]),
    clear: () => clearTimeout(timer),
  };
}

// A database error message quotes the statement's parameters, so the original never leaves here:
// not to Sentry, whose event would carry it, and not to the worker, which stores it on the job.
function report(step: string, error: unknown, job: Job): void {
  const name = error instanceof Error ? error.name : typeof error;
  reportFailure(new Error(`Čtení avíz selhalo: ${step} (${name})`), {
    task: "bank.poll",
    jobId: job.id,
    kind: job.kind,
    ...(job.userId ? { userId: job.userId } : {}),
  });
}

function isDatabaseError(error: unknown): boolean {
  return error instanceof Error && ["DrizzleQueryError", "SqliteError"].includes(error.name);
}

// The first one is what the recipient's server added, and mailparser would merge it with the
// forgeable rest. Folding stays, checkAuthResults reads a bare line break as a smuggled header.
export function firstRawHeader(raw: Buffer, name: string): string | null {
  const lines = raw.toString("latin1").split("\n");
  const start = `${name.toLowerCase()}:`;
  const found: string[] = [];
  for (const line of lines) {
    if (line === "" || line === "\r") break;
    if (found.length > 0) {
      if (!/^[ \t]/.test(line)) break;
      found.push(line);
    } else if (line.toLowerCase().startsWith(start)) {
      found.push(line.slice(start.length).trimStart());
    }
  }
  return found.length > 0 ? found.join("\n").replace(/[\r\n]+$/, "") : null;
}

type Reader = {
  job: Job;
  mailbox: Mailbox;
  session: MailboxSession;
  deadline: Deadline;
  parsers: readonly BankNoticeParser[];
  stored: Date | null;
};

function bodyless(
  reader: Reader,
  parser: BankNoticeParser,
  uid: number,
  envelope: MessageEnvelope,
): IngestInput {
  return {
    bank: parser.bank,
    notice: null,
    fingerprint: envelope.messageId ?? `${reader.session.uidValidity}:${uid}`,
    text: null,
    authResult: "none",
    requireConfirmation: reader.mailbox.requireConfirmation,
    receivedAt: envelope.date ?? clock.now(),
  };
}

async function readNotice(
  reader: Reader,
  parser: BankNoticeParser,
  meta: NoticeMeta,
  envelope: MessageEnvelope,
  raw: Buffer,
): Promise<IngestInput> {
  const fingerprint = envelope.messageId ?? createHash("sha256").update(raw).digest("hex");
  const context = {
    bank: parser.bank,
    requireConfirmation: reader.mailbox.requireConfirmation,
    receivedAt: envelope.date ?? clock.now(),
  };
  let authResult: AuthResult = "none";
  let text: string | null = null;
  try {
    authResult = checkAuthResults(firstRawHeader(raw, "authentication-results"), parser.domain);
    const parsed = await reader.deadline.within(simpleParser(raw, MAIL_OPTIONS));
    text = parsed.text?.trim() ? parsed.text : null;
    const notice = text ? parser.parse(text, meta) : null;
    if (notice) return { ...context, notice, text: text!, authResult };
  } catch (error) {
    if (error instanceof DeadlineExceeded) throw error;
    report("zpracování zprávy", error, reader.job);
  }
  return { ...context, notice: null, fingerprint, text, authResult };
}

function store(reader: Reader, input: IngestInput, fallback: () => IngestInput): void {
  const { job, mailbox } = reader;
  let result;
  try {
    try {
      result = ingestNotice(mailbox.userId, input);
    } catch (error) {
      if (isDatabaseError(error)) throw error;
      report("uložení avíza", error, job);
      result = ingestNotice(mailbox.userId, fallback());
    }
  } catch (error) {
    report("zápis avíza", error, job);
    throw new WriteFailed();
  }
  if (result.status !== "duplicate") reader.stored = clock.now();
}

async function processMessage(reader: Reader, uid: number): Promise<void> {
  const { session, deadline, parsers } = reader;
  const envelope = await deadline.within(session.envelope(uid));
  if (!envelope) return;

  const meta: NoticeMeta = { from: envelope.from, subject: envelope.subject };
  const hit = parserFor(meta, parsers);
  if (!hit || hit.kind === "expense") return;

  const { parser, kind } = hit;
  const unreadable = () => bodyless(reader, parser, uid, envelope);
  if (kind === "unknown") return store(reader, unreadable(), unreadable);

  const raw = await deadline.within(session.download(uid, MAX_MESSAGE_BYTES));
  if (!raw) return store(reader, unreadable(), unreadable);

  const input = await readNotice(reader, parser, meta, envelope, raw);
  store(reader, input, unreadable);
}

function fromPosition(mailbox: Mailbox, session: MailboxSession) {
  const firstReadAt = mailbox.firstReadAt ?? clock.now();
  const moved = mailbox.uidValidity !== session.uidValidity;
  const cursor = moved ? 0 : (mailbox.lastUid ?? 0);
  if (moved || !mailbox.firstReadAt) {
    startCursor(mailbox, {
      uidValidity: session.uidValidity,
      lastUid: moved ? null : mailbox.lastUid,
      firstReadAt,
    });
  }
  const since = new Date(firstReadAt.getTime() - FIRST_READ_DAYS * DAY_MS);
  return { limit: MAX_MESSAGES, cursor, ...(cursor === 0 ? { since } : {}) };
}

async function readMailbox(reader: Reader): Promise<void> {
  const { mailbox, session, deadline } = reader;
  const { cursor, ...range } = fromPosition(mailbox, session);
  const messages = await deadline.within(session.listSince(cursor, range));
  for (const { uid } of messages) {
    await processMessage(reader, uid);
    moveCursor(mailbox, uid);
  }
}

function failureCode(error: unknown): BankFailureCode {
  if (error instanceof DeadlineExceeded) return "timeout";
  if (error instanceof WriteFailed) return "other";
  return classifyImapError(error);
}

async function closeSession(session: MailboxSession): Promise<void> {
  const grace = startDeadline(CLOSE_GRACE_MS);
  try {
    await grace.within(session.close());
  } catch {
    session.destroy();
  } finally {
    grace.clear();
  }
}

function loadMailbox(userId: string) {
  return db
    .select({ ...getTableColumns(bankMailbox), banned: user.banned })
    .from(bankMailbox)
    .innerJoin(user, eq(user.id, bankMailbox.userId))
    .where(scoped(userId).where(bankMailbox))
    .get();
}

function decrypted(mailbox: Mailbox): string | null {
  try {
    return decryptSecret(mailbox.passwordEnc);
  } catch {
    return null;
  }
}

export async function pollMailbox(job: Job, options: PollOptions = {}): Promise<void> {
  const { env = defaultEnv, deadlineMs = RUN_CAP_MS, parsers = BANK_PARSERS } = options;
  const mailbox = job.userId ? loadMailbox(job.userId) : undefined;
  if (!mailbox?.enabled || mailbox.banned) return;

  const password = decrypted(mailbox);
  if (password === null) return recordFailure(mailbox, "decrypt");

  const deadline = startDeadline(deadlineMs);
  const opening = openMailbox({ ...mailbox, password }, env);
  let session: MailboxSession | null = null;
  let stored: Date | null = null;
  try {
    session = await deadline.within(opening);
    const reader: Reader = { job, mailbox, session, deadline, parsers, stored: null };
    try {
      await readMailbox(reader);
    } finally {
      stored = reader.stored;
    }
    recordSuccess(mailbox, stored);
  } catch (error) {
    if (isDatabaseError(error)) report("stav schránky", error, job);
    try {
      recordFailure(mailbox, failureCode(error), stored);
    } catch (writeError) {
      report("stav schránky", writeError, job);
    }
    // The connection may still come up after the cap: nobody else would close it.
    if (!session) void opening.then((late) => late.destroy()).catch(() => {});
    session?.destroy();
    session = null;
  } finally {
    deadline.clear();
  }
  if (session) await closeSession(session);
}

export function planBankPolls(now: Date): void {
  enqueueDuePolls(now);
}

export function checkMailboxNow(actor: Actor, requestId: string): void {
  const userId = actor.userId;
  if (!userId) throw new ServiceError(E.forbidden);
  enforceRateLimit(actor, RATE_RULES.bankCheckUser);
  const row = db.select().from(bankMailbox).where(scoped(userId).where(bankMailbox)).get();
  if (!row) throw new ServiceError(E.notConfigured);
  if (!row.enabled) throw new ServiceError(E.disabled);
  mutate(actor, "bank_mailbox.check", (tx, audit) => {
    enqueue(tx, { kind: "bank.poll", key: `bank:${userId}:now:${requestId}`, userId, payload: {} });
    audit({ entity: "bank_mailbox", entityId: userId, ownerId: userId, scope: "user" });
  });
  kickWorker();
}
