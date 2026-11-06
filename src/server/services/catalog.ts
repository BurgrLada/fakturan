import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { CURRENCIES } from "@/lib/currency";
import { foldText } from "@/lib/fold-text";
import { TEXTS } from "@/lib/texts";
import type { Actor } from "../audit/context";
import { clock } from "../clock";
import { db, type Tx } from "../db";
import { czech } from "../db/collation";
import { catalogItem, unit } from "../db/schema";
import { scoped } from "../db/scoped";
import { ServiceError, type Reader } from "./access";
import type { Page } from "./audit-read";
import { mutate, type Audit } from "./mutation";

const V = TEXTS.catalog.validation;

export type CatalogItem = typeof catalogItem.$inferSelect;
export type Unit = { id: string | null; name: string };
export type CatalogStatus = "active" | "archived" | "all";
export type CatalogSort = "name" | "usage";

export const DEFAULT_UNITS = ["hod.", "ks", "den", "měsíc", "projekt"] as const;

export const MAX_PRICE_MINOR = 99_999_999_999_99;

const text = (max: number) => z.string(V.invalid).trim().max(max, V.tooLong);

export const catalogInputSchema = z.object({
  id: z.string(V.invalid).min(1, V.invalid).optional(),
  name: text(200).min(1, V.name),
  description: text(2000),
  unit: z.string(V.unit).trim().min(1, V.unit).max(20, V.unitTooLong),
  priceMinor: z.number(V.price).int(V.price).min(0, V.price).max(MAX_PRICE_MINOR, V.price),
  currency: z.enum(CURRENCIES, V.currency),
  category: text(60),
  tags: z
    .array(text(30).min(1, V.invalid), V.invalid)
    .max(10, V.tooLong)
    .transform((list) => list.filter((v, i) => list.indexOf(v) === i)),
});

export type CatalogInput = z.input<typeof catalogInputSchema>;

export const unitNameSchema = z.string(V.unitName).trim().min(1, V.unitName).max(20, V.unitTooLong);

export type CatalogFilter = {
  q?: string;
  category?: string;
  status?: CatalogStatus;
  sort?: CatalogSort;
  page?: number;
  pageSize?: number;
};

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

const URL_STATUS: Record<string, CatalogStatus> = { archivovane: "archived", vsechny: "all" };

// Query strings are untrusted: anything that does not fit is dropped, not rejected.
export function parseCatalogFilter(
  raw: Record<string, string | string[] | undefined>,
): CatalogFilter {
  const one = (key: string) => {
    const value = raw[key];
    return Array.isArray(value) ? value[0] : value;
  };
  const filter: CatalogFilter = {};
  const q = one("q")?.trim().slice(0, 100);
  if (q) filter.q = q;
  const category = one("kategorie")?.trim().slice(0, 60);
  if (category) filter.category = category;
  const status = URL_STATUS[one("stav") ?? ""];
  if (status) filter.status = status;
  if (one("razeni") === "pouziti") filter.sort = "usage";
  const page = Number(one("strana"));
  if (Number.isInteger(page) && page > 1 && page <= 100_000) filter.page = page;
  return filter;
}

function ownerOf(actor: Actor): string {
  if (!actor.userId) throw new ServiceError(V.forbidden);
  return actor.userId;
}

function readOwned(q: Reader, ownerId: string, id: string): CatalogItem | null {
  return (
    q
      .select()
      .from(catalogItem)
      .where(scoped(ownerId).where(catalogItem, (t, { eq }) => eq(t.id, id)))
      .get() ?? null
  );
}

