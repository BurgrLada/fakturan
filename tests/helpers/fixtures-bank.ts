import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { czechAccountToIban } from "@/lib/iban";
import type { Db } from "@/server/db";
import { encryptSecret } from "@/server/crypto";
import { bankAccount, bankMailbox, invoice, job, type Job } from "@/server/db/schema";
import { AUTHSERV_ID, VS } from "./fio-mail";
import { issuedInvoice, seedCustomer, seedOwner } from "./fixtures-mail";

export * from "./fio-mail";

export const TARGET = { number: "9999999999", bankCode: "2010" };

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
  return { owner, ...seedPayable(db, owner, now) };
}

export function seedPayable(db: Db, owner: string, now: Date) {
  const customerId = seedCustomer(owner);
  const invoiceId = issuedInvoice(owner, customerId);
  const accountId = seedBankAccount(db, owner, now);
  db.update(invoice)
    .set({ variableSymbol: VS, bankAccountId: accountId })
    .where(eq(invoice.id, invoiceId))
    .run();
  return { customerId, invoiceId, accountId };
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
