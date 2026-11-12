import { suggestedClause } from "./clauses";
import type { Currency } from "./currency";
import { isHexColor } from "./contrast";
import { deviationExceeds, type ExchangeRateSource } from "./fx";
import { addDays, daysBetween, toDiscount, type Appearance, type InvoiceType } from "./invoice";
import {
  allowsNegativePrice,
  cappedDiscounts,
  computeTotals,
  formatQuantity,
  parseQuantity,
  type DiscountKind,
  type RoundingMode,
  type Totals,
  type TotalsLine,
} from "./invoice-totals";
import { AmountOutOfRangeError, formatMoneyInput, parseMoney } from "./money";
import type { CalendarDate } from "./number-format";
import type { DateFormat, Language, PaymentMethod } from "./preferences";
import { planQr, type QrState } from "./qr-payload";
import { formatCalendarDate } from "./template-vars";
import { TEXTS } from "./texts";

export type FormLine = {
  key: string;
  catalogItemId: string | null;
  name: string;
  description: string;
  quantity: string;
  unit: string;
  price: string;
  discountKind: DiscountKind;
  discount: string;
  priceCurrency?: Currency;
};

export type FormValues = {
  customerId: string | null;
  seriesId: string | null;
  bankAccountId: string | null;
  issueDate: string;
  dueDate: string;
  taxableDate: string;
  language: Language;
  currency: Currency;
  exchangeRate: string;
  exchangeRateSource: ExchangeRateSource | null;
  foreign: boolean;
  clause: string;
  paymentMethod: PaymentMethod;
  orderRef: string;
  reference: string;
  textBefore: string;
  textAfter: string;
  note: string;
  discountKind: DiscountKind;
  discount: string;
  rounding: RoundingMode;
  appearance: Appearance;
  lines: FormLine[];
};

export type TouchedField = keyof FormValues;

type DocumentLine = {
  catalogItemId: string | null;
  name: string;
  description: string;
  quantityMilli: number;
  unit: string;
  unitPriceMinor: number;
  discountKind: DiscountKind;
  discountValue: number;
};

export type DocumentFields = Omit<
  FormValues,
  | "customerId"
  | "seriesId"
  | "issueDate"
  | "dueDate"
  | "taxableDate"
  | "exchangeRate"
  | "discount"
  | "lines"
> & {
  issueDate: string | null;
  dueDate: string | null;
  taxableDate: string | null;
  exchangeRateMicros: number | null;
  discountValue: number;
  lines: DocumentLine[];
};

type FormDocument = Omit<
  DocumentFields,
  | "lines"
  | "bankAccountId"
  | "appearance"
  | "language"
  | "currency"
  | "paymentMethod"
  | "exchangeRateSource"
  | "foreign"
  | "clause"
> & {
  // Optional: a template or plan stored before these fields existed has none of them.
  exchangeRateSource?: ExchangeRateSource | null;
  foreign?: boolean;
  clause?: string;
  bankAccountId: string | null;
  appearance: Appearance;
  language: Language;
  currency: Currency;
  paymentMethod: PaymentMethod;
  customerId: string | null;
  seriesId: string | null;
  lines: readonly DocumentLine[];
};

export type AccountChoice = {
  id: string;
  currency: string;
  isDefault: boolean;
  iban: boolean;
  czechIban: boolean;
  bic: boolean;
};

export type CustomerDefaults = {
  dueDays: number;
  language: Language;
  currency: Currency;
  paymentMethod: PaymentMethod;
  appearance: Appearance;
  foreign: boolean;
  dic: string;
  vatIdentified: boolean;
  clauseTexts: Record<Language, string>;
};

export type ClauseDefaults = {
  vatIdentified: boolean;
  customerDic: string;
  texts: Record<Language, string>;
};

export type ForeignDefaults = ClauseDefaults & { currency: Currency; currencyLocked?: boolean };

export type RateResult = {
  rateMicros: number;
  source: Exclude<ExchangeRateSource, "manual">;
  listDate: CalendarDate | null;
  reference: number | null;
} | null;

const RATE = /^(\d+)(?:[.,](\d{1,6}))?$/;
const MICROS = 1_000_000;
const NO_RATE = { exchangeRate: "", exchangeRateSource: null } as const;

let addedLines = 0;

export function blankLine(unit: string): FormLine {
  addedLines += 1;
  return {
    key: `new-${addedLines}`,
    catalogItemId: null,
    name: "",
    description: "",
    quantity: "1",
    unit,
    price: "",
    discountKind: "none",
    discount: "",
  };
}

