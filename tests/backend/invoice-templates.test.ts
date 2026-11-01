import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { TemplateDocument } from "@/lib/invoice-template";
import { TEXTS } from "@/lib/texts";
import { setClockForTests } from "@/server/clock";
import { auditLog, invoice, invoiceTemplate, user } from "@/server/db/schema";
import { hideBankAccount, saveBankAccount } from "@/server/services/bank-accounts";
import { saveCatalogItem } from "@/server/services/catalog";
import { archiveCustomer, deleteCustomer, saveCustomer } from "@/server/services/customers";
import {
  deleteTemplate,
  draftFromTemplate,
  getTemplate,
  listTemplates,
  saveTemplate,
  templateFromInvoice,
} from "@/server/services/invoice-templates";
import { issueInvoice } from "@/server/services/invoice-lifecycle";
import { getInvoice, newDraftDefaults, saveDraft } from "@/server/services/invoices";
import { ensureDefaultSeries } from "@/server/services/number-series";
import { saveSupplier } from "@/server/services/supplier";
import { USER_OWNED_TABLES } from "@/server/services/users";
import { createTestDb } from "../helpers/db";
import { assertIsolated } from "../helpers/isolation";

vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-templates-")));

const db = createTestDb();
const actor = (userId: string) => ({ userId, source: "web" as const });
const NOW = new Date("2026-03-10T10:00:00Z");

let counter = 0;

function newOwner(): string {
  const id = `t${(counter += 1)}`;
  const now = new Date();
  db.insert(user)
    .values({ id, name: id, email: `${id}@example.cz`, createdAt: now, updatedAt: now })
    .run();
  ensureDefaultSeries(actor(id));
  return id;
}

const customerInput = (name: string) => ({
  name,
  street: "Krátká 2",
  city: "Brno",
  zip: "602 00",
  country: "Česká republika",
  ico: "",
  dic: "",
  email: "",
  extraEmails: [],
  phone: "",
  note: "",
  dueDays: null,
  language: null,
  currency: null,
  designId: null,
  remindersEnabled: null,
});

const newCustomer = (owner: string, name = "Alfa s.r.o.") =>
  saveCustomer(actor(owner), customerInput(name)).id;

const accountInput = (name: string, currency: "CZK" | "EUR" = "CZK") => ({
  name,
  currency,
  number: "19-2000145399",
  bankCode: "0800",
  iban: "",
  swift: "",
});

function document(owner: string, over: Partial<TemplateDocument> = {}): TemplateDocument {
  const base = newDraftDefaults(owner, null);
  return {
    type: "invoice",
    bankAccountId: null,
    dueDays: 21,
    language: "en",
    currency: "EUR",
    paymentMethod: "cash",
    orderRef: "OBJ-1",
    reference: "REF-1",
    textBefore: "Fakturujeme za {{mesic_nazev}} {{rok}}.",
    textAfter: "Děkujeme.",
    note: "Poznámka",
    discountKind: "percent",
    discountValue: 1000,
    rounding: "none",
    appearance: { ...base.appearance, designId: "classic" },
    lines: [
      {
        catalogItemId: null,
        name: "Správa webu {{mesic}}/{{rok}}",
        description: "Měsíční paušál",
        quantityMilli: 1000,
        unit: "měsíc",
        unitPriceMinor: 250_000,
        discountKind: "none",
        discountValue: 0,
      },
    ],
    ...over,
  };
}

const input = (owner: string, over: Record<string, unknown> = {}) => ({
  name: "Měsíční správa",
  customerId: null as string | null,
  document: document(owner),
  ...over,
});

beforeEach(() => setClockForTests({ now: () => NOW }));
afterEach(() => setClockForTests(null));