function findOwned(q: Reader, ownerId: string, id: string): CatalogItem {
  const row = readOwned(q, ownerId, id);
  if (!row) throw new ServiceError(V.notFound);
  return row;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// Accents and case are folded away on both sides, because SQLite LIKE only ignores ASCII case.
function searchTextOf(v: Pick<CatalogItem, "name" | "description" | "category" | "tags">): string {
  return foldText([v.name, v.description, v.category, ...v.tags].join("\n"));
}

function matches(q: string): SQL {
  return sql`${catalogItem.searchText} LIKE ${`%${escapeLike(foldText(q))}%`} ESCAPE '\\'`;
}

function snapshot(row: CatalogItem) {
  const { userId: _u, createdAt: _c, updatedAt: _t, searchText: _s, ...rest } = row;
  return rest;
}

function conditions(ownerId: string, filter: CatalogFilter): SQL {
  const status = filter.status ?? "active";
  return scoped(ownerId).where(catalogItem, (t) =>
    and(
      status === "active" ? isNull(t.archivedAt) : undefined,
      status === "archived" ? isNotNull(t.archivedAt) : undefined,
      filter.category ? eq(t.category, filter.category) : undefined,
      filter.q ? matches(filter.q) : undefined,
    ),
  );
}

const byUsage = [desc(catalogItem.useCount), asc(czech(catalogItem.name)), asc(catalogItem.id)];
const byName = [asc(czech(catalogItem.name)), asc(catalogItem.id)];

export function listCatalog(ownerId: string, filter: CatalogFilter): Page<CatalogItem> {
  const page = Math.max(1, Math.floor(filter.page ?? 1));
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, filter.pageSize ?? DEFAULT_PAGE_SIZE));
  const rows = db
    .select()
    .from(catalogItem)
    .where(conditions(ownerId, filter))
    .orderBy(...(filter.sort === "usage" ? byUsage : byName))
    .limit(pageSize + 1)
    .offset((page - 1) * pageSize)
    .all();
  return { rows: rows.slice(0, pageSize), page, pageSize, hasNext: rows.length > pageSize };
}

export function getCatalogItem(ownerId: string, id: string): CatalogItem | null {
  return readOwned(db, ownerId, id);
}

// Picker for the invoice editor: the most used items come first.
export function searchCatalog(ownerId: string, q: string, limit: number): CatalogItem[] {
  const term = q.trim();
  return db
    .select()
    .from(catalogItem)
    .where(conditions(ownerId, { q: term || undefined }))
    .orderBy(...byUsage)
    .limit(Math.min(MAX_PAGE_SIZE, Math.max(1, limit)))
    .all();
}

export function listCategories(ownerId: string): string[] {
  return db
    .selectDistinct({ category: catalogItem.category })
    .from(catalogItem)
    .where(scoped(ownerId).where(catalogItem, (t, { and }) => and(sql`${t.category} <> ''`)))
    .orderBy(asc(czech(catalogItem.category)))
    .all()
    .map((row) => row.category);
}

// Defaults are written inside the first write, never while a page renders; until then listUnits
// reports them without ids.
function ensureDefaultUnits(tx: Tx, ownerId: string, audit: Audit): void {
  const existing = tx
    .select({ id: unit.id })
    .from(unit)
    .where(scoped(ownerId).where(unit))
    .limit(1)
    .get();
  if (existing) return;
  const now = clock.now();
  DEFAULT_UNITS.forEach((name, position) => {
    tx.insert(unit)
      .values({ id: randomUUID(), userId: ownerId, name, position, createdAt: now })
      .run();
  });
  audit({
    action: "unit.seed",
    entity: "unit",
    entityId: null,
    ownerId,
    scope: "user",
    after: { names: [...DEFAULT_UNITS] },
  });
}

export type CatalogValues = z.output<typeof catalogInputSchema>;

export function parseCatalogInput(raw: CatalogInput): CatalogValues {
  const parsed = catalogInputSchema.safeParse(raw);
  if (!parsed.success) throw new ServiceError(parsed.error.issues[0]?.message ?? V.invalid);
  return parsed.data;
}

