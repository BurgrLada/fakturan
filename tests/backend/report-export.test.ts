import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { strFromU8, unzipSync } from "fflate";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { parseReportFilter, REPORT_TABS } from "@/lib/report-filter";
import type { Money } from "@/lib/tabular";
import { setClockForTests } from "@/server/clock";
import { auditLog } from "@/server/db/schema";
import { RATE_RULES } from "@/server/rate-limit";
import { alignPrevious } from "@/server/reports/align";
import { buildSheet, exportReport, forecastUnconverted } from "@/server/services/report-export";
import { reportBundle } from "@/server/services/reports";
import {
  at,
  issuedDocument,
  namedCustomer,
  REPORT_TODAY,
  reportOwner,
  seedReportScenario,
  type ReportScenario,
} from "../fixtures/report-scenario";
import { planDocument, savePlan } from "../helpers/fixtures-recurring";
import { createTestDb } from "../helpers/db";

const session = vi.hoisted(() => ({ userId: "" }));
vi.mock("@/server/auth/session", () => ({
  getCurrentSession: async () => (session.userId ? { user: { id: session.userId } } : null),
  actorFromRequest: async () => ({ userId: session.userId || null, source: "web" }),
}));

vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-report-export-")));

const db = createTestDb();
const { POST } = await import("@/app/(app)/prehledy/export/route");

let s: ReportScenario;
const NOW = new Date(`${REPORT_TODAY}T10:00:00Z`);

beforeAll(() => {
  s = seedReportScenario(db);
  setClockForTests({ now: () => NOW });
});
beforeEach(() => {
  db.$client.exec("DELETE FROM rate_limit");
  setClockForTests({ now: () => NOW });
});
afterAll(() => setClockForTests(null));

const filter = (params: Record<string, string> = {}) => parseReportFilter(params, REPORT_TODAY);
const bundle = () => reportBundle(s.owner, filter(), REPORT_TODAY);
const totalRow = (rows: ReturnType<typeof buildSheet>["rows"]) =>
  rows.find((row) => row[0]?.kind === "text" && row[0].value === "Celkem")!;
const minor = (cell: unknown) => (cell as Money).minor;

describe("listy přehledů", () => {
  test("[REP-004] každý přehled má list a součty souhlasí s fakturací", () => {
    const data = bundle();
    for (const tab of REPORT_TABS) {
      const sheet = buildSheet(tab, data);
      expect(sheet.columns.length, tab).toBeGreaterThan(1);
      expect(sheet.rows.length, tab).toBeGreaterThan(0);
      for (const row of sheet.rows) expect(row.length, tab).toBe(sheet.columns.length);
    }
    expect(minor(totalRow(buildSheet("fakturace", data).rows)[1])).toBe(4_410_000);
    expect(minor(totalRow(buildSheet("uhrady", data).rows)[1])).toBe(4_165_000);
    expect(minor(totalRow(buildSheet("zakaznici", data).rows)[1])).toBe(4_410_000);
    expect(minor(totalRow(buildSheet("polozky", data).rows)[1])).toBe(4_410_000);
    const aging = buildSheet("pohledavky", data).rows;
    const cell = (label: string) =>
      minor(aging.find((row) => (row[0] as { value: string }).value === label)![1]);
    expect(cell("Pohledávky celkem")).toBe(200_000);
    expect(cell("Neuhrazené zálohy")).toBe(200_000);
    expect(buildSheet("limity", data).columns).toEqual([
      "Limit",
      "Hranice",
      "Obrat",
      "Využito (%)",
      "Stav",
    ]);
  });

  test("[REP-004] dobropis -2 500,00 Kč je v CSV číslo a sedí s XLSX", () => {
    setClockForTests({ now: () => NOW });
    const csv = exportReport({ userId: s.owner, source: "web" }, filter(), "csv", REPORT_TODAY);
    expect(csv.filename).toBe("statistiky-fakturace-2026-01-01-2026-12-31.csv");
    expect(csv.body).toContain("duben 2026;-2500,00;0,00\r\n");
    expect(csv.body).toContain("Celkem;44100,00;");

    const xlsx = exportReport(
      { userId: s.owner, source: "web" },
      filter({ zalozka: "fakturace" }),
      "xlsx",
      REPORT_TODAY,
    );
    expect(xlsx.filename).toBe("statistiky-fakturace-2026-01-01-2026-12-31.xlsx");
    const sheet = strFromU8(unzipSync(xlsx.body as Uint8Array)["xl/worksheets/sheet1.xml"]!);
    expect(sheet).toContain("<v>-2500.00</v>");
    expect(sheet).toContain("<v>44100.00</v>");

    const logged = db.select().from(auditLog).where(eq(auditLog.action, "report.export")).all();
    expect(logged.at(-1)).toMatchObject({
      ownerId: s.owner,
      entity: "report",
      entityId: "fakturace",
      after: { format: "xlsx", from: "2026-01-01", to: "2026-12-31", currency: null },
    });
  });

  test("statistiky po přepnutí na EUR neukazují CZK a nesčítají měny", () => {
    const eur = reportBundle(s.owner, filter({ mena: "EUR" }), REPORT_TODAY);
    expect(eur.currency).toBe("EUR");
    expect(eur.summary.invoicedMinor).toBe(90_000);
    const sheet = buildSheet("fakturace", eur);
    const currencies = new Set(
      sheet.rows.flat().flatMap((cell) => (cell?.kind === "money" ? [cell.currency] : [])),
    );
    expect([...currencies]).toEqual(["EUR"]);
  });
});

