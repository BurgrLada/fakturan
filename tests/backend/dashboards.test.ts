import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  addWidgetAction,
  previewWidgetAction,
  saveLayoutAction,
  updateWidgetAction,
} from "@/app/(app)/dashboardy/actions";
import { DEFAULT_DASHBOARD, WIDGET_GALLERY } from "@/lib/dashboard-defaults";
import { TEXTS } from "@/lib/texts";
import { isPinnedWidget, type WidgetConfig } from "@/lib/widget-config";
import { accountTag } from "@/server/account-cache";
import { setClockForTests } from "@/server/clock";
import { auditLog, dashboard, dashboardWidget, rateLimit, user } from "@/server/db/schema";
import { checkRateLimit } from "@/server/rate-limit";
import { RATE_RULES } from "@/server/rate-limit";
import {
  createDashboard,
  deleteDashboard,
  duplicateDashboard,
  ensureDashboards,
  exportDashboard,
  exportWidget,
  getDashboard,
  importDashboard,
  listDashboards,
  previewImport,
  renameDashboard,
  saveLayout,
  setDefaultDashboard,
} from "@/server/services/dashboards";
import { addWidget, previewWidget, removeWidget, updateWidget } from "@/server/services/widgets";
import {
  at,
  issuedDocument,
  namedCustomer,
  REPORT_TODAY,
  reportOwner,
} from "../fixtures/report-scenario";
import { createTestDb } from "../helpers/db";
import { runDashboardWorkers } from "../helpers/run-workers";

const session = vi.hoisted(() => ({ userId: "" }));
const cache = vi.hoisted(() => ({ revalidatePath: vi.fn(), updateTag: vi.fn() }));

