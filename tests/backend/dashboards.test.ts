import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_DASHBOARD, WIDGET_GALLERY } from "@/lib/dashboard-defaults";
import { TEXTS } from "@/lib/texts";
import { isPinnedWidget, type WidgetConfig } from "@/lib/widget-config";
import { setClockForTests } from "@/server/clock";
import { auditLog, dashboard, dashboardWidget, user } from "@/server/db/schema";
import { checkRateLimit } from "@/server/rate-limit";
import { RATE_RULES } from "@/server/rate-limit";
import {
  createDashboard,
  deleteDashboard,
  duplicateDashboard,
  ensureDashboards,
  getDashboard,
  listDashboards,
  renameDashboard,
  saveLayout,
  setDefaultDashboard,
} from "@/server/services/dashboards";
import { addWidget, previewWidget, removeWidget, updateWidget } from "@/server/services/widgets";
import { createTestDb } from "../helpers/db";
import { runDashboardWorkers } from "../helpers/run-workers";

vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-dashboards-")));

const db = createTestDb();
const E = TEXTS.dashboard.errors;
let counter = 0;

afterEach(() => setClockForTests(null));

function owner(): string {
  const id = `d-${++counter}-${Date.now()}`;
  const now = new Date();
  db.insert(user)
    .values({ id, name: id, email: `${id}@example.cz`, createdAt: now, updatedAt: now })
    .run();
  return id;
}

const actor = (userId: string) => ({ userId, source: "web" as const });
const gallery = (id: string): WidgetConfig => WIDGET_GALLERY.find((item) => item.id === id)!.config;

function audits(ownerId: string, action?: string) {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.ownerId, ownerId), action ? eq(auditLog.action, action) : undefined))
    .all();
}

function defaultOf(ownerId: string) {
  return listDashboards(ownerId).filter((row) => row.isDefault);
}

describe("výchozí dashboard", () => {
  test("[DSH-003] nový účet dostane jeden výchozí dashboard i při dvou souběžných voláních", async () => {
    const id = owner();
    const results = await runDashboardWorkers<{ id: string; isDefault: boolean }[]>(
      [{ ownerId: id }, { ownerId: id }, { ownerId: id }],
      db.$client.name,
    );
    for (const result of results) {
      expect(result).toEqual([expect.objectContaining({ isDefault: true })]);
    }
    expect(new Set(results.map((result) => result[0]!.id)).size).toBe(1);
    expect(listDashboards(id)).toHaveLength(1);
    expect(audits(id, "dashboard.create")).toHaveLength(1);

    const view = getDashboard(id, results[0]![0]!.id)!;
    expect(view.name).toBe(DEFAULT_DASHBOARD.name);
    expect(view.widgets).toHaveLength(DEFAULT_DASHBOARD.widgets.length);
    expect(view.widgets.filter((w) => w.config && isPinnedWidget(w.config))).toHaveLength(1);

    const before = audits(id).length;
    expect(ensureDashboards(actor(id))).toEqual(listDashboards(id));
    expect(audits(id)).toHaveLength(before);
  }, 30_000);
});

