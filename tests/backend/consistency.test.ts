import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { describe, expect, test, vi } from "vitest";
import { appearanceFrom } from "@/lib/invoice";
import type { CustomerSnapshot, SupplierSnapshot } from "@/lib/invoice-document";
import { DEFAULT_PREFERENCES } from "@/lib/preferences";
import {
  auditLog,
  exchangeRate,
  invoice,
  invoiceLine,
  payment,
  recurringInvoice,
  recurringRun,
  type RecurringInvoice,
} from "@/server/db/schema";
import { seedCreditNote } from "../fixtures/invoices";
import { assertConsistent } from "../helpers/consistency";
import { createTestDb } from "../helpers/db";

const shifted = vi.hoisted(() => ({ by: 0, unconverted: 0, tax: 0, unpaid: 0 }));
vi.mock("@/server/reports/tax", async (original) => {
  const real = await original<typeof import("@/server/reports/tax")>();
  const taxOverview: typeof real.taxOverview = (...args) => {
    const overview = real.taxOverview(...args);
    return { ...overview, totalCzkMinor: overview.totalCzkMinor + shifted.tax };
  };
  const unpaidAsOf: typeof real.unpaidAsOf = (...args) =>
    real.unpaidAsOf(...args).map((row) => ({ ...row, dueMinor: row.dueMinor + shifted.unpaid }));
  return { ...real, taxOverview, unpaidAsOf };
});
vi.mock("@/server/reports/queries", async (original) => {
  const real = await original<typeof import("@/server/reports/queries")>();
  const reportSummary: typeof real.reportSummary = (...args) => {
    const summary = real.reportSummary(...args);
    const income = summary.unconverted.income;
    return {
      ...summary,
      invoicedMinor: summary.invoicedMinor + shifted.by,
      unconverted: {
        ...summary.unconverted,
        income: {
          ...income,
          byCurrency: income.byCurrency.map((row) => ({
            ...row,
            amountMinor: row.amountMinor + shifted.unconverted,
          })),
        },
      },
    };
  };
  return { ...real, reportSummary };
});

const db = createTestDb();

function createUser(): string {
  const id = randomUUID();
  db.$client
    .prepare(
      "INSERT INTO user (id, name, email, created_at, updated_at) VALUES (?, 'Test', ?, 0, 0)",
    )
    .run(id, `${id}@example.test`);
  return id;
}

function createSeries(ownerId: string): string {
  const id = randomUUID();
  db.$client
    .prepare(
      "INSERT INTO number_series (id, user_id, name, document_type, template, reset, is_default, created_at, updated_at) VALUES (?, ?, 'Řada', 'invoice', '{YYYY}{NNNN}', 'yearly', 0, 0, 0)",
    )
    .run(id, ownerId);
  return id;
}

function createInvoice(ownerId: string, over: Partial<typeof invoice.$inferInsert> = {}): string {
  const id = randomUUID();
  const now = new Date();
  db.insert(invoice)
    .values({
      id,
      userId: ownerId,
      type: "invoice",
      language: "cs",
      currency: "CZK",
      paymentMethod: "cash",
      appearance: appearanceFrom(DEFAULT_PREFERENCES),
      createdAt: now,
      updatedAt: now,
      ...over,
    })
    .run();
  return id;
}

function addLine(ownerId: string, invoiceId: string, netMinor: number): void {
  db.insert(invoiceLine)
    .values({
      id: randomUUID(),
      invoiceId,
      userId: ownerId,
      position: 0,
      quantityMilli: 1000,
      unitPriceMinor: 10_000,
      netMinor,
    })
    .run();
}

const issued = {
  status: "issued",
  dateFormat: "d. M. yyyy",
  supplierSnapshot: { name: "Dodavatel" } as SupplierSnapshot,
  customerSnapshot: { name: "Zákazník" } as CustomerSnapshot,
} as const;

