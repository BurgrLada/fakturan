import { CURRENCIES } from "../currency";
import { isCalendarDate } from "../number-format";
import type { BankNoticeParser, NoticeMeta, NoticeVariant, ParsedNotice } from "./types";

const SENDER = "automat@fio.cz";
const MAX_TEXT_LENGTH = 64 * 1024;

const VARIANT_BY_SUBJECT = new Map<string, NoticeVariant>([
  ["Fio banka - new income on account", "en"],
  ["Fio banka - příjem na kontě", "cs_block"],
  ["Fio banka - příjem na účtu", "cs_sentence"],
]);

const EXPENSE_WORDS = ["výdaj", "vydaj", "expense", "debit", "outgoing"];

type Field =
  | "account"
  | "amount"
  | "currency"
  | "date"
  | "variableSymbol"
  | "constantSymbol"
  | "counterpartyAccount"
  | "counterpartyName"
  | "message"
  | "instructionId";

const CS_DETAIL_LABELS: [string, Field][] = [
  ["Datum", "date"],
  ["VS", "variableSymbol"],
  ["KS", "constantSymbol"],
  ["Protiúčet", "counterpartyAccount"],
  ["Protistrana", "counterpartyName"],
  ["Zpráva příjemci", "message"],
  ["ID pokynu", "instructionId"],
];

// The spec names only Protistrana, Variable symbol, Counterparty and Instruction ID.
// Every other label is an assumption that fails safe into an unrecognized notice.
const LABELS: Record<NoticeVariant, Map<string, Field>> = {
  en: new Map([
    ["Account", "account"],
    ["Amount", "amount"],
    ["Currency", "currency"],
    ["Date", "date"],
    ["Variable symbol", "variableSymbol"],
    ["Constant symbol", "constantSymbol"],
    ["Counterparty account", "counterpartyAccount"],
    ["Counterparty", "counterpartyName"],
    ["Message", "message"],
    ["Instruction ID", "instructionId"],
  ]),
  cs_block: new Map([
    ["Příjem na kontě", "account"],
    ["Částka", "amount"],
    ["Měna", "currency"],
    ...CS_DETAIL_LABELS,
  ]),
  cs_sentence: new Map(CS_DETAIL_LABELS),
};

// Every quantifier is bounded or separated by a literal the next token cannot match,
// so the patterns stay linear on untrusted mail text.
const SENTENCE =
  /(?:^|\s)[Zz]ůstatek účtu (\S{1,40}) se zvýšil o ([\d   ]{1,40}(?:,\d{2})?) ([A-Z]{3})\.?$/;
const EN_AMOUNT = /^(\d{1,3}(?:[   ]\d{3})+|\d+)(?:\.(\d{2}))?$/;
const CS_AMOUNT = /^(\d{1,3}(?:[   ]\d{3})+|\d+)(?:,(\d{2}))?$/;
const EN_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?: ((?:[01]\d|2[0-3]):[0-5]\d))?$/;
const CS_DATE = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?: ((?:[01]\d|2[0-3]):[0-5]\d))?$/;
const ACCOUNT = /^(?:\d{1,6}-)?\d{1,10}(?:\/\d{4})?$/;
const SYMBOL = /^\d{1,10}$/;
const INSTRUCTION_ID = /^[0-9A-Za-z]{1,40}$/;

function isFromFio({ from }: NoticeMeta): boolean {
  return from.length === 1 && from[0]!.toLowerCase() === SENDER;
}

function classify(meta: NoticeMeta) {
  if (!isFromFio(meta)) return null;
  if (VARIANT_BY_SUBJECT.has(meta.subject)) return "income";
  const subject = meta.subject.toLowerCase();
  return EXPENSE_WORDS.some((word) => subject.includes(word)) ? "expense" : "unknown";
}

// A repeated label could be the payer's message posing as a field, so it voids the notice.
function readFields(lines: string[], labels: Map<string, Field>): Map<Field, string> | null {
  const fields = new Map<Field, string>();
  for (const line of lines) {
    const colon = line.indexOf(":");
    const field = labels.get(line.slice(0, colon));
    if (colon < 0 || !field) continue;
    if (fields.has(field)) return null;
    fields.set(field, line.slice(colon + 1).trim());
  }
  return fields;
}

function readSentence(lines: string[], fields: Map<Field, string>): boolean {
  const matches = lines.flatMap((line) => SENTENCE.exec(line) ?? []);
  if (matches.length !== 4) return false;
  fields.set("account", matches[1]!);
  fields.set("amount", matches[2]!);
  fields.set("currency", matches[3]!);
  return true;
}

function parseAmount(text: string, variant: NoticeVariant): number | null {
  const match = (variant === "en" ? EN_AMOUNT : CS_AMOUNT).exec(text);
  if (!match) return null;
  const [, whole, fraction = "0"] = match;
  const minor = Number(whole!.replace(/\D/g, "")) * 100 + Number(fraction);
  return minor > 0 && Number.isSafeInteger(minor) ? minor : null;
}

function parseOccurredAt(text: string, variant: NoticeVariant): ParsedNotice["occurredAt"] | null {
  const match = (variant === "en" ? EN_DATE : CS_DATE).exec(text);
  if (!match) return null;
  const [, first, second, year, time = null] = match;
  const [month, day] = variant === "en" ? [first!, second!] : [second!, first!];
  const date = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  return isCalendarDate(date) ? { date, time } : null;
}

// undefined means the value is present but does not fit, unlike null for an absent one.
function optional(value: string | undefined, pattern: RegExp): string | null | undefined {
  if (!value) return null;
  return pattern.test(value) ? value : undefined;
}

function parse(text: string, meta: NoticeMeta): ParsedNotice | null {
  const variant = VARIANT_BY_SUBJECT.get(meta.subject);
  if (!variant || !isFromFio(meta) || text.length > MAX_TEXT_LENGTH) return null;

  const lines = text.split("\n").map((line) => line.trim());
  const fields = readFields(lines, LABELS[variant]);
  if (!fields) return null;
  if (variant === "cs_sentence" && !readSentence(lines, fields)) return null;

  const targetAccount = fields.get("account") ?? "";
  const amountMinor = parseAmount(fields.get("amount") ?? "", variant);
  const currency = CURRENCIES.find((code) => code === fields.get("currency"));
  const occurredAt = parseOccurredAt(fields.get("date") ?? "", variant);
  const instructionId = fields.get("instructionId") ?? "";
  const variableSymbol = optional(fields.get("variableSymbol"), SYMBOL);
  const constantSymbol = optional(fields.get("constantSymbol"), SYMBOL);
  const counterpartyAccount = optional(fields.get("counterpartyAccount"), ACCOUNT);

  if (
    !ACCOUNT.test(targetAccount) ||
    amountMinor === null ||
    !currency ||
    !occurredAt ||
    !INSTRUCTION_ID.test(instructionId) ||
    variableSymbol === undefined ||
    constantSymbol === undefined ||
    counterpartyAccount === undefined
  ) {
    return null;
  }

  return {
    variant,
    targetAccount,
    amountMinor,
    currency,
    occurredAt,
    variableSymbol,
    constantSymbol,
    counterpartyAccount,
    counterpartyName: fields.get("counterpartyName") || null,
    message: fields.get("message") || null,
    instructionId,
  };
}

export const fioParser: BankNoticeParser = { bank: "fio", classify, parse };
