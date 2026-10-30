import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { CURRENCIES, type Currency } from "@/lib/currency";
import { czechAccountToIban, isValidIban, normalizeIban } from "@/lib/iban";
import type { Actor } from "../audit/context";
import { clock } from "../clock";
import { db, type Tx } from "../db";
import { bankAccount, invoice } from "../db/schema";
import { scoped } from "../db/scoped";
import { ServiceError } from "./access";
import { mutate } from "./mutation";

export type BankAccount = typeof bankAccount.$inferSelect;

const text = (max: number) => z.string().trim().max(max);

export const currencySchema = z.enum(CURRENCIES);

export const bankAccountInputSchema = z
  .object({
    id: z.string().optional(),
    name: text(100).min(1, "Vyplňte název účtu"),
    currency: currencySchema,
    number: text(20),
    bankCode: text(4),
    iban: text(42),
    swift: text(11),
  })
  .superRefine((value, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message });
    if (value.swift && !/^[A-Za-z]{6}[A-Za-z0-9]{2}([A-Za-z0-9]{3})?$/.test(value.swift)) {
      issue("swift", "SWIFT/BIC není platný");
    }
    if (!value.number || !value.bankCode) {
      if (!value.iban) issue("iban", "Vyplňte číslo účtu s kódem banky, nebo IBAN");
      else if (!isValidIban(value.iban)) issue("iban", "IBAN není platný");
      return;
    }
    try {
      czechAccountToIban(value.number, value.bankCode);
    } catch (error) {
      issue("number", error instanceof Error ? error.message : "Číslo účtu není platné");
    }
  });

export type BankAccountInput = z.input<typeof bankAccountInputSchema>;

function ownerOf(actor: Actor): string {
  if (!actor.userId) throw new ServiceError("Na tuto akci nemáte oprávnění");
  return actor.userId;
}

function findOwned(tx: Tx, userId: string, id: string): BankAccount {
  const row = tx
    .select()
    .from(bankAccount)
    .where(scoped(userId).where(bankAccount, (t, { eq }) => eq(t.id, id)))
    .get();
  if (!row) throw new ServiceError("Účet neexistuje");
  return row;
}

function clearDefault(tx: Tx, userId: string, currency: Currency): void {
  tx.update(bankAccount)
    .set({ isDefault: false, updatedAt: clock.now() })
    .where(
      scoped(userId).where(bankAccount, (t, { and, eq }) =>
        and(eq(t.currency, currency), eq(t.isDefault, true)),
      ),
    )
    .run();
}

function hasDefault(tx: Tx, userId: string, currency: Currency): boolean {
  return !!tx
    .select({ id: bankAccount.id })
    .from(bankAccount)
    .where(
      scoped(userId).where(bankAccount, (t, { and, eq }) =>
        and(eq(t.currency, currency), eq(t.isDefault, true)),
      ),
    )
    .get();
}

export function listBankAccounts(ownerId: string): BankAccount[] {
  return db
    .select()
    .from(bankAccount)
    .where(scoped(ownerId).where(bankAccount))
    .orderBy(asc(bankAccount.currency), asc(bankAccount.createdAt), asc(bankAccount.id))
    .all();
}

export function defaultAccountFor(ownerId: string, currency: Currency): BankAccount | null {
  return (
    db
      .select()
      .from(bankAccount)
      .where(
        scoped(ownerId).where(bankAccount, (t, { and, eq }) =>
          and(eq(t.currency, currency), eq(t.isDefault, true), eq(t.hidden, false)),
        ),
      )
      .get() ?? null
  );
}

export function isAccountUsed(tx: Tx, ownerId: string, accountId: string): boolean {
  return !!tx
    .select({ id: invoice.id })
    .from(invoice)
    .where(scoped(ownerId).where(invoice, (t, { eq }) => eq(t.bankAccountId, accountId)))
    .get();
}

