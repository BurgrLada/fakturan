import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, eq, isNotNull, isNull, ne, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { CURRENCIES } from "@/lib/currency";
import {
  canonicalCountry,
  DOMESTIC_COUNTRY,
  isDomesticCountry,
  type CustomerStatus,
} from "@/lib/customers";
import { foldText } from "@/lib/fold-text";
import { isValidIco } from "@/lib/ico";
import { LANGUAGES, type Preferences } from "@/lib/preferences";
import { TEXTS } from "@/lib/texts";
import type { Actor } from "../audit/context";
import { clock } from "../clock";
import { db } from "../db";
import { customer } from "../db/schema";
import { scoped } from "../db/scoped";
import { lookupVies, splitVatId, type ViesState } from "../external/vies";
import { RATE_RULES } from "../rate-limit";
import { enforceRateLimit, ServiceError, type Reader } from "./access";
import type { Page } from "./audit-read";
import { mutate } from "./mutation";

const V = TEXTS.customers.validation;

export type Customer = typeof customer.$inferSelect;

const text = (max: number) => z.string(V.invalid).trim().max(max, V.tooLong);
const optionalEmail = text(200).refine((v) => v === "" || z.email().safeParse(v).success, V.email);

export const customerInputSchema = z
  .object({
    id: z.string(V.invalid).min(1, V.invalid).optional(),
    name: text(200).min(1, V.name),
    street: text(200),
    city: text(100),
    zip: text(20),
    country: text(60).transform(canonicalCountry),
    ico: text(20).transform((v) => v.replace(/\s+/g, "")),
    dic: text(24).transform((v) => v.replace(/\s+/g, "").toUpperCase()),
    email: optionalEmail,
    extraEmails: z
      .array(text(200).pipe(z.email(V.email)), V.invalid)
      .max(10, V.tooLong)
      .transform((list) => list.filter((v, i) => list.indexOf(v) === i)),
    phone: text(40),
    note: text(2000),
    dueDays: z.number(V.dueDays).int(V.dueDays).min(0, V.dueDays).max(365, V.dueDays).nullable(),
    language: z.enum(LANGUAGES, V.language).nullable(),
    currency: z.enum(CURRENCIES, V.currency).nullable(),
    designId: z
      .string(V.designId)
      .trim()
      .regex(/^[a-z0-9-]{1,40}$/, V.designId)
      .nullable(),
    remindersEnabled: z.boolean(V.invalid).nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.ico && isDomesticCountry(value.country) && !isValidIco(value.ico)) {
      ctx.addIssue({ code: "custom", path: ["ico"], message: V.ico });
    }
  });

export type CustomerInput = z.input<typeof customerInputSchema>;

export type CustomerFilter = {
  q?: string;
  foreign?: boolean;
  status?: CustomerStatus;
  page?: number;
  pageSize?: number;
};

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

const URL_STATUS: Record<string, CustomerStatus> = {
  archivovani: "archived",
  vsichni: "all",
};

// Query strings are untrusted: anything that does not fit is dropped, not rejected.
export function parseCustomerFilter(
  raw: Record<string, string | string[] | undefined>,
): CustomerFilter {
  const one = (key: string) => {
    const value = raw[key];
    return Array.isArray(value) ? value[0] : value;
  };
  const filter: CustomerFilter = {};
  const q = one("q")?.trim().slice(0, 100);
  if (q) filter.q = q;
  if (one("zahranici") === "1") filter.foreign = true;
  const status = URL_STATUS[one("stav") ?? ""];
  if (status) filter.status = status;
  const page = Number(one("strana"));
  if (Number.isInteger(page) && page > 1 && page <= 100_000) filter.page = page;
  return filter;
}

function ownerOf(actor: Actor): string {
  if (!actor.userId) throw new ServiceError(V.forbidden);
  return actor.userId;
}

