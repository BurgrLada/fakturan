import { normalizeIban } from "@/lib/iban";
import type { InvoiceDocument } from "@/lib/invoice-document";

export type QrReason =
  | "disabled"
  | "paid"
  | "zero"
  | "currency"
  | "not_czech_account"
  | "missing_iban_bic"
  | "missing_recipient"
  | "amount_too_large";

export type QrPlan =
  | { kind: "spayd" | "epc"; payload: string }
  | { kind: "none"; reason: QrReason };

export type QrInput = {
  currency: string;
  dueMinor: number;
  iban: string | null;
  bic: string | null;
  variableSymbol: string | null;
  message: string | null;
  recipient: string;
  enabled: boolean;
  paid: boolean;
};

const SPAYD_MESSAGE_MAX = 60;
const EPC_MESSAGE_MAX = 140;
const EPC_RECIPIENT_MAX = 70;
const VARIABLE_SYMBOL_MAX = 10;
const MAX_DUE_MINOR = 99_999_999_999;
const EPC_MAX_BYTES = 331;

const TRANSLITERATIONS: Record<string, string> = {
  Ł: "L",
  ł: "l",
  ß: "ss",
  Ø: "O",
  ø: "o",
  Æ: "AE",
  æ: "ae",
  Œ: "OE",
  œ: "oe",
  Đ: "D",
  đ: "d",
  Ð: "D",
  ð: "d",
  Þ: "Th",
  þ: "th",
  ı: "i",
};

export type Balance = {
  totalMinor: number;
  paidMinor: number;
  creditsMinor: number;
  advanceMinor: number;
  supersededAt: Date | null;
};

// The SQL form is dueSql in server/db/invoice-sql. A replaced advance has nothing left to collect.
export function amountDue(row: Balance): number {
  const due = row.totalMinor + row.creditsMinor - row.advanceMinor - row.paidMinor;
  return row.supersededAt ? Math.min(0, due) : due;
}

function formatAmount(minor: number): string {
  return `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, "0")}`;
}

// Output is printable ASCII only, so character limits equal byte limits.
function toAscii(value: string | null): string {
  return (value ?? "")
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/[ŁłßØøÆæŒœĐđÐðÞþı]/g, (char) => TRANSLITERATIONS[char])
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/ +/g, " ")
    .trim();
}

function limit(value: string, max: number): string {
  return value.slice(0, max).trimEnd();
}

function digits(value: string | null): string {
  const only = (value ?? "").replace(/\D/g, "");
  return only.length > VARIABLE_SYMBOL_MAX ? "" : only;
}

function spayd(input: QrInput, iban: string): QrPlan {
  const message = limit(toAscii(input.message), SPAYD_MESSAGE_MAX);
  const vs = digits(input.variableSymbol);
  const parts = ["SPD", "1.0", `ACC:${iban}`, `AM:${formatAmount(input.dueMinor)}`, "CC:CZK"];
  if (vs) parts.push(`X-VS:${vs}`);
  if (message) parts.push(`MSG:${message.replace(/%/g, "%25").replace(/\*/g, "%2A")}`);
  return { kind: "spayd", payload: parts.join("*") };
}

function epc(input: QrInput, iban: string, bic: string, recipient: string): QrPlan {
  const vs = digits(input.variableSymbol);
  const message = toAscii(input.message);
  const remittance = limit([vs && `VS${vs}`, message].filter(Boolean).join(" "), EPC_MESSAGE_MAX);
  const payload = [
    "BCD",
    "002",
    "1",
    "SCT",
    bic,
    recipient,
    iban,
    `EUR${formatAmount(input.dueMinor)}`,
    "",
    "",
    remittance,
  ].join("\n");
  if (payload.length > EPC_MAX_BYTES) throw new Error("EPC payload exceeds 331 bytes");
  return { kind: "epc", payload };
}

export function planQr(input: QrInput): QrPlan {
  if (!input.enabled) return { kind: "none", reason: "disabled" };
  if (input.paid) return { kind: "none", reason: "paid" };
  if (!Number.isSafeInteger(input.dueMinor) || input.dueMinor <= 0) {
    return { kind: "none", reason: "zero" };
  }
  if (input.dueMinor > MAX_DUE_MINOR) return { kind: "none", reason: "amount_too_large" };
  const iban = normalizeIban(input.iban ?? "");
  const bic = (input.bic ?? "").trim().toUpperCase();
  if (input.currency === "CZK") {
    if (!iban) return { kind: "none", reason: "missing_iban_bic" };
    if (!iban.startsWith("CZ")) return { kind: "none", reason: "not_czech_account" };
    return spayd(input, iban);
  }
  if (input.currency === "EUR") {
    if (!iban || !bic) return { kind: "none", reason: "missing_iban_bic" };
    const recipient = limit(toAscii(input.recipient), EPC_RECIPIENT_MAX);
    if (!recipient) return { kind: "none", reason: "missing_recipient" };
    return epc(input, iban, bic, recipient);
  }
  return { kind: "none", reason: "currency" };
}

export type QrState =
  | "spayd"
  | "epc"
  | "turned_off"
  | "other_payment"
  | "no_account"
  | "settled"
  | Exclude<QrReason, "disabled">;

type QrDocument = Pick<
  InvoiceDocument,
  "status" | "currency" | "totals" | "snapshot" | "appearance" | "paymentMethod" | "variableSymbol"
>;

function offReason(doc: QrDocument): QrState | null {
  if (doc.status === "cancelled" || doc.status === "credited") return "settled";
  if (!doc.appearance.showQr) return "turned_off";
  if (doc.paymentMethod !== "transfer") return "other_payment";
  return doc.snapshot.account ? null : "no_account";
}

export function documentQrInput(doc: QrDocument, message: string): QrInput {
  const account = doc.snapshot.account;
  return {
    currency: doc.currency,
    dueMinor: amountDue(doc.totals),
    iban: account?.iban ?? null,
    bic: account?.swift ?? null,
    variableSymbol: doc.variableSymbol,
    message,
    recipient: doc.snapshot.supplier?.name ?? "",
    enabled: offReason(doc) === null,
    paid: doc.status === "paid",
  };
}

export function qrStateOf(doc: QrDocument): QrState {
  const off = offReason(doc);
  if (off) return off;
  const plan = planQr(documentQrInput(doc, ""));
  if (plan.kind !== "none") return plan.kind;
  return plan.reason === "disabled" ? "turned_off" : plan.reason;
}
