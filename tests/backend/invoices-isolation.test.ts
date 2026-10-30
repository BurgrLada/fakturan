import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { invoice, invoiceLine, user } from "@/server/db/schema";
import { saveBankAccount } from "@/server/services/bank-accounts";
import { saveCatalogItem } from "@/server/services/catalog";
import { saveCustomer } from "@/server/services/customers";
import {
  deleteDraft,
  duplicateInvoice,
  getInvoice,
  newDraftDefaults,
  saveDraft,
  type DraftInput,
} from "@/server/services/invoices";
import { ensureDefaultSeries, listSeries } from "@/server/services/number-series";
import { deleteTag, listTags, setInvoiceTags } from "@/server/services/tags";
import { createTestDb } from "../helpers/db";
import { assertIsolated } from "../helpers/isolation";

vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-invoices-iso-")));

const db = createTestDb();
const actor = (userId: string) => ({ userId, source: "web" as const });

function seed(id: string) {
  const now = new Date();
  db.insert(user)
    .values({ id, name: id, email: `${id}@example.cz`, createdAt: now, updatedAt: now })
    .onConflictDoNothing()
    .run();
}

const line = (over: Partial<DraftInput["lines"][number]> = {}): DraftInput["lines"][number] => ({
  catalogItemId: null,
  name: "Konzultace",
  description: "",
  quantityMilli: 1000,
  unit: "hod.",
  unitPriceMinor: 100_000,
  discountKind: "none",
  discountValue: 0,
  ...over,
});

const draft = (owner: string, over: Partial<DraftInput> = {}): DraftInput => ({
  ...newDraftDefaults(owner, null),
  lines: [line()],
  ...over,
});

const ownerRevision = (id: string) =>
  db.select({ revision: invoice.revision }).from(invoice).where(eq(invoice.id, id)).get()?.revision;

beforeEach(() => {
  seed("a");
  seed("b");
});

describe("izolace faktur", () => {
  test("[TST-009] izolace faktury, řádků a štítků včetně update a remove", async () => {
    await assertIsolated({
      owners: ["iso-a", "iso-b"],
      create: (owner) => {
        seed(owner);
        return saveDraft(actor(owner), draft(owner)).id;
      },
      find: (owner, id) => getInvoice(owner, id),
      update: (owner, id) => {
        saveDraft(actor(owner), draft(owner, { id, revision: ownerRevision(id), note: "změna" }));
        return 1;
      },
      remove: (owner, id) => {
        deleteDraft(actor(owner), id);
        return 1;
      },
    });

    await assertIsolated({
      owners: ["line-a", "line-b"],
      create: (owner) => {
        seed(owner);
        return saveDraft(actor(owner), draft(owner)).id;
      },
      find: (owner, id) => getInvoice(owner, id)?.lines ?? [],
      update: (owner, id) => {
        saveDraft(
          actor(owner),
          draft(owner, { id, revision: ownerRevision(id), lines: [line({ name: "Jiná" })] }),
        );
        return 1;
      },
    });

    await assertIsolated({
      owners: ["tag-a", "tag-b"],
      create: (owner) => {
        seed(owner);
        const { id } = saveDraft(actor(owner), draft(owner));
        setInvoiceTags(actor(owner), id, ["Práce"]);
        return listTags(owner)[0]!.id;
      },
      find: (owner, id) => listTags(owner).filter((t) => t.id === id),
      list: (owner) => listTags(owner).map((t) => t.id),
      remove: (owner, id) => {
        deleteTag(actor(owner), id);
        return 1;
      },
    });
  });

  test("[TST-009] cizí faktuře nejde přiřadit štítky ani ji duplikovat", () => {
    const { id } = saveDraft(actor("a"), draft("a"));

    expect(() => setInvoiceTags(actor("b"), id, ["Cizí"])).toThrow("neexistuje");
    expect(() => duplicateInvoice(actor("b"), id)).toThrow("neexistuje");
    expect(listTags("b")).toEqual([]);
    expect(getInvoice("a", id)?.tags).toEqual([]);
  });

  test("[TST-009] koncept nesmí odkázat na cizí zákazníka, účet, řadu ani položku ceníku", () => {
    const customerId = saveCustomer(actor("b"), {
      name: "Cizí",
      street: "",
      city: "",
      zip: "",
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
    }).id;
    const bankAccountId = saveBankAccount(actor("b"), {
      name: "Cizí",
      currency: "CZK",
      number: "19-2000145399",
      bankCode: "0800",
      iban: "",
      swift: "",
    });
    ensureDefaultSeries(actor("b"));
    const seriesId = listSeries("b")[0]!.id;
    const catalogItemId = saveCatalogItem(actor("b"), {
      name: "Cizí",
      description: "",
      unit: "ks",
      priceMinor: 100,
      currency: "CZK",
      category: "",
      tags: [],
    }).id;

    const linesOfA = () =>
      db.select().from(invoiceLine).where(eq(invoiceLine.userId, "a")).all().length;
    const linesBefore = linesOfA();

    for (const over of [
      { customerId },
      { bankAccountId },
      { seriesId },
      { lines: [line({ catalogItemId })] },
    ]) {
      expect(() => saveDraft(actor("a"), draft("a", over))).toThrow("neexistuje");
    }
    expect(linesOfA()).toBe(linesBefore);
  });
});