describe("šablony faktur", () => {
  test("[TPL-001] šablona uloží položky, poznámky, jazyk, měnu, design, splatnost", () => {
    const owner = newOwner();
    const customerId = newCustomer(owner);
    const { id } = saveTemplate(actor(owner), input(owner, { customerId }));

    const row = getTemplate(owner, id)!;
    expect(row.name).toBe("Měsíční správa");
    expect(row.customerId).toBe(customerId);
    expect(row.document).toMatchObject({
      language: "en",
      currency: "EUR",
      dueDays: 21,
      note: "Poznámka",
      textAfter: "Děkujeme.",
      appearance: { designId: "classic" },
    });
    expect(row.document.lines.map((l) => l.name)).toEqual(["Správa webu {{mesic}}/{{rok}}"]);
    expect(row.document).not.toHaveProperty("issueDate");
    expect(row.document).not.toHaveProperty("number");
  });

  test("[TPL-001] úprava šablony mění stejný záznam a zákazník je volitelný", () => {
    const owner = newOwner();
    const { id } = saveTemplate(actor(owner), input(owner));
    saveTemplate(actor(owner), { ...input(owner, { name: "Nový název" }), id });
    expect(listTemplates(owner).map((t) => t.name)).toEqual(["Nový název"]);
    expect(getTemplate(owner, id)!.customerId).toBeNull();
  });

  test("[TPL-001] smazání zákazníka nechá šablonu bez zákazníka", () => {
    const owner = newOwner();
    const customerId = newCustomer(owner);
    const { id } = saveTemplate(actor(owner), input(owner, { customerId }));
    deleteCustomer(actor(owner), customerId);
    expect(getTemplate(owner, id)!.customerId).toBeNull();
  });

  test("[TPL-001] šablona nesmí odkázat na cizího zákazníka, účet ani položku ceníku", () => {
    const owner = newOwner();
    const other = newOwner();
    const foreignCustomer = newCustomer(other);
    const foreignAccount = saveBankAccount(actor(other), accountInput("Cizí"));
    const foreignItem = saveCatalogItem(actor(other), {
      name: "Cizí",
      description: "",
      unit: "ks",
      priceMinor: 100,
      currency: "CZK",
      category: "",
      tags: [],
    }).id;
    const line = document(owner).lines[0]!;

    expect(() => saveTemplate(actor(owner), input(owner, { customerId: foreignCustomer }))).toThrow(
      "Zákazník neexistuje",
    );
    expect(() =>
      saveTemplate(actor(owner), {
        ...input(owner),
        document: document(owner, { bankAccountId: foreignAccount }),
      }),
    ).toThrow("Bankovní účet neexistuje");
    expect(() =>
      saveTemplate(actor(owner), {
        ...input(owner),
        document: document(owner, { lines: [{ ...line, catalogItemId: foreignItem }] }),
      }),
    ).toThrow("Položka ceníku neexistuje");
    expect(listTemplates(owner)).toEqual([]);
  });

  test("záporná cena na faktuře a záloze je odmítnutá u šablony", () => {
    const owner = newOwner();
    const base = document(owner);
    const lines = [{ ...base.lines[0]!, unitPriceMinor: -100 }];
    for (const type of ["invoice", "advance"] as const) {
      expect(() =>
        saveTemplate(actor(owner), { ...input(owner), document: { ...base, type, lines } }),
      ).toThrow(TEXTS.invoices.validation.negativePrice);
    }
    expect(listTemplates(owner)).toEqual([]);
  });

  test("[TPL-001] název je povinný a splatnost musí být celé nezáporné číslo", () => {
    const owner = newOwner();
    expect(() => saveTemplate(actor(owner), input(owner, { name: "  " }))).toThrow(
      "Vyplňte název šablony",
    );
    expect(() =>
      saveTemplate(actor(owner), { ...input(owner), document: document(owner, { dueDays: -1 }) }),
    ).toThrow("Splatnost");
  });

  test("[TPL-002] jedno kliknutí dá koncept s dnešními daty", () => {
    const owner = newOwner();
    const customerId = newCustomer(owner);
    const account = saveBankAccount(actor(owner), accountInput("Euro", "EUR"));
    const { id: templateId } = saveTemplate(actor(owner), {
      ...input(owner, { customerId }),
      document: document(owner, { bankAccountId: account }),
    });

    const { id } = draftFromTemplate(actor(owner), templateId);

    const draft = getInvoice(owner, id)!;
    expect(draft.status).toBe("draft");
    expect(draft.number).toBeNull();
    expect(draft.customerId).toBe(customerId);
    expect(draft.issueDate).toBe("2026-03-10");
    expect(draft.dueDate).toBe("2026-03-31");
    expect(draft.language).toBe("en");
    expect(draft.currency).toBe("EUR");
    expect(draft.bankAccountId).toBe(account);
    expect(draft.seriesId).not.toBeNull();
    expect(draft.discountKind).toBe("percent");
    expect(draft.lines).toHaveLength(1);
    expect(draft.lines[0]).toMatchObject({ name: "Správa webu {{mesic}}/{{rok}}", unit: "měsíc" });
  });

  test("[TPL-002] každé použití vytvoří nový koncept a šablona zůstane", () => {
    const owner = newOwner();
    const { id: templateId } = saveTemplate(actor(owner), input(owner));
    const first = draftFromTemplate(actor(owner), templateId).id;
    const second = draftFromTemplate(actor(owner), templateId).id;
    expect(first).not.toBe(second);
    expect(getTemplate(owner, templateId)).not.toBeNull();
  });

  test("[TPL-002] smazaný nebo archivovaný zákazník, skrytý účet a smazaná položka se nevyberou", () => {
    const owner = newOwner();
    const customerId = newCustomer(owner);
    const accountId = saveBankAccount(actor(owner), accountInput("Euro", "EUR"));
    const itemId = saveCatalogItem(actor(owner), {
      name: "Položka",
      description: "",
      unit: "ks",
      priceMinor: 100,
      currency: "CZK",
      category: "",
      tags: [],
    }).id;
    const line = document(owner).lines[0]!;
    const { id: templateId } = saveTemplate(actor(owner), {
      ...input(owner, { customerId }),
      document: document(owner, {
        bankAccountId: accountId,
        lines: [{ ...line, catalogItemId: itemId }],
      }),
    });
    archiveCustomer(actor(owner), customerId);
    hideBankAccount(actor(owner), accountId);

    const draft = getInvoice(owner, draftFromTemplate(actor(owner), templateId).id)!;

    expect(draft.customerId).toBeNull();
    expect(draft.bankAccountId).toBeNull();
    expect(draft.lines).toHaveLength(1);
  });

  test("[TPL-002] draft z cizí šablony nevznikne", () => {
    const owner = newOwner();
    const other = newOwner();
    const { id } = saveTemplate(actor(owner), input(owner));
    expect(() => draftFromTemplate(actor(other), id)).toThrow("Šablona neexistuje");
    expect(db.select().from(invoice).where(eq(invoice.userId, other)).all()).toEqual([]);
  });

  test("[TPL-003] uložení faktury jako šablony nepřenese číslo ani stav", () => {
    const owner = newOwner();
    saveSupplier(actor(owner), {
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
    const customerId = newCustomer(owner);
    const saved = saveDraft(actor(owner), {
      ...newDraftDefaults(owner, customerId),
      paymentMethod: "cash",
      note: "Dík",
      lines: [
        {
          catalogItemId: null,
          name: "Práce",
          description: "",
          quantityMilli: 3000,
          unit: "hod.",
          unitPriceMinor: 100_000,
          discountKind: "none",
          discountValue: 0,
        },
      ],
    });
    const issued = issueInvoice(actor(owner), saved.id, { revision: saved.revision });

    const { id } = templateFromInvoice(actor(owner), issued.id, "Z faktury");

    const row = getTemplate(owner, id)!;
    expect(row.name).toBe("Z faktury");
    expect(row.customerId).toBe(customerId);
    expect(row.document.dueDays).toBe(14);
    expect(row.document.note).toBe("Dík");
    expect(row.document.lines).toMatchObject([{ name: "Práce", quantityMilli: 3000 }]);
    expect(JSON.stringify(row)).not.toContain(issued.number);
    for (const key of ["number", "status", "issueDate", "dueDate", "revision"]) {
      expect(row.document).not.toHaveProperty(key);
    }
    expect(getInvoice(owner, issued.id)!.status).toBe("issued");
  });

  test("[TPL-004] šablona z konceptu zachová proměnné, z vystaveného dokladu dosazené hodnoty", () => {
    const owner = newOwner();
    const customerId = newCustomer(owner);
    saveSupplier(actor(owner), {
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
    const { id, revision } = saveDraft(actor(owner), {
      ...newDraftDefaults(owner, customerId),
      paymentMethod: "cash",
      note: "Rok {{rok}}",
      orderRef: "OBJ-{{rok}}",
      lines: [
        {
          catalogItemId: null,
          name: "Hosting {{mesic_nazev}} {{rok}}",
          description: "",
          quantityMilli: 1000,
          unit: "ks",
          unitPriceMinor: 100_000,
          discountKind: "none",
          discountValue: 0,
        },
      ],
    });

    const fromDraft = templateFromInvoice(actor(owner), id, "Z konceptu");
    issueInvoice(actor(owner), id, { revision });
    const fromIssued = templateFromInvoice(actor(owner), id, "Z vystavené");

    expect(getTemplate(owner, fromDraft.id)?.document).toMatchObject({
      note: "Rok {{rok}}",
      orderRef: "OBJ-{{rok}}",
      lines: [{ name: "Hosting {{mesic_nazev}} {{rok}}" }],
    });
    expect(getTemplate(owner, fromIssued.id)?.document).toMatchObject({
      note: "Rok 2026",
      orderRef: "OBJ-2026",
      lines: [{ name: "Hosting březen 2026" }],
    });
  });

  test("[TPL-002] audit konceptu ze šablony uvádí zdrojovou šablonu", () => {
    const owner = newOwner();
    const { id: templateId } = saveTemplate(actor(owner), input(owner));

    const { id } = draftFromTemplate(actor(owner), templateId);

    const entry = db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, id))
      .all()
      .find((row) => row.action === "invoice.save");
    expect(entry).toMatchObject({
      after: { fromTemplate: { id: templateId, name: "Měsíční správa" } },
    });
  });

  test("[TPL-003] cizí fakturu nelze uložit jako šablonu", () => {
    const owner = newOwner();
    const other = newOwner();
    const { id } = saveDraft(actor(owner), newDraftDefaults(owner, null));
    expect(() => templateFromInvoice(actor(other), id, "Cizí")).toThrow("neexistuje");
    expect(listTemplates(other)).toEqual([]);
  });

  test("[TPL-004] neznámá proměnná {{neco}} je odmítnutá s názvem", () => {
    const owner = newOwner();
    expect(() =>
      saveTemplate(actor(owner), {
        ...input(owner),
        document: document(owner, { note: "Ahoj {{neco}} a {{jine}}" }),
      }),
    ).toThrow("{{neco}}");
    const line = document(owner).lines[0]!;
    expect(() =>
      saveTemplate(actor(owner), {
        ...input(owner),
        document: document(owner, { lines: [{ ...line, description: "{{spatne}}" }] }),
      }),
    ).toThrow("{{spatne}}");
    expect(listTemplates(owner)).toEqual([]);
  });

  test("[TPL-004] známé proměnné projdou a zůstanou v šabloně nedosazené", () => {
    const owner = newOwner();
    const { id } = saveTemplate(actor(owner), input(owner));
    expect(getTemplate(owner, id)!.document.textBefore).toBe(
      "Fakturujeme za {{mesic_nazev}} {{rok}}.",
    );
  });

  test("[TST-009] izolace šablon", async () => {
    await assertIsolated({
      create: (owner) => {
        const now = new Date();
        db.insert(user)
          .values({
            id: owner,
            name: owner,
            email: `${owner}@example.cz`,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing()
          .run();
        return saveTemplate(actor(owner), input(owner)).id;
      },
      find: (owner, id) => getTemplate(owner, id),
      list: (owner) => listTemplates(owner).map((t) => t.id),
      update: (owner, id) => {
        saveTemplate(actor(owner), { ...input(owner, { name: "Změna" }), id });
        return db.select().from(invoiceTemplate).where(eq(invoiceTemplate.name, "Změna")).all()
          .length;
      },
      remove: (owner, id) => {
        deleteTemplate(actor(owner), id);
        return 1;
      },
    });
  });

  test("[TST-009] šablonu nelze smazat cizím účtem", () => {
    const owner = newOwner();
    const other = newOwner();
    const { id } = saveTemplate(actor(owner), input(owner));
    expect(() => deleteTemplate(actor(other), id)).toThrow("Šablona neexistuje");
    expect(getTemplate(owner, id)).not.toBeNull();
  });

  test("[TPL-001] změny šablon se zapisují do auditu", () => {
    const owner = newOwner();
    const { id } = saveTemplate(actor(owner), input(owner));
    deleteTemplate(actor(owner), id);
    const actions = db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.entityId, id))
      .all()
      .map((r) => r.action);
    expect(actions).toEqual(["invoice_template.save", "invoice_template.delete"]);
    expect(getTemplate(owner, id)).toBeNull();
  });

  test("[ADM-006] tabulka šablon patří mezi data účtu", () => {
    expect(USER_OWNED_TABLES).toContain(invoiceTemplate);
  });
});

describe("zahraniční šablona", () => {
  test("šablona a plán uložené před tímto plánem jdou načíst", () => {
    const owner = newOwner();
    const { foreign: _f, clause: _c, ...old } = document(owner);
    const { id } = saveTemplate(actor(owner), input(owner));
    db.update(invoiceTemplate).set({ document: old }).where(eq(invoiceTemplate.id, id)).run();

    const draft = getInvoice(owner, draftFromTemplate(actor(owner), id).id);
    expect(draft).toMatchObject({ foreign: false, clause: "" });
  });

  test("[FOR-001] šablona nese přepínač a doložku, kurz doplní až vystavení", () => {
    const owner = newOwner();
    const { id } = saveTemplate(
      actor(owner),
      input(owner, { document: document(owner, { foreign: true, clause: "Doložka" }) }),
    );
    expect(getInvoice(owner, draftFromTemplate(actor(owner), id).id)).toMatchObject({
      foreign: true,
      clause: "Doložka",
      exchangeRateMicros: null,
      exchangeRateSource: null,
    });
  });

  test("[R-18] šablona v CZK kurz nikdy nedostane", () => {
    const owner = newOwner();
    const { id } = saveTemplate(
      actor(owner),
      input(owner, {
        document: { ...document(owner), exchangeRateMicros: 25_000_000 },
      }),
    );
    expect(getTemplate(owner, id)?.document).not.toHaveProperty("exchangeRateMicros");
    expect(
      getInvoice(owner, draftFromTemplate(actor(owner), id).id)?.exchangeRateMicros,
    ).toBeNull();
  });
});
