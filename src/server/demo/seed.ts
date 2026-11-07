import "server-only";
import { randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { count } from "drizzle-orm";
import { addDays } from "@/lib/invoice";
import { calendarDateInPrague, type CalendarDate } from "@/lib/number-format";
import { amountDue } from "@/lib/qr-payload";
import type { Actor } from "../audit/context";
import { runAt } from "../clock";
import { db } from "../db";
import { account, invoice, user } from "../db/schema";
import { scoped } from "../db/scoped";
import { env } from "../env";
import { convertAdvance } from "../services/advances";
import { saveBankAccount } from "../services/bank-accounts";
import { createCreditNote } from "../services/credit-notes";
import { saveCustomer, type CustomerInput } from "../services/customers";
import { ensureDashboards } from "../services/dashboards";
import { issueInvoice, markSent } from "../services/invoice-lifecycle";
import { getInvoice, newDraftDefaults, saveDraft, type DraftInput } from "../services/invoices";
import { mutate } from "../services/mutation";
import { ensureDefaultSeries } from "../services/number-series";
import { addPayment } from "../services/payments";
import { completeOnboarding } from "../services/preferences";
import { saveRecurring } from "../services/recurring";
import { saveReminderRule } from "../services/reminders";
import { saveSupplier } from "../services/supplier";
import { demoUserId } from "./mode";

// Invented companies; the IČO only have a valid checksum (IMP-013), never a real document's data.
export const DEMO_ICOS = ["99900017", "99900025", "99900033", "99900041", "99900050"] as const;

const MONTHS_BACK = 18;
const SYSTEM: Actor = { userId: null, source: "system" };

type Line = DraftInput["lines"][number];
type Document = { id: string; customer: string };

function line(name: string, unitPriceMinor: number, quantityMilli = 1000, unit = "ks"): Line {
  return {
    catalogItemId: null,
    name,
    description: "",
    quantityMilli,
    unit,
    unitPriceMinor,
    discountKind: "none",
    discountValue: 0,
  };
}

function customer(
  name: string,
  ico: string,
  email: string,
  city: string,
  zip: string,
  over: Partial<CustomerInput> = {},
): CustomerInput {
  return {
    name,
    street: "Ukázková 12",
    city,
    zip,
    country: "Česká republika",
    ico,
    dic: "",
    email,
    extraEmails: [],
    phone: "",
    note: "",
    dueDays: null,
    language: null,
    currency: null,
    designId: null,
    remindersEnabled: null,
    ...over,
  };
}

const CUSTOMERS: CustomerInput[] = [
  customer("Modrá Hora s. r. o.", "99900025", "fakturace@modrahora.example", "Praha", "110 00"),
  customer("Pekárna U Mlýna s. r. o.", "99900033", "ucetni@umlyna.example", "Brno", "602 00"),
  customer("Studio Lípa s. r. o.", "99900041", "studio@lipa.example", "Olomouc", "779 00"),
  customer("Kovovýroba Jih a. s.", "99900050", "nakup@kovojih.example", "Tábor", "390 01"),
  customer("Nordwind Design GmbH", "", "billing@nordwind.example", "Hamburg", "20095", {
    country: "Německo",
    language: "en",
    currency: "EUR",
  }),
];

const WORK = [
  ["Konzultace", 120_000, "hod."],
  ["Návrh webu", 1_850_000, "ks"],
  ["Správa webu", 450_000, "měs."],
  ["Úprava grafiky", 95_000, "hod."],
  ["Školení", 650_000, "den"],
] as const;

function workLines(seed: number): Line[] {
  const first = WORK[seed % WORK.length]!;
  const second = WORK[(seed * 3 + 1) % WORK.length]!;
  const hours = 1000 * (2 + (seed % 5));
  return [
    line(first[0], first[1], first[2] === "hod." ? hours : 1000, first[2]),
    ...(seed % 2 ? [line(second[0], second[1], 1000, second[2])] : []),
  ];
}

function at(date: CalendarDate, hour = 9): Date {
  return new Date(`${date}T${String(hour).padStart(2, "0")}:00:00+01:00`);
}

function monthStart(now: Date, offset: number): CalendarDate {
  const [year, month] = calendarDateInPrague(now).split("-").map(Number) as [number, number];
  const index = year * 12 + (month - 1) + offset;
  const y = Math.floor(index / 12);
  const m = (index % 12) + 1;
  return `${y}-${String(m).padStart(2, "0")}-01`;
}

// Plain fields, not parameter properties: server code must also run under Node type stripping.
class Seeder {
  readonly userId: string;
  readonly now: Date;
  readonly actor: Actor;
  readonly today: CalendarDate;
  customers: string[] = [];

  constructor(userId: string, now: Date) {
    this.userId = userId;
    this.now = now;
    this.actor = { userId, source: "system" };
    this.today = calendarDateInPrague(now);
  }

  past(date: CalendarDate): boolean {
    return date <= this.today && at(date) <= this.now;
  }

  draft(
    type: DraftInput["type"],
    customerId: string,
    issueDate: CalendarDate,
    over: Partial<DraftInput> = {},
  ) {
    return runAt(at(issueDate), () => {
      const defaults = newDraftDefaults(this.userId, customerId, type);
      return saveDraft(this.actor, {
        ...defaults,
        issueDate,
        dueDate: addDays(issueDate, 14),
        ...over,
      });
    });
  }

  issue(id: string, date: CalendarDate): void {
    runAt(at(date), () => {
      issueInvoice(this.actor, id, { revision: getInvoice(this.userId, id)!.revision });
      markSent(this.actor, id);
    });
  }

  pay(id: string, paidOn: CalendarDate): void {
    if (!this.past(paidOn)) return;
    runAt(at(paidOn, 11), () => {
      const row = getInvoice(this.userId, id)!;
      const due = amountDue(row);
      if (due <= 0) return;
      addPayment(this.actor, id, {
        revision: row.revision,
        paidOn,
        amountMinor: due,
        currency: row.currency,
        method: "transfer",
        note: "",
      });
    });
  }

  invoice(
    customerIndex: number,
    issueDate: CalendarDate,
    lines: Line[],
    over: Partial<DraftInput> = {},
  ): Document {
    const customerId = this.customers[customerIndex]!;
    const { id } = this.draft("invoice", customerId, issueDate, { lines, ...over });
    this.issue(id, issueDate);
    return { id, customer: customerId };
  }
}

function setUp(seeder: Seeder): void {
  const { actor } = seeder;
  runAt(at(monthStart(seeder.now, -MONTHS_BACK)), () => {
    ensureDefaultSeries(actor);
    saveSupplier(actor, {
      name: "Zkušební s. r. o.",
      street: "Vymyšlená 1",
      city: "Praha",
      zip: "120 00",
      country: "Česká republika",
      ico: DEMO_ICOS[0],
      dic: "",
      email: "fakturace@zkusebni.example",
      phone: "",
      web: "",
      registryNote: "",
      contactPerson: "",
      vatIdentified: false,
      footerText: "",
      notVatPayerCs: "Nejsem plátce DPH.",
      notVatPayerEn: "I am not a VAT payer.",
    });
    saveBankAccount(actor, {
      name: "Provozní účet",
      currency: "CZK",
      number: "1234567890",
      bankCode: "2010",
      iban: "",
      swift: "",
    });
    saveBankAccount(actor, {
      name: "Eurový účet",
      currency: "EUR",
      number: "",
      bankCode: "",
      iban: "DE89 3704 0044 0532 0130 00",
      swift: "COBADEFFXXX",
    });
    seeder.customers = CUSTOMERS.map((input) => saveCustomer(actor, input).id);
    saveReminderRule(actor, { offsetDays: 7, texts: null });
    completeOnboarding(actor);
  });
}

function creditNote(seeder: Seeder, invoiceId: string, on: CalendarDate): void {
  const note = runAt(at(on), () => {
    const created = createCreditNote(seeder.actor, invoiceId);
    const draft = getInvoice(seeder.userId, created.id)!;
    saveDraft(seeder.actor, withLines(draft, [line("Sleva za opožděné dodání", -150_000)]));
    return created;
  });
  seeder.issue(note.id, on);
}

// Within a month in date order, so the invoice numbers follow the issue dates.
function seedMonth(seeder: Seeder, offset: number): void {
  const start = monthStart(seeder.now, offset);
  const n = offset + MONTHS_BACK;
  const foreign = n % 3 === 1;
  if (offset === -7) seedAdvance(seeder, start);
  for (const day of [4, 9, 17]) {
    const issueDate = addDays(start, day);
    if (!seeder.past(issueDate)) continue;
    if (day === 9) {
      if (!foreign) continue;
      const hours = 1000 * (4 + (n % 3));
      const doc = seeder.invoice(
        4,
        issueDate,
        [line("UX review", 180_000 + 10_000 * (n % 7), hours, "hod.")],
        { exchangeRateMicros: 24_500_000 + ((n * 37_000) % 900_000) },
      );
      seeder.pay(doc.id, addDays(issueDate, 20));
      continue;
    }
    const customerIndex = day === 4 ? n % 4 : (n + 1) % 4;
    const doc = seeder.invoice(customerIndex, issueDate, workLines(n * 2 + day));
    if (offset === -4 && day === 4) creditNote(seeder, doc.id, addDays(issueDate, 6));
    // Two months back stays unpaid and overdue, for the reminder review.
    if (offset === -2 && day === 17) continue;
    seeder.pay(doc.id, addDays(issueDate, 9 + (n % 6)));
  }
}

function seedMonths(seeder: Seeder): void {
  for (let offset = -MONTHS_BACK; offset <= 0; offset += 1) seedMonth(seeder, offset);
}

function withLines(row: NonNullable<ReturnType<typeof getInvoice>>, lines: Line[]): DraftInput {
  return {
    id: row.id,
    revision: row.revision,
    type: row.type,
    customerId: row.customerId,
    seriesId: row.seriesId,
    bankAccountId: row.bankAccountId,
    issueDate: row.issueDate,
    dueDate: row.dueDate,
    taxableDate: row.taxableDate,
    language: row.language,
    currency: row.currency,
    exchangeRateMicros: row.exchangeRateMicros,
    paymentMethod: row.paymentMethod,
    orderRef: row.orderRef,
    reference: row.reference,
    textBefore: row.textBefore,
    textAfter: row.textAfter,
    note: row.note,
    discountKind: row.discountKind,
    discountValue: row.discountValue,
    rounding: row.rounding,
    appearance: row.appearance,
    lines,
  };
}

// Settled before the month's first invoice, whose number must come after the final invoice's.
function seedAdvance(seeder: Seeder, start: CalendarDate): void {
  const { id } = seeder.draft("advance", seeder.customers[0]!, start, {
    lines: [line("Záloha na redesign e-shopu", 4_000_000)],
  });
  seeder.issue(id, start);
  seeder.pay(id, addDays(start, 1));
  const finalOn = addDays(start, 2);
  const final = runAt(at(finalOn), () => convertAdvance(seeder.actor, id));
  seeder.issue(final.id, finalOn);
  seeder.pay(final.id, finalOn);
}

function seedPlan(seeder: Seeder): void {
  runAt(seeder.now, () =>
    saveRecurring(seeder.actor, {
      name: "Správa webu Studio Lípa",
      customerId: seeder.customers[2]!,
      document: {
        type: "invoice",
        bankAccountId: null,
        dueDays: 14,
        language: "cs",
        currency: "CZK",
        paymentMethod: "transfer",
        orderRef: "",
        reference: "",
        textBefore: "Fakturujeme správu webu za {{mesic_nazev}} {{rok}}.",
        textAfter: "",
        note: "",
        discountKind: "none",
        discountValue: 0,
        rounding: "none",
        appearance: newDraftDefaults(seeder.userId, null).appearance,
        lines: [line("Správa webu {{mesic}}/{{rok}}", 450_000, 1000, "měs.")],
      },
      frequency: "monthly",
      every: 1,
      issueRule: "day",
      issueDay: 1,
      startsOn: monthStart(seeder.now, 1),
      endsOn: null,
      maxCount: null,
      periodOffset: 0,
    }),
  );
  runAt(seeder.now, () => ensureDashboards(seeder.actor));
}

function createDemoUser(passwordHash: string, now: Date): string {
  const email = env.DEMO_EMAIL!;
  const userId = randomUUID();
  mutate(SYSTEM, "demo.seed", (tx, audit) => {
    tx.insert(user)
      .values({
        id: userId,
        name: "Ukázka",
        email,
        emailVerified: true,
        role: "user",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    tx.insert(account)
      .values({
        id: randomUUID(),
        userId,
        accountId: userId,
        providerId: "credential",
        password: passwordHash,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    audit({ entity: "user", entityId: userId, ownerId: null, scope: "instance" });
  });
  return userId;
}

function invoiceCount(userId: string): number {
  return db.select({ n: count() }).from(invoice).where(scoped(userId).where(invoice)).get()?.n ?? 0;
}

export function demoPasswordHash(): Promise<string> {
  return hashPassword(env.DEMO_PASSWORD!);
}

// Synchronous after the hash, so nothing else runs between a reset's purge and the new data.
export function seedDemoWith(
  now: Date,
  passwordHash: string,
): { userId: string; invoices: number } {
  const existing = demoUserId();
  if (existing) return { userId: existing, invoices: invoiceCount(existing) };
  const userId = createDemoUser(passwordHash, now);
  const seeder = new Seeder(userId, now);
  setUp(seeder);
  seedMonths(seeder);
  seedPlan(seeder);
  return { userId, invoices: invoiceCount(userId) };
}

export async function seedDemo(now: Date): Promise<{ userId: string; invoices: number }> {
  const existing = demoUserId();
  if (existing) return { userId: existing, invoices: invoiceCount(existing) };
  return seedDemoWith(now, await demoPasswordHash());
}