describe("assertConsistent", () => {
  test("[TST-018] prochází na čistém účtu", () => {
    const owner = createUser();
    const series = createSeries(owner);
    db.$client
      .prepare(
        "INSERT INTO number_series_counter (series_id, period_key, user_id, next) VALUES (?, '2026', ?, 1)",
      )
      .run(series, owner);
    db.insert(auditLog)
      .values({
        at: new Date(),
        source: "web",
        scope: "user",
        ownerId: owner,
        action: "a",
        entity: "e",
      })
      .run();

    expect(() => assertConsistent(db, owner)).not.toThrow();
  });

  test("[TST-018] kontrola souladu odhalí ručně poškozený řádek", () => {
    const owner = createUser();
    const stranger = createUser();
    const foreignSeries = createSeries(stranger);

    db.$client.pragma("foreign_keys = OFF");
    db.$client
      .prepare(
        "INSERT INTO number_series_counter (series_id, period_key, user_id, next) VALUES (?, '2026', ?, 1)",
      )
      .run(foreignSeries, owner);
    db.$client.pragma("foreign_keys = ON");

    expect(() => assertConsistent(db, owner)).toThrow(/number_series_counter/);
    expect(() => assertConsistent(db, stranger)).not.toThrow();
  });

  test("[TST-018] odhalí řádek patřící neexistujícímu účtu", () => {
    const ghost = randomUUID();
    db.$client.pragma("foreign_keys = OFF");
    db.run(
      sql`INSERT INTO unit (id, user_id, name, position, created_at) VALUES (${randomUUID()}, ${ghost}, 'ks', 0, 0)`,
    );
    db.$client.pragma("foreign_keys = ON");

    expect(() => assertConsistent(db, ghost)).toThrow(/unit/);
  });

  test("[TST-018] přijme vystavený doklad se součty, číslem a snapshoty", () => {
    const owner = createUser();
    const id = createInvoice(owner, {
      ...issued,
      number: "1",
      subtotalMinor: 10_000,
      totalMinor: 10_000,
    });
    addLine(owner, id, 10_000);

    expect(() => assertConsistent(db, owner)).not.toThrow();
  });

  test("[TST-018] odhalí součet, který neodpovídá položkám", () => {
    const owner = createUser();
    const id = createInvoice(owner, { subtotalMinor: 10_000, totalMinor: 9_000 });
    addLine(owner, id, 10_000);

    expect(() => assertConsistent(db, owner)).toThrow(/součty neodpovídají/);
  });

  test("[TST-018] odhalí řádek s jinou částkou než výpočet", () => {
    const owner = createUser();
    const id = createInvoice(owner, { subtotalMinor: 10_000, totalMinor: 10_000 });
    addLine(owner, id, 9_000);

    expect(() => assertConsistent(db, owner)).toThrow(/součty neodpovídají/);
  });

  test("[TST-018] odhalí součty, které nejde spočítat", () => {
    const owner = createUser();
    const id = createInvoice(owner);
    addLine(owner, id, 0);
    db.update(invoiceLine)
      .set({ unitPriceMinor: Number.MAX_SAFE_INTEGER })
      .where(eq(invoiceLine.invoiceId, id))
      .run();

    expect(() => assertConsistent(db, owner)).toThrow(/nejde spočítat/);
  });

  test("[TST-018] odhalí koncept s číslem", () => {
    const owner = createUser();
    createInvoice(owner, { number: "1" });

    expect(() => assertConsistent(db, owner)).toThrow(/koncept má číslo/);
  });

  test("[TST-018] CZK s kurzem kontrola odhalí", () => {
    const owner = createUser();
    createInvoice(owner, { exchangeRateMicros: 25_000_000 });
    expect(() => assertConsistent(db, owner)).toThrow("doklad v CZK drží kurz");
  });

  test("[TST-018] vystavený doklad v cizí měně bez kurzu, zdroje a data kontrola odhalí", () => {
    const owner = createUser();
    createInvoice(owner, {
      status: "issued",
      number: "F-1",
      currency: "EUR",
      exchangeRateSource: "cnb",
    });
    expect(() => assertConsistent(db, owner)).toThrow(/nemá kurz[\s\S]*nemá datum/);
    const other = createUser();
    createInvoice(other, {
      status: "issued",
      number: "F-2",
      currency: "EUR",
      exchangeRateMicros: 25_000_000,
    });
    expect(() => assertConsistent(db, other)).toThrow("nemá zdroj kurzu");
  });

  test("[TST-018] odhalí vystavený doklad bez čísla", () => {
    const owner = createUser();
    createInvoice(owner, issued);

    expect(() => assertConsistent(db, owner)).toThrow(/nemá číslo/);
  });

  test("[TST-018] odhalí vystavený doklad bez snapshotů", () => {
    const owner = createUser();
    createInvoice(owner, { status: "issued", number: "1" });

    expect(() => assertConsistent(db, owner)).toThrow(/nemá snapshoty/);
  });

  test("[TST-018] odhalí vystavený doklad bez formátu data", () => {
    const owner = createUser();
    createInvoice(owner, { ...issued, number: "1", dateFormat: null });

    expect(() => assertConsistent(db, owner)).toThrow(/nemá formát data/);
  });

  test("[TST-018] odhalí převod bez snapshotu účtu", () => {
    const owner = createUser();
    createInvoice(owner, { ...issued, number: "1", paymentMethod: "transfer" });

    expect(() => assertConsistent(db, owner)).toThrow(/bez snapshotu účtu/);
  });

  test("[TST-018] odhalí opakované číslo", () => {
    const owner = createUser();
    createInvoice(owner, { ...issued, number: "1" });
    createInvoice(owner, { ...issued, number: "2" });
    db.run(sql`DROP INDEX invoice_user_number_idx`);
    try {
      db.update(invoice).set({ number: "1" }).where(eq(invoice.userId, owner)).run();

      expect(() => assertConsistent(db, owner)).toThrow(/opakovaná čísla 1/);
    } finally {
      db.delete(invoice).where(eq(invoice.userId, owner)).run();
      db.run(
        sql`CREATE UNIQUE INDEX invoice_user_number_idx ON invoice (user_id, number) WHERE number IS NOT NULL`,
      );
    }
  });

  test("[TST-018] odhalí druhou fakturu téhož období plánu a běh s cizím dokladem", () => {
    const owner = createUser();
    const stranger = createUser();
    const now = new Date();
    const recurringId = randomUUID();
    db.insert(recurringInvoice)
      .values({
        id: recurringId,
        userId: owner,
        name: "Plán",
        document: {} as RecurringInvoice["document"],
        frequency: "monthly",
        issueRule: "period_end",
        startsOn: "2026-01-01",
        cursorDate: "2026-01-01",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const period = { recurringId, periodFrom: "2026-01-01", periodTo: "2026-01-31" };
    const first = createInvoice(owner, period);
    expect(() => assertConsistent(db, owner)).not.toThrow();
    const second = createInvoice(owner, period);
    expect(() => assertConsistent(db, owner)).toThrow(/období plánu/);
    db.delete(invoice).where(eq(invoice.id, second)).run();

    db.insert(recurringRun)
      .values({
        id: randomUUID(),
        userId: owner,
        recurringId,
        periodKey: "2026-01-01",
        plannedDate: "2026-01-31",
        periodFrom: "2026-01-01",
        periodTo: "2026-01-31",
        status: "created",
        invoiceId: createInvoice(stranger),
        createdAt: now,
      })
      .run();
    expect(() => assertConsistent(db, owner)).toThrow(/cizím dokladem/);
    expect(first).toBeTruthy();
  });

  describe("platby", () => {
    const addPayment = (
      owner: string,
      invoiceId: string,
      over: Partial<typeof payment.$inferInsert> = {},
    ) =>
      db
        .insert(payment)
        .values({
          id: randomUUID(),
          userId: owner,
          invoiceId,
          kind: "payment",
          paidOn: "2026-03-10",
          amountMinor: 10_000,
          currency: "CZK",
          creditedMinor: 10_000,
          method: "transfer",
          source: "manual",
          createdAt: new Date(0),
          updatedAt: new Date(0),
          ...over,
        })
        .run();

    function paidInvoice(owner: string) {
      const id = createInvoice(owner, {
        ...issued,
        number: randomUUID(),
        status: "paid",
        subtotalMinor: 10_000,
        totalMinor: 10_000,
        paidMinor: 10_000,
      });
      addLine(owner, id, 10_000);
      addPayment(owner, id);
      return id;
    }

    test("[TST-018] přijme doklad, jehož stav a součet odpovídají platbám", () => {
      const owner = createUser();
      paidInvoice(owner);

      expect(() => assertConsistent(db, owner)).not.toThrow();
    });

    test("[TST-018] nesoulad paid_minor a plateb kontrola odhalí", () => {
      const owner = createUser();
      const id = paidInvoice(owner);
      db.update(invoice).set({ paidMinor: 9000 }).where(eq(invoice.id, id)).run();

      expect(() => assertConsistent(db, owner)).toThrow(/paid_minor/);
    });

    test("[TST-018] nesoulad credits_minor kontrola odhalí", () => {
      const owner = createUser();
      const id = paidInvoice(owner);
      db.update(invoice).set({ creditsMinor: -500 }).where(eq(invoice.id, id)).run();

      expect(() => assertConsistent(db, owner)).toThrow(/credits_minor/);
    });

    test("[TST-018] opravu bez zamrzlého odkazu a s variabilním symbolem kontrola odhalí", () => {
      const owner = createUser();
      const noteId = seedCreditNote(db, paidInvoice(owner), -100);

      db.update(invoice)
        .set({ relatedSnapshot: null, variableSymbol: "123" })
        .where(eq(invoice.id, noteId))
        .run();

      expect(() => assertConsistent(db, owner)).toThrow("oprava bez zamrzlého odkazu");
      expect(() => assertConsistent(db, owner)).toThrow("oprava má variabilní symbol");
    });

    test("[TST-018] nesoulad advance_minor kontrola odhalí", () => {
      const owner = createUser();
      const id = paidInvoice(owner);
      db.update(invoice).set({ advanceMinor: 500 }).where(eq(invoice.id, id)).run();

      expect(() => assertConsistent(db, owner)).toThrow(/advance_minor/);
    });

    test("[TST-018] záporné paid_minor kontrola odhalí", () => {
      const owner = createUser();
      const id = paidInvoice(owner);
      db.update(invoice).set({ paidMinor: -1 }).where(eq(invoice.id, id)).run();

      expect(() => assertConsistent(db, owner)).toThrow(/paid_minor je záporné/);
    });

    test("[TST-018] odhalí stav, který neodpovídá platbám", () => {
      const owner = createUser();
      const id = paidInvoice(owner);
      db.update(invoice).set({ status: "partially_paid" }).where(eq(invoice.id, id)).run();

      expect(() => assertConsistent(db, owner)).toThrow(/neodpovídá platbám/);
    });

    test("[TST-018] změněná částka platby, doklad bez kurzu ani posunutý souhrn kontrolou neprojde", () => {
      const owner = createUser();
      const id = paidInvoice(owner);
      const row = eq(invoice.id, id);
      db.update(invoice).set({ issueDate: "2026-03-01" }).where(row).run();
      expect(() => assertConsistent(db, owner)).not.toThrow();

      db.update(payment).set({ amountMinor: 9_000 }).where(eq(payment.invoiceId, id)).run();
      expect(() => assertConsistent(db, owner)).toThrow(/jinou připsanou/);
      db.update(payment).set({ amountMinor: 10_000 }).where(eq(payment.invoiceId, id)).run();

      db.update(invoice).set({ currency: "EUR", exchangeRateSource: "manual" }).where(row).run();
      db.update(payment)
        .set({ currency: "EUR", rateMicros: 25_000_000 })
        .where(eq(payment.invoiceId, id))
        .run();
      expect(() => assertConsistent(db, owner)).toThrow(/nemá kurz/);
      db.update(invoice).set({ exchangeRateMicros: 25_000_000 }).where(row).run();
      expect(() => assertConsistent(db, owner)).not.toThrow();

      shifted.by = 1;
      try {
        expect(() => assertConsistent(db, owner)).toThrow(/přehled 2026: fakturováno/);
      } finally {
        shifted.by = 0;
      }

      db.update(payment)
        .set({ rateMicros: null, paidOn: "2026-02-10" })
        .where(eq(payment.invoiceId, id))
        .run();
      expect(() => assertConsistent(db, owner)).not.toThrow();
      shifted.unconverted = 1;
      try {
        expect(() => assertConsistent(db, owner)).toThrow(/přehled 2026: příjmy bez kurzu/);
      } finally {
        shifted.unconverted = 0;
      }
    });

    test("[TST-018] posunutý daňový přehled ani neuhrazené k dnešku kontrolou neprojdou", () => {
      const owner = createUser();
      paidInvoice(owner);
      expect(() => assertConsistent(db, owner)).not.toThrow();
      shifted.tax = 1;
      try {
        expect(() => assertConsistent(db, owner)).toThrow(/daňový přehled \d{4} \(paid\): řádky/);
      } finally {
        shifted.tax = 0;
      }
      db.update(payment)
        .set({ creditedMinor: 4_000, amountMinor: 4_000 })
        .where(eq(payment.userId, owner))
        .run();
      db.update(invoice)
        .set({ paidMinor: 4_000, status: "partially_paid", issueDate: "2026-03-01" })
        .where(eq(invoice.userId, owner))
        .run();
      expect(() => assertConsistent(db, owner)).not.toThrow();
      shifted.unpaid = 1;
      try {
        expect(() => assertConsistent(db, owner)).toThrow(/neuhrazeno k dnešku/);
      } finally {
        shifted.unpaid = 0;
      }
    });

    test("[TST-018] odhalí platbu cizího vlastníka na dokladu", () => {
      const owner = createUser();
      const stranger = createUser();
      const id = paidInvoice(owner);
      db.update(payment).set({ userId: stranger }).where(eq(payment.invoiceId, id)).run();

      expect(() => assertConsistent(db, owner)).toThrow(/cizím dokladem/);
      expect(() => assertConsistent(db, stranger)).toThrow(/cizím dokladem/);
    });

    test("[TST-018] v měně dokladu musí připsaná částka odpovídat a jiná měna může lišit", () => {
      const owner = createUser();
      const id = paidInvoice(owner);
      const row = eq(payment.invoiceId, id);
      db.update(payment).set({ currency: "EUR", amountMinor: 400 }).where(row).run();
      expect(() => assertConsistent(db, owner)).not.toThrow();

      db.update(payment).set({ currency: "CZK" }).where(row).run();
      expect(() => assertConsistent(db, owner)).toThrow(/jinou připsanou/);
    });

    test.each(["draft", "cancelled"] as const)("[TST-018] odhalí platbu na stavu %s", (status) => {
      const owner = createUser();
      const id = paidInvoice(owner);
      db.update(invoice).set({ status }).where(eq(invoice.id, id)).run();

      expect(() => assertConsistent(db, owner)).toThrow(/koncept|stornu/);
    });

    test("[TST-018] odhalí platbu na opravné faktuře", () => {
      const owner = createUser();
      const id = paidInvoice(owner);
      db.update(invoice).set({ type: "credit_note" }).where(eq(invoice.id, id)).run();

      expect(() => assertConsistent(db, owner)).toThrow(/plateb na opravné faktuře/);
    });
  });

  test("[TST-018] odhalí nahrazený doklad, který není záloha", () => {
    const owner = createUser();
    createInvoice(owner, { supersededAt: new Date() });

    expect(() => assertConsistent(db, owner)).toThrow(/nahrazený doklad není záloha/);
  });

  test("[TST-018] odhalí lístek zapsaný jen zčásti", () => {
    const owner = createUser();
    const row = { listDate: "2026-03-09", rateMicros: 22_000_000, fetchedAt: new Date() };
    db.insert(exchangeRate)
      .values({ ...row, currency: "USD" })
      .run();
    try {
      expect(() => assertConsistent(db, owner)).toThrow(/lístků bez EUR/);
      db.insert(exchangeRate)
        .values({ ...row, currency: "EUR" })
        .run();
      expect(() => assertConsistent(db, owner)).not.toThrow();
    } finally {
      db.delete(exchangeRate).run();
    }
  });

  // Last on purpose: audit_log is append-only, so the orphan row stays in this file's database.
  test("[TST-018] odhalí uživatelský auditní záznam bez vlastníka", () => {
    const owner = createUser();
    db.insert(auditLog)
      .values({
        at: new Date(),
        source: "web",
        scope: "user",
        ownerId: null,
        action: "a",
        entity: "e",
      })
      .run();

    expect(() => assertConsistent(db, owner)).toThrow(/audit_log/);
  });
});
