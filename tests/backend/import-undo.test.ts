import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { TEXTS } from "@/lib/texts";
import { setClockForTests } from "@/server/clock";
import {
  customer,
  file,
  catalogItem,
  importBatch,
  invoice,
  job,
  payment,
  schedulerState,
} from "@/server/db/schema";
import { userDir } from "@/server/files/store";
import { saveCustomer } from "@/server/services/customers";
import { undoBatch } from "@/server/services/import-undo";
import { saveCatalogItem } from "@/server/services/catalog";
import { saveTemplate } from "@/server/services/invoice-templates";
import { newDraftDefaults } from "@/server/services/invoices";
import { addPayment } from "@/server/services/payments";
import { assertConsistent } from "../helpers/consistency";
import { createTestDb } from "../helpers/db";
import { webActor } from "../helpers/fixtures-mail";
import { pdfWithEmbedded } from "../helpers/hostile-files";
import {
  committed,
  editedIsdoc,
  importOwner,
  isdoc,
  parsed,
  registerImportJobs,
} from "../helpers/import";

vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-import-undo-")));

const db = createTestDb();
const NOW = new Date("2026-03-20T10:00:00Z");

beforeAll(() => registerImportJobs());
beforeEach(() => {
  db.delete(job).run();
  db.delete(schedulerState).run();
  setClockForTests({ now: () => NOW });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});
afterEach(() => {
  setClockForTests(null);
  vi.restoreAllMocks();
});

const docs = (owner: string) => db.select().from(invoice).where(eq(invoice.userId, owner)).all();

function existingCustomer(owner: string) {
  return saveCustomer(webActor(owner), {
    name: "Vzorová a. s.",
    street: "",
    city: "",
    zip: "",
    country: "Česká republika",
    ico: "99900025",
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
}

async function importedBatch(owner: string) {
  const paidAdvance = editedIsdoc(
    "zalohova.isdoc",
    "<PayableAmount>10000.00</PayableAmount>",
    "<PayableAmount>0.00</PayableAmount>",
  );
  const { id } = await parsed(owner, [
    { name: "faktura.pdf", bytes: pdfWithEmbedded(isdoc("faktura-czk.isdoc")) },
    { name: "uhrazena.isdoc", bytes: isdoc("uhrazena.isdoc") },
    { name: "dobropis.isdoc", bytes: isdoc("dobropis.isdoc") },
    { name: "zaloha.isdoc", bytes: paidAdvance },
    { name: "konecna.isdoc", bytes: isdoc("konecna-se-zalohou.isdoc") },
  ]);
  expect((await committed(db, owner, id)).status).toBe("done");
  return id;
}

describe("vrácení importu", () => {
  test("[IMP-008] vrácení smaže doklady, platby a nové zákazníky, staré nechá", async () => {
    const owner = importOwner(db, NOW);
    const kept = existingCustomer(owner);
    const id = await importedBatch(owner);
    expect(docs(owner)).toHaveLength(5);
    const pdf = docs(owner).find((row) => row.importPdfFileId)!.importPdfFileId!;
    expect(db.select().from(customer).where(eq(customer.importBatchId, id)).all()).toHaveLength(1);
    assertConsistent(db, owner);

    undoBatch(webActor(owner), id);

    expect(docs(owner)).toEqual([]);
    expect(db.select().from(payment).where(eq(payment.userId, owner)).all()).toEqual([]);
    const customers = db.select().from(customer).where(eq(customer.userId, owner)).all();
    expect(customers.map((row) => row.id)).toEqual([kept]);
    expect(db.select().from(file).where(eq(file.userId, owner)).all()).toEqual([]);
    expect(existsSync(join(userDir(owner), pdf))).toBe(false);
    expect(db.select().from(importBatch).where(eq(importBatch.id, id)).get()).toMatchObject({
      status: "undone",
    });
    assertConsistent(db, owner);
  });

  test("[IMP-008] položka ceníku v šabloně vrácení přežije a dokumenty se nenačtou", async () => {
    const owner = importOwner(db, NOW);
    const id = await importedBatch(owner);
    const item = (name: string) =>
      saveCatalogItem(webActor(owner), {
        name,
        description: "",
        unit: "ks",
        priceMinor: 100,
        currency: "CZK",
        category: "",
        tags: [],
      }).id;
    const used = item("V šabloně");
    const spare = item("Nikde");
    db.update(catalogItem).set({ importBatchId: id }).where(eq(catalogItem.userId, owner)).run();
    const draft = newDraftDefaults(owner, null);
    saveTemplate(webActor(owner), {
      name: "Šablona",
      customerId: null,
      document: {
        ...draft,
        type: "invoice",
        dueDays: 14,
        lines: [
          {
            catalogItemId: used,
            name: "V šabloně",
            description: "",
            quantityMilli: 1000,
            unit: "ks",
            unitPriceMinor: 100,
            discountKind: "none",
            discountValue: 0,
          },
        ],
      },
    });
    const statements = vi.spyOn(db.$client, "prepare");
    undoBatch(webActor(owner), id);
    const texts = statements.mock.calls.map(([text]) => String(text));
    statements.mockRestore();
    const items = db
      .select({ id: catalogItem.id })
      .from(catalogItem)
      .where(eq(catalogItem.userId, owner))
      .all();
    expect(items.map((row) => row.id)).toEqual([used]);
    expect(spare).not.toBe(used);
    // Read by SQLite through json_each, never selected into the process.
    for (const text of texts) {
      expect(text).not.toMatch(/select "document" from "(invoice_template|recurring_invoice)"/i);
    }
  });

  test("[IMP-008] vrácení s ruční platbou je odmítnuté a jmenuje doklad", async () => {
    const owner = importOwner(db, NOW);
    const id = await importedBatch(owner);
    const open = docs(owner).find((row) => row.number === "2026-0001")!;
    addPayment(webActor(owner), open.id, {
      revision: open.revision,
      paidOn: "2026-03-01",
      amountMinor: 1000,
      currency: "CZK",
      method: "transfer",
      note: "",
    });

    expect(() => undoBatch(webActor(owner), id)).toThrow(
      TEXTS.importing.errors.undoPayments("2026-0001"),
    );
    expect(docs(owner)).toHaveLength(5);
    expect(db.select().from(importBatch).where(eq(importBatch.id, id)).get()!.status).toBe("done");
    assertConsistent(db, owner);
  });

  test("vrácení s opravou mimo import je odmítnuté", async () => {
    const owner = importOwner(db, NOW);
    const first = await parsed(owner, [{ name: "a.isdoc", bytes: isdoc("faktura-czk.isdoc") }]);
    await committed(db, owner, first.id);
    const second = await parsed(owner, [{ name: "d.isdoc", bytes: isdoc("dobropis.isdoc") }]);
    await committed(db, owner, second.id);

    expect(() => undoBatch(webActor(owner), first.id)).toThrow(
      TEXTS.importing.errors.undoLinked("2026-0001"),
    );
    undoBatch(webActor(owner), second.id);
    const original = db
      .select()
      .from(invoice)
      .where(and(eq(invoice.userId, owner), eq(invoice.number, "2026-0001")))
      .get()!;
    expect(original.creditsMinor).toBe(0);
    undoBatch(webActor(owner), first.id);
    expect(docs(owner)).toEqual([]);
    assertConsistent(db, owner);
  });
});
