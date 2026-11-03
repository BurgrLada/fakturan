import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  DASHBOARD_FILE_FORMAT,
  MAX_FILE_BYTES,
  parseDashboardFile,
  placeWidgets,
  shareableConfig,
  toDashboardFile,
} from "@/lib/dashboard-share";
import { WIDGET_GALLERY } from "@/lib/dashboard-defaults";
import { MAX_WIDGETS } from "@/lib/dashboard-layout";
import { TEXTS } from "@/lib/texts";
import type { WidgetConfig } from "@/lib/widget-config";

const S = TEXTS.dashboard.share;
const C = TEXTS.dashboard.config;
const dir = join("tests", "fixtures", "dashboards");
const fixture = (name: string) => readFileSync(join(dir, name), "utf8");
const invalid = (name: string) => fixture(join("neplatne", name));
const gallery = (id: string): WidgetConfig => WIDGET_GALLERY.find((item) => item.id === id)!.config;

describe("export", () => {
  test("[DSH-030] export dashboardu a widgetu je JSON bez ID, účtu, zákazníků a čísel", () => {
    const file = toDashboardFile("Obchod", [gallery("revenue_by_month"), gallery("due_alerts")]);
    const text = JSON.stringify(file);

    expect(file).toEqual({
      format: DASHBOARD_FILE_FORMAT,
      v: 1,
      name: "Obchod",
      widgets: [gallery("revenue_by_month"), gallery("due_alerts")],
    });
    expect(text).not.toMatch(
      /"(id|userId|user_id|ownerId|dashboardId|result|series|total|value)":/,
    );
    const parsed = parseDashboardFile(text);
    expect(parsed).toEqual({ ok: true, file });
  });

  test("[DSH-030] export zahodí customerIds a itemIds", () => {
    const base = gallery("top_customers");
    if (base.kind !== "query") throw new Error("query widget expected");
    const withIds = {
      ...base,
      filters: { customerIds: ["c-1", "c-2"], itemIds: ["i-1"], currency: "EUR" },
    } as unknown as WidgetConfig;
    const onlyIds = { ...base, filters: { customerIds: ["c-1"] } } as WidgetConfig;

    expect(shareableConfig(withIds)).toEqual({ ...base, filters: { currency: "EUR" } });
    expect(shareableConfig(onlyIds)).toEqual(base);
    const text = JSON.stringify(toDashboardFile("Obchod", [withIds, onlyIds]));
    expect(text).not.toContain("customerIds");
    expect(text).not.toContain("itemIds");
    expect(text).not.toContain("c-1");
  });
});

describe("import", () => {
  test("[DSH-031] rozbitý JSON, cizí formát, vyšší verze, 51 widgetů a soubor nad 64 KiB mají konkrétní chybu", () => {
    expect(invalid("nad-64-kib.json").length).toBeGreaterThan(MAX_FILE_BYTES);
    expect(parseDashboardFile(invalid("nad-64-kib.json"))).toEqual({
      ok: false,
      path: "",
      message: S.tooLarge(64),
    });
    expect(parseDashboardFile(invalid("rozbity-json.json"))).toEqual({
      ok: false,
      path: "",
      message: S.notJson,
    });
    expect(parseDashboardFile(invalid("cizi-format.json"))).toEqual({
      ok: false,
      path: "format",
      message: S.foreignFormat,
    });
    expect(parseDashboardFile("[]")).toEqual({ ok: false, path: "", message: S.foreignFormat });
    expect(parseDashboardFile(invalid("vyssi-verze.json"))).toEqual({
      ok: false,
      path: "v",
      message: S.newerVersion(2),
    });
    expect(parseDashboardFile(invalid("51-widgetu.json"))).toEqual({
      ok: false,
      path: "widgets",
      message: S.tooManyWidgets(MAX_WIDGETS),
    });
    // A multi-byte name counts in bytes, not characters.
    const wide = JSON.stringify({ format: DASHBOARD_FILE_FORMAT, v: 1, name: "Ž".repeat(33_000) });
    expect(wide.length).toBeLessThan(MAX_FILE_BYTES);
    expect(parseDashboardFile(wide)).toMatchObject({ ok: false, message: S.tooLarge(64) });
  });

  test("[DSH-031] neplatný widget uvede cestu widgets[3].groupBy a nic nezmění", () => {
    expect(parseDashboardFile(invalid("spatne-seskupeni.json"))).toEqual({
      ok: false,
      path: "widgets[3].groupBy",
      message: C.groupBy,
    });
    const valid = JSON.parse(fixture("platny.json"));
    expect(parseDashboardFile(JSON.stringify({ ...valid, name: "" }))).toEqual({
      ok: false,
      path: "name",
      message: TEXTS.dashboard.errors.name,
    });
    expect(parseDashboardFile(JSON.stringify({ ...valid, id: "d-1" }))).toEqual({
      ok: false,
      path: "id",
      message: C.unknownKey,
    });
  });

  test("[DSH-031] neznámý systemId a pole s kódem jsou odmítnuté", () => {
    expect(parseDashboardFile(invalid("neznamy-system.json"))).toEqual({
      ok: false,
      path: "widgets[0].systemId",
      message: C.invalidValue,
    });
    expect(parseDashboardFile(invalid("pole-s-kodem.json"))).toEqual({
      ok: false,
      path: "widgets[0].code",
      message: C.unknownKey,
    });
    expect(parseDashboardFile(invalid("jiny-druh.json"))).toMatchObject({
      ok: false,
      path: "widgets[0].kind",
    });
  });

  test("[DSH-032] platný soubor projde a widgety dostanou místo v mřížce bez překryvu", () => {
    const parsed = parseDashboardFile(fixture("platny.json"));
    if (!parsed.ok) throw new Error(`${parsed.path}: ${parsed.message}`);
    expect(parsed.file.name).toBe("Obchod");
    expect(parsed.file.widgets).toHaveLength(4);

    const placed = placeWidgets(parsed.file.widgets);
    expect(placed.map((widget) => widget.config)).toEqual(parsed.file.widgets);
    for (const widget of placed) expect(widget.x + widget.w).toBeLessThanOrEqual(12);
    expect(placed[0]).toMatchObject({ x: 0, y: 0 });
    expect(placed[1]!.x).toBe(placed[0]!.w);
  });

  test("[DSH-031] 50 widgetů bez karty upozornění se nevejde, protože ji import přidá", () => {
    const file = toDashboardFile("Plný", Array(MAX_WIDGETS).fill(gallery("revenue_by_month")));
    expect(parseDashboardFile(JSON.stringify(file))).toEqual({
      ok: false,
      path: "widgets",
      message: S.tooManyWidgets(MAX_WIDGETS),
    });
    const withPinned = toDashboardFile("Plný", [
      gallery("due_alerts"),
      ...Array(MAX_WIDGETS - 1).fill(gallery("revenue_by_month")),
    ]);
    expect(parseDashboardFile(JSON.stringify(withPinned)).ok).toBe(true);
  });
});