const label = (cell: unknown) => (cell as { value: string } | null)?.value;

describe("doklady bez kurzu a zarovnání období", () => {
  test("[REP-003] předpověď i její export ukážou doklady bez kurzu", () => {
    const owner = reportOwner(db);
    const customer = namedCustomer(owner, "Alfa s.r.o.");
    at(REPORT_TODAY);
    savePlan(owner, customer, {
      startsOn: "2026-11-01",
      document: planDocument({ currency: "USD", paymentMethod: "cash" }),
    });
    setClockForTests({ now: () => NOW });
    const data = reportBundle(owner, filter({ zalozka: "predpoved" }), REPORT_TODAY);
    expect(forecastUnconverted(data.forecast)).toEqual({
      count: 6,
      byCurrency: [{ currency: "USD", amountMinor: 600_000 }],
    });
    const sheet = buildSheet("predpoved", data);
    const missing = sheet.rows.find((row) => label(row[0]) === "6 dokladů bez kurzu (USD)");
    expect(missing).toBeDefined();
    expect(missing![1]).toEqual({ kind: "money", minor: 600_000, currency: "USD" });
    expect(missing).toHaveLength(sheet.columns.length);
  });

  test("[REP-001] vlastní rozsah porovná předchozí koše od konce a součet sedí se souhrnem", () => {
    const owner = reportOwner(db, "2025-09-01");
    const customer = namedCustomer(owner, "Alfa s.r.o.");
    issuedDocument(owner, customer, { issueDate: "2025-12-05", totalMinor: 30_000 });
    issuedDocument(owner, customer, { issueDate: "2026-01-10", totalMinor: 50_000 });
    issuedDocument(owner, customer, { issueDate: "2026-02-10", totalMinor: 70_000 });
    issuedDocument(owner, customer, { issueDate: "2026-03-01", totalMinor: 20_000 });
    issuedDocument(owner, customer, { issueDate: "2026-04-10", totalMinor: 90_000 });
    setClockForTests({ now: () => NOW });
    const data = reportBundle(
      owner,
      filter({ obdobi: "vlastni", od: "2026-03-02", do: "2026-05-31" }),
      REPORT_TODAY,
    );
    expect(data.previousRange).toEqual({ from: "2025-12-01", to: "2026-03-01" });
    expect(data.previousInvoiced.points).toHaveLength(4);
    expect(data.invoiced.points).toHaveLength(3);

    expect(alignPrevious(data.invoiced, data.previousInvoiced)).toEqual([80_000, 70_000, 20_000]);
    const rows = buildSheet("fakturace", data).rows;
    expect(rows.slice(0, 3).map((row) => [label(row[0]), minor(row[1]), minor(row[2])])).toEqual([
      ["březen 2026", 0, 80_000],
      ["duben 2026", 90_000, 70_000],
      ["květen 2026", 0, 20_000],
    ]);
    expect(minor(totalRow(rows)[2])).toBe(data.previous.invoicedMinor);
    expect(data.previous.invoicedMinor).toBe(170_000);
  });

  test("[DSH-015] export běžícího měsíce páruje dny od začátku jako stránka", () => {
    const today = "2026-11-06";
    const owner = reportOwner(db, "2026-09-01");
    const customer = namedCustomer(owner, "Den s.r.o.");
    for (let day = 1; day <= 6; day++) {
      issuedDocument(owner, customer, { issueDate: `2026-11-0${day}`, totalMinor: day * 100 });
      issuedDocument(owner, customer, { issueDate: `2026-10-0${day}`, totalMinor: day * 1_000 });
    }
    setClockForTests({ now: () => new Date(`${today}T10:00:00Z`) });
    const data = reportBundle(owner, parseReportFilter({ obdobi: "mesic" }, today), today);

    expect(data.anchor).toBe("start");
    const rows = buildSheet("fakturace", data).rows;
    expect(rows.slice(0, 6).map((row) => [minor(row[1]), minor(row[2])])).toEqual([
      [100, 1_000],
      [200, 2_000],
      [300, 3_000],
      [400, 4_000],
      [500, 5_000],
      [600, 6_000],
    ]);
    expect(minor(totalRow(rows)[2])).toBe(data.previous.invoicedMinor);
  });

  test("[REP-001] kratší předchozí období se doplní nulou na začátku", () => {
    const current = {
      points: [1, 2, 3].map((n) => ({ key: `k${n}`, amountMinor: n })),
      unconverted: { count: 0, byCurrency: [] },
    };
    const previous = {
      points: [
        { key: "a", amountMinor: 5 },
        { key: "b", amountMinor: 7 },
      ],
      unconverted: { count: 0, byCurrency: [] },
    };
    expect(alignPrevious(current, previous)).toEqual([0, 5, 7]);
  });
});

