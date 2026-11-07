import "server-only";
import { isHexColor, readableOn } from "@/lib/contrast";
import type { Currency } from "@/lib/currency";
import type { MessageKind } from "@/lib/email-template";
import type { InvoiceDocument } from "@/lib/invoice-document";
import { formatMoney } from "@/lib/money";
import type { Language } from "@/lib/preferences";
import { amountDue } from "@/lib/qr-payload";
import { formatCalendarDate } from "@/lib/template-vars";
import { TEXTS } from "@/lib/texts";
import { getDesign } from "../../pdf/designs";
import { documentTitle } from "../../pdf/view";
import { escapeHtml, paragraphs } from "./escape";
import { LAYOUTS, LAYOUTS_WITH_QR, type MailLayout, type Parts } from "./layouts";
import { COLORS, NEUTRAL_BAND, SIZES, TYPE, WIDTH } from "./tokens";

export const QR_CID = "qr@fakturan";
export const LOGO_CID = "logo@fakturan";

// Only a message that asks for money carries a code to pay it with.
const QR_KINDS: readonly MessageKind[] = ["invoice", "advance", "reminder"];

export type EmailSummary = {
  title: string;
  number: string;
  amountDue: number;
  currency: Currency;
  dueDate: string | null;
  variableSymbol: string | null;
  account: string | null;
};

export type EmailHtmlInput = {
  layout: MailLayout;
  kind: MessageKind;
  language: Language;
  body: string;
  intro: string | null;
  signature: string | null;
  supplierName: string;
  supplierIco: string | null;
  logo: Buffer | null;
  accent: string | null;
  attachment: string | null;
  summary: EmailSummary | null;
  qr: Buffer | null;
};

export type EmailHtml = { html: string; images: { cid: string; png: Buffer }[] };

export function emailAccent(doc: InvoiceDocument): string | null {
  const own = doc.appearance.colors.accent;
  if (isHexColor(own)) return own;
  const design = getDesign(doc.appearance.designId).tokens.colors.accent;
  return isHexColor(design) ? design : null;
}

