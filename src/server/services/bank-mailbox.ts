import "server-only";
import { parserFor } from "@/lib/bank-notices";
import { authservIdOf, firstRawHeader } from "@/lib/bank-notices/auth";
import { bankMailboxSchema, type BankFailureCode, type BankTlsMode } from "@/lib/bank-mailbox";
import { TEXTS } from "@/lib/texts";
import { classifyImapError, openMailbox, type MailboxSession } from "../bank/imap";
import type { Actor } from "../audit/context";
import { recordAudit } from "../audit/record";
import { clock } from "../clock";
import { decryptSecret, encryptSecret } from "../crypto";
import { db } from "../db";
import { bankMailbox } from "../db/schema";
import { scoped } from "../db/scoped";
import { env as defaultEnv, type Env } from "../env";
import { logger } from "../logger";
import { assertPublicHost, BlockedHostError, IMAP_PORTS } from "../mail/host-guard";
import { RATE_RULES } from "../rate-limit";
import { enforceRateLimit, ServiceError } from "./access";
import { mutate } from "./mutation";
import { resolveNotificationsOf } from "./notifications";

const E = TEXTS.bankMailbox.errors;

const SAMPLE_MESSAGES = 20;
const SAMPLE_BYTES = 256 * 1024;
const ALERT = "bank_connection_failed";

type Row = typeof bankMailbox.$inferSelect;

export type BankMailboxView = {
  host: string;
  port: number;
  tls: BankTlsMode;
  username: string;
  folder: string;
  enabled: boolean;
  requireConfirmation: boolean;
  authServId: string;
  hasCredentials: boolean;
  verifiedAt: Date | null;
  lastCheckAt: Date | null;
  lastSuccessAt: Date | null;
  lastNoticeAt: Date | null;
  failureCode: BankFailureCode | null;
  failures: number;
};

function ownerOf(actor: Actor): string {
  if (!actor.userId) throw new ServiceError(E.forbidden);
  return actor.userId;
}

function readRow(ownerId: string): Row | undefined {
  return db.select().from(bankMailbox).where(scoped(ownerId).where(bankMailbox)).get();
}

function auditSnapshot(row: Row | undefined) {
  return {
    host: row?.host ?? null,
    port: row?.port ?? null,
    tls: row?.tls ?? null,
    username: row?.username ?? null,
    folder: row?.folder ?? null,
    enabled: row?.enabled ?? false,
    requireConfirmation: row?.requireConfirmation ?? true,
    authServId: row?.authServId ?? null,
    hasCredentials: Boolean(row?.passwordEnc),
  };
}

export function getBankMailbox(ownerId: string): BankMailboxView | null {
  const row = readRow(ownerId);
  if (!row) return null;
  return {
    host: row.host,
    port: row.port,
    tls: row.tls,
    username: row.username,
    folder: row.folder,
    enabled: row.enabled,
    requireConfirmation: row.requireConfirmation,
    authServId: row.authServId ?? "",
    hasCredentials: Boolean(row.passwordEnc),
    verifiedAt: row.verifiedAt,
    lastCheckAt: row.lastCheckAt,
    lastSuccessAt: row.lastSuccessAt,
    lastNoticeAt: row.lastNoticeAt,
    failureCode: row.failureCode,
    failures: row.failures,
  };
}

async function assertAllowedHost(host: string, port: number, env: Env): Promise<void> {
  try {
    await assertPublicHost(host, port, {
      allowPrivate: env.ALLOW_PRIVATE_MAIL_HOSTS,
      ports: IMAP_PORTS,
    });
  } catch (error) {
    if (error instanceof BlockedHostError) throw new ServiceError(E.blockedHost);
    throw error;
  }
}

