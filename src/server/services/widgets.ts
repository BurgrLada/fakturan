import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { defaultSize } from "@/lib/dashboard-defaults";
import { compactLayout, MAX_WIDGETS } from "@/lib/dashboard-layout";
import { TEXTS } from "@/lib/texts";
import {
  isPinnedWidget,
  parseWidgetConfig,
  WidgetConfigError,
  type WidgetConfig,
} from "@/lib/widget-config";
import type { Actor } from "../audit/context";
import { clock } from "../clock";
import { db, type Tx } from "../db";
import { dashboardWidget } from "../db/schema";
import { scoped } from "../db/scoped";
import { RATE_RULES } from "../rate-limit";
import { runWidget, type WidgetContext, type WidgetResult } from "../reports/widget-query";
import { enforceRateLimit, ServiceError } from "./access";
import { bumpRevision, dashboardIn, ownerOf, parseInput, Unchanged, widgetsIn } from "./dashboards";
import { mutate } from "./mutation";

const E = TEXTS.dashboard.errors;

const idSchema = z.string(E.invalid).min(1, E.invalid).max(64, E.invalid);
const addSchema = z.strictObject({ dashboardId: idSchema, config: z.unknown() });
const updateSchema = z.strictObject({ id: idSchema, config: z.unknown() });
const removeSchema = z.strictObject({ id: idSchema });

export function checkedConfig(raw: unknown): WidgetConfig {
  try {
    return parseWidgetConfig(raw);
  } catch (error) {
    if (error instanceof WidgetConfigError) throw new ServiceError(error.message);
    throw error;
  }
}

function widgetIn(tx: Tx, ownerId: string, id: string) {
  const row = tx
    .select()
    .from(dashboardWidget)
    .where(scoped(ownerId).where(dashboardWidget, (t, { eq }) => eq(t.id, id)))
    .get();
  if (!row) throw new ServiceError(E.widgetNotFound);
  return row;
}

function relayout(tx: Tx, ownerId: string, dashboardId: string, first?: string): void {
  const items = widgetsIn(tx, ownerId, dashboardId);
  const layout = compactLayout(items, first);
  const now = clock.now();
  for (const item of layout) {
    const before = items.find((widget) => widget.id === item.id)!;
    if (before.x === item.x && before.y === item.y && before.w === item.w && before.h === item.h) {
      continue;
    }
    tx.update(dashboardWidget)
      .set({ x: item.x, y: item.y, w: item.w, h: item.h, updatedAt: now })
      .where(scoped(ownerId).where(dashboardWidget, (t, { eq }) => eq(t.id, item.id)))
      .run();
  }
}

export function addWidget(actor: Actor, raw: unknown): { id: string } {
  const ownerId = ownerOf(actor);
  const input = parseInput(addSchema, raw);
  const config = checkedConfig(input.config);
  return mutate(actor, "dashboard_widget.add", (tx, audit) => {
    dashboardIn(tx, ownerId, input.dashboardId);
    const widgets = widgetsIn(tx, ownerId, input.dashboardId);
    if (widgets.length >= MAX_WIDGETS) throw new ServiceError(E.tooManyWidgets(MAX_WIDGETS));
    if (isPinnedWidget(config) && widgets.some((w) => w.config && isPinnedWidget(w.config))) {
      throw new ServiceError(E.duplicatePinned);
    }
    const bottom = widgets.reduce((max, widget) => Math.max(max, widget.y + widget.h), 0);
    const now = clock.now();
    const id = randomUUID();
    tx.insert(dashboardWidget)
      .values({
        id,
        dashboardId: input.dashboardId,
        userId: ownerId,
        config,
        x: 0,
        y: bottom,
        ...defaultSize(config),
        createdAt: now,
        updatedAt: now,
      })
      .run();
    relayout(tx, ownerId, input.dashboardId);
    bumpRevision(tx, ownerId, input.dashboardId);
    audit({
      entity: "dashboard_widget",
      entityId: id,
      ownerId,
      scope: "user",
      after: { dashboardId: input.dashboardId, config },
    });
    return { id };
  });
}

// The due_alerts card stays a due_alerts card (R-20); only its title, size and rows change.
export function updateWidget(actor: Actor, raw: unknown): void {
  const ownerId = ownerOf(actor);
  const input = parseInput(updateSchema, raw);
  const config = checkedConfig(input.config);
  try {
    mutate(actor, "dashboard_widget.update", (tx, audit) => {
      const before = widgetIn(tx, ownerId, input.id);
      const wasPinned = isPinnedWidget(before.config);
      if (wasPinned !== isPinnedWidget(config)) {
        throw new ServiceError(wasPinned ? E.pinned : E.duplicatePinned);
      }
      if (JSON.stringify(before.config) === JSON.stringify(config)) throw new Unchanged();
      tx.update(dashboardWidget)
        .set({ config, updatedAt: clock.now() })
        .where(scoped(ownerId).where(dashboardWidget, (t, { eq }) => eq(t.id, input.id)))
        .run();
      bumpRevision(tx, ownerId, before.dashboardId);
      audit({
        entity: "dashboard_widget",
        entityId: input.id,
        ownerId,
        scope: "user",
        before: { config: before.config },
        after: { config },
      });
    });
  } catch (error) {
    if (!(error instanceof Unchanged)) throw error;
  }
}

export function removeWidget(actor: Actor, raw: unknown): void {
  const ownerId = ownerOf(actor);
  const { id } = parseInput(removeSchema, raw);
  mutate(actor, "dashboard_widget.remove", (tx, audit) => {
    const before = widgetIn(tx, ownerId, id);
    if (isPinnedWidget(before.config)) throw new ServiceError(E.pinned);
    tx.delete(dashboardWidget)
      .where(scoped(ownerId).where(dashboardWidget, (t, { eq }) => eq(t.id, id)))
      .run();
    relayout(tx, ownerId, before.dashboardId);
    bumpRevision(tx, ownerId, before.dashboardId);
    audit({
      entity: "dashboard_widget",
      entityId: id,
      ownerId,
      scope: "user",
      before: { dashboardId: before.dashboardId, config: before.config },
    });
  });
}

// The live preview of the configurator (DSH-017) bypasses the cache, so it has its own limit.
export function previewWidget(actor: Actor, raw: unknown, context: WidgetContext): WidgetResult {
  const ownerId = ownerOf(actor);
  enforceRateLimit(actor, RATE_RULES.widgetPreviewUser);
  return runWidget(db, ownerId, checkedConfig(raw), context);
}

export function widgetResult(
  ownerId: string,
  config: WidgetConfig,
  context: WidgetContext,
): WidgetResult {
  return runWidget(db, ownerId, config, context);
}
