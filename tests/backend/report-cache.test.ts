import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { parseReportFilter, reportQuery } from "@/lib/report-filter";
import type { Actor } from "@/server/audit/context";
import { exchangeRate } from "@/server/db/schema";
import { mutate } from "@/server/services/mutation";
import { accountStamp, reportBundle } from "@/server/services/reports";
import {
  issuedDocument,
  namedCustomer,
  pay,
  REPORT_TODAY,
  reportOwner,
} from "../fixtures/report-scenario";
import { createTestDb } from "../helpers/db";
import { recordStatements } from "../helpers/statements";
import { setClockForTests } from "@/server/clock";

const cache = vi.hoisted(() => ({ cacheLife: vi.fn(), cacheTag: vi.fn() }));
vi.mock("next/cache", () => cache);

vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-report-cache-")));

const db = createTestDb();
const { cachedReport } = await import("@/server/report-cache");

afterAll(() => setClockForTests(null));
beforeEach(() => {
  cache.cacheLife.mockClear();
  cache.cacheTag.mockClear();
});

function touch(actor: Actor, ownerId: string) {
  mutate(actor, "invoice.update", (_tx, audit) =>
    audit({ entity: "invoice", entityId: "x", ownerId, scope: "user" }),
  );
}

describe("razítko dat účtu", () => {
  test("[ARC-005] accountStamp se změní po mutaci z webu i z plánovače", () => {
    const owner = reportOwner(db);
    const first = accountStamp(owner);
    touch({ userId: owner, source: "web" }, owner);
    const afterWeb = accountStamp(owner);
    expect(afterWeb).not.toBe(first);
    touch({ userId: null, source: "scheduler" }, owner);
    const afterScheduler = accountStamp(owner);
    expect(afterScheduler).not.toBe(afterWeb);
    expect(accountStamp(owner)).toBe(afterScheduler);
  });

  test("[ARC-005] mutace účtu A nezmění razítko účtu B", () => {
    const a = reportOwner(db);
    const b = reportOwner(db);
    const before = accountStamp(b);
    touch({ userId: a, source: "web" }, a);
    touch({ userId: null, source: "scheduler" }, a);
    expect(accountStamp(b)).toBe(before);
  });

  test("[ARC-005] nový lístek ČNB změní razítko všem účtům", () => {
    const a = reportOwner(db);
    const b = reportOwner(db);
    const before = [accountStamp(a), accountStamp(b)];
    db.insert(exchangeRate)
      .values({
        currency: "EUR",
        listDate: "2030-01-02",
        rateMicros: 25_000_000,
        fetchedAt: new Date("2030-01-02T13:00:00Z"),
      })
      .run();
    expect(accountStamp(a)).not.toBe(before[0]);
    expect(accountStamp(b)).not.toBe(before[1]);
  });
});

describe("razítko nad velkým auditem", () => {
  test("[ARC-005] accountStamp nad 100 000 záznamy auditu použije index", () => {
    const owner = reportOwner(db);
    const other = reportOwner(db);
    db.$client
      .prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100000)
         INSERT INTO audit_log (at, owner_id, source, scope, action, entity)
         SELECT 1700000000000 + i, CASE WHEN i % 4 = 0 THEN ? ELSE ? END, 'web', 'user',
                'invoice.update', 'invoice'
         FROM n`,
      )
      .run(other, owner);
    const { result, statements } = recordStatements(db, () => accountStamp(owner));
    const auditQuery = statements.find((source) => source.includes('"audit_log"'))!;
    const plan = db.$client
      .prepare(`EXPLAIN QUERY PLAN ${auditQuery}`)
      .all(owner)
      .map((row) => (row as { detail: string }).detail)
      .join("\n");
    expect(plan).toMatch(/USING (COVERING )?INDEX audit_log_owner_id_idx/);
    expect(plan).not.toMatch(/\bSCAN\b/);
    const newest = db.$client
      .prepare("SELECT max(id) AS id FROM audit_log WHERE owner_id = ?")
      .get(owner) as { id: number };
    expect(result.startsWith(`${newest.id}:`)).toBe(true);
  });
});

describe("cachedReport", () => {
  test("[ARC-005] položka nese tag účtu a hodiny a vrací totéž co služba pro svůj účet", async () => {
    const a = reportOwner(db);
    const b = reportOwner(db);
    const id = issuedDocument(a, namedCustomer(a, "Alfa"), {
      issueDate: "2026-03-10",
      totalMinor: 150_000,
    });
    pay(a, id, "2026-03-12", 150_000);
    setClockForTests({ now: () => new Date(`${REPORT_TODAY}T10:00:00Z`) });
    const filter = parseReportFilter({}, REPORT_TODAY);
    const query = reportQuery(filter);

    const own = await cachedReport(a, accountStamp(a), REPORT_TODAY, query);
    expect(cache.cacheTag).toHaveBeenCalledWith(`account:${a}`);
    expect(cache.cacheLife).toHaveBeenCalledWith("hours");
    expect(own).toEqual(reportBundle(a, filter, REPORT_TODAY));
    expect(own.summary.invoicedMinor).toBe(150_000);

    const other = await cachedReport(b, accountStamp(b), REPORT_TODAY, query);
    expect(cache.cacheTag).toHaveBeenLastCalledWith(`account:${b}`);
    expect(other.summary.invoicedMinor).toBe(0);
    expect(other.hasDocuments).toBe(false);
  });
});
