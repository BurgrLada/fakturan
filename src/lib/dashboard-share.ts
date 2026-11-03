import { z } from "zod";
import { defaultSize } from "./dashboard-defaults";
import {
  dashboardNameSchema,
  GRID_COLUMNS,
  MAX_WIDGETS,
  type WidgetDraft,
} from "./dashboard-layout";
import { TEXTS } from "./texts";
import { czechError, firstJsonIssue } from "./validation-issue";
import { isPinnedWidget, widgetConfigSchema, type WidgetConfig } from "./widget-config";

// R-25: a shared file is configuration only. No ids, no account, no customers and no numbers,
// so it can travel between accounts and never says anything about the one it came from.

const S = TEXTS.dashboard.share;

export const DASHBOARD_FILE_FORMAT = "fakturan.dashboard";
export const DASHBOARD_FILE_VERSION = 1;
export const MAX_FILE_BYTES = 64 * 1024;

export type DashboardFile = {
  format: typeof DASHBOARD_FILE_FORMAT;
  v: typeof DASHBOARD_FILE_VERSION;
  name: string;
  widgets: WidgetConfig[];
};

export type ParsedDashboardFile =
  | { ok: true; file: DashboardFile }
  | { ok: false; path: string; message: string };

const fileSchema = z.strictObject({
  format: z.literal(DASHBOARD_FILE_FORMAT),
  v: z.literal(DASHBOARD_FILE_VERSION),
  name: dashboardNameSchema,
  widgets: z.array(widgetConfigSchema),
});

// Customer ids name somebody's customers, so they never leave the account; itemIds is dropped
// too in case an older or hand-written config carries it.
export function shareableConfig(config: WidgetConfig): WidgetConfig {
  if (config.kind !== "query" || !config.filters) return config;
  const {
    customerIds: _customers,
    itemIds: _items,
    ...filters
  } = config.filters as typeof config.filters & { itemIds?: unknown };
  const { filters: _filters, ...rest } = config;
  return Object.keys(filters).length > 0 ? { ...rest, filters } : rest;
}

export function toDashboardFile(name: string, widgets: WidgetConfig[]): DashboardFile {
  return {
    format: DASHBOARD_FILE_FORMAT,
    v: DASHBOARD_FILE_VERSION,
    name,
    widgets: widgets.map(shareableConfig),
  };
}

const fail = (path: string, message: string): ParsedDashboardFile => ({ ok: false, path, message });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Checks run cheapest first, so a huge or foreign file is refused before anything parses it.
export function parseDashboardFile(text: string): ParsedDashboardFile {
  if (text.length > MAX_FILE_BYTES || new TextEncoder().encode(text).length > MAX_FILE_BYTES) {
    return fail("", S.tooLarge(MAX_FILE_BYTES / 1024));
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return fail("", S.notJson);
  }
  if (!isRecord(value)) return fail("", S.foreignFormat);
  if (value.format !== DASHBOARD_FILE_FORMAT) return fail("format", S.foreignFormat);
  if (
    typeof value.v === "number" &&
    Number.isInteger(value.v) &&
    value.v > DASHBOARD_FILE_VERSION
  ) {
    return fail("v", S.newerVersion(value.v));
  }
  if (Array.isArray(value.widgets)) {
    // The import adds the due alerts card when the file has none (R-20), and it must still fit.
    const pinned = value.widgets.some((widget) => {
      const parsed = widgetConfigSchema.safeParse(widget);
      return parsed.success && isPinnedWidget(parsed.data);
    });
    if (value.widgets.length + (pinned ? 0 : 1) > MAX_WIDGETS) {
      return fail("widgets", S.tooManyWidgets(MAX_WIDGETS));
    }
  }
  const parsed = fileSchema.safeParse(value, { error: czechError });
  if (!parsed.success) {
    const { path, message } = firstJsonIssue(parsed.error);
    return fail(path, message);
  }
  return { ok: true, file: parsed.data };
}

// The file keeps the reading order, so widgets flow left to right in their default sizes.
export function placeWidgets(configs: WidgetConfig[]): WidgetDraft[] {
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  return configs.map((config) => {
    const { w, h } = defaultSize(config);
    if (x + w > GRID_COLUMNS) {
      x = 0;
      y += rowHeight;
      rowHeight = 0;
    }
    const placed = { config, x, y, w, h };
    x += w;
    rowHeight = Math.max(rowHeight, h);
    return placed;
  });
}
