import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { and, inArray, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";
import type { AuthResult } from "@/lib/bank-notices/auth";
import { maskAccount, maskDigits } from "@/lib/bank-notices/mask";
import type { ParsedNotice } from "@/lib/bank-notices/types";
import { czechAccountToIban, normalizeIban } from "@/lib/iban";
import { AWAITING_PAYMENT } from "@/lib/invoice";
import {
  autoMatchAllowed,
  matchNotice,
  normalizeSymbol,
  type MatchCandidate,
  type QueueReason,
} from "@/lib/payment-matching";
import type { Actor } from "../audit/context";
import { clock } from "../clock";
import { db, type Tx } from "../db";
import { bankAccount, bankMailbox, bankNotification, invoice } from "../db/schema";
import { scoped } from "../db/scoped";
import { mutate, type Audit } from "./mutation";
import { insertPayment } from "./payments";

const FIO_DEFAULT_BANK_CODE = "2010";
const RETENTION_MS = 90 * 86_400_000;
const MAX_STORED_TEXT = 64 * 1024;

type IngestContext = {
  bank: string;
  authResult: AuthResult;
  requireConfirmation: boolean;
  receivedAt: Date;
};

export type IngestInput = IngestContext &
  (
    | { notice: ParsedNotice; text: string }
    | { notice: null; fingerprint: string; text: string | null }
  );

export type IngestResult =
  | { status: "duplicate" }
  | { status: "matched"; id: string; invoiceId: string }
  | { status: "pending"; id: string; reason: QueueReason }
  | { status: "ignored"; id: string; reason: "foreign_account" }
  | { status: "unrecognized"; id: string };

// Thrown to roll back an empty transaction: mutate refuses to commit one without an audit entry,
// and a repeated message must leave no trace at all.
class AlreadyStored extends Error {}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function targetIban(account: string): string | null {
  const [number = "", bankCode = FIO_DEFAULT_BANK_CODE] = account.split("/");
  try {
    return normalizeIban(czechAccountToIban(number, bankCode));
  } catch {
    return null;
  }
}

// The account is hashed, the full target number must not be stored (R-19), and normalized first,
// so that two spellings of one account cannot count one instruction twice.
function noticeKey(bank: string, notice: ParsedNotice): string {
  const account = targetIban(notice.targetAccount) ?? notice.targetAccount;
  return `${bank}:${sha256(account)}:${notice.instructionId}`;
}

function ownAccountId(tx: Tx, userId: string, account: string): string | null {
  const iban = targetIban(account);
  if (!iban) return null;
  const accounts = tx
    .select({ id: bankAccount.id, iban: bankAccount.iban })
    .from(bankAccount)
    .where(scoped(userId).where(bankAccount))
    .all();
  return accounts.find((row) => normalizeIban(row.iban) === iban)?.id ?? null;
}

function candidatesFor(tx: Tx, userId: string, variableSymbol: string | null): MatchCandidate[] {
  const symbol = normalizeSymbol(variableSymbol);
  if (!symbol) return [];
  return tx
    .select({
      id: invoice.id,
      status: invoice.status,
      currency: invoice.currency,
      bankAccountId: invoice.bankAccountId,
      variableSymbol: invoice.variableSymbol,
      totalMinor: invoice.totalMinor,
      paidMinor: invoice.paidMinor,
    })
    .from(invoice)
    .where(
      scoped(userId).where(invoice, (t) =>
        and(
          inArray(t.status, [...AWAITING_PAYMENT, "paid"]),
          isNotNull(t.number),
          ne(t.type, "credit_note"),
          sql`ltrim(${t.variableSymbol}, '0') = ${symbol}`,
        ),
      ),
    )
    .all();
}

function maskedText(text: string | null): string | null {
  // Masked before the cut, which could otherwise shorten a number below the masking threshold.
  return text ? maskDigits(text).slice(0, MAX_STORED_TEXT) : null;
}

type Decision = { status: "matched"; invoiceId: string } | QueuedDecision;
type QueuedDecision =
  | { status: "pending"; reason: QueueReason }
  | { status: "ignored"; reason: "foreign_account" };

function decide(
  tx: Tx,
  userId: string,
  input: IngestContext,
  notice: ParsedNotice,
  accountId: string | null,
): Decision {
  if (!accountId) return { status: "ignored", reason: "foreign_account" };
  const { authResult, requireConfirmation } = input;
  const match = matchNotice(
    {
      variant: notice.variant,
      authResult,
      amountMinor: notice.amountMinor,
      currency: notice.currency,
      variableSymbol: notice.variableSymbol,
    },
    candidatesFor(tx, userId, notice.variableSymbol),
    {
      autoAllowed: autoMatchAllowed(notice.variant, authResult, requireConfirmation),
      targetAccountId: accountId,
    },
  );
  return match.result === "match"
    ? { status: "matched", invoiceId: match.invoiceId }
    : { status: "pending", reason: match.reason };
}

function insertRow(
  tx: Tx,
  userId: string,
  values: Omit<typeof bankNotification.$inferInsert, "id" | "userId" | "createdAt" | "updatedAt">,
): string {
  const now = clock.now();
  const inserted = tx
    .insert(bankNotification)
    .values({ ...values, id: randomUUID(), userId, createdAt: now, updatedAt: now })
    .onConflictDoNothing()
    .returning({ id: bankNotification.id })
    .get();
  if (!inserted) throw new AlreadyStored();
  return inserted.id;
}

function receivedAt(input: IngestContext): Date {
  const now = clock.now();
  return input.receivedAt > now ? now : input.receivedAt;
}

function ingestParsed(
  tx: Tx,
  audit: Audit,
  userId: string,
  input: IngestContext & { notice: ParsedNotice; text: string },
): IngestResult {
  const { notice } = input;
  const accountId = ownAccountId(tx, userId, notice.targetAccount);
  const decision = decide(tx, userId, input, notice, accountId);
  const reason = decision.status === "matched" ? null : decision.reason;
  const { amountMinor, currency } = notice;

  const id = insertRow(tx, userId, {
    dedupeKey: noticeKey(input.bank, notice),
    bank: input.bank,
    variant: notice.variant,
    status: decision.status,
    reason,
    authResult: input.authResult,
    bankAccountId: accountId,
    accountMasked: maskAccount(notice.targetAccount),
    amountMinor,
    currency,
    paidOn: notice.occurredAt.date,
    paidTime: notice.occurredAt.time,
    variableSymbol: notice.variableSymbol,
    constantSymbol: notice.constantSymbol,
    counterpartyMasked: notice.counterpartyAccount && maskAccount(notice.counterpartyAccount),
    counterpartyName: notice.counterpartyName,
    message: notice.message,
    instructionId: notice.instructionId,
    textMasked: maskedText(input.text),
    receivedAt: receivedAt(input),
  });

  const entry = {
    entity: "bank_notification",
    entityId: id,
    ownerId: userId,
    scope: "user",
  } as const;
  if (decision.status === "matched") {
    const { invoiceId } = decision;
    insertPayment(tx, audit, userId, invoiceId, {
      paidOn: notice.occurredAt.date,
      amountMinor,
      currency,
      creditedMinor: amountMinor,
      method: "transfer",
      note: "",
      source: "notice",
      notificationId: id,
    });
    audit({
      ...entry,
      action: "notice.matched",
      after: { invoiceId, amountMinor, currency, reason },
    });
    return { status: "matched", id, invoiceId };
  }
  const action = decision.status === "pending" ? "notice.queued" : "notice.ignored";
  audit({ ...entry, action, after: { amountMinor, currency, reason } });
  return { ...decision, id };
}

function ingestUnrecognized(
  tx: Tx,
  audit: Audit,
  userId: string,
  input: IngestContext & { fingerprint: string; text: string | null },
): IngestResult {
  const id = insertRow(tx, userId, {
    dedupeKey: `msg:${sha256(input.fingerprint)}`,
    bank: input.bank,
    status: "unrecognized",
    authResult: input.authResult,
    textMasked: maskedText(input.text),
    receivedAt: receivedAt(input),
  });
  audit({
    action: "notice.unrecognized",
    entity: "bank_notification",
    entityId: id,
    ownerId: userId,
    scope: "user",
    after: { amountMinor: null, currency: null, reason: null },
  });
  return { status: "unrecognized", id };
}

export function ingestNotice(actorUserId: string, input: IngestInput): IngestResult {
  const actor: Actor = { userId: actorUserId, source: "scheduler" };
  const action = input.notice ? "notice.queued" : "notice.unrecognized";
  try {
    return mutate(actor, action, (tx, audit) =>
      input.notice
        ? ingestParsed(tx, audit, actorUserId, input)
        : ingestUnrecognized(tx, audit, actorUserId, input),
    );
  } catch (error) {
    if (error instanceof AlreadyStored) return { status: "duplicate" };
    throw error;
  }
}

const PURGEABLE = ["matched", "ignored", "dismissed"] as const;

// Pending and unrecognized rows stay until the user settles them (BNK-012). dedupe_key, the
// amount and the date stay for good, so that a re-read message cannot pay twice (R-18).
export function purgeNotices(now: Date): void {
  const cutoff = new Date(now.getTime() - RETENTION_MS);
  const expired = (t: typeof bankNotification) =>
    and(inArray(t.status, PURGEABLE), isNull(t.purgedAt), lt(t.receivedAt, cutoff));

  const owners = db
    .selectDistinct({ userId: bankNotification.userId })
    .from(bankNotification)
    .where(expired(bankNotification))
    .all();
  for (const { userId } of owners) {
    mutate({ userId, source: "scheduler" }, "notice.purged", (tx, audit) => {
      const { changes } = tx
        .update(bankNotification)
        .set({
          textMasked: null,
          counterpartyName: null,
          counterpartyMasked: null,
          message: null,
          variableSymbol: null,
          constantSymbol: null,
          purgedAt: now,
          updatedAt: now,
        })
        .where(scoped(userId).where(bankNotification, expired))
        .run();
      audit({
        entity: "bank_notification",
        entityId: userId,
        ownerId: userId,
        scope: "user",
        after: { count: changes },
      });
    });
  }
}

export function bankStatus(ownerId: string) {
  const row = db
    .select({
      enabled: bankMailbox.enabled,
      lastCheckAt: bankMailbox.lastCheckAt,
      lastSuccessAt: bankMailbox.lastSuccessAt,
      lastNoticeAt: bankMailbox.lastNoticeAt,
      failureCode: bankMailbox.failureCode,
      failures: bankMailbox.failures,
    })
    .from(bankMailbox)
    .where(scoped(ownerId).where(bankMailbox))
    .get();
  return row ?? null;
}
