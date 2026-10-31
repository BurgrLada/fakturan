import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { ZodType } from "zod";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";
import type { AuthResult } from "@/lib/bank-notices/auth";
import { maskAccount, maskDigits } from "@/lib/bank-notices/mask";
import type { ParsedNotice } from "@/lib/bank-notices/types";
import { czechAccountToIban, normalizeIban } from "@/lib/iban";
import { AWAITING_PAYMENT } from "@/lib/invoice";
import { calendarDateInPrague } from "@/lib/number-format";
import {
  assignInputSchema,
  splitInputSchema,
  type AssignInput,
  type SplitInput,
} from "@/lib/notice-queue";
import {
  autoMatchAllowed,
  matchNotice,
  normalizeSymbol,
  type MatchCandidate,
  type QueueReason,
} from "@/lib/payment-matching";
import { isProvisional } from "@/lib/bank-notices";
import { amountDue } from "@/lib/qr-payload";
import { TEXTS } from "@/lib/texts";
import type { Actor } from "../audit/context";
import { clock } from "../clock";
import { db, type Tx } from "../db";
import { logger } from "../logger";
import {
  bankAccount,
  bankMailbox,
  bankNotification,
  invoice,
  payment,
  type BankNotification,
} from "../db/schema";
import { scoped } from "../db/scoped";
import { ServiceError, type Reader } from "./access";
import { findOwned, ownerOf } from "./invoices";
import { mutate, type Audit } from "./mutation";
import { insertPayment, undoNoticeIn } from "./payments";

const FIO_DEFAULT_BANK_CODE = "2010";
const RETENTION_MS = 90 * 86_400_000;
const MAX_STORED_TEXT = 64 * 1024;
const MAX_FAILED_AUTH_TEXT = 2 * 1024;
const MAX_UNRECOGNIZED_PER_DAY = 50;
const DAY_MS = 86_400_000;

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
  | { status: "unrecognized"; id: string }
  | { status: "dropped" };

// Thrown to roll back an empty transaction: mutate refuses to commit one without an audit entry,
// and a repeated message must leave no trace at all.
class AlreadyStored extends Error {}

class OverLimit extends Error {}

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
  const rows = tx
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
  if (rows.length === 0) return [];
  const manual = tx
    .select({
      invoiceId: payment.invoiceId,
      amountMinor: payment.amountMinor,
      paidOn: payment.paidOn,
    })
    .from(payment)
    .where(
      scoped(userId).where(payment, (t) =>
        and(
          eq(t.source, "manual"),
          eq(t.kind, "payment"),
          inArray(
            t.invoiceId,
            rows.map((row) => row.id),
          ),
        ),
      ),
    )
    .all();
  return rows.map((row) => ({
    ...row,
    manualPayments: manual.filter((entry) => entry.invoiceId === row.id),
  }));
}