function readOwned(q: Reader, ownerId: string, id: string): Customer | null {
  return (
    q
      .select()
      .from(customer)
      .where(scoped(ownerId).where(customer, (t, { eq }) => eq(t.id, id)))
      .get() ?? null
  );
}

function findOwned(q: Reader, ownerId: string, id: string): Customer {
  const row = readOwned(q, ownerId, id);
  if (!row) throw new ServiceError(V.notFound);
  return row;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// Accents and case are folded away on both sides, because SQLite LIKE only ignores ASCII case.
function searchTextOf(v: Pick<Customer, "name" | "ico" | "dic" | "email">): string {
  return foldText([v.name, v.ico, v.dic, v.email].join("\n"));
}

function matches(q: string): SQL {
  return sql`${customer.searchText} LIKE ${`%${escapeLike(foldText(q))}%`} ESCAPE '\\'`;
}

function snapshot(row: Customer) {
  const { userId: _u, createdAt: _c, updatedAt: _t, searchText: _s, ...rest } = row;
  return rest;
}

function conditions(ownerId: string, filter: CustomerFilter): SQL {
  const status = filter.status ?? "active";
  return scoped(ownerId).where(customer, (t) =>
    and(
      status === "active" ? isNull(t.archivedAt) : undefined,
      status === "archived" ? isNotNull(t.archivedAt) : undefined,
      filter.foreign ? and(ne(t.country, ""), ne(t.country, DOMESTIC_COUNTRY)) : undefined,
      filter.q ? matches(filter.q) : undefined,
    ),
  );
}

export function listCustomers(ownerId: string, filter: CustomerFilter): Page<Customer> {
  const page = Math.max(1, Math.floor(filter.page ?? 1));
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, filter.pageSize ?? DEFAULT_PAGE_SIZE));
  const rows = db
    .select()
    .from(customer)
    .where(conditions(ownerId, filter))
    .orderBy(asc(customer.name), asc(customer.id))
    .limit(pageSize + 1)
    .offset((page - 1) * pageSize)
    .all();
  return { rows: rows.slice(0, pageSize), page, pageSize, hasNext: rows.length > pageSize };
}

export function getCustomer(ownerId: string, id: string): Customer | null {
  return readOwned(db, ownerId, id);
}

export function searchCustomers(ownerId: string, q: string, limit: number): Customer[] {
  const term = q.trim();
  return db
    .select()
    .from(customer)
    .where(conditions(ownerId, { q: term || undefined }))
    .orderBy(asc(customer.name), asc(customer.id))
    .limit(Math.min(MAX_PAGE_SIZE, Math.max(1, limit)))
    .all();
}

export function duplicateIcoOf(q: Reader, ownerId: string, row: Pick<Customer, "id" | "ico">) {
  if (!row.ico) return null;
  const other = q
    .select({ id: customer.id })
    .from(customer)
    .where(
      scoped(ownerId).where(customer, (t, { and, eq }) =>
        and(eq(t.ico, row.ico), ne(t.id, row.id)),
      ),
    )
    .get();
  return other ? row.ico : null;
}

export function saveCustomer(
  actor: Actor,
  raw: CustomerInput,
): { id: string; duplicateOfIco: string | null } {
  const userId = ownerOf(actor);
  const parsed = customerInputSchema.safeParse(raw);
  if (!parsed.success) throw new ServiceError(parsed.error.issues[0]?.message ?? V.invalid);
  const { id: existingId, ...values } = parsed.data;

  return mutate(actor, "customer.save", (tx, audit) => {
    const before = existingId ? findOwned(tx, userId, existingId) : null;
    const id = before?.id ?? randomUUID();
    const now = clock.now();
    // The verification belongs to the VAT ID that was checked.
    const searchText = searchTextOf(values);
    const vatChanged = before !== null && before.dic !== values.dic;
    if (before) {
      tx.update(customer)
        .set({
          ...values,
          searchText,
          ...(vatChanged ? { vatVerifiedAt: null, vatValid: null } : {}),
          updatedAt: now,
        })
        .where(and(eq(customer.id, id), eq(customer.userId, userId)))
        .run();
    } else {
      tx.insert(customer)
        .values({ id, userId, ...values, searchText, createdAt: now, updatedAt: now })
        .run();
    }
    audit({
      entity: "customer",
      entityId: id,
      ownerId: userId,
      scope: "user",
      before: before && snapshot(before),
      after: snapshot(findOwned(tx, userId, id)),
    });
    return { id, duplicateOfIco: duplicateIcoOf(tx, userId, { id, ico: values.ico }) };
  });
}

