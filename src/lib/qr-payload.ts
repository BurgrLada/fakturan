import { normalizeIban } from "@/lib/iban";

export type QrReason =
  | "disabled"
  | "paid"
  | "zero"
  | "currency"
  | "not_czech_account"
  | "missing_iban_bic";

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

export function amountDue(row: { totalMinor: number; paidMinor: number }): number {
  return row.totalMinor - row.paidMinor;
}

function formatAmount(minor: number): string {
  return `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, "0")}`;
}

// Cuts by code point so a surrogate pair is never split.
function truncate(value: string, max: number): string {
  return [...value].slice(0, max).join("");
}

function stripDiacritics(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "");
}

function cleanMessage(value: string | null): string {
  return stripDiacritics(value ?? "").trim();
}

function digits(value: string | null): string {
  return (value ?? "").replace(/\D/g, "").slice(0, VARIABLE_SYMBOL_MAX);
}

function spayd(input: QrInput, iban: string): QrPlan {
  const message = truncate(cleanMessage(input.message), SPAYD_MESSAGE_MAX);
  const vs = digits(input.variableSymbol);
  const parts = ["SPD", "1.0", `ACC:${iban}`, `AM:${formatAmount(input.dueMinor)}`, "CC:CZK"];
  if (vs) parts.push(`X-VS:${vs}`);
  if (message) parts.push(`MSG:${message.replace(/%/g, "%25").replace(/\*/g, "%2A")}`);
  return { kind: "spayd", payload: parts.join("*") };
}

function epc(input: QrInput, iban: string, bic: string): QrPlan {
  const vs = digits(input.variableSymbol);
  const message = cleanMessage(input.message);
  const remittance = truncate(
    [vs && `VS${vs}`, message].filter(Boolean).join(" "),
    EPC_MESSAGE_MAX,
  );
  const payload = [
    "BCD",
    "002",
    "1",
    "SCT",
    bic,
    truncate(input.recipient, EPC_RECIPIENT_MAX),
    iban,
    `EUR${formatAmount(input.dueMinor)}`,
    "",
    "",
    remittance,
  ].join("\n");
  return { kind: "epc", payload };
}

export function planQr(input: QrInput): QrPlan {
  if (!input.enabled) return { kind: "none", reason: "disabled" };
  if (input.paid) return { kind: "none", reason: "paid" };
  if (input.dueMinor <= 0) return { kind: "none", reason: "zero" };
  const iban = normalizeIban(input.iban ?? "");
  const bic = (input.bic ?? "").trim().toUpperCase();
  if (input.currency === "CZK") {
    if (!iban) return { kind: "none", reason: "missing_iban_bic" };
    if (!iban.startsWith("CZ")) return { kind: "none", reason: "not_czech_account" };
    return spayd(input, iban);
  }
  if (input.currency === "EUR") {
    if (!iban || !bic) return { kind: "none", reason: "missing_iban_bic" };
    return epc(input, iban, bic);
  }
  return { kind: "none", reason: "currency" };
}