export async function saveBankMailbox(
  actor: Actor,
  raw: unknown,
  env: Env = defaultEnv,
): Promise<void> {
  const userId = ownerOf(actor);
  enforceRateLimit(actor, RATE_RULES.bankSaveUser);
  const parsed = bankMailboxSchema.safeParse(raw);
  if (!parsed.success) throw new ServiceError(parsed.error.issues[0]?.message ?? E.invalid);
  const input = parsed.data;
  await assertAllowedHost(input.host, input.port, env);

  mutate(actor, "bank_mailbox.save", (tx, audit) => {
    const row = tx.select().from(bankMailbox).where(scoped(userId).where(bankMailbox)).get();
    const sameTarget =
      row?.host === input.host &&
      row.port === input.port &&
      row.tls === input.tls &&
      row.username === input.username;
    // A hijacked session must not be able to point the stored password at another server.
    if (row && !sameTarget && !input.password) throw new ServiceError(E.passwordChanged);
    const passwordEnc = input.password ? encryptSecret(input.password) : row?.passwordEnc;
    if (!passwordEnc) throw new ServiceError(E.passwordRequired);

    // UIDs belong to one folder on one server, so the read position cannot survive a move.
    const sameMailbox = sameTarget && row.folder === input.folder;
    const keepsConnection = sameTarget && !input.password;
    const next = {
      host: input.host,
      port: input.port,
      tls: input.tls,
      username: input.username,
      passwordEnc,
      folder: input.folder,
      enabled: input.enabled,
      requireConfirmation: input.requireConfirmation,
      authServId: input.authServId || null,
      ...(sameMailbox ? {} : { uidValidity: null, lastUid: null, firstReadAt: null }),
      ...(keepsConnection && sameMailbox && input.enabled
        ? {}
        : { failureCode: null, failures: 0 }),
      verifiedAt: keepsConnection && sameMailbox ? row.verifiedAt : null,
      updatedAt: clock.now(),
    };
    tx.insert(bankMailbox)
      .values({ ...next, userId })
      .onConflictDoUpdate({ target: bankMailbox.userId, set: next })
      .run();
    if (!input.enabled) resolveNotificationsOf(tx, userId, ALERT);
    const required = auditSnapshot(row).requireConfirmation;
    // Off means an unverified notice may settle an invoice, so it must be findable on its own.
    if (required !== input.requireConfirmation) {
      recordAudit(tx, {
        action: "bank_mailbox.confirmation",
        entity: "bank_mailbox",
        entityId: userId,
        ownerId: userId,
        scope: "user",
        before: { requireConfirmation: required },
        after: { requireConfirmation: input.requireConfirmation },
      });
    }
    audit({
      entity: "bank_mailbox",
      entityId: userId,
      ownerId: userId,
      scope: "user",
      before: auditSnapshot(row),
      // Named so that audit redaction, which masks every key containing "pass", keeps the flag.
      after: {
        ...auditSnapshot({ ...next, userId } as Row),
        credentialsChanged: Boolean(input.password),
      },
    });
  });
}

export function clearBankMailbox(actor: Actor): void {
  const userId = ownerOf(actor);
  enforceRateLimit(actor, RATE_RULES.bankSaveUser);
  if (!readRow(userId)) return;
  mutate(actor, "bank_mailbox.clear", (tx, audit) => {
    const row = tx.select().from(bankMailbox).where(scoped(userId).where(bankMailbox)).get();
    tx.delete(bankMailbox).where(scoped(userId).where(bankMailbox)).run();
    resolveNotificationsOf(tx, userId, ALERT);
    audit({
      entity: "bank_mailbox",
      entityId: userId,
      ownerId: userId,
      scope: "user",
      before: auditSnapshot(row),
      after: { ...auditSnapshot(undefined), credentialsChanged: false },
    });
  });
}

// The test ran against a snapshot: a save in the meantime must not inherit its verdict.
function markVerified(actor: Actor, tested: Row): void {
  const userId = tested.userId;
  mutate(actor, "bank_mailbox.test", (tx, audit) => {
    const { changes } = tx
      .update(bankMailbox)
      .set({ verifiedAt: clock.now() })
      .where(
        scoped(userId).where(bankMailbox, (t, { and, eq }) =>
          and(
            eq(t.host, tested.host),
            eq(t.port, tested.port),
            eq(t.tls, tested.tls),
            eq(t.username, tested.username),
            eq(t.folder, tested.folder),
            eq(t.passwordEnc, tested.passwordEnc),
          ),
        ),
      )
      .run();
    if (changes === 0) throw new ServiceError(E.testFailed);
    audit({ entity: "bank_mailbox", entityId: userId, ownerId: userId, scope: "user" });
  });
}

// Only the headers of the newest notice are used, and only as an offer: the user has to confirm
// that the name is their own server, a forged top header looks the same here.
async function suggestAuthServId(session: MailboxSession): Promise<string | null> {
  const messages = await session.listSince(0, { limit: Number.MAX_SAFE_INTEGER });
  for (const { uid } of messages.slice(-SAMPLE_MESSAGES).reverse()) {
    const envelope = await session.envelope(uid);
    if (!envelope || parserFor(envelope)?.kind !== "income") continue;
    const raw = await session.download(uid, SAMPLE_BYTES);
    if (!raw) continue;
    return authservIdOf(firstRawHeader(raw.toString("latin1"), "authentication-results"));
  }
  return null;
}

// Checks the login and the folder of the saved settings. One generic failure on purpose:
// distinct errors would turn this page into a network scanner.
export async function testBankMailbox(
  actor: Actor,
  env: Env = defaultEnv,
): Promise<{ suggestedAuthServId: string | null }> {
  const userId = ownerOf(actor);
  enforceRateLimit(actor, RATE_RULES.bankTestUser);
  const row = readRow(userId);
  if (!row) throw new ServiceError(E.notConfigured);

  let suggestedAuthServId: string | null = null;
  let password: string;
  try {
    password = decryptSecret(row.passwordEnc);
  } catch {
    logger.warn("Test schránky s avízy selhal", { code: "decrypt" satisfies BankFailureCode });
    throw new ServiceError(E.testFailed);
  }
  try {
    const session = await openMailbox({ ...row, password }, env);
    try {
      suggestedAuthServId = await suggestAuthServId(session);
    } finally {
      await session.close();
    }
  } catch (error) {
    if (error instanceof BlockedHostError) throw new ServiceError(E.blockedHost);
    logger.warn("Test schránky s avízy selhal", { code: classifyImapError(error) });
    throw new ServiceError(E.testFailed);
  }
  markVerified(actor, row);
  return { suggestedAuthServId };
}
