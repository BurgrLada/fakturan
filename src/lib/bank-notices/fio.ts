import { CURRENCIES } from "../currency";
import { isCalendarDate } from "../number-format";
import type { BankNoticeParser, NoticeMeta, ParsedNotice } from "./types";

type FioVariant = "en" | "cs";

const SENDER = "automat@fio.cz";
const MAX_TEXT_LENGTH = 64 * 1024;

const VARIANT_BY_SUBJECT = new Map<string, FioVariant>([
  ["Fio banka - new income on account", "en"],
  ["Fio banka - příjem na účtu", "cs"],
]);

const EXPENSE_WORDS = ["výdaj", "vydaj", "expense", "debit", "outgoing"];

type Field =
  | "account"
  | "amount"
  | "currency"
  | "date"
  | "variableSymbol"
  | "specificSymbol"
  | "constantSymbol"
  | "userSymbol"
  | "movementType"
  | "counterparty"
  | "counterpartyAccount"
  | "counterpartyName"
  | "message"
  | "instructionId";

type Layout = { labels: Map<string, Field>; ordered: boolean };

// English is assembled from the labels the spec names and was never compared with a real notice.
// Czech follows a real notice, whose fields come in this fixed order.
const LAYOUTS: Record<FioVariant, Layout> = {
  en: {
    ordered: false,
    labels: new Map([
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
  },
  cs: {
    ordered: true,
    labels: new Map([
      ["Typ pohybu", "movementType"],
      ["Protistrana", "counterparty"],
      ["ID pokynu", "instructionId"],
      ["Variabilní symbol", "variableSymbol"],
      ["Specifický symbol", "specificSymbol"],
      ["Konstantní symbol", "constantSymbol"],
      ["Uživatelský symbol", "userSymbol"],
      ["Zpráva pro příjemce", "message"],
    ]),
  },
};

// Every quantifier is bounded or separated by a literal the next token cannot match,
// so the patterns stay linear on untrusted mail text.
const SENTENCE =
  /^[Zz]ůstatek účtu (\S{1,40}) se (\d{1,2}\.\d{1,2}\.\d{4}) v (\d{1,2}:\d{2}) zvýšil o ([\d \u00A0\u202F]{1,40}(?:,\d{2})?) ([A-Z]{3})\.?$/u;
const COUNTERPARTY = /^(\S{1,40})(?: \((.{1,255})\))?$/u;
const EN_AMOUNT = /^([1-9]\d{0,2}(?:[ \u00A0\u202F]\d{3})+|0|[1-9]\d*)(?:\.(\d{2}))?$/;
const CS_AMOUNT = /^([1-9]\d{0,2}(?:[ \u00A0\u202F]\d{3})+|0|[1-9]\d*)(?:,(\d{2}))?$/;
const EN_DATE = /^(\d{1,2})\/(\d{1,2})\/(20\d{2})(?: ((?:[01]\d|2[0-3]):[0-5]\d))?$/;
const CS_DATE = /^(\d{1,2})\.(\d{1,2})\.(20\d{2})(?: ((?:[01]\d|2[0-3]):[0-5]\d))?$/;
const ACCOUNT = /^(?:\d{1,6}-)?\d{1,10}(?:\/\d{4})?$/;
const COUNTERPARTY_ACCOUNT = /^(?:\d{1,6}-)?\d{1,10}\/\d{4}$/;
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

function fieldOf(line: string, labels: Map<string, Field>): Field | undefined {
  const colon = line.indexOf(":");
  return colon < 0 ? undefined : labels.get(line.slice(0, colon));
}

// The message is free text from the payer and may span lines, so nothing after its
// label can be trusted, however much it looks like a field.
function linesThroughMessage(lines: string[], labels: Map<string, Field>): string[] {
  const message = lines.findIndex((line) => fieldOf(line, labels) === "message");
  return message < 0 ? lines : lines.slice(0, message + 1);
}

// In an ordered layout a field out of place can only come from a value spanning lines,
// such as a user symbol, so it is as doubtful as a repeated one.
function readFields(lines: string[], { labels, ordered }: Layout): Map<Field, string> | null {
  const order = [...labels.values()];
  const fields = new Map<Field, string>();
  let last = -1;
  for (const line of lines) {
    const field = fieldOf(line, labels);
    if (!field) continue;
    if (fields.has(field)) return null;
    const position = order.indexOf(field);
    if (ordered && position < last) return null;
    last = position;
    fields.set(field, line.slice(line.indexOf(":") + 1).trim());
  }
  return fields;
}

// The sentence must stand alone before the first field, so that no field value can supply it.
function readSentence(lines: string[], labels: Map<string, Field>, fields: Map<Field, string>) {
  const firstField = lines.findIndex((line) => fieldOf(line, labels));
  const found = lines.flatMap((line, index) => {
    const match = SENTENCE.exec(line);
    return match ? [{ index, match }] : [];
  });
  if (found.length !== 1) return false;
  const [{ index, match }] = found as [{ index: number; match: RegExpExecArray }];
  if (firstField >= 0 && index > firstField) return false;
  const [, account, date, time, amount, currency] = match as string[];
  fields.set("account", account!);
  fields.set("date", `${date!} ${time!.padStart(5, "0")}`);
  fields.set("amount", amount!);
  fields.set("currency", currency!);
  return true;
}

function readCounterparty(fields: Map<Field, string>): boolean {
  const value = fields.get("counterparty");
  if (!value) return true;
  const match = COUNTERPARTY.exec(value);
  if (!match || !COUNTERPARTY_ACCOUNT.test(match[1]!)) return false;
  fields.set("counterpartyAccount", match[1]!);
  if (match[2]) fields.set("counterpartyName", match[2].trim());
  return true;
}

function parseAmount(text: string, variant: FioVariant): number | null {
  const match = (variant === "en" ? EN_AMOUNT : CS_AMOUNT).exec(text);
  if (!match) return null;
  const [, whole, fraction = "0"] = match;
  const minor = Number(whole!.replace(/\D/g, "")) * 100 + Number(fraction);
  return minor > 0 && Number.isSafeInteger(minor) ? minor : null;
}

function parseOccurredAt(text: string, variant: FioVariant): ParsedNotice["occurredAt"] | null {
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

  const layout = LAYOUTS[variant];
  const lines = linesThroughMessage(
    text.split("\n").map((line) => line.trim()),
    layout.labels,
  );
  const fields = readFields(lines, layout);
  if (!fields) return null;
  if (variant === "cs" && !(readSentence(lines, layout.labels, fields) && readCounterparty(fields)))
    return null;

  const targetAccount = fields.get("account") ?? "";
  const amountMinor = parseAmount(fields.get("amount") ?? "", variant);
  const currency = CURRENCIES.find((code) => code === fields.get("currency"));
  const occurredAt = parseOccurredAt(fields.get("date") ?? "", variant);
  const instructionId = fields.get("instructionId") ?? "";
  const variableSymbol = optional(fields.get("variableSymbol"), SYMBOL);
  const specificSymbol = optional(fields.get("specificSymbol"), SYMBOL);
  const constantSymbol = optional(fields.get("constantSymbol"), SYMBOL);
  const counterpartyAccount = optional(fields.get("counterpartyAccount"), ACCOUNT);

  if (
    !ACCOUNT.test(targetAccount) ||
    amountMinor === null ||
    !currency ||
    !occurredAt ||
    !INSTRUCTION_ID.test(instructionId) ||
    variableSymbol === undefined ||
    specificSymbol === undefined ||
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

export const fioParser: BankNoticeParser = {
  bank: "fio",
  domain: "fio.cz",
  variants: [...VARIANT_BY_SUBJECT.values()],
  autoMatchVariants: ["cs"],
  classify,
  parse,
};