vi.mock("@/server/auth/session", () => ({
  getCurrentSession: async () => (session.userId ? { user: { id: session.userId } } : null),
  actorFromRequest: async () => ({ userId: session.userId, source: "web" }),
}));
vi.mock("next/cache", () => cache);
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
    expect(() => createDashboard(actor(id), { name: "A", extra: 1 })).toThrow(
      new Error("extra: Neznámý klíč"),
    );
    expect(() => renameDashboard(actor(id), { id: 5, name: "A" })).toThrow(
      new Error(`id: ${E.invalid}`),
    );

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
  test("saveLayout vrátí uložené zkompaktněné pozice a česky odmítne vadný vstup", () => {
    const id = owner();
    const [home] = ensureDashboards(actor(id));
    const view = getDashboard(id, home!.id)!;
    const items = view.widgets.map(({ id: widgetId, x, y, w, h }) => ({
      id: widgetId,
      x,
      y: y + 20,
      w,
      h,
    }));
    const saved = saveLayout(actor(id), { id: home!.id, revision: view.revision, items });
    const after = getDashboard(id, home!.id)!;
    expect(saved.revision).toBe(after.revision);
    expect([...saved.items].sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      after.widgets
        .map(({ id: widgetId, x, y, w, h }) => ({ id: widgetId, x, y, w, h }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    );
    expect(saved.items.map(({ y }) => y)).toEqual(items.map(({ y }) => y - 20));

    expect(() => saveLayout(actor(id), { id: home!.id, revision: "1", items: [] })).toThrow(
      new Error("revision: Neplatný typ hodnoty"),
    );
    expect(() =>
      saveLayout(actor(id), {
        id: home!.id,
        revision: after.revision,
        items: [{ id: "a", x: -1, y: 0, w: 2, h: 2 }],
      }),
    ).toThrow(new Error("items.0.x: Hodnota je příliš malá"));
  });

  test("dashboard_widget má index začínající user_id", () => {
    const indexes = db.$client
      .prepare("SELECT name FROM pragma_index_list('dashboard_widget')")
      .all() as { name: string }[];
    const leading = indexes.map(
      ({ name }) =>
        (
          db.$client.prepare("SELECT name FROM pragma_index_info(?) WHERE seqno = 0").get(name) as {
            name: string;
          }
        ).name,
    );
    expect(leading).toContain("user_id");
  });

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

  test("[REM-009] karta je na novém i duplikovaném dashboardu a nejde odebrat", () => {
    const id = owner();
    const [home] = ensureDashboards(actor(id));
    const { id: fresh } = createDashboard(actor(id), { name: "Nový" });
    const { id: copy } = duplicateDashboard(actor(id), { id: home!.id });
    for (const dashboardId of [home!.id, fresh, copy]) {
      const pinned = getDashboard(id, dashboardId)!.widgets.filter(
        (w) => w.config && isPinnedWidget(w.config),
      );
      expect(pinned, dashboardId).toHaveLength(1);
      expect(() => removeWidget(actor(id), { id: pinned[0]!.id })).toThrow(E.pinned);
    }
  });

  test("poškozený uložený JSON vrátí jen tento widget bez konfigurace", () => {
    const id = owner();
    const [home] = ensureDashboards(actor(id));
    const [first, second] = getDashboard(id, home!.id)!.widgets;
    db.$client
      .prepare("UPDATE dashboard_widget SET config = ? WHERE id = ?")
      .run("{nejde o json", first!.id);
    db.$client
      .prepare("UPDATE dashboard_widget SET config = ? WHERE id = ?")
      .run(JSON.stringify({ v: 1, kind: "query", title: "Vadný" }), second!.id);
    const widgets = getDashboard(id, home!.id)!.widgets;
    expect(widgets.find((w) => w.id === first!.id)!.config).toBeNull();
    expect(widgets.find((w) => w.id === second!.id)!.config).toBeNull();
    expect(widgets.filter((w) => w.config !== null)).toHaveLength(widgets.length - 2);
  });

  test("[DSH-018] uložení widgetu odmítne neplatnou konfiguraci s cestou", () => {
    const id = owner();
    const [home] = ensureDashboards(actor(id));
    const config = { ...gallery("top_customers"), groupBy: "1; DROP TABLE invoice" };
    expect(() => addWidget(actor(id), { dashboardId: home!.id, config })).toThrow(
      new Error("groupBy: Nepovolená hodnota"),
    );
    expect(() =>
      addWidget(actor(id), { dashboardId: home!.id, config: { ...gallery("overdue"), v: 2 } }),
    ).toThrow(new Error("v: Nepovolená hodnota"));
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

describe("akce dashboardu", () => {
  const boxes = (dashboardId: string, ownerId: string) =>
    getDashboard(ownerId, dashboardId)!.widgets.map(({ id, x, y, w, h }) => ({ id, x, y, w, h }));

  test("[DSH-001] stará revize rozložení je odmítnutá", async () => {
    const id = owner();
    session.userId = id;
    const [home] = ensureDashboards(actor(id));
    const view = getDashboard(id, home!.id)!;
    const items = boxes(home!.id, id);
    const wider = items.map((item, index) => (index === 0 ? { ...item, w: item.w + 1 } : item));
    cache.updateTag.mockClear();
    cache.revalidatePath.mockClear();

    const byId = (list: { id: string }[]) => [...list].sort((a, b) => a.id.localeCompare(b.id));
    const saved = await saveLayoutAction({ id: home!.id, revision: view.revision, items: wider });
    if (!saved.ok) throw new Error(saved.error);
    expect(saved.revision).toBe(view.revision + 1);
    expect(byId(saved.items)).toEqual(byId(boxes(home!.id, id)));
    expect(cache.updateTag).toHaveBeenCalledWith(accountTag(id));
    expect(cache.revalidatePath).toHaveBeenCalledWith("/");
    const after = getDashboard(id, home!.id);

    expect(await saveLayoutAction({ id: home!.id, revision: view.revision, items })).toEqual({
      ok: false,
      error: E.staleLayout,
    });
    expect(getDashboard(id, home!.id)).toEqual(after);
  });

  test("[DSH-016] barva je token a hodnota mimo výčet je odmítnutá", async () => {
    const id = owner();
    session.userId = id;
    const [home] = ensureDashboards(actor(id));
    const base = gallery("revenue_by_month");
    const added = await addWidgetAction({ dashboardId: home!.id, config: base });
    if (!added.ok) throw new Error(added.error);
    const refused: [unknown, string][] = [
      [{ ...base, color: "#ff0000" }, "color: Nepovolená hodnota"],
      [{ ...base, color: "var(--chart-1)" }, "color: Nepovolená hodnota"],
      [{ ...base, format: "millions" }, "format: Nepovolená hodnota"],
      [{ ...base, labels: "ano" }, "labels: Neplatný typ hodnoty"],
    ];
    for (const [config, error] of refused) {
      expect(await updateWidgetAction({ id: added.id, config })).toEqual({ ok: false, error });
    }

    const wanted = { ...base, title: "Tržby", color: "chart-3", format: "thousands", labels: true };
    expect(await updateWidgetAction({ id: added.id, config: wanted })).toEqual({ ok: true });
    const stored = db
      .select({ config: dashboardWidget.config })
      .from(dashboardWidget)
      .where(eq(dashboardWidget.id, added.id))
      .get()!;
    expect(stored.config).toEqual(wanted);
  });

  test("[DSH-017] překročený limit náhledu vrátí chybu a nespadne", async () => {
    const id = owner();
    session.userId = id;
    expect(await previewWidgetAction({ config: gallery("invoiced_this_year") })).toMatchObject({
      ok: true,
      result: { kind: "total", total: 0 },
    });
    expect(await previewWidgetAction({ config: gallery("due_alerts") })).toMatchObject({
      ok: true,
      result: { kind: "system", detail: { kind: "due_alerts", overdue: [], dueSoon: [] } },
    });
    expect(
      await previewWidgetAction({ config: { ...gallery("heatmap"), display: "number" } }),
    ).toEqual({ ok: false, error: `groupBy: ${TEXTS.dashboard.config.numberGroup}` });
    expect(await previewWidgetAction({ config: gallery("heatmap"), extra: 1 })).toMatchObject({
      ok: false,
    });

    for (let i = 3; i < RATE_RULES.widgetPreviewUser.limit; i++) {
      checkRateLimit(id, RATE_RULES.widgetPreviewUser);
    }
    expect(await previewWidgetAction({ config: gallery("invoiced_this_year") })).toEqual({
      ok: false,
      error: "Příliš mnoho pokusů, zkuste to později",
    });
    expect(audits(id, "rate_limit.exceeded")).toHaveLength(1);
  });
});

describe("sdílení JSON", () => {
  const fixture = readFileSync(join("tests", "fixtures", "dashboards", "platny.json"), "utf8");
  const counts = (ownerId: string) => ({
    dashboards: listDashboards(ownerId).length,
    widgets: db.select().from(dashboardWidget).where(eq(dashboardWidget.userId, ownerId)).all()
      .length,
    audits: audits(ownerId).length,
  });

  function withSales(): { id: string; customerId: string } {
    const id = reportOwner(db, REPORT_TODAY);
    const customerId = namedCustomer(id, "Alfa s.r.o.");
    issuedDocument(id, customerId, { issueDate: "2026-03-02", totalMinor: 121_000 });
    at(REPORT_TODAY);
    return { id, customerId };
  }

  test("[DSH-030] export dashboardu a widgetu je JSON bez ID, účtu, zákazníků a čísel", () => {
    const { id, customerId } = withSales();
    const [home] = ensureDashboards(actor(id));
    const base = gallery("top_customers");
    const { id: widgetId } = addWidget(actor(id), {
      dashboardId: home!.id,
      config: { ...base, filters: { customerIds: [customerId], currency: "CZK" } },
    });

    const file = exportDashboard(actor(id), home!.id);
    const text = JSON.stringify(file);
    expect(file.format).toBe("fakturan.dashboard");
    expect(file.name).toBe(home!.name);
    expect(file.widgets).toHaveLength(getDashboard(id, home!.id)!.widgets.length);
    for (const secret of [id, home!.id, widgetId, customerId, "Alfa", "1210", "121000"]) {
      expect(text).not.toContain(secret);
    }
    expect(file.widgets).toContainEqual({ ...base, filters: { currency: "CZK" } });

    const single = exportWidget(actor(id), home!.id, widgetId);
    expect(single).toEqual({
      format: "fakturan.dashboard",
      v: 1,
      name: base.title,
      widgets: [{ ...base, filters: { currency: "CZK" } }],
    });
    expect(() => exportWidget(actor(id), "jiny", widgetId)).toThrow(E.notFound);
    const [other] = ensureDashboards(actor(owner()));
    expect(() => exportWidget(actor(id), other!.id, widgetId)).toThrow(E.notFound);
  });

  test("[DSH-032] náhled nezapíše nic a ukáže widgety nad vlastními daty", () => {
    const { id } = withSales();
    ensureDashboards(actor(id));
    const before = counts(id);

    const preview = previewImport(actor(id), fixture);
    expect(counts(id)).toEqual(before);
    expect(preview.name).toBe("Obchod");
    const configs = preview.widgets.map((widget) => widget.config);
    expect(configs.filter(isPinnedWidget)).toHaveLength(1);
    expect(preview.addedPinned).toBe(true);
    const invoiced = preview.widgets.find((widget) => widget.config.title === "Fakturováno letos");
    expect(invoiced).toMatchObject({ ok: true, result: { kind: "total", total: 121_000 } });
    const top = preview.widgets.find((widget) => widget.config.title === "Nejlepší zákazníci");
    expect(top).toMatchObject({ ok: true, result: { rows: [{ name: "Alfa s.r.o." }] } });

    expect(() => previewImport(actor(id), "{")).toThrow(TEXTS.dashboard.share.notJson);
    const broken = JSON.stringify({
      ...JSON.parse(fixture),
      widgets: [{ ...JSON.parse(fixture).widgets[0], display: "donut" }],
    });
    expect(() => previewImport(actor(id), broken)).toThrow(
      `widgets[0].groupBy: ${TEXTS.dashboard.config.donutCategory}`,
    );
    expect(counts(id)).toEqual(before);
  });

  test("[DSH-032] soubor nenese data a import založí nový dashboard", () => {
    const { id } = withSales();
    const [home] = ensureDashboards(actor(id));
    const homeBefore = getDashboard(id, home!.id);
    createDashboard(actor(id), { name: "Obchod" });

    const { id: imported } = importDashboard(actor(id), fixture);
    expect(imported).not.toBe(home!.id);
    expect(getDashboard(id, home!.id)).toEqual(homeBefore);
    const view = getDashboard(id, imported)!;
    expect(view.name).toBe("Obchod (2)");
    expect(view.isDefault).toBe(false);
    const titles = view.widgets.map((widget) => widget.config?.title);
    expect(titles).toEqual(
      expect.arrayContaining(JSON.parse(fixture).widgets.map((w: WidgetConfig) => w.title)),
    );
    expect(importDashboard(actor(id), fixture).id).not.toBe(imported);
    expect(listDashboards(id).map((row) => row.name)).toEqual(
      expect.arrayContaining(["Obchod", "Obchod (2)", "Obchod (3)"]),
    );
    expect(audits(id, "dashboard.import")).toHaveLength(2);
    expect(() => importDashboard(actor(id), "[]")).toThrow(TEXTS.dashboard.share.foreignFormat);
  });

  test("[DSH-032] po importu je na dashboardu karta due_alerts", () => {
    const id = owner();
    ensureDashboards(actor(id));
    const { id: imported } = importDashboard(actor(id), fixture);
    const widgets = getDashboard(id, imported)!.widgets;
    expect(widgets.filter((widget) => widget.config && isPinnedWidget(widget.config))).toHaveLength(
      1,
    );
    expect(widgets).toHaveLength(JSON.parse(fixture).widgets.length + 1);
    const twice = JSON.stringify({
      ...JSON.parse(fixture),
      widgets: [gallery("due_alerts"), gallery("due_alerts"), gallery("overdue")],
    });
    const again = getDashboard(id, importDashboard(actor(id), twice).id)!.widgets;
    expect(again.filter((widget) => widget.config && isPinnedWidget(widget.config))).toHaveLength(
      1,
    );
    expect(again).toHaveLength(2);
  });

  test("[DSH-032] filtr se zákazníky cizího účtu projde, zahodí se a náhled to řekne", () => {
    const mine = withSales();
    const stranger = withSales();
    const base = gallery("top_customers");
    const file = JSON.stringify({
      ...JSON.parse(fixture),
      widgets: [
        { ...base, title: "Cizí", filters: { customerIds: [stranger.customerId] } },
        {
          ...base,
          title: "Smíšený",
          filters: { customerIds: [stranger.customerId, mine.customerId], currency: "CZK" },
        },
      ],
    });

    const preview = previewImport(actor(mine.id), file);
    const byTitle = (title: string) => preview.widgets.find((w) => w.config.title === title)!;
    expect(byTitle("Cizí")).toMatchObject({ droppedCustomers: true });
    expect(byTitle("Cizí").config).toEqual({ ...base, title: "Cizí" });
    expect(byTitle("Smíšený")).toMatchObject({ droppedCustomers: true });
    expect(byTitle("Smíšený").config).toEqual({
      ...base,
      title: "Smíšený",
      filters: { customerIds: [mine.customerId], currency: "CZK" },
    });

    const { id } = importDashboard(actor(mine.id), file);
    const stored = JSON.stringify(getDashboard(mine.id, id)!.widgets);
    expect(stored).not.toContain(stranger.customerId);
    expect(stored).toContain(mine.customerId);
  });

  test("[AUD-002] export dashboardu a widgetu je v auditu a má limit exportů", () => {
    const id = owner();
    const [home] = ensureDashboards(actor(id));
    const widgets = getDashboard(id, home!.id)!.widgets;
    exportDashboard(actor(id), home!.id);
    exportWidget(actor(id), home!.id, widgets[0]!.id);
    expect(audits(id, "dashboard.export").map((row) => row.after)).toEqual([
      { widgets: widgets.length },
      { widgets: 1 },
    ]);
    for (let i = 2; i < RATE_RULES.exportUser.limit; i++) {
      checkRateLimit(id, RATE_RULES.exportUser);
    }
    expect(() => exportDashboard(actor(id), home!.id)).toThrow("Příliš mnoho pokusů");
    expect(audits(id, "dashboard.export")).toHaveLength(2);
  });

  test("[DSH-030] dashboard s rozbitým widgetem se neexportuje potichu bez něj", () => {
    const id = owner();
    const [home] = ensureDashboards(actor(id));
    const [first] = getDashboard(id, home!.id)!.widgets;
    db.$client
      .prepare("UPDATE dashboard_widget SET config = ? WHERE id = ?")
      .run("{nejde o json", first!.id);
    expect(() => exportDashboard(actor(id), home!.id)).toThrow(
      TEXTS.dashboard.share.brokenWidgets(1),
    );
    expect(() => exportWidget(actor(id), home!.id, first!.id)).toThrow(
      TEXTS.dashboard.share.brokenWidget,
    );
    expect(audits(id, "dashboard.export")).toHaveLength(0);
  });

  test("[DSH-032] import má limit importů a náhled stojí tolik, kolik spustí widgetů", () => {
    const id = owner();
    ensureDashboards(actor(id));
    const preview = previewImport(actor(id), fixture);
    const used = db
      .select({ count: rateLimit.count })
      .from(rateLimit)
      .where(eq(rateLimit.key, `widgetPreviewUser:${id}`))
      .get();
    expect(used?.count).toBe(preview.widgets.length);
    const left = RATE_RULES.widgetPreviewUser.limit - preview.widgets.length;
    for (let i = 0; i < left - preview.widgets.length + 1; i++) {
      checkRateLimit(id, RATE_RULES.widgetPreviewUser);
    }
    expect(() => previewImport(actor(id), fixture)).toThrow("Příliš mnoho pokusů");

    importDashboard(actor(id), fixture);
    for (let i = 1; i < RATE_RULES.importUser.limit; i++) {
      checkRateLimit(id, RATE_RULES.importUser);
    }
    const before = listDashboards(id).length;
    expect(() => importDashboard(actor(id), fixture)).toThrow("Příliš mnoho pokusů");
    expect(listDashboards(id)).toHaveLength(before);
  });
});
