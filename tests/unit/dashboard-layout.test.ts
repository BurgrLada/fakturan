import { describe, expect, test } from "vitest";
import { DEFAULT_DASHBOARD, PINNED_WIDGET, WIDGET_GALLERY } from "@/lib/dashboard-defaults";
import {
  compactLayout,
  GRID_COLUMNS,
  moveWidget,
  normalizeWidgets,
  resizeWidget,
  type LayoutItem,
} from "@/lib/dashboard-layout";
import { isPinnedWidget } from "@/lib/widget-config";

const item = (id: string, x: number, y: number, w = 4, h = 2): LayoutItem => ({ id, x, y, w, h });

function overlapping(items: LayoutItem[]): boolean {
  return items.some((a, i) =>
    items.some(
      (b, j) => i < j && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h,
    ),
  );
}

describe("rozložení dashboardu", () => {
  test("compactLayout vyřeší překryv a vytáhne widgety nahoru", () => {
    const layout = compactLayout([item("a", 0, 5), item("b", 2, 5), item("c", 8, 9)]);
    expect(layout).toEqual([item("a", 0, 0), item("b", 2, 2), item("c", 8, 0)]);
    expect(overlapping(layout)).toBe(false);
  });

  test("posun dolů a nahoru přeskočí souseda ve stejných sloupcích", () => {
    const start = [item("a", 0, 0), item("b", 0, 2), item("c", 6, 0)];
    const down = moveWidget(start, "a", "down");
    expect(down).toEqual([item("a", 0, 2), item("b", 0, 0), item("c", 6, 0)]);
    expect(moveWidget(down, "a", "up")).toEqual(start);
    expect(moveWidget(start, "a", "up")).toEqual(start);
  });

  test("posun doleva a doprava zůstane v mřížce a sousedy odsune", () => {
    const start = [item("a", 0, 0), item("b", 4, 0)];
    expect(moveWidget(start, "a", "left")).toEqual(start);
    const right = moveWidget(start, "a", "right");
    expect(right).toEqual([item("a", 1, 0), item("b", 4, 2)]);
    const edge = [item("a", GRID_COLUMNS - 4, 0)];
    expect(moveWidget(edge, "a", "right")).toEqual(edge);
  });

  test("změna velikosti je omezená na mřížku", () => {
    const [wide] = resizeWidget([item("a", 6, 0)], "a", { w: 40, h: 99 });
    expect(wide).toEqual({ id: "a", x: 0, y: 0, w: GRID_COLUMNS, h: 8 });
    const [tiny] = resizeWidget([item("a", 6, 0)], "a", { w: 0, h: 0 });
    expect(tiny).toEqual({ id: "a", x: 6, y: 0, w: 2, h: 1 });
  });

  test("karta due_alerts nejde odebrat a normalizeWidgets ji doplní", () => {
    const empty = normalizeWidgets([]);
    expect(empty).toHaveLength(1);
    expect(isPinnedWidget(empty[0]!.config)).toBe(true);

    const chart = WIDGET_GALLERY.find((entry) => entry.id === "revenue_by_month")!;
    const withChart = normalizeWidgets([{ config: chart.config, x: 0, y: 0, ...chart.size }]);
    expect(withChart.map((w) => isPinnedWidget(w.config))).toEqual([true, false]);
    expect(withChart[0]).toMatchObject({ x: 0, y: 0 });
    expect(withChart[1]).toMatchObject({ y: 4 });

    const twice = normalizeWidgets([
      { config: PINNED_WIDGET, x: 0, y: 0, w: 4, h: 4 },
      { config: PINNED_WIDGET, x: 4, y: 0, w: 4, h: 4 },
    ]);
    expect(twice).toHaveLength(1);

    const defaults = normalizeWidgets(DEFAULT_DASHBOARD.widgets);
    expect(defaults).toEqual(DEFAULT_DASHBOARD.widgets);
  });
});
