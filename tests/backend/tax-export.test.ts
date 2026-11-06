import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { TaxOverviewView } from "@/components/reports/tax-overview";
import { formatMoney } from "@/lib/money";
import { TABULAR_LIMITS } from "@/lib/safe-input/limits";
import { readXlsx } from "@/lib/safe-input/xlsx-reader";
import { TEXTS } from "@/lib/texts";
import { setClockForTests } from "@/server/clock";
import { auditLog, invoice } from "@/server/db/schema";
import { TAX_PAGE_ROWS, taxPage } from "@/server/reports/tax";
import { exportTaxOverview, taxOverview } from "@/server/services/tax-report";
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
import { pdfText } from "../helpers/pdf";

const session = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock("@/server/auth/session", () => ({
  getCurrentSession: async () => (session.userId ? { user: { id: session.userId } } : null),
  actorFromRequest: async () => ({ userId: session.userId, source: "web" }),
}));
vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-tax-export-")));

const db = createTestDb();
const T = TEXTS.tax;
const FILTER = { year: 2026, basis: "paid" as const, today: REPORT_TODAY };
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
let s: ReportScenario;

beforeAll(() => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  s = seedReportScenario(db);
});
afterAll(() => setClockForTests(null));

const flat = (text: string) => text.replace(/\s+/g, " ");

