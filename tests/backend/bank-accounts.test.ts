import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, test, vi } from "vitest";
import { auditLog, user } from "@/server/db/schema";
import {
  bankAccountInputSchema,
  defaultAccountFor,
  deleteBankAccount,
  hideBankAccount,
  unhideBankAccount,
  isAccountUsed,
  listBankAccounts,
  saveBankAccount,
  setDefaultForCurrency,
  type BankAccountInput,
} from "@/server/services/bank-accounts";
import { USER_OWNED_TABLES } from "@/server/services/users";
import { bankAccount } from "@/server/db/schema";
import { assertIsolated } from "../helpers/isolation";
import { createTestDb } from "../helpers/db";

vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-bank-")));

const db = createTestDb();
const actor = (userId: string) => ({ userId, source: "web" as const });

function seed(id: string) {
  const now = new Date();
  db.insert(user)
    .values({ id, name: id, email: `${id}@example.cz`, createdAt: now, updatedAt: now })
    .onConflictDoNothing()
    .run();
}

const czk = (over: Partial<BankAccountInput> = {}): BankAccountInput => ({
  name: "Provozní",
  currency: "CZK",
  number: "1234567890",
  bankCode: "2010",
  iban: "",
  swift: "",
  ...over,
});

const eur = (over: Partial<BankAccountInput> = {}): BankAccountInput =>
  czk({
    name: "Euro",
    currency: "EUR",
    number: "",
    bankCode: "",
    iban: "DE89 3704 0044 0532 0130 00",
    swift: "COBADEFFXXX",
    ...over,
  });

describe("bankovní účty", () => {
  test("[SET-020] české číslo se uloží s vypočteným IBAN", () => {
    seed("b1");

    const id = saveBankAccount(actor("b1"), czk());

    expect(listBankAccounts("b1")).toEqual([
      expect.objectContaining({
        id,
        number: "1234567890",
        bankCode: "2010",
        iban: "CZ2120100000001234567890",
        currency: "CZK",
      }),
    ]);
  });

  test("[SET-020] zahraniční účet se uloží s IBAN bez mezer a SWIFT", () => {
    seed("b2");

    saveBankAccount(actor("b2"), eur());

    expect(listBankAccounts("b2")[0]).toMatchObject({
      iban: "DE89370400440532013000",
      swift: "COBADEFFXXX",
      number: "",
      bankCode: "",
    });
  });

  test("[SET-020] neplatný IBAN, SWIFT, měna nebo prázdný účet se odmítnou", () => {
    expect(bankAccountInputSchema.safeParse(eur({ iban: "DE00370400440532013000" })).success).toBe(
      false,
    );
    expect(bankAccountInputSchema.safeParse(eur({ swift: "x" })).success).toBe(false);
    expect(bankAccountInputSchema.safeParse(czk({ currency: "JPY" as "CZK" })).success).toBe(false);
    expect(bankAccountInputSchema.safeParse(czk({ number: "", bankCode: "" })).success).toBe(false);
    expect(bankAccountInputSchema.safeParse(czk({ name: " " })).success).toBe(false);
    expect(bankAccountInputSchema.safeParse(czk({ number: "12ab" })).success).toBe(false);
  });

  test("[SET-020] uložení se audituje pod vlastníkem", () => {
    seed("b3");
    const id = saveBankAccount(actor("b3"), czk());

    const rows = db.select().from(auditLog).where(eq(auditLog.ownerId, "b3")).all();

    expect(rows.filter((row) => row.action === "bank_account.save")).toEqual([
      expect.objectContaining({ entity: "bank_account", entityId: id, scope: "user" }),
    ]);
  });

  test("[SET-020] úprava změní účet a zachová výchozí", () => {
    seed("b4");
    const id = saveBankAccount(actor("b4"), czk());

    saveBankAccount(actor("b4"), { ...czk({ name: "Hlavní" }), id });

    expect(listBankAccounts("b4")).toEqual([
      expect.objectContaining({ id, name: "Hlavní", isDefault: true }),
    ]);
  });

  test("[SET-020] úprava čísla účtu přepočítá IBAN a zastaralý IBAN se ignoruje", () => {
    seed("b7");
    const id = saveBankAccount(actor("b7"), czk());
    const stale = listBankAccounts("b7")[0]!.iban;

    saveBankAccount(actor("b7"), {
      ...czk({ number: "2000145399", bankCode: "0800" }),
      id,
      iban: stale,
    });

    expect(listBankAccounts("b7")[0]?.iban).toBe("CZ7908000000002000145399");
  });

  test("[SET-020] skrytý účet jde znovu zobrazit", () => {
    seed("b8");
    const id = saveBankAccount(actor("b8"), czk());
    hideBankAccount(actor("b8"), id);

    unhideBankAccount(actor("b8"), id);

    expect(listBankAccounts("b8")[0]?.hidden).toBe(false);
    expect(() => unhideBankAccount(actor("b7"), id)).toThrow("neexistuje");
  });

  test("[SET-020] izolace účtů", async () => {
    await assertIsolated<string>({
      create: (ownerId) => {
        seed(ownerId);
        return saveBankAccount(actor(ownerId), czk());
      },
      find: (ownerId, id) => listBankAccounts(ownerId).filter((row) => row.id === id),
      list: (ownerId) => listBankAccounts(ownerId).map((row) => row.id),
      update: (ownerId, id) => {
        saveBankAccount(actor(ownerId), { ...czk({ name: "Změna" }), id });
        return 1;
      },
      remove: (ownerId, id) => {
        deleteBankAccount(actor(ownerId), id);
        return 1;
      },
    });
  });

  test("[SET-020] skrytí a výchozí účet nejdou cizímu uživateli", () => {
    seed("b5");
    seed("b6");
    const id = saveBankAccount(actor("b5"), czk());

    expect(() => hideBankAccount(actor("b6"), id)).toThrow("neexistuje");
    expect(() => setDefaultForCurrency(actor("b6"), "CZK", id)).toThrow("neexistuje");
    expect(listBankAccounts("b5")[0]?.hidden).toBe(false);
  });

  test("[SET-020] tabulka účtů je v seznamu dat účtu", () => {
    expect(USER_OWNED_TABLES).toContain(bankAccount);
  });
});

