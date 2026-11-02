import { z } from "zod";
import { PINNED_WIDGET, PINNED_SIZE } from "./dashboard-defaults";
import { TEXTS } from "./texts";
import { isPinnedWidget, type WidgetConfig } from "./widget-config";

export const GRID_COLUMNS = 12;
export const MIN_W = 2;
export const MIN_H = 1;
export const MAX_H = 8;
export const MAX_WIDGETS = 50;

export type Box = { x: number; y: number; w: number; h: number };
export type LayoutItem = Box & { id: string };
export type WidgetDraft = Box & { config: WidgetConfig };
export type Direction = "left" | "right" | "up" | "down";

const E = TEXTS.dashboard.errors;

export const dashboardNameSchema = z.string(E.name).trim().min(1, E.name).max(60, E.nameTooLong);

const cell = z.int().min(0).max(1000);

export const layoutSchema = z.strictObject({
  id: z.string().min(1).max(64),
  revision: z.int().min(1),
  items: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(64),
        x: cell,
        y: cell,
        w: cell,
        h: cell,
      }),
    )
    .max(MAX_WIDGETS),
});

export type LayoutInput = z.infer<typeof layoutSchema>;

function clampInt(value: number, min: number, max: number): number {
  const whole = Number.isFinite(value) ? Math.trunc(value) : min;
  return Math.min(max, Math.max(min, whole));
}

export function clampBox<T extends Box>(item: T): T {
  const w = clampInt(item.w, MIN_W, GRID_COLUMNS);
  const h = clampInt(item.h, MIN_H, MAX_H);
  return {
    ...item,
    w,
    h,
    x: clampInt(item.x, 0, GRID_COLUMNS - w),
    y: clampInt(item.y, 0, 10_000),
  };
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

// Gravity towards the top in reading order: each item takes the highest free row in its own
// columns, so the result never overlaps whatever the input was. `first` wins a tie on its row.
export function compactLayout<T extends LayoutItem>(items: T[], first?: string): T[] {
  const order = items
    .map((item, index) => ({ item: clampBox(item), index }))
    .sort(
      (a, b) =>
        a.item.y - b.item.y ||
        Number(b.item.id === first) - Number(a.item.id === first) ||
        a.item.x - b.item.x ||
        a.index - b.index,
    );
  const placed: T[] = [];
  for (const { item } of order) {
    let y = 0;
    for (;;) {
      const blocker = placed.find((other) => overlaps({ ...item, y }, other));
      if (!blocker) break;
      y = blocker.y + blocker.h;
    }
    placed.push({ ...item, y });
  }
  const byId = new Map(placed.map((item) => [item.id, item]));
  return items.map((item) => byId.get(item.id)!);
}

function sharesColumns(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w;
}

// Up and down step over the nearest neighbour in the same columns, because gravity would pull a
// plain one-row shift straight back.
export function moveWidget<T extends LayoutItem>(
  items: T[],
  id: string,
  direction: Direction,
): T[] {
  const index = items.findIndex((item) => item.id === id);
  if (index < 0) return compactLayout(items);
  const current = clampBox(items[index]!);
  let target: T = current;
  if (direction === "left") target = { ...current, x: current.x - 1 };
  if (direction === "right") target = { ...current, x: current.x + 1 };
  if (direction === "up" || direction === "down") {
    const others = items.filter((item) => item.id !== id && sharesColumns(item, current));
    const neighbour =
      direction === "up"
        ? others.filter((o) => o.y < current.y).sort((a, b) => b.y - a.y)[0]
        : others.filter((o) => o.y > current.y).sort((a, b) => a.y - b.y)[0];
    if (neighbour) {
      const y = direction === "up" ? neighbour.y : neighbour.y + 1;
      const rest = items.map((item) => (item.id === id ? { ...current, y } : item));
      if (direction === "up") return compactLayout(rest, id);
      return compactLayout(rest);
    }
  }
  return compactLayout(
    items.map((item) => (item.id === id ? clampBox(target) : item)),
    id,
  );
}

export function resizeWidget<T extends LayoutItem>(
  items: T[],
  id: string,
  size: { w: number; h: number },
): T[] {
  return compactLayout(
    items.map((item) => {
      if (item.id !== id) return item;
      const w = clampInt(size.w, MIN_W, GRID_COLUMNS);
      return clampBox({ ...item, w, h: size.h, x: Math.min(item.x, GRID_COLUMNS - w) });
    }),
    id,
  );
}

// Every dashboard keeps exactly one due_alerts card (R-20): a missing one goes on top, an extra
// one is dropped, and the layout ends up inside the grid without overlaps.
export function normalizeWidgets(widgets: WidgetDraft[]): WidgetDraft[] {
  let pinned = false;
  const kept = widgets.filter((widget) => {
    if (!isPinnedWidget(widget.config)) return true;
    if (pinned) return false;
    pinned = true;
    return true;
  });
  const items = kept
    .slice(0, MAX_WIDGETS)
    .map((widget, index) => ({ ...widget, id: String(index) }));
  if (!pinned) {
    items.unshift({ ...PINNED_SIZE, x: 0, y: 0, config: PINNED_WIDGET, id: "pinned" });
    if (items.length > MAX_WIDGETS) items.pop();
  }
  return compactLayout(items, pinned ? undefined : "pinned").map(
    ({ id: _id, ...widget }) => widget,
  );
}
