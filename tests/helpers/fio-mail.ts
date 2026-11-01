import { randomUUID } from "node:crypto";

// Free of server modules: Playwright loads this too, and "server-only" refuses to load there.

export const VS = "20260042";
export const COUNTERPARTY = "1111111116/0800";
export const INVOICE_TOTAL = 300_000;

export type NoticeFields = {
  account?: string;
  amount?: string;
  currency?: string;
  date?: string;
  vs?: string;
  id?: string;
  message?: string;
};

export function noticeText(over: NoticeFields = {}): string {
  return [
    "Dear client,",
    "",
    `Account: ${over.account ?? "9999999999/2010"}`,
    `Amount: ${over.amount ?? "3 000.00"}`,
    `Currency: ${over.currency ?? "CZK"}`,
    `Date: ${over.date ?? "10/30/2026 14:05"}`,
    `Variable symbol: ${over.vs ?? VS}`,
    "Constant symbol: 0308",
    `Counterparty account: ${COUNTERPARTY}`,
    "Counterparty: Ukazkova Firma s.r.o.",
    `Instruction ID: ${over.id ?? "10000000001"}`,
    `Message: ${over.message ?? "Fiktivni platba"}`,
  ].join("\r\n");
}

export const AUTHSERV_ID = "mx.example.cz";

export const PASS_HEADER =
  "Authentication-Results: mx.example.cz; dkim=pass header.d=fio.cz; spf=pass smtp.mailfrom=fio.cz";

export type MailFields = {
  from?: string;
  subject?: string;
  headers?: string[];
  body?: string;
  messageId?: string | null;
  eol?: string;
};

export function rawMail(fields: MailFields = {}): string {
  const {
    from = "Fio banka <automat@fio.cz>",
    subject = "Fio banka - new income on account",
    headers = [PASS_HEADER],
    body = noticeText(),
    messageId = `<${randomUUID()}@fio.cz>`,
    eol = "\r\n",
  } = fields;
  return [
    ...headers,
    `From: ${from}`,
    "To: avizo@example.cz",
    `Subject: ${subject}`,
    "Date: Fri, 30 Oct 2026 14:05:00 +0100",
    ...(messageId ? [`Message-ID: ${messageId}`] : []),
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
  ].join(eol);
}

export function encodedSubject(text: string): string {
  return `=?UTF-8?B?${Buffer.from(text).toString("base64")}?=`;
}
