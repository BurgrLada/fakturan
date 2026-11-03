import { describe, expect, test } from "vitest";
import { DEFAULT_DASHBOARD, PINNED_WIDGET, WIDGET_GALLERY } from "@/lib/dashboard-defaults";
import {
  clampBox,
  compactLayout,
  dashboardNameSchema,
  GRID_COLUMNS,
  layoutSchema,
  MAX_WIDGETS,
  moveWidget,
  normalizeWidgets,
  resizeWidget,
  type LayoutItem,
} from "@/lib/dashboard-layout";
import { TEXTS } from "@/lib/texts";
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

describe("rozložení dashboardu přesně", () => {
  const E = TEXTS.dashboard.errors;

  test("[DSH-002] název dashboardu se ořízne a má české chyby", () => {
    expect(dashboardNameSchema.parse("  Obchod  ")).toBe("Obchod");
    expect(dashboardNameSchema.parse("x".repeat(60))).toHaveLength(60);
    const error = (value: unknown) =>
      dashboardNameSchema.safeParse(value).error?.issues[0]?.message;
    expect(error(1)).toBe(E.name);
    expect(error("   ")).toBe(E.name);
    expect(error("x".repeat(61))).toBe(E.nameTooLong);
  });

  test("[DSH-001] rozložení přijme jen celé buňky v mezích a známé klíče", () => {
    const valid = { id: "d", revision: 1, items: [{ id: "w", x: 0, y: 1000, w: 2, h: 1 }] };
    expect(layoutSchema.parse(valid)).toEqual(valid);
    const ok = (over: object) => layoutSchema.safeParse({ ...valid, ...over }).success;
    const okItem = (over: object) => ok({ items: [{ ...valid.items[0], ...over }] });
    expect(ok({ id: "" })).toBe(false);
    expect(ok({ id: "x".repeat(64) })).toBe(true);
    expect(ok({ id: "x".repeat(65) })).toBe(false);
    expect(ok({ revision: 0 })).toBe(false);
    expect(ok({ revision: 1.5 })).toBe(false);
    expect(ok({ extra: 1 })).toBe(false);
    expect(ok({ items: Array(MAX_WIDGETS).fill(valid.items[0]) })).toBe(true);
    expect(ok({ items: Array(MAX_WIDGETS + 1).fill(valid.items[0]) })).toBe(false);
    expect(okItem({ id: "" })).toBe(false);
    expect(okItem({ id: "x".repeat(64) })).toBe(true);
    expect(okItem({ id: "x".repeat(65) })).toBe(false);
    expect(okItem({ x: -1 })).toBe(false);
    expect(okItem({ y: 1001 })).toBe(false);
    expect(okItem({ w: 0.5 })).toBe(false);
    expect(okItem({ extra: 1 })).toBe(false);
  });

  test("clampBox usekne desetinná a nekonečná čísla", () => {
    expect(clampBox(item("a", 3.7, 2.9, 4.6, 2.2))).toEqual(item("a", 3, 2, 4, 2));
    expect(clampBox(item("a", Number.NaN, -3, Infinity, Number.NaN))).toEqual(
      item("a", 0, 0, 2, 1),
    );
    expect(clampBox(item("a", 11, 20_000, 4, 9))).toEqual(item("a", 8, 10_000, 4, 8));
  });

  test("compactLayout vytáhne widget nad níže položený, s nímž sdílí sloupce", () => {
    const start = [item("a", 0, 0, 4, 1), item("b", 0, 1, 12, 2), item("c", 4, 5, 4, 1)];
    expect(compactLayout(start)).toEqual([
      item("a", 0, 0, 4, 1),
      item("b", 0, 1, 12, 2),
      item("c", 4, 0, 4, 1),
    ]);
    const touching = [item("a", 0, 0, 4, 2), item("b", 0, 2, 4, 2), item("c", 4, 0, 4, 2)];
    expect(compactLayout(touching)).toEqual(touching);
  });

  test("compactLayout řadí podle řádku, zvoleného widgetu, sloupce a pořadí", () => {
    const pair = [item("x", 0, 0, 6, 2), item("y", 0, 0, 6, 2)];
    expect(compactLayout(pair)).toEqual([item("x", 0, 0, 6, 2), item("y", 0, 2, 6, 2)]);
    expect(compactLayout(pair, "y")).toEqual([item("x", 0, 2, 6, 2), item("y", 0, 0, 6, 2)]);
    expect(compactLayout(pair, "x")).toEqual([item("x", 0, 0, 6, 2), item("y", 0, 2, 6, 2)]);
    const byColumn = [item("q", 2, 0, 6, 2), item("p", 0, 0, 6, 2)];
    expect(compactLayout(byColumn)).toEqual([item("q", 2, 2, 6, 2), item("p", 0, 0, 6, 2)]);
    const byRow = [item("low", 0, 4, 6, 2), item("high", 0, 3, 6, 2)];
    expect(compactLayout(byRow)).toEqual([item("low", 0, 2, 6, 2), item("high", 0, 0, 6, 2)]);
    const three = [item("a", 0, 0, 6, 1), item("b", 0, 0, 6, 1), item("c", 0, 0, 6, 1)];
    expect(compactLayout(three).map((box) => box.y)).toEqual([0, 1, 2]);
  });

  test("posun nahoru a dolů bere nejbližšího souseda jen ve stejných sloupcích", () => {
    const stack = [
      item("a", 0, 0, 6, 1),
      item("b", 0, 1, 6, 1),
      item("c", 0, 2, 6, 1),
      item("side", 6, 0, 6, 1),
    ];
    expect(moveWidget(stack, "c", "up")).toEqual([
      item("a", 0, 0, 6, 1),
      item("b", 0, 2, 6, 1),
      item("c", 0, 1, 6, 1),
      item("side", 6, 0, 6, 1),
    ]);
    expect(moveWidget(stack, "a", "down")).toEqual([
      item("a", 0, 1, 6, 1),
      item("b", 0, 0, 6, 1),
      item("c", 0, 2, 6, 1),
      item("side", 6, 0, 6, 1),
    ]);
    expect(moveWidget(stack, "side", "down")).toEqual(stack);
    expect(moveWidget(stack, "side", "up")).toEqual(stack);
    expect(moveWidget(stack, "c", "down")).toEqual(stack);
    const beside = [
      item("a", 0, 0, 6, 1),
      item("b", 0, 1, 6, 2),
      item("c", 0, 3, 6, 1),
      item("s1", 6, 0, 6, 2),
      item("s2", 6, 2, 6, 1),
    ];
    expect(moveWidget(beside, "c", "up")).toEqual([
      item("a", 0, 0, 6, 1),
      item("b", 0, 2, 6, 2),
      item("c", 0, 1, 6, 1),
      item("s1", 6, 0, 6, 2),
      item("s2", 6, 2, 6, 1),
    ]);
    const touching = [item("l", 0, 0, 6, 1), item("r", 6, 1, 6, 1)];
    expect(moveWidget(touching, "r", "up")).toEqual([item("l", 0, 0, 6, 1), item("r", 6, 0, 6, 1)]);
    expect(moveWidget(stack, "missing", "up")).toEqual(stack);
    expect(moveWidget([item("a", 0, 3)], "missing", "up")).toEqual([item("a", 0, 0)]);
  });

  test("posun doleva o jeden sloupec a změna velikosti u pravého okraje", () => {
    expect(moveWidget([item("a", 5, 0)], "a", "left")).toEqual([item("a", 4, 0)]);
    expect(resizeWidget([item("a", 8, 0), item("b", 0, 0)], "a", { w: 8, h: 3 })).toEqual([
      item("a", 4, 0, 8, 3),
      item("b", 0, 0),
    ]);
    expect(resizeWidget([item("a", 0, 0), item("b", 4, 0)], "b", { w: 6, h: 2 })).toEqual([
      item("a", 0, 0),
      item("b", 4, 0, 6, 2),
    ]);
  });

  test("[REM-009] normalizeWidgets dá chybějící kartu nahoru a vejde se do 50 widgetů", () => {
    const chart = WIDGET_GALLERY.find((entry) => entry.id === "revenue_by_month")!;
    const draft = { config: chart.config, x: 0, y: 0, ...chart.size };
    const full = normalizeWidgets(Array(MAX_WIDGETS).fill(draft));
    expect(full).toHaveLength(MAX_WIDGETS);
    expect(isPinnedWidget(full[0]!.config)).toBe(true);
    expect(full[0]).toMatchObject({ x: 0, y: 0, w: 4, h: 4 });
    expect(full.slice(1).every((widget) => widget.config === chart.config)).toBe(true);
    expect(normalizeWidgets(Array(MAX_WIDGETS - 1).fill(draft))).toHaveLength(MAX_WIDGETS);
    const over = normalizeWidgets(Array(MAX_WIDGETS + 3).fill(draft));
    expect(over).toHaveLength(MAX_WIDGETS);
    const pinned = { config: PINNED_WIDGET, x: 0, y: 6, w: 4, h: 4 };
    const kept = normalizeWidgets([draft, pinned, pinned]);
    expect(kept).toEqual([
      { ...draft, x: 0, y: 0 },
      { ...pinned, y: 4 },
    ]);
    const atTop = normalizeWidgets([{ ...draft, x: 0, y: 0, w: 12 }]);
    expect(atTop[0]).toMatchObject({ config: PINNED_WIDGET, y: 0 });
    expect(atTop[1]).toMatchObject({ y: 4 });
  });
});