describe("správa dashboardů", () => {
  test("[DSH-002] dashboard jde založit, přejmenovat, duplikovat a smazat", () => {
    const id = owner();
    const [home] = ensureDashboards(actor(id));
    const { id: sales } = createDashboard(actor(id), { name: "  Obchod  " });
    expect(getDashboard(id, sales)).toMatchObject({ name: "Obchod", isDefault: false });
    expect(
      getDashboard(id, sales)!.widgets.map((w) => w.config && isPinnedWidget(w.config)),
    ).toEqual([true]);

    renameDashboard(actor(id), { id: sales, name: "Prodej" });
    expect(getDashboard(id, sales)!.name).toBe("Prodej");
    expect(() => renameDashboard(actor(id), { id: sales, name: " " })).toThrow(E.name);
    expect(() => renameDashboard(actor(id), { id: sales, name: "x".repeat(61) })).toThrow(
      E.nameTooLong,
    );
    expect(() => createDashboard(actor(id), { name: "A", extra: 1 })).toThrow();

    addWidget(actor(id), { dashboardId: sales, config: gallery("top_customers") });
    const { id: copy } = duplicateDashboard(actor(id), { id: sales });
    const copied = getDashboard(id, copy)!;
    expect(copied.name).toBe("Prodej (kopie)");
    expect(copied.widgets.map((w) => w.config)).toEqual(
      getDashboard(id, sales)!.widgets.map((w) => w.config),
    );

    deleteDashboard(actor(id), { id: copy });
    expect(getDashboard(id, copy)).toBeNull();
    expect(
      db.select().from(dashboardWidget).where(eq(dashboardWidget.dashboardId, copy)).all(),
    ).toEqual([]);
    expect(listDashboards(id).map((row) => row.id)).toEqual([home!.id, sales]);

    setDefaultDashboard(actor(id), { id: sales });
    expect(defaultOf(id).map((row) => row.id)).toEqual([sales]);
  });

  test("[DSH-002] smazání výchozího přenese příznak a poslední smazat nejde", () => {
    const id = owner();
    setClockForTests({ now: () => new Date("2026-11-02T08:00:00Z") });
    const [home] = ensureDashboards(actor(id));
    setClockForTests({ now: () => new Date("2026-11-02T09:00:00Z") });
    const { id: older } = createDashboard(actor(id), { name: "Starší" });
    setClockForTests({ now: () => new Date("2026-11-02T10:00:00Z") });
    const { id: newer } = createDashboard(actor(id), { name: "Novější" });
    setDefaultDashboard(actor(id), { id: newer });
    setDefaultDashboard(actor(id), { id: home!.id });

    deleteDashboard(actor(id), { id: home!.id });
    expect(defaultOf(id).map((row) => row.id)).toEqual([older]);
    deleteDashboard(actor(id), { id: older });
    expect(defaultOf(id).map((row) => row.id)).toEqual([newer]);
    expect(() => deleteDashboard(actor(id), { id: newer })).toThrow(E.lastDashboard);
    expect(listDashboards(id)).toHaveLength(1);
  });
});