export function emailSummary(
  doc: InvoiceDocument,
  dateFormat = doc.dateFormat ?? "d. M. yyyy",
): EmailSummary {
  const account = doc.paymentMethod === "transfer" ? doc.snapshot.account : null;
  return {
    title: documentTitle(doc, doc.status === "draft"),
    number: doc.number ?? "",
    amountDue: amountDue(doc.totals),
    currency: doc.currency,
    dueDate: doc.dueDate ? formatCalendarDate(doc.dueDate, dateFormat) : null,
    variableSymbol: doc.variableSymbol || null,
    account: account?.number
      ? `${account.number}/${account.bankCode}`
      : account?.iban
        ? account.iban.replace(/(.{4})(?=.)/g, "$1 ")
        : null,
  };
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngSize(png: Buffer): { width: number; height: number } {
  if (png.length < 24 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("E-mail images must be PNG");
  }
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

function logoBox(png: Buffer): { width: number; height: number } {
  const { width, height } = pngSize(png);
  const scale = Math.min(1, SIZES.logoHeight / height, SIZES.logoMaxWidth / width);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

// Spaces inside an amount must not break, and the entity survives any transfer encoding.
const money = (minor: number, currency: Currency) =>
  escapeHtml(formatMoney(minor, currency)).replace(/[  ]/g, "&nbsp;");

function amountOf(summary: EmailSummary, labels: (typeof TEXTS.mailHtml)[Language]) {
  const { amountDue: due, currency } = summary;
  const date = summary.dueDate ? escapeHtml(summary.dueDate) : null;
  if (due > 0) {
    return {
      label: labels.due,
      value: money(due, currency),
      dueBy: date ? escapeHtml(labels.dueBy(summary.dueDate!)) : labels.due,
    };
  }
  if (due < 0) {
    return { label: labels.overpaid, value: money(-due, currency), dueBy: labels.overpaid };
  }
  return { label: labels.due, value: labels.paid, dueBy: labels.due };
}

export function renderEmailHtml(input: EmailHtmlInput): EmailHtml {
  const labels = TEXTS.mailHtml[input.language];
  const layout = LAYOUTS[input.layout];
  const { summary } = input;
  const name = escapeHtml(input.supplierName);
  const background = input.accent && isHexColor(input.accent) ? input.accent : NEUTRAL_BAND;
  const images: EmailHtml["images"] = [];

  let logoTag: ((extra: string) => string) | null = null;
  if (input.logo) {
    const box = logoBox(input.logo);
    images.push({ cid: LOGO_CID, png: input.logo });
    logoTag = (extra) =>
      `<img src="cid:${LOGO_CID}" width="${box.width}" height="${box.height}" alt="${name}" style="display:block;border:0;outline:none;text-decoration:none;height:${box.height}px;width:${box.width}px${extra}">`;
  }

  const showQr =
    input.qr !== null &&
    summary !== null &&
    summary.amountDue > 0 &&
    LAYOUTS_WITH_QR.includes(input.layout) &&
    QR_KINDS.includes(input.kind);
  if (showQr) images.push({ cid: QR_CID, png: input.qr! });

  const dueDate = summary?.dueDate ? escapeHtml(summary.dueDate) : null;
  const ico = input.supplierIco ? `${labels.ico} ${escapeHtml(input.supplierIco)}` : null;
  const parts: Parts = {
    header: (color, gap = 16) =>
      logoTag
        ? `<div style="margin-bottom:${gap}px">${logoTag("")}</div>`
        : `<div style="${TYPE.name};color:${color};margin-bottom:${gap}px">${name}</div>`,
    centeredHeader: logoTag
      ? `<div style="margin-bottom:16px">${logoTag(";margin:0 auto")}</div>`
      : `<div style="${TYPE.name};color:${COLORS.ink};margin-bottom:16px">${name}</div>`,
    message: paragraphs(input.intro ?? "") + paragraphs(input.body),
    signature: paragraphs(input.signature ?? "", TYPE.signature),
    amount: summary ? amountOf(summary, labels) : null,
    dueOn: summary?.dueDate ? escapeHtml(labels.dueOn(summary.dueDate)) : null,
    dueDate,
    account: summary?.account ? escapeHtml(summary.account) : null,
    variableSymbol: summary?.variableSymbol ? escapeHtml(summary.variableSymbol) : null,
    number: summary?.number ? escapeHtml(summary.number) : null,
    title: summary?.title ? escapeHtml(summary.title) : null,
    attachment: input.attachment ? escapeHtml(labels.attachment(input.attachment)) : null,
    footer: [name, ico].filter(Boolean).join(" · "),
    qr: showQr
      ? (size) =>
          `<img src="cid:${QR_CID}" width="${size}" height="${size}" alt="${labels.qrAlt}" style="display:block;border:0;outline:none;height:${size}px;width:${size}px;margin:0 auto;background-color:${COLORS.card}">`
      : null,
    band: { background, text: readableOn(background) },
    labels: {
      due: labels.due,
      number: labels.number,
      dueDate: labels.dueDate,
      account: labels.account,
      variableSymbol: labels.variableSymbol,
      vs: labels.vs,
      scanHint: labels.scanHint,
    },
  };

  const title = escapeHtml(summary?.title || input.supplierName);
  const page = layout.page;
  const html = [
    "<!DOCTYPE html>",
    `<html lang="${input.language}"><head><meta charset="utf-8">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light">',
    `<title>${title}</title></head>`,
    `<body style="margin:0;padding:0;background-color:${page}">`,
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="${page}" style="background-color:${page}"><tr><td align="center" style="padding:${SIZES.pagePadding}">`,
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="${WIDTH}" style="width:100%;max-width:${WIDTH}px;text-align:left;${TYPE.base}">`,
    layout.body(parts),
    "</table></td></tr></table></body></html>",
  ].join("");
  return { html, images };
}