function maskedText(text: string | null, authResult: AuthResult): string | null {
  const limit = authResult === "fail" ? MAX_FAILED_AUTH_TEXT : MAX_STORED_TEXT;
  // Masked before the cut, which could otherwise shorten a number below the masking threshold.
  return text ? maskDigits(text).slice(0, limit) : null;
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
      paidOn: notice.occurredAt.date,
    },
    candidatesFor(tx, userId, notice.variableSymbol),
    {
      autoAllowed: autoMatchAllowed(notice.variant, authResult, requireConfirmation),
      targetAccountId: accountId,
      today: calendarDateInPrague(clock.now()),
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

type ParsedInput = IngestContext & { notice: ParsedNotice; text: string };
type NoticeValues = Parameters<typeof insertRow>[2];

function findByKey(tx: Tx, userId: string, dedupeKey: string): BankNotification | undefined {
  return tx
    .select()
    .from(bankNotification)
    .where(scoped(userId).where(bankNotification, (t, { eq }) => eq(t.dedupeKey, dedupeKey)))
    .get();
}

// A forged message that guessed the instruction ID must not cost the real notice its match. An
// undone row is left alone: the user took that match back on purpose (R-22).
function isOverridable(tx: Tx, userId: string, row: BankNotification, input: ParsedInput): boolean {
  if (input.authResult !== "pass" || row.authResult === "pass") return false;
  if (row.status !== "pending" || row.reason === "undone") return false;
  const paid = tx
    .select({ id: payment.id })
    .from(payment)
    .where(scoped(userId).where(payment, (t, { eq }) => eq(t.notificationId, row.id)))
    .get();
  return paid === undefined;
}

function contradicts(row: BankNotification, values: NoticeValues): boolean {
  return (
    row.amountMinor !== values.amountMinor ||
    row.currency !== values.currency ||
    row.accountMasked !== values.accountMasked ||
    normalizeSymbol(row.variableSymbol) !== normalizeSymbol(values.variableSymbol ?? null)
  );
}

function noticeValues(
  input: ParsedInput,
  dedupeKey: string,
  accountId: string | null,
): NoticeValues {
  const { notice } = input;
  return {
    dedupeKey,
    bank: input.bank,
    variant: notice.variant,
    status: "pending",
    authResult: input.authResult,
    bankAccountId: accountId,
    accountMasked: maskAccount(notice.targetAccount),
    amountMinor: notice.amountMinor,
    currency: notice.currency,
    paidOn: notice.occurredAt.date,
    paidTime: notice.occurredAt.time,
    variableSymbol: notice.variableSymbol,
    constantSymbol: notice.constantSymbol,
    counterpartyMasked: notice.counterpartyAccount && maskAccount(notice.counterpartyAccount),
    counterpartyName: notice.counterpartyName,
    message: notice.message,
    instructionId: notice.instructionId,
    textMasked: maskedText(input.text, input.authResult),
    receivedAt: receivedAt(input),
  };
}

function ingestParsed(tx: Tx, audit: Audit, userId: string, input: ParsedInput): IngestResult {
  const { notice } = input;
  const { amountMinor, currency } = notice;
  const dedupeKey = noticeKey(input.bank, notice);
  const accountId = ownAccountId(tx, userId, notice.targetAccount);
  const values = noticeValues(input, dedupeKey, accountId);

  const existing = findByKey(tx, userId, dedupeKey);
  if (existing && !isOverridable(tx, userId, existing, input)) throw new AlreadyStored();
  const conflict = existing !== undefined && contradicts(existing, values);
  const decision: Decision = conflict
    ? { status: "pending", reason: "conflict" }
    : decide(tx, userId, input, notice, accountId);
  const reason = decision.status === "matched" ? null : decision.reason;

  const stored = { ...values, status: decision.status, reason };
  let id: string;
  if (existing) {
    id = existing.id;
    tx.update(bankNotification)
      .set({ ...stored, updatedAt: clock.now() })
      .where(scoped(userId).where(bankNotification, (t, { eq }) => eq(t.id, id)))
      .run();
  } else {
    id = insertRow(tx, userId, stored);
  }

  const entry = {
    entity: "bank_notification",
    entityId: id,
    ownerId: userId,
    scope: "user",
  } as const;
  if (conflict) {
    audit({
      ...entry,
      action: "notice.conflict",
      before: { amountMinor: existing.amountMinor, currency: existing.currency },
      after: { amountMinor, currency, reason },
    });
    return { status: "pending", id, reason: "conflict" };
  }
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

// Anyone can send a message from a forged Fio address, so one day's mail must not fill the
// database. Dismissed rows count too, or dismissing would reopen the limit.
function overDailyLimit(tx: Tx, userId: string): boolean {
  const since = new Date(clock.now().getTime() - DAY_MS);
  const row = tx
    .select({ n: sql<number>`count(*)` })
    .from(bankNotification)
    .where(
      scoped(userId).where(bankNotification, (t) =>
        and(isNull(t.variant), gte(t.createdAt, since)),
      ),
    )
    .get();
  return (row?.n ?? 0) >= MAX_UNRECOGNIZED_PER_DAY;
}

function ingestUnrecognized(
  tx: Tx,
  audit: Audit,
  userId: string,
  input: IngestContext & { fingerprint: string; text: string | null },
): IngestResult {
  if (overDailyLimit(tx, userId)) throw new OverLimit();
  const id = insertRow(tx, userId, {
    dedupeKey: `msg:${sha256(input.fingerprint)}`,
    bank: input.bank,
    status: "unrecognized",
    authResult: input.authResult,
    textMasked: maskedText(input.text, input.authResult),
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
    if (error instanceof OverLimit) {
      logger.warn("Denní strop nerozpoznaných avíz", { userId: actorUserId });
      return { status: "dropped" };
    }
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

const E = TEXTS.bankQueue.errors;

type NoticeStatus = BankNotification["status"];

export type NoticeFilter = { statuses: readonly NoticeStatus[]; limit?: number };

export type NoticeRow = {
  id: string;
  status: NoticeStatus;
  reason: string | null;
  provisional: boolean;
  authResult: BankNotification["authResult"];
  paidOn: string | null;
  paidTime: string | null;
  amountMinor: number | null;
  currency: BankNotification["currency"];
  variableSymbol: string | null;
  counterpartyName: string | null;
  counterpartyMasked: string | null;
  message: string | null;
  accountMasked: string | null;
  receivedAt: Date;
  purged: boolean;
  invoices: { id: string; number: string | null }[];
};

const DEFAULT_LIST_LIMIT = 100;
const OTHER_CANDIDATES = 50;

export function listNotices(ownerId: string, filter: NoticeFilter): NoticeRow[] {
  if (filter.statuses.length === 0) return [];
  const rows = db
    .select()
    .from(bankNotification)
    .where(scoped(ownerId).where(bankNotification, (t) => inArray(t.status, [...filter.statuses])))
    .orderBy(desc(bankNotification.receivedAt), desc(bankNotification.id))
    .limit(filter.limit ?? DEFAULT_LIST_LIMIT)
    .all();
  if (rows.length === 0) return [];

  const linked = db
    .select({
      noticeId: payment.notificationId,
      invoiceId: invoice.id,
      number: invoice.number,
    })
    .from(payment)
    .innerJoin(invoice, eq(invoice.id, payment.invoiceId))
    .where(
      scoped(ownerId).where(payment, (t) =>
        inArray(
          t.notificationId,
          rows.map((row) => row.id),
        ),
      ),
    )
    .all();
  return rows.map((row) => {
    const seen = new Set<string>();
    const invoices = linked
      .filter((link) => link.noticeId === row.id && !seen.has(link.invoiceId))
      .map((link) => {
        seen.add(link.invoiceId);
        return { id: link.invoiceId, number: link.number };
      });
    return {
      id: row.id,
      status: row.status,
      reason: row.reason,
      provisional: row.variant !== null && isProvisional(row.variant),
      authResult: row.authResult,
      paidOn: row.paidOn,
      paidTime: row.paidTime,
      amountMinor: row.amountMinor,
      currency: row.currency,
      variableSymbol: row.variableSymbol,
      counterpartyName: row.counterpartyName,
      counterpartyMasked: row.counterpartyMasked,
      message: row.message,
      accountMasked: row.accountMasked,
      receivedAt: row.receivedAt,
      purged: row.purgedAt !== null,
      invoices,
    };
  });
}

export function noticeCounts(ownerId: string): { pending: number; unrecognized: number } {
  const rows = db
    .select({ status: bankNotification.status, n: sql<number>`count(*)` })
    .from(bankNotification)
    .where(
      scoped(ownerId).where(bankNotification, (t) =>
        inArray(t.status, ["pending", "unrecognized"]),
      ),
    )
    .groupBy(bankNotification.status)
    .all();
  const of = (status: NoticeStatus) => rows.find((row) => row.status === status)?.n ?? 0;
  return { pending: of("pending"), unrecognized: of("unrecognized") };
}

export type NoticeCandidate = {
  id: string;
  number: string | null;
  customerName: string;
  currency: typeof invoice.$inferSelect.currency;
  variableSymbol: string | null;
  dueMinor: number;
  suggested: boolean;
};

// Same-symbol documents come first, then the other documents waiting for money: a notice with
// no or a wrong symbol still has to be assignable by hand.
export function noticeCandidates(ownerId: string, noticeId: string): NoticeCandidate[] {
  const notice = readNotice(db, ownerId, noticeId);
  const symbol = normalizeSymbol(notice.variableSymbol);
  const rows = db
    .select({
      id: invoice.id,
      number: invoice.number,
      customerName: invoice.customerName,
      currency: invoice.currency,
      variableSymbol: invoice.variableSymbol,
      totalMinor: invoice.totalMinor,
      paidMinor: invoice.paidMinor,
      status: invoice.status,
    })
    .from(invoice)
    .where(
      scoped(ownerId).where(invoice, (t) =>
        and(
          inArray(t.status, [...AWAITING_PAYMENT, "paid"]),
          isNotNull(t.number),
          ne(t.type, "credit_note"),
        ),
      ),
    )
    .orderBy(asc(invoice.dueDate), asc(invoice.id))
    .all();
  const toCandidate = (row: (typeof rows)[number], suggested: boolean): NoticeCandidate => ({
    id: row.id,
    number: row.number,
    customerName: row.customerName,
    currency: row.currency,
    variableSymbol: row.variableSymbol,
    dueMinor: amountDue(row),
    suggested,
  });
  const same = symbol ? rows.filter((row) => normalizeSymbol(row.variableSymbol) === symbol) : [];
  const others = rows
    .filter((row) => (AWAITING_PAYMENT as readonly string[]).includes(row.status))
    .filter((row) => !same.includes(row))
    .slice(0, OTHER_CANDIDATES);
  return [
    ...same.map((row) => toCandidate(row, true)),
    ...others.map((row) => toCandidate(row, false)),
  ];
}

function readNotice(q: Reader, ownerId: string, id: string): BankNotification {
  const row = q
    .select()
    .from(bankNotification)
    .where(scoped(ownerId).where(bankNotification, (t, { eq }) => eq(t.id, id)))
    .get();
  if (!row) throw new ServiceError(E.notFound);
  return row;
}

type OpenNotice = BankNotification & {
  amountMinor: number;
  currency: NonNullable<BankNotification["currency"]>;
  paidOn: string;
};

// The status is the guard against a double click: the second call finds a notice that is no
// longer pending.
function pendingNotice(tx: Tx, userId: string, id: string): OpenNotice {
  const row = readNotice(tx, userId, id);
  const { amountMinor, currency, paidOn } = row;
  if (row.status !== "pending" || amountMinor === null || currency === null || paidOn === null) {
    throw new ServiceError(E.notPending);
  }
  return { ...row, amountMinor, currency, paidOn };
}

function setStatus(tx: Tx, userId: string, id: string, status: NoticeStatus): void {
  tx.update(bankNotification)
    .set({ status, updatedAt: clock.now() })
    .where(scoped(userId).where(bankNotification, (t, { eq }) => eq(t.id, id)))
    .run();
}

function credit(
  invoiceCurrency: string,
  notice: OpenNotice,
  amountMinor: number,
  creditedMinor: number | null | undefined,
): number {
  if (invoiceCurrency === notice.currency) return amountMinor;
  if (!creditedMinor) throw new ServiceError(TEXTS.payments.errors.creditedRequired);
  return creditedMinor;
}

function parseOrThrow<T>(schema: ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ServiceError(parsed.error.issues[0]?.message ?? E.invalid);
  return parsed.data;
}

function settle(
  tx: Tx,
  audit: Audit,
  userId: string,
  notice: OpenNotice,
  parts: { invoiceId: string; amountMinor: number; creditedMinor?: number | null }[],
  action: "notice.assigned" | "notice.split",
): void {
  for (const part of parts) {
    const row = findOwned(tx, userId, part.invoiceId);
    insertPayment(tx, audit, userId, part.invoiceId, {
      paidOn: notice.paidOn,
      amountMinor: part.amountMinor,
      currency: notice.currency,
      creditedMinor: credit(row.currency, notice, part.amountMinor, part.creditedMinor),
      method: "transfer",
      note: "",
      source: "notice",
      notificationId: notice.id,
    });
  }
  setStatus(tx, userId, notice.id, "matched");
  audit({
    action,
    entity: "bank_notification",
    entityId: notice.id,
    ownerId: userId,
    scope: "user",
    after: {
      amountMinor: notice.amountMinor,
      currency: notice.currency,
      reason: notice.reason,
      invoiceIds: parts.map((part) => part.invoiceId),
    },
  });
}

export function assignNotice(actor: Actor, id: string, raw: AssignInput): void {
  const userId = ownerOf(actor);
  const input = parseOrThrow(assignInputSchema, raw);
  mutate(actor, "notice.assigned", (tx, audit) => {
    const notice = pendingNotice(tx, userId, id);
    settle(
      tx,
      audit,
      userId,
      notice,
      [
        {
          invoiceId: input.invoiceId,
          amountMinor: notice.amountMinor,
          creditedMinor: input.creditedMinor,
        },
      ],
      "notice.assigned",
    );
  });
}

// R-23: money without a record is not allowed, so the parts must add up to the whole notice.
export function splitNotice(actor: Actor, id: string, raw: SplitInput): void {
  const userId = ownerOf(actor);
  const { parts } = parseOrThrow(splitInputSchema, raw);
  mutate(actor, "notice.split", (tx, audit) => {
    const notice = pendingNotice(tx, userId, id);
    const total = parts.reduce((sum, part) => sum + part.amountMinor, 0);
    if (total !== notice.amountMinor) throw new ServiceError(E.splitSum);
    settle(tx, audit, userId, notice, parts, "notice.split");
  });
}

function queueAudit(
  audit: Audit,
  userId: string,
  action: "notice.dismissed" | "notice.restored",
  row: BankNotification,
) {
  audit({
    action,
    entity: "bank_notification",
    entityId: row.id,
    ownerId: userId,
    scope: "user",
    after: { amountMinor: row.amountMinor, currency: row.currency, reason: row.reason },
  });
}

export function dismissNotice(actor: Actor, id: string): void {
  const userId = ownerOf(actor);
  mutate(actor, "notice.dismissed", (tx, audit) => {
    const row = readNotice(tx, userId, id);
    if (row.status !== "pending" && row.status !== "unrecognized") {
      throw new ServiceError(E.notDismissable);
    }
    setStatus(tx, userId, id, "dismissed");
    queueAudit(audit, userId, "notice.dismissed", row);
  });
}

// A dismissed message without a read amount goes back among the unrecognized ones.
export function restoreNotice(actor: Actor, id: string): void {
  const userId = ownerOf(actor);
  mutate(actor, "notice.restored", (tx, audit) => {
    const row = readNotice(tx, userId, id);
    if (row.status !== "dismissed") throw new ServiceError(E.notRestorable);
    setStatus(tx, userId, id, row.amountMinor === null ? "unrecognized" : "pending");
    queueAudit(audit, userId, "notice.restored", row);
  });
}

export function undoNotice(actor: Actor, id: string): void {
  const userId = ownerOf(actor);
  mutate(actor, "notice.undone", (tx, audit) => undoNoticeIn(tx, audit, userId, id));
}
