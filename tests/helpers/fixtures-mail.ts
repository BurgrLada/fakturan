import { randomUUID } from "node:crypto";
import type { Db } from "@/server/db";
import { mailSettings, user } from "@/server/db/schema";
import { saveBankAccount } from "@/server/services/bank-accounts";
import { saveCustomer } from "@/server/services/customers";
import { issueInvoice } from "@/server/services/invoice-lifecycle";
import { newDraftDefaults, saveDraft, type DraftInput } from "@/server/services/invoices";
import { ensureDefaultSeries } from "@/server/services/number-series";
import { saveSupplier } from "@/server/services/supplier";

export const webActor = (userId: string) => ({ userId, source: "web" as const });

export function seedOwner(db: Db, now: Date): string {
  const id = `m-${randomUUID()}`;
  db.insert(user)
    .values({ id, name: id, email: `${id}@example.cz`, createdAt: now, updatedAt: now })
    .run();
  const actor = webActor(id);
  ensureDefaultSeries(actor);
  saveSupplier(actor, {
    name: "Jan Novák",
    street: "Dlouhá 1",
    city: "Praha",
    zip: "110 00",
    country: "Česká republika",
    ico: "27082440",
    dic: "",
    email: "",
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
    name: "Účet",
    currency: "CZK",
    number: "19-2000145399",
    bankCode: "0800",
    iban: "",
    swift: "",
  });
  return id;
}

export function seedCustomer(owner: string, email = "alfa@example.cz"): string {
  return saveCustomer(webActor(owner), {
    name: "Alfa s.r.o.",
    street: "Krátká 2",
    city: "Brno",
    zip: "602 00",
    country: "Česká republika",
    ico: "",
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
  }).id;
}

export function draftFor(owner: string, customerId: string, over: Partial<DraftInput> = {}) {
  return saveDraft(webActor(owner), {
    ...newDraftDefaults(owner, customerId),
    lines: [
      {
        catalogItemId: null,
        name: "Konzultace",
        description: "",
        quantityMilli: 2000,
        unit: "hod.",
        unitPriceMinor: 150_000,
        discountKind: "none",
        discountValue: 0,
      },
    ],
    ...over,
  });
}

export function issuedInvoice(owner: string, customerId = seedCustomer(owner)): string {
  const { id, revision } = draftFor(owner, customerId);
  issueInvoice(webActor(owner), id, { revision });
  return id;
}

export function issuedAdvance(
  owner: string,
  customerId = seedCustomer(owner),
  total = 1_000_000,
  over: Partial<DraftInput> = {},
) {
  const { id, revision } = draftFor(owner, customerId, {
    ...newDraftDefaults(owner, customerId, "advance"),
    lines: [
      {
        catalogItemId: null,
        name: "Záloha",
        description: "",
        quantityMilli: 1000,
        unit: "ks",
        unitPriceMinor: total,
        discountKind: "none",
        discountValue: 0,
      },
    ],
    ...over,
  });
  issueInvoice(webActor(owner), id, { revision });
  return id;
}

export function ownSmtp(
  db: Db,
  owner: string,
  port: number,
  over: { cc?: string[]; bcc?: string[]; replyTo?: string } = {},
): void {
  db.insert(mailSettings)
    .values({
      userId: owner,
      smtpHost: "127.0.0.1",
      smtpPort: port,
      fromEmail: "fakturace@novak.example.cz",
      senderName: "Jan Novák",
      cc: over.cc ?? [],
      bcc: over.bcc ?? [],
      replyTo: over.replyTo ?? null,
      updatedAt: new Date(0),
    })
    .run();
}
