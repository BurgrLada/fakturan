import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { MESSAGE_KINDS, kindForInvoice } from "@/lib/email-template";
import { LANGUAGES } from "@/lib/preferences";
import { formatMoney } from "@/lib/money";
import { setClockForTests } from "@/server/clock";
import { auditLog, emailTemplate, rateLimit, user } from "@/server/db/schema";
import { DEFAULT_MAIL_CONTENT } from "@/server/mail/defaults";
import { ServiceError } from "@/server/services/access";
import { saveCustomer } from "@/server/services/customers";
import {
  composeMail,
  getEmailTemplate,
  listEmailTemplates,
  mailRecipients,
  resetEmailTemplate,
  saveEmailTemplate,
} from "@/server/services/email-templates";
import { saveBankAccount } from "@/server/services/bank-accounts";
import { issueInvoice } from "@/server/services/invoice-lifecycle";
import { newDraftDefaults, saveDraft, type DraftInput } from "@/server/services/invoices";
import { RATE_RULES } from "@/server/rate-limit";
import { saveMailSettings } from "@/server/services/mail-settings";
import { ensureDefaultSeries } from "@/server/services/number-series";
import { saveSupplier } from "@/server/services/supplier";
import { deleteUser, USER_OWNED_TABLES } from "@/server/services/users";
import { createTestDb } from "../helpers/db";
import { assertIsolated } from "../helpers/isolation";

vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-email-templates-")));

const db = createTestDb();
const NOW = new Date("2026-07-15T10:00:00Z");
const actor = (userId: string) => ({ userId, source: "web" as const });

beforeEach(() => setClockForTests({ now: () => NOW }));
afterEach(() => setClockForTests(null));

let counter = 0;

