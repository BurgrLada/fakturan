import "server-only";
import { and, desc, eq, gte, inArray, isNull, lt, ne, or, type SQL } from "drizzle-orm";
import { z } from "zod";
import { auditActionLabel } from "@/lib/audit-labels";
import { neutralizeCsvCell } from "@/lib/tabular";
import type { Actor } from "../audit/context";
import { db, type Tx } from "../db";
import {
  auditLog,
  catalogItem,
  customer,
  dashboard,
  importBatch,
  invoice,
  recurringInvoice,
} from "../db/schema";
import { scoped } from "../db/scoped";
import { RATE_RULES } from "../rate-limit";
import { enforceRateLimit, ServiceError } from "./access";
import { mutate } from "./mutation";

export type AuditRow = typeof auditLog.$inferSelect;

export type Page<T> = { rows: T[]; page: number; pageSize: number; hasNext: boolean };

export const AUDIT_SOURCES = ["web", "scheduler", "import", "system"] as const;

export type AuditFilter = {
  action?: string;
  entity?: string;
  source?: (typeof AUDIT_SOURCES)[number];
  actor?: "self" | "other";
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
};

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const EXPORT_LIMIT = 50_000;
const HISTORY_LIMIT = 100;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const PRAGUE_HOUR = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  hourCycle: "h23",
  timeZone: "Europe/Prague",
});

function pragueMidnight(date: string): Date | null {
  if (!DATE_ONLY.test(date)) return null;
  for (const offset of ["+01:00", "+02:00"]) {
    const candidate = new Date(`${date}T00:00:00${offset}`);
    if (!Number.isNaN(candidate.getTime()) && PRAGUE_HOUR.format(candidate) === "00") {
      return candidate;
    }
  }
  return null;
}

function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

const text = z.string().trim().min(1).max(100).optional().catch(undefined);

const filterSchema = z.object({
  action: text,
  entity: text,
  source: z.enum(AUDIT_SOURCES).optional().catch(undefined),
  actor: z.enum(["self", "other"]).optional().catch(undefined),
  from: z.string().regex(DATE_ONLY).optional().catch(undefined),
  to: z.string().regex(DATE_ONLY).optional().catch(undefined),
  page: z.coerce.number().int().min(1).max(100_000).optional().catch(undefined),
});

// Query strings are untrusted: anything that does not fit is dropped, not rejected.
export function parseAuditFilter(raw: Record<string, string | string[] | undefined>): AuditFilter {
  const single = Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value]),
  );
  const parsed = filterSchema.parse(single);
  return Object.fromEntries(Object.entries(parsed).filter(([, value]) => value !== undefined));
}

function ownerOf(actor: Actor): string {
  if (!actor.userId) throw new ServiceError("Pro zobrazení historie se přihlaste");
  return actor.userId;
}

function conditions(ownerId: string, filter: AuditFilter): SQL {
  const from = filter.from ? pragueMidnight(filter.from) : null;
  const to = filter.to && DATE_ONLY.test(filter.to) ? pragueMidnight(nextDay(filter.to)) : null;
  return scoped(ownerId).where(auditLog, (t) =>
    and(
      filter.action ? eq(t.action, filter.action) : undefined,
      filter.entity ? eq(t.entity, filter.entity) : undefined,
      filter.source ? eq(t.source, filter.source) : undefined,
      filter.actor === "self" ? eq(t.actorId, ownerId) : undefined,
      filter.actor === "other" ? or(isNull(t.actorId), ne(t.actorId, ownerId)) : undefined,
      from ? gte(t.at, from) : undefined,
      to ? lt(t.at, to) : undefined,
    ),
  );
}

// Another user's address and browser (e.g. an administrator acting on this account) are theirs,
// not the owner's; the account backup masks them the same way.
export function isForeignActor(actorId: string | null, ownerId: string): boolean {
  return actorId !== null && actorId !== ownerId;
}

function maskForeignActor(row: AuditRow, ownerId: string): AuditRow {
  if (!isForeignActor(row.actorId, ownerId)) return row;
  return { ...row, ip: null, userAgent: null };
}

export function listAudit(actor: Actor, filter: AuditFilter = {}): Page<AuditRow> {
  const ownerId = ownerOf(actor);
  const page = Math.max(1, Math.floor(filter.page ?? 1));
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, filter.pageSize ?? DEFAULT_PAGE_SIZE));
  const rows = db
    .select()
    .from(auditLog)
    .where(conditions(ownerId, filter))
    .orderBy(desc(auditLog.at), desc(auditLog.id))
    .limit(pageSize + 1)
    .offset((page - 1) * pageSize)
    .all();
  return {
    rows: rows.slice(0, pageSize).map((row) => maskForeignActor(row, ownerId)),
    page,
    pageSize,
    hasNext: rows.length > pageSize,
  };
}