describe("widgety a rozložení", () => {
  test("saveLayout se starou revizí nic nezmění", () => {
    const id = owner();
    const [home] = ensureDashboards(actor(id));
    const view = getDashboard(id, home!.id)!;
    const items = view.widgets.map(({ id: widgetId, x, y, w, h }) => ({
      id: widgetId,
      x,
      y,
      w,
      h,
    }));
    const moved = items.map((item, index) => (index === 0 ? { ...item, w: item.w + 1 } : item));

    const { revision } = saveLayout(actor(id), {
      id: home!.id,
      revision: view.revision,
      items: moved,
    });
    expect(revision).toBe(view.revision + 1);
    const after = getDashboard(id, home!.id)!;

    expect(() => saveLayout(actor(id), { id: home!.id, revision: view.revision, items })).toThrow(
      E.staleLayout,
    );
    expect(getDashboard(id, home!.id)).toEqual(after);
    expect(audits(id, "dashboard.layout")).toHaveLength(1);
    expect(audits(id, "dashboard.layout")[0]!.after).toEqual({ widgets: items.length });

    expect(() =>
      saveLayout(actor(id), { id: home!.id, revision: after.revision, items: items.slice(1) }),
    ).toThrow(E.layout);
    addWidget(actor(id), { dashboardId: home!.id, config: gallery("heatmap") });
    expect(() =>
      saveLayout(actor(id), { id: home!.id, revision: after.revision, items: moved }),
    ).toThrow(E.staleLayout);
  });

  test("odebrání a přepsání karty due_alerts služba odmítne", () => {
    const id = owner();
    const [home] = ensureDashboards(actor(id));
    const pinned = getDashboard(id, home!.id)!.widgets.find(
      (w) => w.config && isPinnedWidget(w.config),
    )!;
    expect(() => removeWidget(actor(id), { id: pinned.id })).toThrow(E.pinned);
    expect(() => updateWidget(actor(id), { id: pinned.id, config: gallery("aging") })).toThrow(
      E.pinned,
    );
    expect(() =>
      addWidget(actor(id), { dashboardId: home!.id, config: gallery("due_alerts") }),
    ).toThrow(E.duplicatePinned);
    updateWidget(actor(id), { id: pinned.id, config: { ...pinned.config!, title: "Splatnosti" } });
    expect(
      getDashboard(id, home!.id)!.widgets.find((w) => w.id === pinned.id)!.config,
    ).toMatchObject({ title: "Splatnosti" });
  });

  test("[DSH-018] uložení widgetu odmítne neplatnou konfiguraci s cestou", () => {
    const id = owner();
    const [home] = ensureDashboards(actor(id));
    const config = { ...gallery("top_customers"), groupBy: "1; DROP TABLE invoice" };
    expect(() => addWidget(actor(id), { dashboardId: home!.id, config })).toThrow(/^groupBy:/);
    expect(() =>
      addWidget(actor(id), {
        dashboardId: home!.id,
        config: { ...gallery("top_customers"), sql: "x" },
      }),
    ).toThrow("sql: Neznámý klíč");
  });

  test("náhled widgetu má vlastní limit", () => {
    const id = owner();
    expect(RATE_RULES.widgetPreviewUser).toEqual({
      name: "widgetPreviewUser",
      limit: 120,
      windowSeconds: 60,
    });
    expect(
      previewWidget(actor(id), gallery("invoiced_this_year"), { today: "2026-11-02" }).total,
    ).toBe(0);
    for (let i = 1; i < RATE_RULES.widgetPreviewUser.limit; i++) {
      checkRateLimit(id, RATE_RULES.widgetPreviewUser);
    }
    expect(() =>
      previewWidget(actor(id), gallery("invoiced_this_year"), { today: "2026-11-02" }),
    ).toThrow("Příliš mnoho pokusů");
  });

  test("[AUD-001] změny dashboardu a widgetu jsou v auditu", () => {
    const id = owner();
    const [home] = ensureDashboards(actor(id));
    const { id: second } = createDashboard(actor(id), { name: "Druhý" });
    renameDashboard(actor(id), { id: second, name: "Druhý přehled" });
    renameDashboard(actor(id), { id: second, name: "Druhý přehled" });
    const { id: copy } = duplicateDashboard(actor(id), { id: second });
    setDefaultDashboard(actor(id), { id: second });
    setDefaultDashboard(actor(id), { id: second });
    const { id: widgetId } = addWidget(actor(id), {
      dashboardId: second,
      config: gallery("overdue"),
    });
    updateWidget(actor(id), { id: widgetId, config: { ...gallery("overdue"), title: "Dluhy" } });
    removeWidget(actor(id), { id: widgetId });
    const view = getDashboard(id, second)!;
    saveLayout(actor(id), {
      id: second,
      revision: view.revision,
      items: view.widgets.map(({ id: w, x, y, h }) => ({ id: w, x, y, w: 6, h })),
    });
    deleteDashboard(actor(id), { id: copy });

    expect(audits(id).map((row) => row.action)).toEqual([
      "dashboard.create",
      "dashboard.create",
      "dashboard.rename",
      "dashboard.duplicate",
      "dashboard.set_default",
      "dashboard_widget.add",
      "dashboard_widget.update",
      "dashboard_widget.remove",
      "dashboard.layout",
      "dashboard.delete",
    ]);
    const rename = audits(id, "dashboard.rename")[0]!;
    expect(rename).toMatchObject({
      entity: "dashboard",
      entityId: second,
      before: { name: "Druhý" },
      after: { name: "Druhý přehled" },
    });
    expect(audits(id, "dashboard_widget.update")[0]).toMatchObject({
      entity: "dashboard_widget",
      before: { config: { title: TEXTS.dashboard.gallery.overdue } },
      after: { config: { title: "Dluhy" } },
    });
    expect(home).toBeDefined();
    expect(db.select().from(dashboard).where(eq(dashboard.userId, id)).all()).toHaveLength(2);
  });
});
