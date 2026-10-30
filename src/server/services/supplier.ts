import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { isValidIco } from "@/lib/ico";
import type { Actor } from "../audit/context";
import { clock } from "../clock";
import { db } from "../db";
import { supplier } from "../db/schema";
import { scoped } from "../db/scoped";
import { ServiceError } from "./access";
import { deleteFile, storeFile, type FileKind } from "./files";
import { mutate } from "./mutation";

export { isValidIco };

export const DEFAULT_NOT_VAT_PAYER_CS = "Nejsem plátce DPH.";
export const DEFAULT_NOT_VAT_PAYER_EN = "I am not a VAT payer.";

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
    ico: z.string().trim().refine(isValidIco, "IČO není platné"),
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
  })
  .superRefine((value, ctx) => {
    const required = [
      ["name", "Vyplňte jméno nebo firmu"],
      ["street", "Vyplňte ulici"],
      ["city", "Vyplňte město"],
      ["zip", "Vyplňte PSČ"],
      ["country", "Vyplňte stát"],
    ] as const;
    for (const [path, message] of required) {
      if (!value[path]) ctx.addIssue({ code: "custom", path: [path], message });
    }
    if (value.vatIdentified && !value.dic) {
      ctx.addIssue({
        code: "custom",
        path: ["dic"],
        message: "Identifikovaná osoba k DPH musí mít vyplněné DIČ",
      });
    }
  });

export type SupplierInput = z.infer<typeof supplierInputSchema>;

const REQUIRED_LABELS = [
  ["name", "Jméno nebo firma"],
  ["street", "Ulice"],
  ["city", "Město"],
  ["zip", "PSČ"],
  ["country", "Stát"],
  ["ico", "IČO"],
] as const;

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

export function missingSupplierFields(ownerId: string): string[] {
  const profile = getSupplier(ownerId);
  return REQUIRED_LABELS.filter(([key]) => !profile?.[key]?.trim()).map(([, label]) => label);
}

export function saveSupplier(actor: Actor, raw: SupplierInput): void {
  const userId = ownerOf(actor);
  const parsed = supplierInputSchema.safeParse(raw);
  if (!parsed.success) throw new ServiceError(parsed.error.issues[0]?.message ?? "Neplatné údaje");
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
        after: { image: kind },
      });
      return old;
    });
  } catch (error) {
    deleteFile(actor, id);
    throw error;
  }
  if (previous) deleteFile(actor, previous);
}

export function clearSupplierImage(actor: Actor, kind: SupplierImageKind): void {
  const userId = ownerOf(actor);
  const column = IMAGE_COLUMN[kind];
  const previous = mutate(actor, "supplier.image_clear", (tx, audit) => {
    const old =
      tx.select().from(supplier).where(scoped(userId).where(supplier)).get()?.[column] ?? null;
    if (!old) throw new ServiceError("Obrázek není nahraný");
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
  deleteFile(actor, previous);
}