export function isEmptyLine(line: FormLine): boolean {
  return !line.catalogItemId && !line.name.trim() && !line.description.trim() && !line.price.trim();
}

export function nonEmptyLines(lines: FormLine[]): FormLine[] {
  return lines.filter((line) => !isEmptyLine(line));
}

export function parseRate(input: string): number | null {
  const match = RATE.exec(input.trim());
  if (!match) return null;
  const [, whole, fraction = ""] = match;
  const micros = Number(whole) * MICROS + Number(fraction.padEnd(6, "0"));
  return Number.isSafeInteger(micros) && micros > 0 ? micros : null;
}

export function formatRate(micros: number | null): string {
  if (micros === null) return "";
  const fraction = String(micros % MICROS)
    .padStart(6, "0")
    .replace(/0+$/, "");
  const whole = Math.trunc(micros / MICROS);
  return fraction ? `${whole},${fraction}` : String(whole);
}

function formatAmount(value: number): string {
  return formatMoneyInput(value).replace(/,00$/, "");
}

// Percent is stored in basis points, which share the two decimal places of money.
export const formatDiscount = (kind: DiscountKind, value: number) =>
  kind === "none" ? "" : formatAmount(value);

const parseAmount = (input: string, signed = false): number | null => {
  if (!input.trim()) return 0;
  const value = parseMoney(input);
  return value !== null && (signed || value >= 0) ? value : null;
};

export function formFromDocument(document: FormDocument, defaultUnit: string): FormValues {
  return {
    customerId: document.customerId,
    seriesId: document.seriesId,
    bankAccountId: document.bankAccountId,
    issueDate: document.issueDate ?? "",
    dueDate: document.dueDate ?? "",
    taxableDate: document.taxableDate ?? "",
    language: document.language,
    currency: document.currency,
    exchangeRate: formatRate(document.exchangeRateMicros),
    // A rate saved before sources existed was typed by a person.
    exchangeRateSource:
      document.exchangeRateSource ?? (document.exchangeRateMicros === null ? null : "manual"),
    foreign: document.foreign ?? false,
    clause: document.clause ?? "",
    paymentMethod: document.paymentMethod,
    orderRef: document.orderRef,
    reference: document.reference,
    textBefore: document.textBefore,
    textAfter: document.textAfter,
    note: document.note,
    discountKind: document.discountKind,
    discount: formatDiscount(document.discountKind, document.discountValue),
    rounding: document.rounding,
    appearance: document.appearance,
    // Keys must match between server and client render, so they come from the position.
    lines:
      document.lines.length > 0
        ? document.lines.map((line, i) => ({
            key: `saved-${i}`,
            catalogItemId: line.catalogItemId,
            name: line.name,
            description: line.description,
            quantity: formatQuantity(line.quantityMilli),
            unit: line.unit,
            price: formatAmount(line.unitPriceMinor),
            discountKind: line.discountKind,
            discount: formatDiscount(line.discountKind, line.discountValue),
          }))
        : [{ ...blankLine(defaultUnit), key: "saved-0" }],
  };
}

export type FieldsResult = { ok: true; fields: DocumentFields } | { ok: false; invalid: string[] };

export function toDocumentFields(values: FormValues, type: InvoiceType): FieldsResult {
  const signedPrice = allowsNegativePrice(type);
  const invalid: string[] = [];
  const checked = <T>(id: string, value: T | null, fallback: T): T => {
    if (value !== null) return value;
    invalid.push(id);
    return fallback;
  };

  const lines = nonEmptyLines(values.lines).map((line) => {
    const id = (field: string) => `line-${line.key}-${field}`;
    return {
      catalogItemId: line.catalogItemId,
      name: line.name,
      description: line.description,
      quantityMilli: checked(
        id("quantity"),
        line.quantity.trim() ? parseQuantity(line.quantity) : 0,
        0,
      ),
      unit: line.unit,
      unitPriceMinor: checked(id("price"), parseAmount(line.price, signedPrice), 0),
      discountKind: line.discountKind,
      discountValue:
        line.discountKind === "none" ? 0 : checked(id("discount"), parseAmount(line.discount), 0),
    };
  });

  const usesRate = values.currency !== "CZK" && values.exchangeRate.trim() !== "";
  const {
    customerId: _c,
    seriesId: _s,
    exchangeRate: _r,
    discount: _d,
    lines: _l,
    ...rest
  } = values;
  const fields: DocumentFields = {
    ...rest,
    issueDate: values.issueDate || null,
    dueDate: values.dueDate || null,
    taxableDate: values.taxableDate || null,
    exchangeRateMicros: usesRate
      ? checked("field-exchangeRate", parseRate(values.exchangeRate), null)
      : null,
    exchangeRateSource: usesRate ? values.exchangeRateSource : null,
    discountValue:
      values.discountKind === "none"
        ? 0
        : checked("field-discount", parseAmount(values.discount), 0),
    lines,
  };
  for (const [name, color] of Object.entries(values.appearance.colors)) {
    if (color && !isHexColor(color)) invalid.push(`field-color-${name}`);
  }
  return invalid.length > 0 ? { ok: false, invalid } : { ok: true, fields };
}

