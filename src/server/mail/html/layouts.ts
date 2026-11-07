import type { MailLayout } from "@/lib/mail-look";
import { COLORS, SIZES, TYPE } from "./tokens";

export {
  DEFAULT_MAIL_LAYOUT,
  isMailLayout,
  LAYOUTS_WITH_QR,
  MAIL_LAYOUTS,
  type MailLayout,
} from "@/lib/mail-look";

// Every string here is already escaped HTML; layouts only arrange it.
export type Parts = {
  header: (color: string, place?: "page" | "band") => string;
  centeredHeader: string;
  message: string;
  signature: string;
  amount: { label: string; value: string; dueBy: string } | null;
  dueOn: string | null;
  account: string | null;
  variableSymbol: string | null;
  number: string | null;
  title: string | null;
  attachment: string | null;
  footer: string;
  qr: ((size: number) => string) | null;
  band: { background: string; text: string };
  labels: {
    due: string;
    number: string;
    dueDate: string;
    account: string;
    variableSymbol: string;
    vs: string;
    scanHint: string;
  };
  dueDate: string | null;
};

export type Layout = { page: string; body: (parts: Parts) => string };

const TABLE = 'role="presentation" cellpadding="0" cellspacing="0" border="0"';

const row = (content: string, style = "") => `<tr><td style="${style}">${content}</td></tr>`;

function card(content: string, extra = ""): string {
  return `<tr><td bgcolor="${COLORS.card}" style="background-color:${COLORS.card};border:1px solid ${COLORS.rule};border-radius:${SIZES.radius};padding:${SIZES.cardPadding}${extra}">${content}</td></tr>`;
}

function foot(parts: Parts): string {
  return `<tr><td align="center" style="padding-top:14px;text-align:center;${TYPE.foot}">${parts.footer}</td></tr>`;
}

function rows(pairs: [string, string | null][]): string {
  const cell = `padding:7px 0;border-top:1px solid ${COLORS.rule};vertical-align:top`;
  const present = pairs.filter((pair): pair is [string, string] => pair[1] !== null);
  if (present.length === 0) return "";
  const body = present
    .map(
      ([label, value]) =>
        `<tr><td style="${cell}">${label}</td><td align="right" style="${cell};text-align:right;font-weight:600">${value}</td></tr>`,
    )
    .join("");
  return `<table ${TABLE} width="100%" style="border-collapse:collapse;margin:12px 0;${TYPE.rows}">${body}</table>`;
}

const small = (text: string | null, extra = "") =>
  text ? `<div style="${TYPE.small}${extra}">${text}</div>` : "";

function amountBlock(parts: Parts, label: string | null, under: string | null): string {
  if (!parts.amount) return "";
  return `${small(label)}<div style="${TYPE.amount}">${parts.amount.value}</div>${small(under)}`;
}

// Inline blocks wrap on a narrow screen, so the code drops under the amount without a media query.
function side(left: string, qr: string | null): string {
  const block = "display:inline-block;vertical-align:middle";
  const right = qr ? `<div style="${block};margin:8px 0 0 16px">${qr}</div>` : "";
  return `<table ${TABLE} width="100%"><tr><td style="font-size:0;line-height:0"><div style="${block};width:100%;max-width:340px;${TYPE.base}">${left}</div>${right}</td></tr></table>`;
}

const joinDots = (...items: (string | null)[]) => items.filter(Boolean).join(" · ");

const chip = (parts: Parts) =>
  parts.attachment ? `<span style="${TYPE.chip}">${parts.attachment}</span>` : "";

function b1(p: Parts): string {
  const content = [
    p.header(COLORS.ink),
    p.message,
    p.signature,
    amountBlock(p, p.amount?.label ?? null, null),
    rows([
      [p.labels.number, p.number],
      [p.labels.dueDate, p.dueDate],
    ]),
    chip(p),
  ].join("");
  return card(content) + foot(p);
}

function b2(p: Parts): string {
  const content = [
    p.header(COLORS.ink),
    p.message,
    p.signature,
    p.amount ? side(amountBlock(p, p.amount.label, p.dueOn), p.qr?.(SIZES.qr.b2) ?? null) : "",
    rows([
      [p.labels.account, p.account],
      [p.labels.variableSymbol, p.variableSymbol],
    ]),
    chip(p),
  ].join("");
  return card(content) + foot(p);
}

