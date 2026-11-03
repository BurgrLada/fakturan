import "server-only";
import { randomUUID } from "node:crypto";
import { asc, ne, sql } from "drizzle-orm";
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
import { TEXTS } from "@/lib/texts";
import { czechError, issueText } from "@/lib/validation-issue";
import { widgetConfigSchema, type WidgetConfig } from "@/lib/widget-config";
import type { Actor } from "../audit/context";
import { clock } from "../clock";
import { db, type Tx } from "../db";
import { dashboard, dashboardWidget } from "../db/schema";
import { scoped } from "../db/scoped";
import { ServiceError, type Reader } from "./access";
import { mutate } from "./mutation";

const T = TEXTS.dashboard;
const E = T.errors;

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