export function draftFields(type: InvoiceType, values: FormValues, fields: DocumentFields) {
  return { ...fields, type, customerId: values.customerId, seriesId: values.seriesId };
}

type DiscountedLine = Pick<
  DocumentLine,
  "quantityMilli" | "unitPriceMinor" | "discountKind" | "discountValue"
>;

const totalsLines = (lines: readonly DiscountedLine[]): TotalsLine[] =>
  lines.map((line) => ({
    quantityMilli: line.quantityMilli,
    unitPriceMinor: line.unitPriceMinor,
    discount: toDiscount(line.discountKind, line.discountValue),
  }));

export function discountNotes(
  document: { discountKind: DiscountKind; discountValue: number; lines: readonly DiscountedLine[] },
  totals: Totals,
): string[] {
  const capped = cappedDiscounts(
    totalsLines(document.lines),
    toDiscount(document.discountKind, document.discountValue),
    totals,
  );
  const T = TEXTS.invoices.form;
  return [
    ...(capped.document ? [T.discountCapped] : []),
    ...capped.lines.map(T.lineDiscountCapped),
  ];
}

export function hasFixedDiscount(values: Pick<FormValues, "discountKind" | "lines">): boolean {
  return (
    values.discountKind === "amount" || values.lines.some((line) => line.discountKind === "amount")
  );
}

export function computeFormTotals(values: FormValues, type: InvoiceType): Totals | null {
  const result = toDocumentFields(values, type);
  if (!result.ok) return null;
  const { fields } = result;
  try {
    return computeTotals(
      totalsLines(fields.lines),
      toDiscount(fields.discountKind, fields.discountValue),
      fields.rounding,
    );
  } catch (error) {
    if (error instanceof AmountOutOfRangeError) return null;
    throw error;
  }
}

export function defaultAccountId(
  accounts: readonly AccountChoice[],
  currency: string,
): string | null {
  const own = accounts.filter((account) => account.currency === currency);
  return (own.find((account) => account.isDefault) ?? own[0])?.id ?? null;
}

export function changeCurrency(
  values: FormValues,
  currency: Currency,
  touched: ReadonlySet<TouchedField>,
  accounts: readonly AccountChoice[],
): FormValues {
  const rate = currency === values.currency ? {} : NO_RATE;
  return {
    ...values,
    ...rate,
    currency,
    bankAccountId: touched.has("bankAccountId")
      ? values.bankAccountId
      : defaultAccountId(accounts, currency),
  };
}

export function changeRate(values: FormValues, exchangeRate: string): FormValues {
  return { ...values, exchangeRate, exchangeRateSource: exchangeRate.trim() ? "manual" : null };
}

// A rate typed by a person stays, only a change of currency or their own action replaces it. No
// answer keeps what is there: an outage must not take a usable rate away, issuing looks again.
export function applyRate(values: FormValues, result: RateResult): FormValues {
  if (values.exchangeRateSource === "manual" || !result) return values;
  return {
    ...values,
    exchangeRate: formatRate(result.rateMicros),
    exchangeRateSource: result.source,
  };
}

export function changeForeign(
  values: FormValues,
  on: boolean,
  defaults: ForeignDefaults,
  touched: ReadonlySet<TouchedField>,
  accounts: readonly AccountChoice[],
): FormValues {
  if (on) {
    const { customerDic, vatIdentified, texts } = defaults;
    const language = values.language;
    const clause =
      values.clause ||
      suggestedClause({ foreign: true, language, vatIdentified, customerDic, texts });
    return { ...values, foreign: true, clause };
  }
  const off = { ...values, foreign: false, clause: "" };
  return defaults.currencyLocked ? off : changeCurrency(off, defaults.currency, touched, accounts);
}

