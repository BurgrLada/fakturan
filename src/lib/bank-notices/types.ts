import type { Currency } from "../currency";
import type { CalendarDate } from "../number-format";

export type NoticeMeta = { from: string[]; subject: string };

export type NoticeVariant = "en" | "cs_block" | "cs_sentence";

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

// classify returns null for a sender the parser does not own.
export type BankNoticeParser = {
  bank: string;
  classify(meta: NoticeMeta): NoticeKind | null;
  parse(text: string, meta: NoticeMeta): ParsedNotice | null;
};
