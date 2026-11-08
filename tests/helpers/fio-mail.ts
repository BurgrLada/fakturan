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
  time?: string;
  vs?: string;
  id?: string;
  message?: string;
};

export const INCOME_SUBJECT = "Fio banka - příjem na účtu";

// The layout of a real Czech Fio notice, trailing spaces included; every value is made up.
export function noticeText(over: NoticeFields = {}): string {
  const account = over.account ?? "9999999999";
  const date = over.date ?? "30.10.2026";
  const time = over.time ?? "14:05";
  const amount = over.amount ?? "3 000,00";
  const currency = over.currency ?? "CZK";
  return [
    "Dobrý den, ",
    " ",
    `zůstatek účtu ${account} se ${date} v ${time} zvýšil o ${amount} ${currency}.`,
    "",
    "Další parametry",
    "Typ pohybu: Okamžitá příchozí platba ",
    `Protistrana: ${COUNTERPARTY} (Ukazkova Firma s.r.o.) `,
    `ID pokynu: ${over.id ?? "10000000001"}     `,
    `Variabilní symbol: ${over.vs ?? VS} `,
    "Konstantní symbol: 0308",
    `Zpráva pro příjemce: ${over.message ?? "Fiktivni platba"} `,
    "",
    `Aktuální zůstatek: 103 000,00 ${currency}`,
    "",
    "Fio banka",
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
    subject = encodedSubject(INCOME_SUBJECT),
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
