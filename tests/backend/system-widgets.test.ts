import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { WIDGET_GALLERY } from "@/lib/dashboard-defaults";
import { TEXTS } from "@/lib/texts";
import type { QueryWidgetConfig, SystemWidgetConfig } from "@/lib/widget-config";
import { setClockForTests } from "@/server/clock";
import { bankNotification } from "@/server/db/schema";
import { reportSummary } from "@/server/reports/queries";
import { registerSystemWidgets } from "@/server/reports/system-widgets";
import { runWidget, type WidgetContext } from "@/server/reports/widget-query";
import { setPaused } from "@/server/services/automation";
import { percentChange } from "@/components/dashboard/widget-number";
import {
  issuedDocument,
  namedCustomer,
  pay,
  REPORT_TODAY,
  reportOwner,
  seedReportScenario,
  type ReportScenario,
} from "../fixtures/report-scenario";
import { createTestDb } from "../helpers/db";
import { webActor } from "../helpers/fixtures-mail";
import { savePlan } from "../helpers/fixtures-recurring";

vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-system-widgets-")));

const db = createTestDb();
const context: WidgetContext = { today: REPORT_TODAY };
const G = TEXTS.dashboard.gallery;

let s: ReportScenario;

beforeAll(() => {
  registerSystemWidgets();
  s = seedReportScenario(db);
  savePlan(s.owner, s.customers.alfa);
  setClockForTests(null);
});
afterAll(() => setClockForTests(null));

const system = (systemId: SystemWidgetConfig["systemId"], rows?: number): SystemWidgetConfig => ({
  v: 1,
  kind: "system",
  systemId,
  title: "",
  color: "chart-1",
  format: "auto",
  ...(rows && { rows }),
});
const run = (config: SystemWidgetConfig | QueryWidgetConfig, owner = s.owner) =>
  runWidget(db, owner, config, context);
const gallery = (id: string) => WIDGET_GALLERY.find((item) => item.id === id)!.config;