const LINKABLE = {
  invoice,
  customer,
  recurring_invoice: recurringInvoice,
  catalog_item: catalogItem,
  import_batch: importBatch,
  dashboard,
} as const;

export type AuditEntityType = keyof typeof LINKABLE;

// Only entities that still exist get a link, so a history row never leads to a missing page.
export function liveAuditEntities(actor: Actor, rows: AuditRow[]): Set<string> {
  const ownerId = ownerOf(actor);
  const live = new Set<string>();
  for (const [type, table] of Object.entries(LINKABLE)) {
    const ids = [
      ...new Set(
        rows.flatMap((r) => (r.entity === type && r.entityId !== null ? [r.entityId] : [])),
      ),
    ];
    if (ids.length === 0) continue;
    const found = db
      .select({ id: table.id })
      .from(table)
      .where(scoped(ownerId).where(table, (t) => inArray(t.id, ids)))
      .all();
    for (const { id } of found) live.add(`${type}:${id}`);
  }
  return live;
}

export function listAuditFacets(actor: Actor): { actions: string[]; entities: string[] } {
  const ownerId = ownerOf(actor);
  const where = scoped(ownerId).where(auditLog);
  const actions = db
    .selectDistinct({ value: auditLog.action })
    .from(auditLog)
    .where(where)
    .all()
    .map((row) => row.value);
  const entities = db
    .selectDistinct({ value: auditLog.entity })
    .from(auditLog)
    .where(where)
    .all()
    .map((row) => row.value);
  return { actions: actions.sort(), entities: entities.sort() };
}

export async function entityHistory(
  userId: string,
  entity: string,
  entityId: string,
): Promise<AuditRow[]> {
  return db
    .select()
    .from(auditLog)
    .where(
      scoped(userId).where(auditLog, (t) => and(eq(t.entity, entity), eq(t.entityId, entityId))),
    )
    .orderBy(desc(auditLog.at), desc(auditLog.id))
    .limit(HISTORY_LIMIT)
    .all()
    .map((row) => maskForeignActor(row, userId));
}

export { neutralizeCsvCell };

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = neutralizeCsvCell(typeof value === "string" ? value : String(value));
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function actorLabel(row: AuditRow, ownerId: string): string {
  if (row.actorId === ownerId) return "Já";
  return row.actorId ? "Jiný uživatel" : "Systém nebo nepřihlášený";
}

const CSV_HEADER = [
  "Čas",
  "Aktér",
  "Zdroj",
  "Akce",
  "Kód akce",
  "Entita",
  "ID entity",
  "Před",
  "Po",
  "IP",
  "Prohlížeč",
  "ID požadavku",
];

function csvRows(tx: Pick<Tx, "select">, ownerId: string, filter: AuditFilter): string {
  const rows = tx
    .select()
    .from(auditLog)
    .where(conditions(ownerId, filter))
    .orderBy(desc(auditLog.at), desc(auditLog.id))
    .limit(EXPORT_LIMIT)
    .all()
    .map((row) => maskForeignActor(row, ownerId));
  const lines = rows.map((row) =>
    [
      row.at.toISOString(),
      actorLabel(row, ownerId),
      row.source,
      auditActionLabel(row.action),
      row.action,
      row.entity,
      row.entityId,
      row.before === null ? null : JSON.stringify(row.before),
      row.after === null ? null : JSON.stringify(row.after),
      row.ip,
      row.userAgent,
      row.requestId,
    ]
      .map(csvCell)
      .join(","),
  );
  return [CSV_HEADER.map(csvCell).join(","), ...lines].join("\r\n") + "\r\n";
}

// The BOM makes Excel read the file as UTF-8.
export function exportAuditCsv(actor: Actor, filter: AuditFilter = {}): string {
  const ownerId = ownerOf(actor);
  enforceRateLimit(actor, RATE_RULES.exportUser);
  const { page: _page, pageSize: _pageSize, ...criteria } = filter;
  return mutate(actor, "audit.export", (tx, audit) => {
    const csv = csvRows(tx, ownerId, criteria);
    audit({
      entity: "audit_log",
      entityId: null,
      ownerId,
      scope: "user",
      after: { filter: criteria },
    });
    return "﻿" + csv;
  });
}
