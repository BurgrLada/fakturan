import "server-only";
import { eq, or, sql } from "drizzle-orm";
import { z } from "zod";
import { REVERSE_CHARGE_CLAUSE } from "@/lib/clauses";
import { isValidIco } from "@/lib/ico";
import type { ClauseDefaults } from "@/lib/invoice-form";
import { TEXTS } from "@/lib/texts";
import type { Actor } from "../audit/context";
import { clock } from "../clock";
import { db } from "../db";
import { invoice, invoiceVersion, supplier } from "../db/schema";
import { scoped } from "../db/scoped";
import { logger } from "../logger";
import { ServiceError } from "./access";
import { deleteFile, storeFile, type FileKind } from "./files";
import { mutate } from "./mutation";

export { isValidIco };

export type SupplierProfile = typeof supplier.$inferSelect;
export type SupplierImageKind = Extract<FileKind, "logo" | "qr_logo" | "signature">;

const text = (max: number) => z.string().trim().max(max);

export const supplierInputSchema = z
  .object({
    name: text(200),
    street: text(200),
    city: text(100),
    zip: text(20),
    country: text(100),
    ico: z.string().trim().refine(isValidIco, TEXTS.supplier.validation.invalidIco),
    dic: text(20),
    email: z.union([z.literal(""), z.email().max(254)]),
    phone: text(40),
    web: text(200),
    registryNote: text(500),
    contactPerson: text(200),
    vatIdentified: z.boolean(),
    footerText: text(1000),
    notVatPayerCs: text(300),
    notVatPayerEn: text(300),
    reverseChargeCs: text(300).default(REVERSE_CHARGE_CLAUSE.cs),
    reverseChargeEn: text(300).default(REVERSE_CHARGE_CLAUSE.en),
  })
  .superRefine((value, ctx) => {
    for (const path of ["name", "street", "city", "zip", "country"] as const) {
      if (!value[path]) {
        ctx.addIssue({ code: "custom", path: [path], message: TEXTS.supplier.validation[path] });
      }
    }
    if (value.vatIdentified && !value.dic) {
      ctx.addIssue({
        code: "custom",
        path: ["dic"],
        message: TEXTS.supplier.validation.dic,
      });
    }
  });

export type SupplierInput = z.input<typeof supplierInputSchema>;

const REQUIRED_FIELDS = ["name", "street", "city", "zip", "country", "ico"] as const;

export type SupplierField = (typeof REQUIRED_FIELDS)[number];

const IMAGE_COLUMN = {
  logo: "logoFileId",
  qr_logo: "qrLogoFileId",
  signature: "signatureFileId",
} as const;

function ownerOf(actor: Actor): string {
  if (!actor.userId) throw new ServiceError("Na tuto akci nemáte oprávnění");
  return actor.userId;
}

export function getSupplier(ownerId: string): SupplierProfile | null {
  return db.select().from(supplier).where(scoped(ownerId).where(supplier)).get() ?? null;
}

export function clauseDefaultsOf(ownerId: string): Omit<ClauseDefaults, "customerDic"> {
  const profile = getSupplier(ownerId);
  return {
    vatIdentified: profile?.vatIdentified ?? false,
    texts: {
      cs: profile?.reverseChargeCs ?? REVERSE_CHARGE_CLAUSE.cs,
      en: profile?.reverseChargeEn ?? REVERSE_CHARGE_CLAUSE.en,
    },
  };
}

export function missingSupplierKeys(ownerId: string): SupplierField[] {
  const profile = getSupplier(ownerId);
  return REQUIRED_FIELDS.filter((key) => !profile?.[key]?.trim());
}

export function missingSupplierFields(ownerId: string): string[] {
  return missingSupplierKeys(ownerId).map((key) => TEXTS.supplier.required[key]);
}