function notice(owner: string, status: "pending" | "unrecognized" | "matched", amount: number) {
  const now = new Date(`${REPORT_TODAY}T10:00:00Z`);
  db.insert(bankNotification)
    .values({
      id: randomUUID(),
      userId: owner,
      dedupeKey: randomUUID(),
      bank: "fio",
      status,
      authResult: "pass",
      amountMinor: amount,
      currency: "CZK",
      paidOn: REPORT_TODAY,
      variableSymbol: String(amount),
      receivedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

// The spec names of DSH-020, in its order, and the gallery entry that covers each.
const SPEC_WIDGETS: [name: string, id: string][] = [
  ["fakturováno letos", "invoiced_this_year"],
  ["uhrazeno letos", "income_this_year"],
  ["pohledávky", "outstanding"],
  ["po splatnosti", "overdue"],
  ["tržby po měsících", "revenue_by_month"],
  ["po čtvrtletích", "revenue_by_quarter"],
  ["meziroční porovnání", "year_over_year"],
  ["top zákazníci", "top_customers"],
  ["top položky", "top_items"],
  ["poměr uhrazeno/neuhrazeno", "paid_ratio"],
  ["průměrná doba úhrady", "payment_days"],
  ["stárnutí pohledávek", "aging"],
  ["nejbližší splatnosti", "due_alerts"],
  ["nadcházející pravidelné faktury", "upcoming_recurring"],
  ["předpověď příjmů", "forecast"],
  ["nespárované platby", "unmatched_payments"],
  ["roční obrat vs. limity", "limits"],
  ["podíl měn", "currency_shares"],
  ["kumulativní obrat", "cumulative"],
  ["heatmapa fakturace", "heatmap"],
];

describe("galerie", () => {
  test("[DSH-020] galerie obsahuje všech 20 názvů ze spec a každý widget vrátí výsledek", () => {
    expect(SPEC_WIDGETS).toHaveLength(20);
    const ids = WIDGET_GALLERY.map((item) => item.id);
    for (const [name, id] of SPEC_WIDGETS) expect(ids, name).toContain(id);
    expect(WIDGET_GALLERY).toHaveLength(22);
    for (const item of WIDGET_GALLERY) {
      const result = run(item.config);
      expect(result.range, item.id).toEqual({
        from: expect.any(String),
        to: expect.any(String),
      });
      expect(result.unconverted.count, item.id).toBeGreaterThanOrEqual(0);
      if (item.config.kind === "system") {
        expect(result.kind, item.id).toBe("system");
        expect(item.config.title, item.id).toBe(G[item.config.systemId]);
      }
    }
  });

  test("předpověď, stárnutí a poměr úhrad dávají řádky nebo série", () => {
    const forecast = run(gallery("forecast") as SystemWidgetConfig);
    expect(forecast.series.map((series) => series.key)).toEqual([
      "overdue",
      "open",
      "planned",
      "plannedDrafts",
      "advances",
    ]);
    expect(forecast.series[0]!.points).toHaveLength(6);
    const aging = run(gallery("aging") as SystemWidgetConfig);
    expect(aging.rows.map((row) => row.key)).toContain("days31to60");
    expect(aging.range).toEqual({ from: REPORT_TODAY, to: REPORT_TODAY });
    const ratio = run(gallery("paid_ratio") as SystemWidgetConfig);
    expect(ratio.rows.map((row) => row.key)).toEqual(["paid", "unpaid"]);
    expect(ratio.rows[1]!.value).toBe(200_000);
    expect(ratio.range).toEqual({ from: "2026-01-01", to: "2026-12-31" });
  });

  test("nadcházející pravidelné faktury ukazují termín dalšího vystavení", () => {
    const result = run(system("upcoming_recurring", 5));
    expect(result.detail).toMatchObject({
      kind: "upcoming_recurring",
      count: 1,
      plans: [{ name: "Správa webu", nextIssueDate: "2026-11-10" }],
    });
  });
});

describe("systémové widgety", () => {
  test("widget záloh ukazuje advanceOpenMinor a pohledávky ho nepočítají", () => {
    const summary = reportSummary(
      db,
      s.owner,
      { range: { from: REPORT_TODAY, to: REPORT_TODAY }, includeExternal: true },
      REPORT_TODAY,
    );
    const advances = run(system("open_advances", 5));
    expect(advances.total).toBe(summary.advanceOpenMinor);
    expect(advances.total).toBe(200_000);
    expect(advances.detail).toMatchObject({
      kind: "open_advances",
      count: 1,
      advances: [{ id: s.ids.f, amountDueMinor: 200_000, currency: "CZK" }],
    });
    expect(run(gallery("outstanding")).total).toBe(200_000);
    expect(run(gallery("overdue")).total).toBe(200_000);
  });

  test("nespárované platby widget ukazuje jen vlastní avíza", () => {
    const mine = reportOwner(db, REPORT_TODAY);
    const other = reportOwner(db, REPORT_TODAY);
    setClockForTests(null);
    notice(mine, "pending", 1_111);
    notice(mine, "unrecognized", 2_222);
    notice(mine, "matched", 3_333);
    notice(other, "pending", 4_444);
    const result = run(system("unmatched_payments", 5), mine);
    expect(result.detail).toMatchObject({
      kind: "unmatched_payments",
      pending: 1,
      unrecognized: 1,
    });
    const amounts = result.detail?.kind === "unmatched_payments" ? result.detail.notices : [];
    expect(amounts.map((row) => row.amountMinor).sort()).toEqual([1_111, 2_222]);
    expect(run(system("unmatched_payments", 1), mine).detail).toMatchObject({
      notices: [expect.anything()],
    });
    expect(run(system("unmatched_payments"), s.owner).detail).toMatchObject({
      notices: [],
      pending: 0,
      unrecognized: 0,
    });
  });

  test("stav automatiky ukáže pauzu hlavního vypínače", () => {
    const owner = reportOwner(db, REPORT_TODAY);
    setClockForTests(null);
    expect(run(system("automation_status"), owner).detail).toMatchObject({
      kind: "automation_status",
      paused: false,
    });
    setPaused(webActor(owner), true, { confirmed: true });
    const detail = run(system("automation_status"), owner).detail;
    expect(detail).toMatchObject({ kind: "automation_status", paused: true });
    expect(Object.keys(detail!).sort()).toEqual(
      ["kind", "paused", "sendTime", "enabled", "next"].sort(),
    );
  });

  test("[REM-009] karta nejbližších splatností vrací po splatnosti i blížící se splatnost", () => {
    const result = run(system("due_alerts", 5));
    expect(result.detail).toMatchObject({
      kind: "due_alerts",
      overdue: expect.arrayContaining([
        expect.objectContaining({ id: s.ids.e, amountDueMinor: 200_000 }),
      ]),
      dueSoon: [],
    });
  });

  test("globální filtr na systémové widgety bez období nepůsobí", () => {
    const filtered = runWidget(db, s.owner, system("aging"), {
      today: REPORT_TODAY,
      globalFilter: { period: "last_year", currency: "EUR" },
    });
    expect(filtered).toEqual(run(system("aging")));
    const ratio = runWidget(db, s.owner, gallery("paid_ratio"), {
      today: REPORT_TODAY,
      globalFilter: { period: "last_year" },
    });
    expect(ratio.range).toEqual({ from: "2025-01-01", to: "2025-12-31" });
    expect(ratio.total).toBe(0);
  });
});

describe("porovnání dnů do úhrady", () => {
  test("necelý průměr dnů s globálním porovnáním dá rozdíl i procento", () => {
    const owner = reportOwner(db, "2026-01-01");
    const customer = namedCustomer(owner, "Omega s.r.o.");
    for (const [issueDate, paidOn] of [
      ["2026-02-01", "2026-02-03"],
      ["2026-03-02", "2026-03-05"],
      ["2026-03-10", "2026-03-14"],
    ] as const) {
      const id = issuedDocument(owner, customer, { issueDate, totalMinor: 10_000 });
      pay(owner, id, paidOn, 10_000);
    }
    setClockForTests(null);
    const result = runWidget(db, owner, gallery("payment_days"), {
      today: REPORT_TODAY,
      globalFilter: { period: { from: "2026-03-01", to: "2026-03-31" }, compare: "previous" },
    });
    expect(result.total).toBe(3.5);
    expect(result.compare).toMatchObject({ total: 2, delta: 1.5 });
    expect(percentChange(result.total, result.compare!.total)).toBe(75);
  });
});