function b3(p: Parts): string {
  const qr = p.qr?.(SIZES.qr.b3) ?? null;
  const details = [
    p.account && `${p.labels.account} ${p.account}`,
    p.variableSymbol && `${p.labels.vs} ${p.variableSymbol}`,
  ]
    .filter(Boolean)
    .join("<br>");
  const block = p.amount
    ? `<table ${TABLE} width="100%"><tr><td bgcolor="${COLORS.tint}" style="background-color:${COLORS.tint};border-radius:6px;padding:${SIZES.tintPadding}">${side(amountBlock(p, p.amount.dueBy, details || null), qr)}</td></tr></table>`
    : "";
  const hint = qr ? `<p style="margin:12px 0 0;${TYPE.small}">${p.labels.scanHint}</p>` : "";
  return card([p.header(COLORS.ink), p.message, p.signature, block, hint].join("")) + foot(p);
}

function b4(p: Parts): string {
  const { background, text } = p.band;
  const title = p.title
    ? `<td align="right" style="text-align:right;vertical-align:middle;color:${text};font-size:15px">${p.title}</td>`
    : "";
  const band = `<tr><td bgcolor="${background}" style="background-color:${background};color:${text};padding:${SIZES.bandPadding};border-radius:${SIZES.radius} ${SIZES.radius} 0 0"><table ${TABLE} width="100%"><tr><td style="vertical-align:middle;color:${text}">${p.header(text, "band")}</td>${title}</tr></table></td></tr>`;
  const under = joinDots(p.dueOn, p.variableSymbol && `${p.labels.vs} ${p.variableSymbol}`);
  const content = [
    p.message,
    p.signature,
    amountBlock(p, p.amount?.label ?? null, under || null),
  ].join("");
  const body = `<tr><td bgcolor="${COLORS.card}" style="background-color:${COLORS.card};border:1px solid ${COLORS.rule};border-top:0;border-radius:0 0 ${SIZES.radius} ${SIZES.radius};padding:${SIZES.cardPadding}">${content}</td></tr>`;
  return band + body + foot(p);
}

function b5(p: Parts): string {
  const qr = p.qr?.(SIZES.qr.b5) ?? null;
  const centered = (html: string) => `<div style="text-align:center">${html}</div>`;
  const amount = p.amount
    ? `<div style="margin-top:12px">${amountBlock(p, p.amount.label === p.labels.due ? null : p.amount.label, p.dueOn)}</div>`
    : "";
  const content = [
    p.centeredHeader,
    p.title ? `<span style="${TYPE.tag}">${p.title}</span>` : "",
    amount,
    qr ? `<div style="margin:12px 0 4px">${qr}</div>` : "",
    small(
      joinDots(
        p.account && `${p.labels.account} ${p.account}`,
        p.variableSymbol && `${p.labels.vs} ${p.variableSymbol}`,
      ) || null,
    ),
    `<div style="margin-top:14px">${p.message}${p.signature}</div>`,
  ].join("");
  return card(centered(content), ";text-align:center") + foot(p);
}

function letter(p: Parts, accentLine: boolean): string {
  const line = accentLine
    ? `<table ${TABLE} width="${SIZES.rule.width}" style="margin-bottom:16px"><tr><td height="${SIZES.rule.height}" bgcolor="${p.band.background}" style="height:${SIZES.rule.height}px;line-height:${SIZES.rule.height}px;font-size:0;background-color:${p.band.background};border-radius:2px">&nbsp;</td></tr></table>`
    : "";
  const content = [
    line,
    p.header(COLORS.ink),
    p.message,
    rows([
      [p.labels.number, p.number],
      [p.amount?.label ?? "", p.amount?.value ?? null],
      [p.labels.dueDate, p.dueDate],
    ]),
    p.signature,
  ].join("");
  return row(content);
}

export const LAYOUTS: Record<MailLayout, Layout> = {
  b1: { page: COLORS.page, body: b1 },
  b2: { page: COLORS.page, body: b2 },
  b3: { page: COLORS.page, body: b3 },
  b4: { page: COLORS.page, body: b4 },
  b5: { page: COLORS.page, body: b5 },
  a: { page: COLORS.card, body: (p) => letter(p, false) },
  c: { page: COLORS.card, body: (p) => letter(p, true) },
};