// The write inside a caller's transaction; an import passes its batch, which only a new row takes.
export function saveCatalogItemIn(
  tx: Tx,
  audit: Audit,
  userId: string,
  parsed: CatalogValues,
  importBatchId: string | null = null,
): { id: string } {
  const { id: existingId, ...values } = parsed;
  ensureDefaultUnits(tx, userId, audit);
  const before = existingId ? findOwned(tx, userId, existingId) : null;
  const id = before?.id ?? randomUUID();
  const now = clock.now();
  const searchText = searchTextOf(values);
  if (before) {
    tx.update(catalogItem)
      .set({ ...values, searchText, updatedAt: now })
      .where(and(eq(catalogItem.id, id), eq(catalogItem.userId, userId)))
      .run();
  } else {
    tx.insert(catalogItem)
      .values({
        id,
        userId,
        ...values,
        searchText,
        ...(importBatchId ? { importBatchId } : {}),
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }
  audit({
    entity: "catalog_item",
    entityId: id,
    ownerId: userId,
    scope: "user",
    before: before && snapshot(before),
    after: snapshot(findOwned(tx, userId, id)),
  });
  return { id };
}

export function saveCatalogItem(actor: Actor, raw: CatalogInput): { id: string } {
  const userId = ownerOf(actor);
  const parsed = parseCatalogInput(raw);
  return mutate(actor, "catalog_item.save", (tx, audit) =>
    saveCatalogItemIn(tx, audit, userId, parsed),
  );
}

function setArchived(actor: Actor, id: string, archived: boolean): void {
  const userId = ownerOf(actor);
  mutate(actor, archived ? "catalog_item.archive" : "catalog_item.restore", (tx, audit) => {
    const row = findOwned(tx, userId, id);
    const archivedAt = archived ? clock.now() : null;
    tx.update(catalogItem)
      .set({ archivedAt, updatedAt: clock.now() })
      .where(and(eq(catalogItem.id, id), eq(catalogItem.userId, userId)))
      .run();
    audit({
      entity: "catalog_item",
      entityId: id,
      ownerId: userId,
      scope: "user",
      before: { archivedAt: row.archivedAt },
      after: { archivedAt },
    });
  });
}

export function archiveCatalogItem(actor: Actor, id: string): void {
  setArchived(actor, id, true);
}

export function restoreCatalogItem(actor: Actor, id: string): void {
  setArchived(actor, id, false);
}

// Runs inside the caller's transaction (issuing a document), so it writes no audit entry of its own.
export function recordCatalogUse(tx: Tx, ownerId: string, id: string): void {
  const { changes } = tx
    .update(catalogItem)
    .set({ useCount: sql`${catalogItem.useCount} + 1` })
    .where(and(eq(catalogItem.id, id), eq(catalogItem.userId, ownerId)))
    .run();
  if (changes === 0) throw new ServiceError(V.notFound);
}

export function listUnits(ownerId: string): Unit[] {
  const rows = db
    .select({ id: unit.id, name: unit.name })
    .from(unit)
    .where(scoped(ownerId).where(unit))
    .orderBy(asc(unit.position), asc(unit.name))
    .all();
  return rows.length > 0 ? rows : DEFAULT_UNITS.map((name) => ({ id: null, name }));
}

export function saveUnit(actor: Actor, rawName: string): { id: string } {
  const userId = ownerOf(actor);
  const parsed = unitNameSchema.safeParse(rawName);
  if (!parsed.success) throw new ServiceError(parsed.error.issues[0]?.message ?? V.invalid);
  const name = parsed.data;

  return mutate(actor, "unit.save", (tx, audit) => {
    ensureDefaultUnits(tx, userId, audit);
    const rows = tx.select().from(unit).where(scoped(userId).where(unit)).all();
    if (rows.some((row) => foldText(row.name) === foldText(name))) {
      throw new ServiceError(V.unitExists);
    }
    const id = randomUUID();
    const position = rows.reduce((max, row) => Math.max(max, row.position), -1) + 1;
    tx.insert(unit).values({ id, userId, name, position, createdAt: clock.now() }).run();
    audit({ entity: "unit", entityId: id, ownerId: userId, scope: "user", after: { name } });
    return { id };
  });
}

export function deleteUnit(actor: Actor, id: string): void {
  const userId = ownerOf(actor);
  mutate(actor, "unit.delete", (tx, audit) => {
    const row = tx
      .select()
      .from(unit)
      .where(scoped(userId).where(unit, (t, { eq }) => eq(t.id, id)))
      .get();
    if (!row) throw new ServiceError(V.unitNotFound);
    tx.delete(unit)
      .where(and(eq(unit.id, id), eq(unit.userId, userId)))
      .run();
    audit({
      entity: "unit",
      entityId: id,
      ownerId: userId,
      scope: "user",
      before: { name: row.name },
    });
  });
}
