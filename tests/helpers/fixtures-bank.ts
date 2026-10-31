import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { czechAccountToIban } from "@/lib/iban";
import type { Db } from "@/server/db";
import { encryptSecret } from "@/server/crypto";
import { bankAccount, bankMailbox, invoice, job, type Job } from "@/server/db/schema";
import { issuedInvoice, seedCustomer, seedOwner } from "./fixtures-mail";

export const TARGET = { number: "9999999999", bankCode: "2010" };
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

export function seedBankAccount(db: Db, owner: string, now: Date, over = {}): string {
  const id = randomUUID();
  db.insert(bankAccount)
    .values({
      id,
      userId: owner,
      name: "Fio",
      currency: "CZK",
      number: TARGET.number,
      bankCode: TARGET.bankCode,
      iban: czechAccountToIban(TARGET.number, TARGET.bankCode),
      createdAt: now,
      updatedAt: now,
      ...over,
    })
    .run();
  return id;
}

export function seedAccount(db: Db, now: Date) {
  const owner = seedOwner(db, now);
  const customerId = seedCustomer(owner);
  const invoiceId = issuedInvoice(owner, customerId);
  const accountId = seedBankAccount(db, owner, now);
  db.update(invoice)
    .set({ variableSymbol: VS, bankAccountId: accountId })
    .where(eq(invoice.id, invoiceId))
    .run();
  return { owner, customerId, invoiceId, accountId };
}

export function seedMailbox(
  db: Db,
  owner: string,
  port: number,
  now: Date,
  over: Partial<typeof bankMailbox.$inferInsert> = {},
): void {
  db.insert(bankMailbox)
    .values({
      userId: owner,
      host: "127.0.0.1",
      port,
      tls: "starttls",
      username: "avizo",
      passwordEnc: encryptSecret("tajne-heslo-imap-4c1d"),
      updatedAt: now,
      requireConfirmation: true,
      authServId: AUTHSERV_ID,
      ...over,
    })
    .run();
}

export function pollJob(owner: string, now: Date): Job {
  return {
    id: randomUUID(),
    userId: owner,
    kind: "bank.poll",
    key: `bank:${owner}:test`,
    payload: {},
    status: "running",
    runAt: now,
    attempts: 1,
    maxAttempts: 3,
    lockedBy: "w",
    reason: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function jobsOf(db: Db, owner: string) {
  return db.select().from(job).where(eq(job.userId, owner)).all();
}
