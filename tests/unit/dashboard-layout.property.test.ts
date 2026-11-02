import fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  compactLayout,
  GRID_COLUMNS,
  MAX_H,
  MIN_H,
  MIN_W,
  moveWidget,
  resizeWidget,
  type LayoutItem,
} from "@/lib/dashboard-layout";

const layoutArb = fc
  .array(
    fc.record({
      x: fc.integer({ min: -5, max: 20 }),
      y: fc.integer({ min: -5, max: 30 }),
      w: fc.integer({ min: -2, max: 20 }),
      h: fc.integer({ min: -2, max: 12 }),
    }),
    { minLength: 1, maxLength: 12 },
  )
  .map((boxes) => boxes.map((box, index) => ({ ...box, id: `w${index}` })));

const opArb = fc.oneof(
  fc.record({
    kind: fc.constant("move" as const),
    index: fc.nat(),
    direction: fc.constantFrom("left" as const, "right" as const, "up" as const, "down" as const),
  }),
  fc.record({
    kind: fc.constant("resize" as const),
    index: fc.nat(),
    w: fc.integer({ min: -3, max: 20 }),
    h: fc.integer({ min: -3, max: 12 }),
  }),
);

function assertValid(items: LayoutItem[], ids: string[]): void {
  expect(items.map((item) => item.id).sort()).toEqual([...ids].sort());
  for (const { x, y, w, h } of items) {
    expect(Number.isInteger(x) && Number.isInteger(y)).toBe(true);
    expect(x).toBeGreaterThanOrEqual(0);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(w).toBeGreaterThanOrEqual(MIN_W);
    expect(h).toBeGreaterThanOrEqual(MIN_H);
    expect(h).toBeLessThanOrEqual(MAX_H);
    expect(x + w).toBeLessThanOrEqual(GRID_COLUMNS);
  }
  for (const [i, a] of items.entries()) {
    for (const b of items.slice(i + 1)) {
      const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      expect(overlap, `${a.id} a ${b.id} se překrývají`).toBe(false);
    }
  }
}

describe("rozložení dashboardu (vlastnosti)", () => {
  test("posun widgetu mimo mřížku je omezený a nikdy se nepřekrývají", () => {
    fc.assert(
      fc.property(layoutArb, fc.array(opArb, { maxLength: 15 }), (start, ops) => {
        const ids = start.map((item) => item.id);
        let items = compactLayout(start);
        assertValid(items, ids);
        for (const op of ops) {
          const id = ids[op.index % ids.length]!;
          items =
            op.kind === "move"
              ? moveWidget(items, id, op.direction)
              : resizeWidget(items, id, { w: op.w, h: op.h });
          assertValid(items, ids);
        }
      }),
      { numRuns: 300 },
    );
  });

  test("compactLayout je idempotentní", () => {
    fc.assert(
      fc.property(layoutArb, (start) => {
        const once = compactLayout(start);
        expect(compactLayout(once)).toEqual(once);
      }),
    );
  });
});
