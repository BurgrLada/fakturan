import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, test, vi } from "vitest";
import { auditLog, file, supplier, user } from "@/server/db/schema";
import { DEFAULT_NOT_VAT_PAYER_CS, DEFAULT_NOT_VAT_PAYER_EN } from "@/lib/supplier-defaults";
import { readOwnedFile } from "@/server/services/files";
import {
  clearSupplierImage,
  getSupplier,
  isValidIco,
  missingSupplierFields,
  saveSupplier,
  setSupplierImage,
  supplierInputSchema,
  type SupplierInput,
} from "@/server/services/supplier";
import { assertIsolated } from "../helpers/isolation";
import { createTestDb } from "../helpers/db";

vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-supplier-")));

const db = createTestDb();
const actor = (userId: string) => ({ userId, source: "web" as const });
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 1),
]);

function seed(id: string) {
  const now = new Date();
  db.insert(user)
    .values({ id, name: id, email: `${id}@example.cz`, createdAt: now, updatedAt: now })
    .onConflictDoNothing()
    .run();
}

const input = (over: Partial<SupplierInput> = {}): SupplierInput => ({
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
  notVatPayerCs: DEFAULT_NOT_VAT_PAYER_CS,
  notVatPayerEn: DEFAULT_NOT_VAT_PAYER_EN,
  ...over,
});

const audits = (ownerId: string, action: string) =>
  db
    .select()
    .from(auditLog)
    .where(eq(auditLog.ownerId, ownerId))
    .all()
    .filter((row) => row.action === action);

describe("profil dodavatele", () => {
  test("[SET-010] profil se uloží a audituje", () => {
    seed("s1");

    saveSupplier(actor("s1"), input({ email: "jan@example.cz", phone: "+420 777 123 456" }));

    expect(getSupplier("s1")).toMatchObject({
      name: "Jan Novák",
      ico: "27082440",
      email: "jan@example.cz",
      phone: "+420 777 123 456",
    });
    const [row] = audits("s1", "supplier.save");
    expect(row).toMatchObject({ entity: "supplier", scope: "user" });
    saveSupplier(actor("s1"), input({ name: "Jan Novák OSVČ" }));
    expect(getSupplier("s1")?.name).toBe("Jan Novák OSVČ");
    expect(audits("s1", "supplier.save")).toHaveLength(2);
  });

  test("[SET-010] getSupplier bez profilu vrátí null", () => {
    seed("s2");
    expect(getSupplier("s2")).toBeNull();
  });

  test("[SET-010] IČO se ověřuje kontrolní číslicí", () => {
    expect(isValidIco("27082440")).toBe(true);
    expect(isValidIco("25596641")).toBe(true);
    expect(isValidIco("12345678")).toBe(false);
    expect(isValidIco("2708244")).toBe(false);
    expect(isValidIco("abcdefgh")).toBe(false);
    seed("s3");

    expect(() => saveSupplier(actor("s3"), input({ ico: "12345678" }))).toThrow("IČO");
    expect(getSupplier("s3")).toBeNull();
  });

  test("[SET-011] identifikovaná osoba vyžaduje DIČ", () => {
    seed("s4");

    expect(() => saveSupplier(actor("s4"), input({ vatIdentified: true, dic: "" }))).toThrow("DIČ");
    saveSupplier(actor("s4"), input({ vatIdentified: true, dic: "CZ27082440" }));

    expect(getSupplier("s4")).toMatchObject({ vatIdentified: true, dic: "CZ27082440" });
  });

  test("[SET-012] výchozí text o neplátcovství jde upravit v obou jazycích", () => {
    seed("s5");
    saveSupplier(actor("s5"), input());
    expect(getSupplier("s5")).toMatchObject({
      notVatPayerCs: "Nejsem plátce DPH.",
      notVatPayerEn: "I am not a VAT payer.",
    });

    saveSupplier(
      actor("s5"),
      input({ notVatPayerCs: "Dodavatel není plátce DPH.", notVatPayerEn: "Not a VAT payer." }),
    );

    expect(getSupplier("s5")).toMatchObject({
      notVatPayerCs: "Dodavatel není plátce DPH.",
      notVatPayerEn: "Not a VAT payer.",
    });
  });

  test("[SET-012] výchozí text patičky se uloží", () => {
    seed("s6");
    saveSupplier(actor("s6"), input({ footerText: "Děkuji za spolupráci." }));
    expect(getSupplier("s6")?.footerText).toBe("Děkuji za spolupráci.");
  });

  test("missingSupplierFields vrátí chybějící údaje", () => {
    seed("s7");
    expect(missingSupplierFields("s7")).toEqual([
      "Jméno nebo firma",
      "Ulice",
      "Město",
      "PSČ",
      "Stát",
      "IČO",
    ]);

    saveSupplier(actor("s7"), input());
    expect(missingSupplierFields("s7")).toEqual([]);

    setSupplierImage(actor("s7"), "logo", PNG, "logo.png");
    expect(missingSupplierFields("s7")).toEqual([]);
  });

  test("[SET-010] schéma vstupu odmítne neplatná data", () => {
    expect(supplierInputSchema.safeParse(input()).success).toBe(true);
    expect(supplierInputSchema.safeParse({ ...input(), name: "" }).success).toBe(false);
    expect(supplierInputSchema.safeParse({ ...input(), name: "x".repeat(300) }).success).toBe(
      false,
    );
    expect(supplierInputSchema.safeParse({ ...input(), email: "ne-email" }).success).toBe(false);
    expect(supplierInputSchema.safeParse({ ...input(), vatIdentified: "ano" }).success).toBe(false);
    expect(supplierInputSchema.safeParse({ ...input(), ico: "1234" }).success).toBe(false);
  });

  test("[SET-010] izolace profilu", async () => {
    const marker = (id: string) => `Změněno ${id}`;
    await assertIsolated<string>({
      create: (ownerId) => {
        seed(ownerId);
        saveSupplier(actor(ownerId), input({ name: `Firma ${ownerId}` }));
        setSupplierImage(actor(ownerId), "logo", PNG, "logo.png");
        return ownerId;
      },
      find: (ownerId, id) => {
        const row = getSupplier(ownerId);
        return row?.userId === id && row.logoFileId ? row : null;
      },
      update: (ownerId, id) => {
        saveSupplier(actor(ownerId), input({ name: marker(id) }));
        return getSupplier(id)?.name === marker(id) ? 1 : 0;
      },
      remove: (ownerId, id) => {
        const had = getSupplier(id)?.logoFileId;
        clearSupplierImage(actor(ownerId), "logo");
        return had && !getSupplier(id)?.logoFileId ? 1 : 0;
      },
    });
  });
});