function request(origin: string | null, body: Record<string, string> = {}) {
  const form = new FormData();
  for (const [key, value] of Object.entries(body)) form.set(key, value);
  return new Request("http://localhost:3000/prehledy/export", {
    method: "POST",
    headers: origin ? { origin } : {},
    body: form,
  }) as never;
}

describe("route exportu", () => {
  test("[REP-004] cizí origin dostane 403 a překročený limit 429", async () => {
    session.userId = s.owner;
    expect((await POST(request("https://evil.example"))).status).toBe(403);
    expect((await POST(request(null))).status).toBe(403);

    const ok = await POST(
      request("http://localhost:3000", {
        zalozka: "pohledavky",
        format: "xlsx",
        obdobi: "minuly-rok",
      }),
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-disposition")).toBe(
      'attachment; filename="statistiky-pohledavky-2025-01-01-2025-12-31.xlsx"',
    );
    expect(ok.headers.get("cache-control")).toBe("no-store");
    const files = unzipSync(new Uint8Array(await ok.arrayBuffer()));
    expect(strFromU8(files["xl/worksheets/sheet1.xml"]!)).toContain("Ve splatnosti");

    const odd = await POST(request("http://localhost:3000", { zalozka: "../x", format: "exe" }));
    expect(odd.headers.get("content-disposition")).toBe(
      'attachment; filename="statistiky-fakturace-2026-01-01-2026-12-31.csv"',
    );

    for (let i = 2; i < RATE_RULES.exportUser.limit; i++) {
      expect((await POST(request("http://localhost:3000"))).status).toBe(200);
    }
    expect((await POST(request("http://localhost:3000"))).status).toBe(429);

    session.userId = "";
    expect((await POST(request("http://localhost:3000"))).status).toBe(401);
  });
});