function setArchived(actor: Actor, id: string, archived: boolean): void {
  const userId = ownerOf(actor);
  mutate(actor, archived ? "customer.archive" : "customer.restore", (tx, audit) => {
    const row = findOwned(tx, userId, id);
    const archivedAt = archived ? clock.now() : null;
    tx.update(customer)
      .set({ archivedAt, updatedAt: clock.now() })
      .where(and(eq(customer.id, id), eq(customer.userId, userId)))
      .run();
    audit({
      entity: "customer",
      entityId: id,
      ownerId: userId,
      scope: "user",
      before: { archivedAt: row.archivedAt },
      after: { archivedAt },
    });
  });
}

export function archiveCustomer(actor: Actor, id: string): void {
  setArchived(actor, id, true);
}

export function restoreCustomer(actor: Actor, id: string): void {
  setArchived(actor, id, false);
}

// Plan 3 adds the check for issued documents (CUS-007); until then every customer is deletable.
export function deleteCustomer(actor: Actor, id: string): void {
  const userId = ownerOf(actor);
  mutate(actor, "customer.delete", (tx, audit) => {
    const row = findOwned(tx, userId, id);
    tx.delete(customer)
      .where(and(eq(customer.id, id), eq(customer.userId, userId)))
      .run();
    audit({ entity: "customer", entityId: id, ownerId: userId, scope: "user", before: row });
  });
}

export type VatStatus = { state: ViesState; verifiedAt: Date | null };

export async function verifyVat(actor: Actor, id: string): Promise<VatStatus> {
  const userId = ownerOf(actor);
  const row = findOwned(db, userId, id);
  if (!row.dic) throw new ServiceError(V.noVatId);
  if (!splitVatId(row.dic)) throw new ServiceError(V.badVatId);
  enforceRateLimit(actor, RATE_RULES.viesLookup);

  const state = await lookupVies(row.dic);
  if (state === "unavailable") return { state, verifiedAt: row.vatVerifiedAt };

  const verifiedAt = clock.now();
  mutate(actor, "customer.vat_verify", (tx, audit) => {
    // The VAT ID may have been edited while VIES was answering.
    const current = findOwned(tx, userId, id);
    if (current.dic !== row.dic) throw new ServiceError(V.invalid);
    tx.update(customer)
      .set({ vatVerifiedAt: verifiedAt, vatValid: state === "valid" })
      .where(and(eq(customer.id, id), eq(customer.userId, userId)))
      .run();
    audit({
      entity: "customer",
      entityId: id,
      ownerId: userId,
      scope: "user",
      before: { vatVerifiedAt: current.vatVerifiedAt, vatValid: current.vatValid },
      after: { vatVerifiedAt: verifiedAt, vatValid: state === "valid" },
    });
  });
  return { state, verifiedAt };
}

export type CustomerDefaults = Preferences & { remindersEnabled: boolean | null };

// null in remindersEnabled still means "follow the account setting"; plan 3 resolves it with REM-005.
export function customerDefaults(
  ownerId: string,
  customerId: string,
  prefs: Preferences,
): CustomerDefaults {
  const row = findOwned(db, ownerId, customerId);
  return {
    ...prefs,
    dueDays: row.dueDays ?? prefs.dueDays,
    language: row.language ?? prefs.language,
    currency: row.currency ?? prefs.currency,
    designId: row.designId ?? prefs.designId,
    remindersEnabled: row.remindersEnabled,
  };
}
