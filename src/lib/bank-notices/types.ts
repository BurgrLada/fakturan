import type { Currency } from "../currency";
import type { CalendarDate } from "../number-format";

// from holds bare addresses, one per mailbox in the From header, never "Name <address>".
export type NoticeMeta = { from: string[]; subject: string };

// Each parser owns its variant ids; they must stay unique across banks.
export type NoticeVariant = string;

export type NoticeKind = "income" | "expense" | "unknown";

export type ParsedNotice = {
  variant: NoticeVariant;
  targetAccount: string;
  amountMinor: number;
  currency: Currency;
  occurredAt: { date: CalendarDate; time: string | null };
  variableSymbol: string | null;
  constantSymbol: string | null;
  counterpartyAccount: string | null;
  counterpartyName: string | null;
  message: string | null;
  instructionId: string;
};

// classify returns null for a sender the parser does not own. domain is what
// checkAuthResults verifies; a variant outside autoMatchVariants never pays an invoice alone.
export type BankNoticeParser = {
  bank: string;
  domain: string;
  autoMatchVariants: readonly NoticeVariant[];
  classify(meta: NoticeMeta): NoticeKind | null;
  parse(text: string, meta: NoticeMeta): ParsedNotice | null;
};