// Only the exact default text is ours to translate, whatever the person wrote stays.
export function changeLanguage(
  values: FormValues,
  language: Language,
  defaults: ClauseDefaults,
  touched: ReadonlySet<TouchedField>,
): FormValues {
  const untouched = !touched.has("clause") && values.clause === defaults.texts[values.language];
  return { ...values, language, clause: untouched ? defaults.texts[language] : values.clause };
}

// The PDF prints the date only with showDuzp, and a date just filled in is meant to be printed.
export function changeTaxableDate(values: FormValues, taxableDate: string): FormValues {
  const appearance =
    taxableDate && !values.taxableDate
      ? { ...values.appearance, showDuzp: true }
      : values.appearance;
  return { ...values, taxableDate, appearance };
}

export function changeIssueDate(
  values: FormValues,
  issueDate: string,
  touched: ReadonlySet<TouchedField>,
): FormValues {
  const keepsGap =
    !touched.has("dueDate") && Boolean(issueDate && values.issueDate && values.dueDate);
  return {
    ...values,
    issueDate,
    dueDate: keepsGap
      ? addDays(issueDate, daysBetween(values.issueDate, values.dueDate))
      : values.dueDate,
  };
}

function isOwnClause(
  values: Pick<FormValues, "clause">,
  texts: Record<Language, string>,
  touched: ReadonlySet<TouchedField>,
): boolean {
  if (touched.has("clause")) return true;
  return values.clause.trim() !== "" && !Object.values(texts).includes(values.clause);
}

export function foreignFieldsOpen(
  values: Pick<FormValues, "foreign" | "currency" | "clause">,
): boolean {
  return values.foreign || values.currency !== "CZK" || values.clause.trim() !== "";
}

export function customerForeign(
  values: FormValues,
  defaults: Pick<CustomerDefaults, "foreign" | "dic" | "vatIdentified" | "clauseTexts">,
  touched: ReadonlySet<TouchedField>,
): FormValues {
  const foreign = touched.has("foreign") ? values.foreign : defaults.foreign;
  const clause = isOwnClause(values, defaults.clauseTexts, touched)
    ? values.clause
    : suggestedClause({
        foreign,
        language: values.language,
        vatIdentified: defaults.vatIdentified,
        customerDic: defaults.dic,
        texts: defaults.clauseTexts,
      });
  return { ...values, foreign, clause };
}

export type ForeignOffer = Partial<Pick<FormValues, "foreign" | "clause">>;

// What a customer would change. A person's own clause on a domestic document goes only through
// this offer, because customerForeign never deletes it on its own.
export function foreignOffer(
  values: FormValues,
  defaults: Pick<CustomerDefaults, "foreign" | "dic" | "vatIdentified" | "clauseTexts">,
  touched: ReadonlySet<TouchedField>,
): ForeignOffer | null {
  const next = customerForeign(values, defaults, touched);
  const wanted = { foreign: next.foreign, clause: next.foreign ? next.clause : "" };
  const changed = Object.entries(wanted).filter(
    ([field, value]) => value !== values[field as keyof ForeignOffer],
  );
  return changed.length > 0 ? Object.fromEntries(changed) : null;
}

export function applyCustomerDefaults(
  values: FormValues,
  defaults: CustomerDefaults,
  touched: ReadonlySet<TouchedField>,
  accounts: readonly AccountChoice[],
): FormValues {
  const unlessTouched = <K extends keyof CustomerDefaults & TouchedField>(field: K) =>
    touched.has(field) ? values[field] : defaults[field];
  const next: FormValues = {
    ...values,
    language: unlessTouched("language"),
    paymentMethod: unlessTouched("paymentMethod"),
    appearance: touched.has("appearance")
      ? values.appearance
      : {
          ...defaults.appearance,
          showDuzp: defaults.appearance.showDuzp || values.appearance.showDuzp,
        },
    dueDate:
      touched.has("dueDate") || !values.issueDate
        ? values.dueDate
        : addDays(values.issueDate, defaults.dueDays),
  };
  return changeCurrency(
    customerForeign(next, defaults, touched),
    unlessTouched("currency"),
    touched,
    accounts,
  );
}

export type CustomerOffer = Partial<
  Pick<
    FormValues,
    | "currency"
    | "exchangeRate"
    | "exchangeRateSource"
    | "bankAccountId"
    | "language"
    | "paymentMethod"
    | "appearance"
    | "dueDate"
    | "foreign"
    | "clause"
  >