describe("výchozí účet na měnu", () => {
  test("[SET-021] první účet v měně se stane výchozím, druhý ne", () => {
    seed("d1");

    const first = saveBankAccount(actor("d1"), czk());
    const second = saveBankAccount(actor("d1"), czk({ name: "Spořicí", number: "9876543210" }));

    const byId = new Map(listBankAccounts("d1").map((row) => [row.id, row.isDefault]));
    expect(byId.get(first)).toBe(true);
    expect(byId.get(second)).toBe(false);
  });

  test("[SET-021] každá měna má nejvýš jeden výchozí účet", () => {
    seed("d2");
    const first = saveBankAccount(actor("d2"), czk());
    const second = saveBankAccount(actor("d2"), czk({ number: "9876543210" }));
    const euro = saveBankAccount(actor("d2"), eur());

    setDefaultForCurrency(actor("d2"), "CZK", second);

    const rows = listBankAccounts("d2");
    expect(rows.filter((row) => row.currency === "CZK" && row.isDefault).map((r) => r.id)).toEqual([
      second,
    ]);
    expect(rows.find((row) => row.id === first)?.isDefault).toBe(false);
    expect(rows.find((row) => row.id === euro)?.isDefault).toBe(true);
    expect(() =>
      db.update(bankAccount).set({ isDefault: true }).where(eq(bankAccount.id, first)).run(),
    ).toThrow();
  });

  test("[SET-021] účet nejde nastavit jako výchozí pro jinou měnu ani skrytý", () => {
    seed("d3");
    const czkId = saveBankAccount(actor("d3"), czk());
    const other = saveBankAccount(actor("d3"), czk({ number: "9876543210" }));

    expect(() => setDefaultForCurrency(actor("d3"), "EUR", czkId)).toThrow("měn");
    hideBankAccount(actor("d3"), other);
    expect(() => setDefaultForCurrency(actor("d3"), "CZK", other)).toThrow("Skrytý");
  });

  test("[SET-021] defaultAccountFor vrátí účet podle měny", () => {
    seed("d4");
    const czkId = saveBankAccount(actor("d4"), czk());
    const eurId = saveBankAccount(actor("d4"), eur());

    expect(defaultAccountFor("d4", "CZK")?.id).toBe(czkId);
    expect(defaultAccountFor("d4", "EUR")?.id).toBe(eurId);
    expect(defaultAccountFor("d4", "USD")).toBeNull();
    seed("d4-other");
    expect(defaultAccountFor("d4-other", "EUR")).toBeNull();
  });

  test("[SET-021] změna měny výchozího účtu ho z výchozích vyřadí", () => {
    seed("d5");
    const id = saveBankAccount(actor("d5"), czk());

    saveBankAccount(actor("d5"), { ...eur(), id });

    expect(defaultAccountFor("d5", "CZK")).toBeNull();
    expect(defaultAccountFor("d5", "EUR")?.id).toBe(id);
  });

  test("[SET-021] skrytý výchozí účet přestane být výchozí", () => {
    seed("d6");
    const id = saveBankAccount(actor("d6"), czk());

    hideBankAccount(actor("d6"), id);

    expect(defaultAccountFor("d6", "CZK")).toBeNull();
    expect(listBankAccounts("d6")[0]).toMatchObject({ hidden: true, isDefault: false });
  });
});

describe("smazání účtu", () => {
  test("[SET-020] nepoužitý účet jde smazat a audituje se", () => {
    seed("x1");
    const id = saveBankAccount(actor("x1"), czk());

    expect(isAccountUsed("x1", id)).toBe(false);
    deleteBankAccount(actor("x1"), id);

    expect(listBankAccounts("x1")).toEqual([]);
    expect(
      db
        .select()
        .from(auditLog)
        .where(eq(auditLog.ownerId, "x1"))
        .all()
        .some((row) => row.action === "bank_account.delete"),
    ).toBe(true);
  });
});
