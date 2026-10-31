import type { Currency } from "./currency";
import type { DiscountKind } from "./invoice-totals";
import type { InvoiceChange, lineBody } from "./invoice-diff";
import type { InvoiceDocument } from "./invoice-document";
import { formatRate } from "./invoice-form";
import { formatQuantity } from "./invoice-totals";
import { formatMoney } from "./money";
import { formatCalendarDate } from "./template-vars";
import { TEXTS } from "./texts";

const T = TEXTS.invoices.versions;
const P = TEXTS.preferences;

export type VersionChange = InvoiceChange;
type FieldChange = Extract<InvoiceChange, { kind: "field" }>;
type LineChange = Extract<InvoiceChange, { kind: "line" }>;
type LineBody = ReturnType<typeof lineBody>;
type Side = "before" | "after";

export type VersionFormat = {
  before: InvoiceDocument;
  after: InvoiceDocument;
  seriesName: (id: string) => string | undefined;
};

// The snapshot next to these ids says the same thing in words.
const HIDDEN_FIELDS = new Set(["customerId", "bankAccountId"]);
const DATE_FIELDS = new Set(["issueDate", "dueDate", "taxableDate"]);
const PARTY = /^snapshot\.(customer|supplier|account)\.(\w+)$/;
const COLOR = /^appearance\.colors\.(\w+)$/;

export function visibleChanges(changes: InvoiceChange[]): InvoiceChange[] {
  return changes.filter((change) => change.kind === "line" || !HIDDEN_FIELDS.has(change.field));
}

function lookup(map: object, key: string): string | undefined {
  return (map as Record<string, string>)[key];
}

function fieldLabel(field: string): string {
  const party = PARTY.exec(field);
  if (party) {
    const name = lookup(T.partyFields, party[2]!);
    return name ? `${lookup(T.party, party[1]!)} – ${name}` : T.otherField;
  }
  const color = COLOR.exec(field);
  if (color) return `${T.colorPrefix} – ${lookup(TEXTS.designs.color, color[1]!) ?? color[1]}`;
  return lookup(T.fields, field) ?? T.otherField;
}

function discountText(kind: DiscountKind, value: number, currency: Currency): string {
  if (kind === "percent") return `${(value / 100).toLocaleString("cs-CZ")} %`;
  if (kind === "amount") return formatMoney(value, currency);
  return TEXTS.invoices.form.discounts.none;
}

function fieldValue(change: FieldChange, side: Side, format: VersionFormat): string {
  const value = change[side];
  const { field } = change;
  const doc = format[side];
  if (value === null || value === "") return "–";
  if (typeof value === "boolean") return value ? T.yes : T.no;
  if (field.endsWith("Minor")) return formatMoney(Number(value), doc.currency);
  if (field.startsWith("images.")) return T.file;
  if (field === "seriesId") return format.seriesName(String(value)) ?? T.removedSeries;
  if (field === "discountValue") {
    return discountText(doc.discountKind, Number(value), doc.currency);
  }
  if (DATE_FIELDS.has(field)) return formatCalendarDate(String(value), "d. M. yyyy");
  if (field === "exchangeRateMicros") return formatRate(Number(value));
  const text = String(value);
  if (field === "paymentMethod") return lookup(P.paymentMethods, text) ?? text;
  if (field === "language") return lookup(P.languages, text) ?? text;
  if (field === "rounding") return lookup(P.roundings, text) ?? text;
  if (field === "discountKind") return lookup(TEXTS.invoices.form.discounts, text) ?? text;
  if (field === "appearance.logoPosition") return lookup(TEXTS.designs.logoPositions, text) ?? text;
  return text;
}

function lineDifferences(change: LineChange, format: VersionFormat): string {
  const { before, after } = change as { before: LineBody; after: LineBody };
  const from = format.before.currency;
  const to = format.after.currency;
  const pairs: [string, string, string][] = [
    [T.lineFields.name, before.name, after.name],
    [T.lineFields.description, before.description || "–", after.description || "–"],
    [
      T.lineFields.quantity,
      formatQuantity(before.quantityMilli),
      formatQuantity(after.quantityMilli),
    ],
    [T.lineFields.unit, before.unit, after.unit],
    [
      T.lineFields.price,
      formatMoney(before.unitPriceMinor, from),
      formatMoney(after.unitPriceMinor, to),
    ],
    [
      T.lineFields.discount,
      discountText(before.discountKind, before.discountValue, from),
      discountText(after.discountKind, after.discountValue, to),
    ],
  ];
  return pairs
    .filter(([, a, b]) => a !== b)
    .map(([label, a, b]) => `${label} ${a} → ${b}`)
    .join(", ");
}

export function changeTitle(change: InvoiceChange): string {
  return change.kind === "field" ? fieldLabel(change.field) : T.line[change.change];
}

export function changeDetail(change: InvoiceChange, format: VersionFormat): string {
  if (change.kind === "field") {
    return `${fieldValue(change, "before", format)} → ${fieldValue(change, "after", format)}`;
  }
  const name = (change.after ?? change.before)?.name ?? "";
  if (change.change === "moved") {
    const from = (change.before?.position ?? 0) + 1;
    return `${name}, ${T.positions(from, change.position + 1)}`;
  }
  if (change.change === "changed") return `${name}: ${lineDifferences(change, format)}`;
  return name;
}