>;

// A saved document already says what it wants, so a new customer only proposes its defaults. The
// account stays with the currency: without a currency change there is no reason to swap it. A locked
// currency (the document has payments) is never offered, nor is the account that follows it.
export function customerOffer(
  values: FormValues,
  defaults: CustomerDefaults,
  touched: ReadonlySet<TouchedField>,
  accounts: readonly AccountChoice[],
  currencyLocked = false,
): CustomerOffer | null {
  const wantedDefaults = currencyLocked ? { ...defaults, currency: values.currency } : defaults;
  const next = applyCustomerDefaults(values, wantedDefaults, touched, accounts);
  const { currency, exchangeRate, exchangeRateSource } = next;
  const { language, paymentMethod, appearance, dueDate } = next;
  const bankAccountId = currency === values.currency ? values.bankAccountId : next.bankAccountId;
  const wanted = {
    currency,
    exchangeRate,
    exchangeRateSource,
    language,
    paymentMethod,
    appearance,
    dueDate,
    bankAccountId,
  };
  const changed = Object.entries(wanted).filter(
    ([field, value]) =>
      JSON.stringify(value) !== JSON.stringify(values[field as keyof CustomerOffer]),
  );
  const offer = { ...Object.fromEntries(changed), ...foreignOffer(values, defaults, touched) };
  return Object.keys(offer).length > 0 ? offer : null;
}

// Only presence travels to the browser. Any valid numbers stand in, planQr then decides the rest.
const SAMPLE_IBAN = "CZ6508000000192000145399";
const SAMPLE_FOREIGN_IBAN = "DE89370400440532013000";
const SAMPLE_BIC = "GIBACZPX";

export function formQrState(values: FormValues, accounts: readonly AccountChoice[]): QrState {
  if (!values.appearance.showQr) return "turned_off";
  if (values.paymentMethod !== "transfer") return "other_payment";
  const account = accounts.find((item) => item.id === values.bankAccountId);
  if (!account) return "no_account";
  const plan = planQr({
    currency: values.currency,
    dueMinor: 1,
    iban: account.iban ? (account.czechIban ? SAMPLE_IBAN : SAMPLE_FOREIGN_IBAN) : null,
    bic: account.bic ? SAMPLE_BIC : null,
    variableSymbol: null,
    message: null,
    recipient: "-",
    enabled: true,
    paid: false,
  });
  if (plan.kind !== "none") return plan.kind;
  return plan.reason === "disabled" ? "turned_off" : plan.reason;
}

export function formRateNotes(input: {
  currency: string;
  rateMicros: number | null;
  source: ExchangeRateSource | null;
  listDate: CalendarDate | null;
  reference: number | null;
  dateFormat: DateFormat;
}): string[] {
  const { currency, rateMicros, source, listDate, reference, dateFormat } = input;
  if (currency === "CZK" || !rateMicros) return [];
  const R = TEXTS.exchangeRates.notes;
  return [
    ...(source === "last_known" && listDate
      ? [R.lastKnown(currency, formatCalendarDate(listDate, dateFormat))]
      : []),
    ...(reference === null
      ? [R.noReference]
      : deviationExceeds(rateMicros, reference)
        ? [R.deviation(currency)]
        : []),
  ];
}

const LINE_FIELDS: Record<string, string> = {
  name: "name",
  description: "description",
  quantityMilli: "quantity",
  unitPriceMinor: "price",
};

const SETTINGS_FIELDS: Record<string, string> = {
  seriesId: "/nastaveni/rady",
};

export type FieldTarget = { href: string; external: boolean };

export function fieldTarget(field: string, values: FormValues, accountCount: number): FieldTarget {
  const external = (href: string) => ({ href, external: true });
  if (field.startsWith("supplier.")) return external("/nastaveni/dodavatel");
  if (field === "bankAccountId" && accountCount === 0) return external("/nastaveni/ucty");
  const settings = SETTINGS_FIELDS[field];
  if (settings) return external(settings);

  const [, position, part] = /^lines\.(\d+)\.(\w+)$/.exec(field) ?? [];
  const line = position === undefined ? undefined : nonEmptyLines(values.lines)[Number(position)];
  if (line) return { href: `#line-${line.key}-${LINE_FIELDS[part!] ?? "name"}`, external: false };
  const name = field === "exchangeRateMicros" ? "exchangeRate" : field;
  return { href: `#field-${name}`, external: false };
}
