import "server-only";
import { randomUUID } from "node:crypto";
import { asc, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { DEFAULT_DASHBOARD } from "@/lib/dashboard-defaults";
import {
  compactLayout,
  dashboardNameSchema,
  layoutSchema,
  normalizeWidgets,
  type LayoutItem,
  type WidgetDraft,
} from "@/lib/dashboard-layout";
import {
  parseDashboardFile,
  placeWidgets,
  toDashboardFile,
  type DashboardFile,
} from "@/lib/dashboard-share";
import { calendarDateInPrague } from "@/lib/number-format";
import { TEXTS } from "@/lib/texts";
import { czechError, issueText } from "@/lib/validation-issue";
import { isPinnedWidget, widgetConfigSchema, type WidgetConfig } from "@/lib/widget-config";
import type { Actor } from "../audit/context";
import { clock } from "../clock";
import { db, type Tx } from "../db";
import { customer, dashboard, dashboardWidget } from "../db/schema";
import { scoped } from "../db/scoped";
import { RATE_RULES } from "../rate-limit";
import { registerSystemWidgets } from "../reports/system-widgets";
import { runWidget, type WidgetResult } from "../reports/widget-query";
import { reportFailure } from "../scheduler/report";
import { assertRowLimit } from "./account-limits";
import { enforceRateLimit, ServiceError, type Reader } from "./access";
import { mutate } from "./mutation";

const T = TEXTS.dashboard;
const E = T.errors;
const S = T.share;

export type DashboardSummary = {
  id: string;
  name: string;
  isDefault: boolean;
  position: number;
  revision: number;
};

// A stored config that no longer parses comes back as null, so one broken widget never takes
// the whole dashboard down.
export type DashboardWidgetView = {
  id: string;
  config: WidgetConfig | null;
  x: number;
  y: number;
  w: number;
  h: number;
};

export type DashboardView = DashboardSummary & { widgets: DashboardWidgetView[] };

export class Unchanged extends Error {}

export function ownerOf(actor: Actor): string {
  if (!actor.userId) throw new ServiceError(E.signedOut);
  return actor.userId;
}

function summaryColumns() {
  return {
    id: dashboard.id,
    name: dashboard.name,
    isDefault: dashboard.isDefault,
    position: dashboard.position,
    revision: dashboard.revision,
  };
}

function listIn(q: Reader, ownerId: string): DashboardSummary[] {
  return q
    .select(summaryColumns())
    .from(dashboard)
    .where(scoped(ownerId).where(dashboard))
    .orderBy(asc(dashboard.position), asc(dashboard.createdAt), asc(dashboard.id))
    .all();
}

export function listDashboards(ownerId: string): DashboardSummary[] {
  return listIn(db, ownerId);
}

// Read as text, so a row that is not even JSON fails alone instead of the whole query.
function storedConfig(raw: string): WidgetConfig | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = widgetConfigSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function widgetsIn(q: Reader, ownerId: string, dashboardId: string): DashboardWidgetView[] {
  return q
    .select({
      id: dashboardWidget.id,
      raw: sql<string>`${dashboardWidget.config}`,
      x: dashboardWidget.x,
      y: dashboardWidget.y,
      w: dashboardWidget.w,
      h: dashboardWidget.h,
    })
    .from(dashboardWidget)
    .where(scoped(ownerId).where(dashboardWidget, (t, { eq }) => eq(t.dashboardId, dashboardId)))
    .orderBy(asc(dashboardWidget.y), asc(dashboardWidget.x), asc(dashboardWidget.id))
    .all()
    .map(({ raw, ...row }) => ({ ...row, config: storedConfig(raw) }));
}

export function dashboardIn(q: Reader, ownerId: string, id: string): DashboardSummary {
  const row = q
    .select(summaryColumns())
    .from(dashboard)
    .where(scoped(ownerId).where(dashboard, (t, { eq }) => eq(t.id, id)))
    .get();
  if (!row) throw new ServiceError(E.notFound);
  return row;
}

export function getDashboard(ownerId: string, id: string): DashboardView | null {
  const row = db
    .select(summaryColumns())
    .from(dashboard)
    .where(scoped(ownerId).where(dashboard, (t, { eq }) => eq(t.id, id)))
    .get();
  return row ? { ...row, widgets: widgetsIn(db, ownerId, id) } : null;
}

// Any change of the widget set or their boxes moves the revision, so an older layout from
// another tab fails instead of overwriting it (R-26).
export function bumpRevision(tx: Tx, ownerId: string, id: string): number {
  const row = tx
    .update(dashboard)
    .set({ revision: sql`${dashboard.revision} + 1`, updatedAt: clock.now() })
    .where(scoped(ownerId).where(dashboard, (t, { eq }) => eq(t.id, id)))
    .returning({ revision: dashboard.revision })
    .get();
  if (!row) throw new ServiceError(E.notFound);
  return row.revision;
}

export function insertWidgets(
  tx: Tx,
  ownerId: string,
  dashboardId: string,
  widgets: WidgetDraft[],
): void {
  const now = clock.now();
  for (const widget of widgets) {
    const { x, y, w, h } = widget;
    tx.insert(dashboardWidget)
      .values({
        id: randomUUID(),
        dashboardId,
        userId: ownerId,
        config: widget.config,
        x,
        y,
        w,
        h,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }
}

function nextPosition(tx: Tx, ownerId: string): number {
  const row = tx
    .select({ max: sql<number | null>`max(${dashboard.position})` })
    .from(dashboard)
    .where(scoped(ownerId).where(dashboard))
    .get();
  return (row?.max ?? -1) + 1;
}

function insertDashboard(
  tx: Tx,
  ownerId: string,
  name: string,
  isDefault: boolean,
): string | undefined {
  assertRowLimit(tx, "dashboard", dashboard, ownerId);
  const now = clock.now();
  const id = randomUUID();
  const inserted = tx
    .insert(dashboard)
    .values({
      id,
      userId: ownerId,
      name,
      isDefault,
      position: nextPosition(tx, ownerId),
      createdAt: now,
      updatedAt: now,
    })
    // Drizzle writes a target's WHERE after DO NOTHING, which SQLite rejects; the id is random,
    // so the only constraint left to hit is dashboard_default_idx.
    .onConflictDoNothing()
    .returning({ id: dashboard.id })
    .get();
  return inserted?.id;
}

// The only write behind reading the overview (R-19). Two tabs opening it at once both see no
// dashboard; the partial unique index lets one insert win and the other just reads.
export function ensureDashboards(actor: Actor): DashboardSummary[] {
  const ownerId = ownerOf(actor);
  const existing = listDashboards(ownerId);
  if (existing.length > 0) return existing;
  try {
    mutate(actor, "dashboard.create", (tx, audit) => {
      const id = insertDashboard(tx, ownerId, DEFAULT_DASHBOARD.name, true);
      // Thrown to roll back: mutate refuses a transaction without an audit entry.
      if (!id) throw new Unchanged();
      const widgets = normalizeWidgets(DEFAULT_DASHBOARD.widgets);
      insertWidgets(tx, ownerId, id, widgets);
      audit({
        entity: "dashboard",
        entityId: id,
        ownerId,
        scope: "user",
        after: { name: DEFAULT_DASHBOARD.name, isDefault: true, widgets: widgets.length },
      });
    });
  } catch (error) {
    if (!(error instanceof Unchanged)) throw error;
  }
  return listDashboards(ownerId);
}

export function parseInput<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw, { error: czechError });
  if (!parsed.success) throw new ServiceError(issueText(parsed.error));
  return parsed.data;
}

function parseName(raw: unknown): string {
  return parseInput(dashboardNameSchema, raw);
}

const idSchema = z.string(E.invalid).min(1, E.invalid).max(64, E.invalid);
const createSchema = z.strictObject({ name: z.unknown() });
const renameSchema = z.strictObject({ id: idSchema, name: z.unknown() });
const idOnlySchema = z.strictObject({ id: idSchema });

export function createDashboard(actor: Actor, raw: unknown): { id: string } {
  const ownerId = ownerOf(actor);
  const name = parseName(parseInput(createSchema, raw).name);
  return mutate(actor, "dashboard.create", (tx, audit) => {
    const hasDefault = listIn(tx, ownerId).some((row) => row.isDefault);
    const id = insertDashboard(tx, ownerId, name, !hasDefault);
    if (!id) throw new ServiceError(E.invalid);
    const widgets = normalizeWidgets([]);
    insertWidgets(tx, ownerId, id, widgets);
    audit({
      entity: "dashboard",
      entityId: id,
      ownerId,
      scope: "user",
      after: { name, isDefault: !hasDefault, widgets: widgets.length },
    });
    return { id };
  });
}

export function renameDashboard(actor: Actor, raw: unknown): void {
  const ownerId = ownerOf(actor);
  const input = parseInput(renameSchema, raw);
  const name = parseName(input.name);
  try {
    mutate(actor, "dashboard.rename", (tx, audit) => {
      const before = dashboardIn(tx, ownerId, input.id);
      if (before.name === name) throw new Unchanged();
      tx.update(dashboard)
        .set({ name, updatedAt: clock.now() })
        .where(scoped(ownerId).where(dashboard, (t, { eq }) => eq(t.id, input.id)))
        .run();
      audit({
        entity: "dashboard",
        entityId: input.id,
        ownerId,
        scope: "user",
        before: { name: before.name },
        after: { name },
      });
    });
  } catch (error) {
    if (!(error instanceof Unchanged)) throw error;
  }
}

export function duplicateDashboard(actor: Actor, raw: unknown): { id: string } {
  const ownerId = ownerOf(actor);
  const { id: sourceId } = parseInput(idOnlySchema, raw);
  return mutate(actor, "dashboard.duplicate", (tx, audit) => {
    const source = dashboardIn(tx, ownerId, sourceId);
    const name = T.copyName(source.name).slice(0, 60);
    const id = insertDashboard(tx, ownerId, name, false)!;
    const widgets = normalizeWidgets(
      widgetsIn(tx, ownerId, sourceId).flatMap(({ config, x, y, w, h }) =>
        config ? [{ config, x, y, w, h }] : [],
      ),
    );
    insertWidgets(tx, ownerId, id, widgets);
    audit({
      entity: "dashboard",
      entityId: id,
      ownerId,
      scope: "user",
      after: { name, from: sourceId, widgets: widgets.length },
    });
    return { id };
  });
}

// The default moves to the oldest dashboard left, and the last one stays (R-19).
export function deleteDashboard(actor: Actor, raw: unknown): void {
  const ownerId = ownerOf(actor);
  const { id } = parseInput(idOnlySchema, raw);
  mutate(actor, "dashboard.delete", (tx, audit) => {
    const target = dashboardIn(tx, ownerId, id);
    const others = tx
      .select({ id: dashboard.id })
      .from(dashboard)
      .where(scoped(ownerId).where(dashboard, (t) => ne(t.id, id)))
      .orderBy(asc(dashboard.createdAt), asc(dashboard.id))
      .all();
    if (others.length === 0) throw new ServiceError(E.lastDashboard);
    tx.delete(dashboardWidget)
      .where(scoped(ownerId).where(dashboardWidget, (t, { eq }) => eq(t.dashboardId, id)))
      .run();
    tx.delete(dashboard)
      .where(scoped(ownerId).where(dashboard, (t, { eq }) => eq(t.id, id)))
      .run();
    const heir = target.isDefault ? others[0]!.id : null;
    if (heir) {
      tx.update(dashboard)
        .set({ isDefault: true, updatedAt: clock.now() })
        .where(scoped(ownerId).where(dashboard, (t, { eq }) => eq(t.id, heir)))
        .run();
    }
    audit({
      entity: "dashboard",
      entityId: id,
      ownerId,
      scope: "user",
      before: { name: target.name, isDefault: target.isDefault },
      after: heir ? { defaultTo: heir } : undefined,
    });
  });
}

export function setDefaultDashboard(actor: Actor, raw: unknown): void {
  const ownerId = ownerOf(actor);
  const { id } = parseInput(idOnlySchema, raw);
  try {
    mutate(actor, "dashboard.set_default", (tx, audit) => {
      const target = dashboardIn(tx, ownerId, id);
      if (target.isDefault) throw new Unchanged();
      const now = clock.now();
      tx.update(dashboard)
        .set({ isDefault: false, updatedAt: now })
        .where(scoped(ownerId).where(dashboard, (t, { eq }) => eq(t.isDefault, true)))
        .run();
      tx.update(dashboard)
        .set({ isDefault: true, updatedAt: now })
        .where(scoped(ownerId).where(dashboard, (t, { eq }) => eq(t.id, id)))
        .run();
      audit({
        entity: "dashboard",
        entityId: id,
        ownerId,
        scope: "user",
        before: { isDefault: false },
        after: { isDefault: true },
      });
    });
  } catch (error) {
    if (!(error instanceof Unchanged)) throw error;
  }
}

// The audit keeps only the number of widgets, never the layout itself (R-26).
type SavedLayout = { revision: number; items: LayoutItem[] };

const boxOf = ({ id, x, y, w, h }: LayoutItem): LayoutItem => ({ id, x, y, w, h });

export function saveLayout(actor: Actor, raw: unknown): SavedLayout {
  const ownerId = ownerOf(actor);
  const input = parseInput(layoutSchema, raw);
  try {
    return mutate(actor, "dashboard.layout", (tx, audit) => {
      const target = dashboardIn(tx, ownerId, input.id);
      if (target.revision !== input.revision) throw new ServiceError(E.staleLayout);
      const current = widgetsIn(tx, ownerId, input.id);
      const wanted = new Map(input.items.map((item) => [item.id, item]));
      if (wanted.size !== input.items.length || wanted.size !== current.length) {
        throw new ServiceError(E.layout);
      }
      if (current.some((widget) => !wanted.has(widget.id))) throw new ServiceError(E.layout);
      const layout = compactLayout(input.items);
      const changed = layout.filter((item) => {
        const before = current.find((widget) => widget.id === item.id)!;
        return (
          before.x !== item.x || before.y !== item.y || before.w !== item.w || before.h !== item.h
        );
      });
      if (changed.length === 0) throw new Unchanged();
      const now = clock.now();
      for (const { id, x, y, w, h } of changed) {
        tx.update(dashboardWidget)
          .set({ x, y, w, h, updatedAt: now })
          .where(
            scoped(ownerId).where(dashboardWidget, (t, { and, eq }) =>
              and(eq(t.id, id), eq(t.dashboardId, input.id)),
            ),
          )
          .run();
      }
      const revision = bumpRevision(tx, ownerId, input.id);
      audit({
        entity: "dashboard",
        entityId: input.id,
        ownerId,
        scope: "user",
        after: { widgets: layout.length },
      });
      return { revision, items: layout.map(boxOf) };
    });
  } catch (error) {
    if (!(error instanceof Unchanged)) throw error;
    return { revision: input.revision, items: widgetsIn(db, ownerId, input.id).map(boxOf) };
  }
}

function auditedExport(actor: Actor, id: string, file: DashboardFile): DashboardFile {
  const ownerId = ownerOf(actor);
  mutate(actor, "dashboard.export", (_tx, audit) =>
    audit({
      entity: "dashboard",
      entityId: id,
      ownerId,
      scope: "user",
      after: { widgets: file.widgets.length },
    }),
  );
  return file;
}

// R-25: only the configuration travels. A widget that no longer parses stops the export, so the
// file never silently misses part of the dashboard.
export function exportDashboard(actor: Actor, id: string): DashboardFile {
  const ownerId = ownerOf(actor);
  enforceRateLimit(actor, RATE_RULES.exportUser);
  const target = dashboardIn(db, ownerId, id);
  const widgets = widgetsIn(db, ownerId, id);
  const broken = widgets.filter((widget) => !widget.config).length;
  if (broken > 0) throw new ServiceError(S.brokenWidgets(broken));
  const configs = widgets.flatMap(({ config }) => (config ? [config] : []));
  return auditedExport(actor, id, toDashboardFile(target.name, configs));
}

export function exportWidget(actor: Actor, dashboardId: string, widgetId: string): DashboardFile {
  const ownerId = ownerOf(actor);
  enforceRateLimit(actor, RATE_RULES.exportUser);
  dashboardIn(db, ownerId, dashboardId);
  const widget = widgetsIn(db, ownerId, dashboardId).find((row) => row.id === widgetId);
  if (!widget) throw new ServiceError(E.widgetNotFound);
  const { config } = widget;
  if (!config) throw new ServiceError(S.brokenWidget);
  const title = config.title || (config.kind === "system" ? T.gallery[config.systemId] : "");
  const file = toDashboardFile((title || T.view.untitled).slice(0, 60), [config]);
  return auditedExport(actor, dashboardId, file);
}

type Imported = { config: WidgetConfig; droppedCustomers: boolean };

function readFile(raw: unknown): DashboardFile {
  if (typeof raw !== "string") throw new ServiceError(S.notJson);
  const parsed = parseDashboardFile(raw);
  if (!parsed.ok) {
    throw new ServiceError(parsed.path ? `${parsed.path}: ${parsed.message}` : parsed.message);
  }
  return parsed.file;
}

// A customer filter from another account is not an error: the ids that are not ours go, and the
// preview says so (R-25). The check runs again on import, never trusted from the preview.
function ownWidgets(q: Reader, ownerId: string, file: DashboardFile): Imported[] {
  const wanted = [
    ...new Set(
      file.widgets.flatMap((config) =>
        config.kind === "query" ? (config.filters?.customerIds ?? []) : [],
      ),
    ),
  ];
  const own = new Set(
    wanted.length === 0
      ? []
      : q
          .select({ id: customer.id })
          .from(customer)
          .where(scoped(ownerId).where(customer, (t) => inArray(t.id, wanted)))
          .all()
          .map((row) => row.id),
  );
  return file.widgets.map((config) => {
    if (config.kind !== "query" || !config.filters?.customerIds) {
      return { config, droppedCustomers: false };
    }
    const { customerIds, ...others } = config.filters;
    const kept = customerIds.filter((id) => own.has(id));
    if (kept.length === customerIds.length) return { config, droppedCustomers: false };
    const filters = kept.length > 0 ? { ...others, customerIds: kept } : others;
    const { filters: _filters, ...rest } = config;
    return {
      config: Object.keys(filters).length > 0 ? { ...rest, filters } : rest,
      droppedCustomers: true,
    };
  });
}

function importName(q: Reader, ownerId: string, name: string): string {
  const taken = new Set(listIn(q, ownerId).map((row) => row.name));
  if (!taken.has(name)) return name;
  for (let n = 2; ; n++) {
    const suffix = S.importName("", n);
    const candidate = `${name.slice(0, 60 - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function importLayout(widgets: Imported[]) {
  const dropped = new Map(widgets.map((widget) => [widget.config, widget.droppedCustomers]));
  return normalizeWidgets(placeWidgets(widgets.map((widget) => widget.config))).map((draft) => ({
    draft,
    droppedCustomers: dropped.get(draft.config) ?? false,
  }));
}

export type ImportPreviewWidget = {
  config: WidgetConfig;
  droppedCustomers: boolean;
} & ({ ok: true; result: WidgetResult } | { ok: false; error: string });

export type ImportPreview = {
  name: string;
  addedPinned: boolean;
  widgets: ImportPreviewWidget[];
};

// DSH-032: reads only. Every widget runs over the importing account's own data.
export function previewImport(actor: Actor, raw: unknown): ImportPreview {
  const ownerId = ownerOf(actor);
  const file = readFile(raw);
  const layout = importLayout(ownWidgets(db, ownerId, file));
  // Every widget runs a query, so the preview spends one attempt per widget, not per file; a file
  // without widgets still spends one.
  enforceRateLimit(actor, RATE_RULES.widgetPreviewUser, Math.max(1, layout.length));
  registerSystemWidgets();
  const today = calendarDateInPrague(clock.now());
  return {
    name: importName(db, ownerId, file.name),
    addedPinned: !file.widgets.some(isPinnedWidget),
    widgets: layout.map(({ draft: { config }, droppedCustomers }) => {
      try {
        return {
          config,
          droppedCustomers,
          ok: true,
          result: runWidget(db, ownerId, config, { today }),
        };
      } catch (error) {
        if (error instanceof ServiceError) {
          return { config, droppedCustomers, ok: false, error: error.message };
        }
        reportFailure(error, { task: "dashboard.import_preview", userId: ownerId });
        return { config, droppedCustomers, ok: false, error: S.widgetFailed };
      }
    }),
  };
}

// Always a new dashboard, never over an existing one (R-25), with the due alerts card (R-20).
export function importDashboard(actor: Actor, raw: unknown): { id: string } {
  const ownerId = ownerOf(actor);
  enforceRateLimit(actor, RATE_RULES.importUser);
  const file = readFile(raw);
  return mutate(actor, "dashboard.import", (tx, audit) => {
    const imported = ownWidgets(tx, ownerId, file);
    const name = importName(tx, ownerId, file.name);
    const hasDefault = listIn(tx, ownerId).some((row) => row.isDefault);
    const id = insertDashboard(tx, ownerId, name, !hasDefault);
    if (!id) throw new ServiceError(E.invalid);
    const widgets = importLayout(imported).map(({ draft }) => draft);
    insertWidgets(tx, ownerId, id, widgets);
    audit({
      entity: "dashboard",
      entityId: id,
      ownerId,
      scope: "user",
      after: {
        name,
        widgets: widgets.length,
        droppedCustomers: imported.filter((widget) => widget.droppedCustomers).length,
      },
    });
    return { id };
  });
}