export function saveBankAccount(actor: Actor, raw: BankAccountInput): string {
  const userId = ownerOf(actor);
  const parsed = bankAccountInputSchema.safeParse(raw);
  if (!parsed.success) throw new ServiceError(parsed.error.issues[0]?.message ?? "Neplatné údaje");
  const { id: existingId, ...values } = parsed.data;
  // A Czech number always wins: an IBAN left in the form from before an edit would be stale.
  const iban =
    values.number && values.bankCode
      ? czechAccountToIban(values.number, values.bankCode)
      : normalizeIban(values.iban);
  const columns = { ...values, iban, swift: values.swift.toUpperCase() };

  return mutate(actor, "bank_account.save", (tx, audit) => {
    const before = existingId ? findOwned(tx, userId, existingId) : null;
    const id = before?.id ?? randomUUID();
    const now = clock.now();
    if (before) {
      const changesCurrency = before.currency !== columns.currency;
      tx.update(bankAccount)
        .set({ ...columns, isDefault: changesCurrency ? false : before.isDefault, updatedAt: now })
        .where(and(eq(bankAccount.id, id), eq(bankAccount.userId, userId)))
        .run();
    } else {
      tx.insert(bankAccount)
        .values({ id, userId, ...columns, createdAt: now, updatedAt: now })
        .run();
    }
    const current = findOwned(tx, userId, id);
    if (!current.hidden && !hasDefault(tx, userId, current.currency)) {
      tx.update(bankAccount)
        .set({ isDefault: true })
        .where(and(eq(bankAccount.id, id), eq(bankAccount.userId, userId)))
        .run();
    }
    audit({
      entity: "bank_account",
      entityId: id,
      ownerId: userId,
      scope: "user",
      before,
      after: columns,
    });
    return id;
  });
}

export function setDefaultForCurrency(actor: Actor, currency: Currency, accountId: string): void {
  const userId = ownerOf(actor);
  mutate(actor, "bank_account.set_default", (tx, audit) => {
    const account = findOwned(tx, userId, accountId);
    if (account.currency !== currency) throw new ServiceError("Účet je v jiné měně");
    if (account.hidden) throw new ServiceError("Skrytý účet nemůže být výchozí");
    clearDefault(tx, userId, currency);
    tx.update(bankAccount)
      .set({ isDefault: true, updatedAt: clock.now() })
      .where(and(eq(bankAccount.id, accountId), eq(bankAccount.userId, userId)))
      .run();
    audit({
      entity: "bank_account",
      entityId: accountId,
      ownerId: userId,
      scope: "user",
      before: { isDefault: account.isDefault },
      after: { isDefault: true, currency },
    });
  });
}

export function unhideBankAccount(actor: Actor, id: string): void {
  const userId = ownerOf(actor);
  mutate(actor, "bank_account.unhide", (tx, audit) => {
    const account = findOwned(tx, userId, id);
    tx.update(bankAccount)
      .set({ hidden: false, updatedAt: clock.now() })
      .where(and(eq(bankAccount.id, id), eq(bankAccount.userId, userId)))
      .run();
    audit({
      entity: "bank_account",
      entityId: id,
      ownerId: userId,
      scope: "user",
      before: { hidden: account.hidden },
      after: { hidden: false },
    });
  });
}

export function hideBankAccount(actor: Actor, id: string): void {
  const userId = ownerOf(actor);
  mutate(actor, "bank_account.hide", (tx, audit) => {
    const account = findOwned(tx, userId, id);
    tx.update(bankAccount)
      .set({ hidden: true, isDefault: false, updatedAt: clock.now() })
      .where(and(eq(bankAccount.id, id), eq(bankAccount.userId, userId)))
      .run();
    audit({
      entity: "bank_account",
      entityId: id,
      ownerId: userId,
      scope: "user",
      before: { hidden: account.hidden, isDefault: account.isDefault },
      after: { hidden: true, isDefault: false },
    });
  });
}

export function deleteBankAccount(actor: Actor, id: string): void {
  const userId = ownerOf(actor);
  mutate(actor, "bank_account.delete", (tx, audit) => {
    const account = findOwned(tx, userId, id);
    if (isAccountUsed(tx, userId, id)) {
      throw new ServiceError("Účet je použitý na faktuře, nejde smazat, jen skrýt");
    }
    tx.delete(bankAccount)
      .where(and(eq(bankAccount.id, id), eq(bankAccount.userId, userId)))
      .run();
    audit({
      entity: "bank_account",
      entityId: id,
      ownerId: userId,
      scope: "user",
      before: account,
    });
  });
}