describe("výstupy daňového přehledu", () => {
  test("[TAX-003] PDF, Excel a CSV mají stejný součet a upozornění", async () => {
    const actor = webActor(s.owner);
    const csv = await exportTaxOverview(actor, FILTER, "csv");
    expect(csv).toMatchObject({
      filename: "danovy-podklad-2026-paid.csv",
      contentType: "text/csv; charset=utf-8",
    });
    const lines = (csv.body as string).replace(/^﻿/, "").split("\r\n");
    expect(lines[0]).toBe(T.disclaimer);
    expect(lines.find((line) => line.startsWith(T.incomeTotal(2026)))).toContain("41650,00");

    const xlsx = await exportTaxOverview(actor, FILTER, "xlsx");
    const sheet = await readXlsx(xlsx.body as Uint8Array, TABULAR_LIMITS);
    expect(sheet.rows[0]).toEqual([T.disclaimer]);
    expect(sheet.rows.find((row) => row[0] === T.incomeTotal(2026))).toContain("41650.00");

    const pdf = await exportTaxOverview(actor, FILTER, "pdf");
    expect(pdf.contentType).toBe("application/pdf");
    const text = flat((await pdfText(Buffer.from(pdf.body as Uint8Array))).join(" "));
    expect(text).toContain(flat(T.disclaimer));
    expect(text).toContain(flat(formatMoney(4_165_000, "CZK")));

    const audited = db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ownerId, s.owner), eq(auditLog.action, "tax.export")))
      .all();
    expect(audited.map((row) => (row.after as { format: string }).format)).toEqual([
      "csv",
      "xlsx",
      "pdf",
    ]);
    expect(JSON.stringify(audited)).not.toContain("Alfa");
  });

  test("[TAX-004] upozornění je na stránce i na každé straně PDF", async () => {
    const owner = reportOwner(db, "2026-01-02");
    const client = namedCustomer(owner, "Hromadný s.r.o.");
    for (let i = 0; i < 70; i += 1) {
      const day = String((i % 27) + 1).padStart(2, "0");
      const month = String(Math.floor(i / 27) + 1).padStart(2, "0");
      const date = `2026-${month}-${day}`;
      const id = issuedDocument(owner, client, { issueDate: date, totalMinor: 10_000 + i });
      pay(owner, id, date, 10_000 + i);
    }
    const pdf = await exportTaxOverview(webActor(owner), FILTER, "pdf");
    const pages = await pdfText(Buffer.from(pdf.body as Uint8Array));
    expect(pages.length).toBeGreaterThanOrEqual(3);
    pages.forEach((page, index) => {
      expect(flat(page), `strana ${index + 1}`).toContain(flat(T.disclaimer));
      expect(flat(page)).toContain(T.page(index + 1, pages.length));
    });

    const html = renderToStaticMarkup(
      createElement(TaxOverviewView, {
        overview: taxOverview(owner, FILTER, REPORT_TODAY),
        filter: FILTER,
        today: REPORT_TODAY,
      }),
    );
    expect(html).toContain(T.disclaimer);
    expect(html).toContain(T.reviewPending);
  });

  test("[TAX-003] export jde jen přes POST se stejným původem a přihlášením", async () => {
    const { POST } = await import("@/app/(app)/prehledy/dane/export/route");
    const request = (origin: string | null) =>
      new Request("http://localhost:3000/prehledy/dane/export", {
        method: "POST",
        headers: origin ? { origin } : {},
        body: new URLSearchParams({ rok: "2026", zaklad: "uhrada", format: "csv" }),
      });
    session.userId = s.owner;
    expect((await POST(request("https://evil.example") as never)).status).toBe(403);
    expect((await POST(request(null) as never)).status).toBe(403);
    session.userId = null;
    expect((await POST(request("http://localhost:3000") as never)).status).toBe(401);
    session.userId = s.owner;
    const response = await POST(request("http://localhost:3000") as never);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(decoder.decode(await response.arrayBuffer())).toContain(T.disclaimer);

    const strict = (fields: Record<string, string>) =>
      POST(
        new Request("http://localhost:3000/prehledy/dane/export", {
          method: "POST",
          headers: { origin: "http://localhost:3000" },
          body: new URLSearchParams(fields),
        }) as never,
      );
    const good = { rok: "2026", zaklad: "uhrada", format: "csv" };
    expect((await strict(good)).status).toBe(200);
    for (const bad of [
      { ...good, rok: "2031" },
      { ...good, rok: "abc" },
      { ...good, zaklad: "jiny" },
      { ...good, format: "docx" },
      { ...good, navic: "1" },
      { rok: "2026", zaklad: "uhrada" },
    ]) {
      expect((await strict(bad)).status, JSON.stringify(bad)).toBe(400);
    }
  });

  test("[TAX-003] souborové pole v daňovém exportu vrátí 400", async () => {
    const { POST } = await import("@/app/(app)/prehledy/dane/export/route");
    session.userId = s.owner;
    const send = (form: FormData) =>
      POST(
        new Request("http://localhost:3000/prehledy/dane/export", {
          method: "POST",
          headers: { origin: "http://localhost:3000" },
          body: form,
        }) as never,
      );
    const form = () => {
      const data = new FormData();
      data.set("rok", "2026");
      data.set("zaklad", "uhrada");
      data.set("format", "csv");
      return data;
    };
    expect((await send(form())).status).toBe(200);
    const extra = form();
    extra.set("priloha", new Blob(["x"]), "x.txt");
    expect((await send(extra)).status).toBe(400);
    const asFile = form();
    asFile.set("format", new Blob(["csv"]), "format.txt");
    expect((await send(asFile)).status).toBe(400);
  });

  test("[TAX-003] PDF nad strop řádků odkáže na Excel a audit nevznikne", async () => {
    const owner = reportOwner(db, "2026-01-02");
    const client = namedCustomer(owner, "Strop s.r.o.");
    for (let i = 1; i <= 4; i += 1) {
      const date = `2026-01-0${i + 1}`;
      pay(
        owner,
        issuedDocument(owner, client, { issueDate: date, totalMinor: 10_000 }),
        date,
        10_000,
      );
    }
    await expect(
      exportTaxOverview(webActor(owner), FILTER, "pdf", { rowLimit: 3 }),
    ).rejects.toThrow(T.errors.pdfTooLong(3));
    const audited = db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ownerId, owner), eq(auditLog.action, "tax.export")))
      .all();
    expect(audited).toEqual([]);
    expect((await exportTaxOverview(webActor(owner), FILTER, "xlsx")).filename).toMatch(/xlsx$/);
  });

  test("[TAX-003] PDF nad rozpočet textu odkáže na Excel a audit nevznikne", async () => {
    const owner = reportOwner(db, "2026-01-02");
    const client = namedCustomer(owner, "Dlouhé jméno zákazníka s.r.o.");
    pay(
      owner,
      issuedDocument(owner, client, { issueDate: "2026-01-02", totalMinor: 10_000 }),
      "2026-01-02",
      10_000,
    );
    await expect(
      exportTaxOverview(webActor(owner), FILTER, "pdf", { textBudget: 20 }),
    ).rejects.toThrow(T.errors.pdfTooMuchText);
    const audited = db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ownerId, owner), eq(auditLog.action, "tax.export")))
      .all();
    expect(audited).toEqual([]);
  });

  test("[TAX-003] 2 000 běžných řádků se do PDF vejde, identifikátory se do rozpočtu nepočítají", async () => {
    const owner = reportOwner(db, "2026-01-02");
    const client = namedCustomer(owner, "Obchodní společnost Novák a synové s.r.o.");
    const first = issuedDocument(owner, client, { issueDate: "2026-01-02", totalMinor: 10_000 });
    const row = db.select().from(invoice).where(eq(invoice.id, first)).get()!;
    db.transaction((tx) => {
      for (let i = 2; i <= 1_000; i += 1) {
        const number = `2026${String(i).padStart(6, "0")}`;
        tx.insert(invoice)
          .values({ ...row, id: randomUUID(), number, variableSymbol: number })
          .run();
      }
    });
    const filter = { ...FILTER, basis: "issued" as const };
    const overview = taxOverview(owner, filter, REPORT_TODAY);
    expect(overview.lines.length + overview.unpaid.length).toBe(2_000);
    const pdf = await exportTaxOverview(webActor(owner), filter, "pdf");
    expect(
      Buffer.from(pdf.body as Uint8Array)
        .subarray(0, 5)
        .toString(),
    ).toBe("%PDF-");
  }, 120_000);

  test("[TAX-001] stránka ukáže nejvýš strop řádků a řekne, kolik jich je", () => {
    const owner = reportOwner(db, "2026-01-02");
    const client = namedCustomer(owner, "Mnoho s.r.o.");
    for (let i = 1; i <= 4; i += 1) {
      const date = `2026-01-0${i + 1}`;
      pay(
        owner,
        issuedDocument(owner, client, { issueDate: date, totalMinor: 10_000 }),
        date,
        10_000,
      );
    }
    const full = taxOverview(owner, FILTER, REPORT_TODAY);
    const page = taxPage(full, 3);
    expect(TAX_PAGE_ROWS).toBe(2_000);
    expect(page.lines).toHaveLength(3);
    expect(page).toMatchObject({ linesCount: 4, totalCzkMinor: full.totalCzkMinor });
    const html = renderToStaticMarkup(
      createElement(TaxOverviewView, { overview: page, filter: FILTER, today: REPORT_TODAY }),
    );
    expect(html).toContain(T.truncated(3, 4));
  });
});
