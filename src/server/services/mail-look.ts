import "server-only";
import sharp from "sharp";
import {
  DEFAULT_MAIL_LAYOUT,
  mailLookSchema,
  type MailLayout,
  type MailLogoMode,
} from "@/lib/mail-look";
import { isHexColor } from "@/lib/contrast";
import { TEXTS } from "@/lib/texts";
import { renderEmailHtml } from "../mail/html/render";
import { getDesign } from "../pdf/designs";
import { qrPng } from "../pdf/qr";
import type { Actor } from "../audit/context";
import { clock } from "../clock";
import { db } from "../db";
import { mailLook, supplier } from "../db/schema";
import { scoped } from "../db/scoped";
import { ServiceError } from "./access";
import { deleteFile, FileNotFoundError, readOwnedFile, storeFile } from "./files";
import { mutate } from "./mutation";
import { getPreferences } from "./preferences";

const E = TEXTS.mailLook.errors;

export type MailLook = {
  layout: MailLayout;
  intro: string | null;
  signature: string | null;
  logoMode: MailLogoMode;
  logoFileId: string | null;
};

const LOGO_BOX = { width: 600, height: 200 };
const SVG_DENSITY = 216;

function ownerOf(actor: Actor): string {
  if (!actor.userId) throw new ServiceError(TEXTS.invoiceMail.errors.forbidden);
  return actor.userId;
}

export function getMailLook(ownerId: string): MailLook {
  const row = db.select().from(mailLook).where(scoped(ownerId).where(mailLook)).get();
  return {
    layout: row?.layout ?? DEFAULT_MAIL_LAYOUT,
    intro: row?.intro ?? null,
    signature: row?.signature ?? null,
    logoMode: row?.logoMode ?? "supplier",
    logoFileId: row?.logoFileId ?? null,
  };
}

export function saveMailLook(actor: Actor, raw: unknown): MailLook {
  const userId = ownerOf(actor);
  const parsed = mailLookSchema.safeParse(raw);
  if (!parsed.success) throw new ServiceError(parsed.error.issues[0]?.message ?? E.invalid);
  const input = parsed.data;
  mutate(actor, "mail_look.save", (tx, audit) => {
    const now = clock.now();
    tx.insert(mailLook)
      .values({ userId, ...input, updatedAt: now })
      .onConflictDoUpdate({ target: mailLook.userId, set: { ...input, updatedAt: now } })
      .run();
    audit({
      entity: "mail_look",
      entityId: userId,
      ownerId: userId,
      scope: "user",
      after: {
        layout: input.layout,
        logoMode: input.logoMode,
        intro: input.intro !== null,
        signature: input.signature !== null,
      },
    });
  });
  return getMailLook(userId);
}

function dropFile(actor: Actor, id: string | null): void {
  if (!id) return;
  try {
    deleteFile(actor, id);
  } catch (error) {
    if (!(error instanceof FileNotFoundError)) throw error;
  }
}

// Uploading a logo also chooses it: nobody uploads one to keep using another.
export function setMailLogo(actor: Actor, data: Buffer, name: string): void {
  const userId = ownerOf(actor);
  const { id } = storeFile(actor, "mail_logo", data, name);
  let previous: string | null;
  try {
    previous = mutate(actor, "mail_look.logo_set", (tx, audit) => {
      const old = tx.select().from(mailLook).where(scoped(userId).where(mailLook)).get();
      const now = clock.now();
      tx.insert(mailLook)
        .values({ userId, logoMode: "custom", logoFileId: id, updatedAt: now })
        .onConflictDoUpdate({
          target: mailLook.userId,
          set: { logoMode: "custom", logoFileId: id, updatedAt: now },
        })
        .run();
      audit({
        entity: "mail_look",
        entityId: userId,
        ownerId: userId,
        scope: "user",
        after: { fileId: id, previousFileId: old?.logoFileId ?? null },
      });
      return old?.logoFileId ?? null;
    });
  } catch (error) {
    dropFile(actor, id);
    throw error;
  }
  dropFile(actor, previous);
}

export function clearMailLogo(actor: Actor): void {
  const userId = ownerOf(actor);
  const previous = mutate(actor, "mail_look.logo_clear", (tx, audit) => {
    const old = tx.select().from(mailLook).where(scoped(userId).where(mailLook)).get();
    if (!old?.logoFileId) throw new ServiceError(E.noLogo);
    tx.update(mailLook)
      .set({
        logoFileId: null,
        logoMode: old.logoMode === "custom" ? "supplier" : old.logoMode,
        updatedAt: clock.now(),
      })
      .where(scoped(userId).where(mailLook))
      .run();
    audit({
      entity: "mail_look",
      entityId: userId,
      ownerId: userId,
      scope: "user",
      before: { fileId: old.logoFileId },
    });
    return old.logoFileId;
  });
  dropFile(actor, previous);
}

function logoFileOf(ownerId: string, look: MailLook): string | null {
  if (look.logoMode === "none") return null;
  if (look.logoMode === "custom") return look.logoFileId;
  return (
    db
      .select({ id: supplier.logoFileId })
      .from(supplier)
      .where(scoped(ownerId).where(supplier))
      .get()?.id ?? null
  );
}

// Stored images are already validated and SVG sanitized; a mail client gets PNG only (SEC-005).
export async function emailLogoPng(data: Buffer): Promise<Buffer | null> {
  try {
    return await sharp(data, { density: SVG_DENSITY })
      .rotate()
      .resize({ ...LOGO_BOX, fit: "inside", withoutEnlargement: true })
      .toColourspace("srgb")
      .png()
      .toBuffer();
  } catch {
    return null;
  }
}

export async function mailLogo(ownerId: string, look: MailLook): Promise<Buffer | null> {
  const id = logoFileOf(ownerId, look);
  if (!id) return null;
  try {
    return await emailLogoPng(readOwnedFile({ userId: ownerId, source: "system" }, id).data);
  } catch (error) {
    if (error instanceof FileNotFoundError) return null;
    throw error;
  }
}

const SAMPLE_QR = "SPD*1.0*ACC:CZ6508000000192000145399*AM:12100.00*CC:CZK*X-VS:2026040";

// Settings preview: the account's own name, logo and texts around a sample invoice. Images go in
// as data: URIs, since a browser has no cid: to resolve.
export async function mailLookPreview(ownerId: string, layout: MailLayout): Promise<string> {
  const look = getMailLook(ownerId);
  const S = TEXTS.mailLook.sample;
  const party = db
    .select({ name: supplier.name, ico: supplier.ico })
    .from(supplier)
    .where(scoped(ownerId).where(supplier))
    .get();
  const accent = getDesign(getPreferences(ownerId).designId).tokens.colors.accent;
  const out = renderEmailHtml({
    layout,
    kind: "invoice",
    language: "cs",
    body: S.body,
    intro: look.intro,
    signature: look.signature,
    supplierName: party?.name || S.supplier,
    supplierIco: party?.ico || null,
    logo: await mailLogo(ownerId, look),
    accent: isHexColor(accent) ? accent : null,
    attachment: "2026-040.pdf",
    summary: {
      title: "Faktura 2026-040",
      number: "2026-040",
      amountDue: 1_210_000,
      currency: "CZK",
      dueDate: "14. 11. 2026",
      variableSymbol: "2026040",
      account: "19-2000145399/0800",
    },
    qr: await qrPng(SAMPLE_QR, null),
  });
  let html = out.html;
  for (const image of out.images) {
    html = html.replaceAll(
      `cid:${image.cid}`,
      `data:image/png;base64,${image.png.toString("base64")}`,
    );
  }
  return html;
}