export function saveSupplier(actor: Actor, raw: SupplierInput): void {
  const userId = ownerOf(actor);
  const parsed = supplierInputSchema.safeParse(raw);
  if (!parsed.success)
    throw new ServiceError(parsed.error.issues[0]?.message ?? TEXTS.supplier.validation.invalid);
  const values = parsed.data;
  mutate(actor, "supplier.save", (tx, audit) => {
    const before = tx.select().from(supplier).where(scoped(userId).where(supplier)).get();
    tx.insert(supplier)
      .values({ userId, ...values, updatedAt: clock.now() })
      .onConflictDoUpdate({
        target: supplier.userId,
        set: { ...values, updatedAt: clock.now() },
      })
      .run();
    audit({
      entity: "supplier",
      entityId: userId,
      ownerId: userId,
      scope: "user",
      before,
      after: values,
    });
  });
}

export function setSupplierImage(
  actor: Actor,
  kind: SupplierImageKind,
  data: Buffer,
  name: string,
): void {
  const userId = ownerOf(actor);
  const column = IMAGE_COLUMN[kind];
  const { id } = storeFile(actor, kind, data, name);
  let previous: string | null;
  try {
    previous = mutate(actor, "supplier.image_set", (tx, audit) => {
      const old =
        tx.select().from(supplier).where(scoped(userId).where(supplier)).get()?.[column] ?? null;
      tx.insert(supplier)
        .values({ userId, [column]: id, updatedAt: clock.now() })
        .onConflictDoUpdate({
          target: supplier.userId,
          set: { [column]: id, updatedAt: clock.now() },
        })
        .run();
      audit({
        entity: "supplier",
        entityId: userId,
        ownerId: userId,
        scope: "user",
        after: { image: kind, fileId: id, previousFileId: old },
      });
      return old;
    });
  } catch (error) {
    deleteFile(actor, id);
    throw error;
  }
  discardFile(actor, previous);
}

export function clearSupplierImage(actor: Actor, kind: SupplierImageKind): void {
  const userId = ownerOf(actor);
  const column = IMAGE_COLUMN[kind];
  const previous = mutate(actor, "supplier.image_clear", (tx, audit) => {
    const old =
      tx.select().from(supplier).where(scoped(userId).where(supplier)).get()?.[column] ?? null;
    if (!old) throw new ServiceError(TEXTS.supplier.validation.noImage);
    tx.update(supplier)
      .set({ [column]: null, updatedAt: clock.now() })
      .where(eq(supplier.userId, userId))
      .run();
    audit({
      entity: "supplier",
      entityId: userId,
      ownerId: userId,
      scope: "user",
      before: { image: kind },
    });
    return old;
  });
  discardFile(actor, previous);
}

// A version can be restored at any time, so the files it names must outlive the profile's use.
function isUsedByVersion(ownerId: string, id: string): boolean {
  return !!db
    .select({ id: invoiceVersion.id })
    .from(invoiceVersion)
    .where(
      scoped(ownerId).where(invoiceVersion, (t) =>
        or(
          ...Object.values(IMAGE_COLUMN).map(
            (key) => sql`json_extract(${t.document}, ${`$.images.${key}`}) = ${id}`,
          ),
        ),
      ),
    )
    .get();
}

function isUsedByInvoice(ownerId: string, id: string): boolean {
  const onInvoice = db
    .select({ id: invoice.id })
    .from(invoice)
    .where(
      scoped(ownerId).where(invoice, (t) =>
        or(eq(t.logoFileId, id), eq(t.qrLogoFileId, id), eq(t.signatureFileId, id)),
      ),
    )
    .get();
  return !!onInvoice || isUsedByVersion(ownerId, id);
}

// The swap is already committed, so a leftover file must not turn it into a failure. Checking after
// the commit is safe: issuing reads the profile, which no longer points at this file.
function discardFile(actor: Actor, id: string | null): void {
  if (!id) return;
  try {
    if (!isUsedByInvoice(ownerOf(actor), id)) deleteFile(actor, id);
  } catch (error) {
    logger.warn("Starý obrázek dodavatele se nepodařilo smazat", { fileId: id, error });
  }
}