describe("logo a podpis", () => {
  test("[SET-014] logo, logo do QR a podpis se uloží přes storeFile a jdou nahradit", () => {
    seed("f1");
    setSupplierImage(actor("f1"), "logo", PNG, "logo.png");
    setSupplierImage(actor("f1"), "qr_logo", PNG, "qr.png");

    const first = getSupplier("f1");
    expect(first?.logoFileId).toBeTruthy();
    expect(first?.qrLogoFileId).toBeTruthy();
    expect(first?.signatureFileId).toBeNull();
    expect(readOwnedFile(actor("f1"), first!.logoFileId!).mimeType).toBe("image/png");

    setSupplierImage(actor("f1"), "logo", PNG, "novy.png");

    const second = getSupplier("f1");
    expect(second?.logoFileId).not.toBe(first?.logoFileId);
    expect(db.select().from(file).where(eq(file.id, first!.logoFileId!)).all()).toEqual([]);
  });

  test("[SET-013] podpis se nahraje a odebere", () => {
    seed("f2");
    setSupplierImage(actor("f2"), "signature", PNG, "podpis.png");
    const id = getSupplier("f2")?.signatureFileId;
    expect(id).toBeTruthy();

    clearSupplierImage(actor("f2"), "signature");

    expect(getSupplier("f2")?.signatureFileId).toBeNull();
    expect(db.select().from(file).where(eq(file.id, id!)).all()).toEqual([]);
  });

  test("[SET-014] neplatný obrázek profil nezmění", () => {
    seed("f3");
    expect(() => setSupplierImage(actor("f3"), "logo", Buffer.from("<html>"), "a.png")).toThrow();
    expect(getSupplier("f3")).toBeNull();
  });

  test("[SET-013] uložení profilu nepřepíše nahraný obrázek", () => {
    seed("f4");
    setSupplierImage(actor("f4"), "signature", PNG, "podpis.png");
    const id = getSupplier("f4")?.signatureFileId;

    saveSupplier(actor("f4"), input());

    expect(getSupplier("f4")?.signatureFileId).toBe(id);
    expect(
      db
        .select()
        .from(supplier)
        .all()
        .some((r) => r.userId === "f4"),
    ).toBe(true);
  });
});