function seed(): string {
  const id = `e${(counter += 1)}-${randomUUID()}`;
  db.insert(user)
    .values({ id, name: id, email: `${id}@example.cz`, createdAt: NOW, updatedAt: NOW })
    .run();
  ensureDefaultSeries(actor(id));
  saveSupplier(actor(id), {
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
  saveBankAccount(actor(id), {
    name: "Účet",
    currency: "CZK",
    number: "19-2000145399",
    bankCode: "0800",
    iban: "",
    swift: "",
  });
  return id;
}

function newCustomer(owner: string, over: Record<string, unknown> = {}) {
  return saveCustomer(actor(owner), {
    name: "Alfa s.r.o.",
    street: "Krátká 2",
    city: "Brno",
    zip: "602 00",
    country: "Česká republika",
    ico: "",
    dic: "",
    email: "alfa@example.cz",
    extraEmails: [],
    phone: "",
    note: "",
    dueDays: null,
    language: null,
    currency: null,
    designId: null,
    remindersEnabled: null,
    ...over,
  }).id;
}

function issued(owner: string, customerId: string, over: Partial<DraftInput> = {}) {
  const { id, revision } = saveDraft(actor(owner), {
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
  issueInvoice(actor(owner), id, { revision });
  return id;
}

const reject = (owner: string, raw: unknown) => {
  expect(() => saveEmailTemplate(actor(owner), raw)).toThrow(ServiceError);
};

const input = (over: Record<string, unknown> = {}) => ({
  kind: "invoice",
  language: "cs",
  subject: "Faktura {{cislo_faktury}}",
  body: "Dobrý den, posílám fakturu.",
  ...over,
});

describe("předvyplnění", () => {
  test("[MAIL-002] předvyplnění je v jazyce faktury s dosazenými proměnnými", () => {
    const owner = seed();
    const customerId = newCustomer(owner);
    const en = issued(owner, customerId, { language: "en" });
    const cs = issued(owner, customerId, { language: "cs" });
    db.run(sql`UPDATE invoice SET paid_minor = 100000 WHERE id = ${cs}`);

    const english = composeMail(owner, en, "invoice");
    const czech = composeMail(owner, cs, "reminder");

    expect(english.subject).toMatch(/^Invoice \d+/);
    expect(english.body).toContain(formatMoney(300_000, "CZK"));
    expect(english.body).toContain("Kind regards,\nJan Novák");
    expect(english.to).toEqual(["alfa@example.cz"]);
    expect(czech.subject).toMatch(/^Upomínka k faktuře \d+/);
    expect(czech.body).toContain(`Zbývá uhradit ${formatMoney(200_000, "CZK")}`);
    expect(czech.body).toContain("S pozdravem\nJan Novák");
    expect(czech.attachmentName).toMatch(/\.pdf$/);
    expect(czech.body).not.toMatch(/\{\{/);
  });

  test("[MAIL-002] datum splatnosti má formát dokladu a zpráva nese stálé kopie", async () => {
    const owner = seed();
    await saveMailSettings(actor(owner), {
      smtpHost: "",
      smtpPort: "",
      smtpUser: "",
      smtpPassword: "",
      fromEmail: "",
      senderName: "",
      replyTo: "",
      cc: "kopie@example.cz",
      bcc: "skryta@example.cz",
    });
    const id = issued(owner, newCustomer(owner));
    db.run(
      sql`UPDATE invoice SET due_date = '2026-07-29', date_format = 'dd.MM.yyyy' WHERE id = ${id}`,
    );

    const draft = composeMail(owner, id, "invoice");

    expect(draft.body).toContain("se splatností 29.07.2026");
    expect(draft.cc).toEqual(["kopie@example.cz"]);
    expect(draft.bcc).toEqual(["skryta@example.cz"]);
  });

  test("[MAIL-002] ruční úprava v dialogu se nerozvíjí a hlídá předmět", () => {
    const owner = seed();
    const id = issued(owner, newCustomer(owner));

    const draft = composeMail(owner, id, "invoice", { subject: "Ruční {{rok}}", body: "Text" });

    expect(draft.subject).toBe("Ruční {{rok}}");
    expect(() =>
      composeMail(owner, id, "invoice", { subject: "A\r\nBcc: x@y.cz", body: "T" }),
    ).toThrow(ServiceError);
    expect(() => composeMail("cizi", id, "invoice")).toThrow(ServiceError);
  });

  test("[REC-024] {{mesic_nazev}} v anglické faktuře je July", () => {
    const owner = seed();
    const id = issued(owner, newCustomer(owner), { language: "en" });
    const cs = issued(owner, newCustomer(owner, { name: "Beta" }), { language: "cs" });
    for (const [language, kind] of [["en", "invoice"] as const, ["cs", "invoice"] as const]) {
      saveEmailTemplate(actor(owner), input({ language, kind, subject: "{{mesic_nazev}}" }));
    }

    expect(composeMail(owner, id, "invoice").subject).toBe("July");
    expect(composeMail(owner, cs, "invoice").subject).toBe("červenec");
  });

  test("{{zbyva}} je jen v e-mailu, v dokladu zůstává text", async () => {
    const { renderVariables } = await import("@/lib/template-vars");
    const ctx = {
      period: { from: "2026-07-01", to: "2026-07-31" },
      language: "cs" as const,
      dateFormat: "dd.MM.yyyy" as const,
      number: "1",
      customer: "A",
    };

    expect(renderVariables("Zbývá {{zbyva}}", ctx)).toBe("Zbývá {{zbyva}}");
  });

  test("[SEC-006] vykreslený předmět má strop 200 znaků bez rozseknutí znaku", () => {
    const owner = seed();
    saveEmailTemplate(actor(owner), input({ subject: "{{zakaznik}}" }));
    const subjectFor = (name: string) => {
      const id = issued(owner, newCustomer(owner));
      db.run(sql`UPDATE invoice SET customer_name = ${name} WHERE id = ${id}`);
      return composeMail(owner, id, "invoice").subject;
    };
    const long = subjectFor("a".repeat(250));
    const emoji = subjectFor(`${"b".repeat(199)}😀`);

    expect(long).toBe("a".repeat(200));
    expect(emoji).toBe("b".repeat(199));
  });

  test("[SEC-006] konec řádku ve jménu zákazníka nebo dodavatele se v předmětu změní na mezeru", () => {
    const owner = seed();
    saveEmailTemplate(actor(owner), input({ subject: "{{zakaznik}} / {{dodavatel}}" }));
    const id = issued(owner, newCustomer(owner));
    db.run(
      sql`UPDATE invoice SET customer_name = ${"Alfa\r\nBcc: x@y.cz"},
        supplier_snapshot = json_set(supplier_snapshot, '$.name', ${"Jan\n\u2028Novák"}) WHERE id = ${id}`,
    );

    const { subject } = composeMail(owner, id, "invoice");

    expect(subject).toBe("Alfa Bcc: x@y.cz / Jan Novák");
    expect(subject).not.toMatch(/[\r\n\u0085\u2028\u2029]/);
  });

  test("[SEC-011] jméno zákazníka s {{rok}} a <script> zůstane doslova", () => {
    const owner = seed();
    const name = "{{rok}} <script>alert(1)</script> {{castka}}";
    const id = issued(owner, newCustomer(owner, { name }));
    saveEmailTemplate(
      actor(owner),
      input({ subject: "Pro {{zakaznik}}", body: "{{zakaznik}} dluží {{castka}}" }),
    );

    const draft = composeMail(owner, id, "invoice");

    expect(draft.subject).toBe(`Pro ${name}`);
    expect(draft.body).toBe(`${name} dluží ${formatMoney(300_000, "CZK")}`);
  });
});

describe("příjemci", () => {
  test("[MAIL-002] příjemce se bere z aktuální karty zákazníka bez duplicit", () => {
    const owner = seed();
    const customerId = newCustomer(owner);
    const id = issued(owner, customerId);
    saveCustomer(actor(owner), {
      id: customerId,
      name: "Alfa s.r.o.",
      street: "Krátká 2",
      city: "Brno",
      zip: "602 00",
      country: "Česká republika",
      ico: "",
      dic: "",
      email: "nova@example.cz",
      extraEmails: ["druha@example.cz", "nova@example.cz"],
      phone: "",
      note: "",
      dueDays: null,
      language: null,
      currency: null,
      designId: null,
      remindersEnabled: null,
    });

    expect(composeMail(owner, id, "invoice").to).toEqual(["nova@example.cz", "druha@example.cz"]);
  });

  test("[MAIL-002] bez karty zákazníka zůstane záloha ze snapshotu", () => {
    expect(
      mailRecipients("nikdo", {
        customerId: null,
        customerSnapshot: { email: "stary@example.cz" },
      }),
    ).toEqual(["stary@example.cz"]);
    expect(mailRecipients("nikdo", { customerId: null, customerSnapshot: null })).toEqual([]);
  });
});

describe("úprava šablon", () => {
  test("[MAIL-003] každý z 5 druhů jde upravit v obou jazycích a vrátit na výchozí", () => {
    const owner = seed();
    const rows = () => db.select().from(emailTemplate).where(eq(emailTemplate.userId, owner)).all();

    for (const language of LANGUAGES) {
      for (const kind of MESSAGE_KINDS) {
        expect(getEmailTemplate(owner, kind, language)).toEqual(
          DEFAULT_MAIL_CONTENT[language][kind],
        );
        saveEmailTemplate(
          actor(owner),
          input({ kind, language, subject: `S ${kind} ${language}`, body: `T {{rok}}` }),
        );
        expect(getEmailTemplate(owner, kind, language)).toEqual({
          subject: `S ${kind} ${language}`,
          body: "T {{rok}}",
        });
      }
    }
    expect(rows()).toHaveLength(10);

    saveEmailTemplate(actor(owner), input({ subject: "Podruhé" }));
    expect(rows()).toHaveLength(10);

    for (const language of LANGUAGES) {
      for (const kind of MESSAGE_KINDS) {
        resetEmailTemplate(actor(owner), kind, language);
        expect(getEmailTemplate(owner, kind, language)).toEqual(
          DEFAULT_MAIL_CONTENT[language][kind],
        );
      }
    }
    expect(rows()).toHaveLength(0);
    const actions = db.select().from(auditLog).where(eq(auditLog.ownerId, owner)).all();
    expect(actions.filter((row) => row.action === "email_template.reset")).toHaveLength(10);
    expect(() => resetEmailTemplate(actor(owner), "invoice", "cs")).not.toThrow();
  });

  test("[MAIL-003] neznámá proměnná je odmítnutá s názvem", () => {
    const owner = seed();

    expect(() =>
      saveEmailTemplate(actor(owner), input({ body: "Ahoj {{jmeno}} {{rok}} {{nic}}" })),
    ).toThrow("Neznámá proměnná: {{jmeno}}, {{nic}}");
    expect(() => saveEmailTemplate(actor(owner), input({ subject: "{{ rok }}" }))).toThrow(
      "{{ rok }}",
    );
    expect(
      db
        .select()
        .from(emailTemplate)
        .all()
        .filter((r) => r.userId === owner),
    ).toHaveLength(0);
  });

  test("[SEC-006] meze předmětu a těla a neplatné vstupy", () => {
    const owner = seed();

    reject(owner, input({ subject: "x".repeat(201) }));
    reject(owner, input({ subject: "A\nB" }));
    reject(owner, input({ subject: "A\r\nBcc: x@y.cz" }));
    reject(owner, input({ subject: "A B" }));
    reject(owner, input({ subject: "  " }));
    reject(owner, input({ body: "" }));
    reject(owner, input({ body: "x".repeat(10_001) }));
    reject(owner, input({ kind: "newsletter" }));
    reject(owner, input({ language: "de" }));
    reject(owner, null);
    expect(() => saveEmailTemplate({ userId: null, source: "system" }, input())).toThrow(
      ServiceError,
    );

    saveEmailTemplate(actor(owner), input({ subject: "x".repeat(200), body: "y".repeat(10_000) }));
    expect(getEmailTemplate(owner, "invoice", "cs").subject).toHaveLength(200);
  });

  test("tělo se ukládá s konci řádků \\n", () => {
    const owner = seed();

    saveEmailTemplate(actor(owner), input({ body: "A\r\nB\rC" }));

    expect(getEmailTemplate(owner, "invoice", "cs").body).toBe("A\nB\nC");
  });

  test("druh zprávy odpovídá typu dokladu", () => {
    expect(kindForInvoice("invoice")).toBe("invoice");
    expect(kindForInvoice("advance")).toBe("advance");
    expect(kindForInvoice("credit_note")).toBe("credit_note");
  });
});

describe("výchozí texty", () => {
  test("[MAIL-007] výchozí texty neobsahují sledování ani potvrzení přijetí", () => {
    for (const language of LANGUAGES) {
      for (const kind of MESSAGE_KINDS) {
        const { subject, body } = DEFAULT_MAIL_CONTENT[language][kind];
        const text = `${subject}\n${body}`;
        expect(text).not.toMatch(
          /https?:|<[a-z!/]|\bwww\.|pixel|track|potvrzen[ií] přijet|read receipt/i,
        );
        expect(subject).not.toMatch(/[\r\n]/);
        expect(subject.length).toBeLessThanOrEqual(200);
      }
    }
  });
});

describe("izolace a účet", () => {
  test("[TST-009] izolace šablon e-mailů", async () => {
    await assertIsolated<string>({
      owners: [seed(), seed()],
      create: (ownerId) => {
        saveEmailTemplate(actor(ownerId), input({ subject: `Předmět ${ownerId}` }));
        return ownerId;
      },
      find: (ownerId, id) => {
        const template = getEmailTemplate(ownerId, "invoice", "cs");
        return template.subject === `Předmět ${id}` ? template : null;
      },
      update: (ownerId, id) => {
        const marker = randomUUID();
        saveEmailTemplate(actor(ownerId), input({ subject: marker }));
        return getEmailTemplate(id, "invoice", "cs").subject === marker ? 1 : 0;
      },
      remove: (ownerId, id) => {
        resetEmailTemplate(actor(ownerId), "invoice", "cs");
        return listEmailTemplates(id).some(
          (t) => t.kind === "invoice" && t.language === "cs" && t.custom,
        )
          ? 0
          : 1;
      },
    });
  });

  test("[TST-009] smazání účtu odstraní šablony e-mailů", () => {
    const owner = seed();
    saveEmailTemplate(actor(owner), input());
    expect(USER_OWNED_TABLES).toContain(emailTemplate);

    db.delete(user).where(eq(user.id, owner)).run();

    expect(db.select().from(emailTemplate).where(eq(emailTemplate.userId, owner)).all()).toEqual(
      [],
    );
  });

  test("[TST-009] deleteUser odstraní šablony e-mailů", () => {
    const admin = seed();
    db.update(user).set({ role: "admin" }).where(eq(user.id, admin)).run();
    const owner = seed();
    saveEmailTemplate(actor(owner), input());
    saveEmailTemplate(actor(admin), input());

    deleteUser(actor(admin), owner, `${owner}@example.cz`);

    expect(db.select().from(emailTemplate).where(eq(emailTemplate.userId, owner)).all()).toEqual(
      [],
    );
    expect(
      db.select().from(emailTemplate).where(eq(emailTemplate.userId, admin)).all(),
    ).toHaveLength(1);
  });
});

describe("audit a omezení", () => {
  const templateAudits = (owner: string, action: string) =>
    db
      .select()
      .from(auditLog)
      .where(eq(auditLog.ownerId, owner))
      .all()
      .filter((row) => row.action === action);

  test("[AUD-004] audit uložení šablony má obsah před a po", () => {
    const owner = seed();

    saveEmailTemplate(actor(owner), input({ subject: "První", body: "A" }));
    saveEmailTemplate(actor(owner), input({ subject: "Druhý", body: "B" }));

    const [first, second] = templateAudits(owner, "email_template.save");
    expect(first.before).toBeNull();
    expect(first.after).toEqual({ kind: "invoice", language: "cs", subject: "První", body: "A" });
    expect(second.before).toEqual({ kind: "invoice", language: "cs", subject: "První", body: "A" });
    expect(second.after).toEqual({ kind: "invoice", language: "cs", subject: "Druhý", body: "B" });
  });

  test("[SEC-001] uložení i vrácení šablony sdílí omezení s nastavením pošty", () => {
    const owner = seed();
    saveEmailTemplate(actor(owner), input());
    db.update(rateLimit)
      .set({ count: RATE_RULES.mailSaveUser.limit })
      .where(eq(rateLimit.key, `${RATE_RULES.mailSaveUser.name}:${owner}`))
      .run();

    expect(() => saveEmailTemplate(actor(owner), input({ subject: "Jiný" }))).toThrow(
      "Příliš mnoho pokusů",
    );
    expect(() => resetEmailTemplate(actor(owner), "invoice", "cs")).toThrow("Příliš mnoho pokusů");

    expect(getEmailTemplate(owner, "invoice", "cs").subject).toBe("Faktura {{cislo_faktury}}");
    expect(templateAudits(owner, "rate_limit.exceeded")).toHaveLength(1);
  });
});
