import type { AuthResult } from "./bank-notices/auth";
import { isProvisional } from "./bank-notices";
import type { NoticeVariant } from "./bank-notices/types";
import type { Currency } from "./currency";
import { AWAITING_PAYMENT, daysBetween, type InvoiceStatus } from "./invoice";
import type { CalendarDate } from "./number-format";
import { amountDue, type Balance } from "./qr-payload";

export const QUEUE_REASONS = [
  "unknown_vs",
  "no_vs",
  "amount",
  "currency",
  "multiple",
  "other_account",
  "closed",
  "provisional",
  "unverified",
  "auth_failed",
  "undone",
  "conflict",
  "manual_duplicate",
  "future_date",
] as const;
export type QueueReason = (typeof QUEUE_REASONS)[number];

const MANUAL_DUPLICATE_DAYS = 7;

export type MatchableNotice = {
  variant: NoticeVariant;
  authResult: AuthResult;
  amountMinor: number;
  currency: Currency;
  variableSymbol: string | null;
  paidOn: CalendarDate;
};

export type MatchCandidate = Balance & {
  id: string;
  status: InvoiceStatus;
  currency: Currency;
  bankAccountId: string | null;
  variableSymbol: string | null;
  manualPayments: readonly { amountMinor: number; paidOn: CalendarDate }[];
};

export type MatchResult =
  | { result: "match"; invoiceId: string }
  | { result: "queue"; reason: QueueReason; invoiceIds: string[] };

export function normalizeSymbol(value: string | null): string | null {
  return value?.trim().replace(/^0+/, "") || null;
}

export function autoMatchAllowed(
  variant: NoticeVariant,
  authResult: AuthResult,
  requireConfirmation: boolean,
): boolean {
  if (isProvisional(variant)) return false;
  return authResult === "pass" || (authResult === "none" && !requireConfirmation);
}

// Checked again here so that no caller can turn on matching for what R-15 and R-16 forbid.
function blockReason(notice: MatchableNotice, autoAllowed: boolean): QueueReason | null {
  if (notice.authResult === "fail") return "auth_failed";
  if (isProvisional(notice.variant)) return "provisional";
  return autoAllowed ? null : "unverified";
}

function queue(reason: QueueReason, candidates: MatchCandidate[]): MatchResult {
  return { result: "queue", reason, invoiceIds: candidates.map(({ id }) => id) };
}

export function matchNotice(
  notice: MatchableNotice,
  candidates: readonly MatchCandidate[],
  opts: { autoAllowed: boolean; targetAccountId: string; today: CalendarDate },
): MatchResult {
  const symbol = normalizeSymbol(notice.variableSymbol);
  const sameSymbol = symbol
    ? candidates.filter((row) => normalizeSymbol(row.variableSymbol) === symbol)
    : [];
  const open = sameSymbol.filter(
    (row) =>
      (AWAITING_PAYMENT as readonly InvoiceStatus[]).includes(row.status) && !row.supersededAt,
  );

  const blocked = blockReason(notice, opts.autoAllowed);
  if (blocked) return queue(blocked, open);
  if (notice.paidOn > opts.today) return queue("future_date", open);
  if (!symbol) return queue("no_vs", []);
  if (sameSymbol.length === 0) return queue("unknown_vs", []);
  if (open.length === 0) return queue("closed", sameSymbol);

  const sameCurrency = open.filter((row) => row.currency === notice.currency);
  if (sameCurrency.length === 0) return queue("currency", open);
  const sameAmount = sameCurrency.filter((row) => amountDue(row) === notice.amountMinor);
  if (sameAmount.length === 0) return queue("amount", sameCurrency);
  const onAccount = sameAmount.filter(
    (row) => row.bankAccountId === null || row.bankAccountId === opts.targetAccountId,
  );
  if (onAccount.length === 0) return queue("other_account", sameAmount);
  if (onAccount.length > 1) return queue("multiple", onAccount);
  const [only] = onAccount as [MatchCandidate];
  // The user may have written this very money down by hand before the notice arrived, and the
  // date they typed need not be the bank's.
  const recorded = only.manualPayments.some(
    (row) =>
      row.amountMinor === notice.amountMinor &&
      Math.abs(daysBetween(row.paidOn, notice.paidOn)) <= MANUAL_DUPLICATE_DAYS,
  );
  if (recorded) return queue("manual_duplicate", onAccount);
  return { result: "match", invoiceId: only.id };
}
