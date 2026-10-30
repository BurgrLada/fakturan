import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Actor } from "@/server/audit/context";
import { setClockForTests } from "@/server/clock";
import { auditLog, rateLimit } from "@/server/db/schema";
import { RATE_RULES } from "@/server/rate-limit";
import {
  entityHistory,
  exportAuditCsv,
  listAudit,
  neutralizeCsvCell,
  parseAuditFilter,
} from "@/server/services/audit-read";
import { mutate } from "@/server/services/mutation";
import { createTestDb } from "../helpers/db";

vi.mock("next/cache", () => ({ cacheTag: vi.fn(), cacheLife: vi.fn() }));

const db = createTestDb();
const A: Actor = { userId: "user-a", source: "web" };
const B: Actor = { userId: "user-b", source: "web" };

function write(
  actor: Actor,
  action: `${string}.${string}`,
  extra: { entity?: string; entityId?: string; after?: unknown; before?: unknown } = {},
  at = new Date("2026-03-10T10:00:00Z"),
) {
  setClockForTests({ now: () => at });
  mutate(actor, action, (_tx, audit) =>
    audit({
      entity: extra.entity ?? "invoice",
      entityId: extra.entityId ?? "1",
      ownerId: actor.userId,
      scope: "user",
      before: extra.before,
      after: extra.after,
    }),
  );
  setClockForTests(null);
}

beforeEach(() => {
  db.$client.exec("DELETE FROM rate_limit");
});

describe("listAudit", () => {
  test("[AUD-007] uživatel filtruje vlastní audit a nevidí cizí", () => {
    write(A, "invoice.create", { entityId: "a1" }, new Date("2026-03-01T10:00:00Z"));
    write(A, "invoice.update", { entityId: "a1" }, new Date("2026-03-05T10:00:00Z"));
    write(A, "customer.create", { entity: "customer", entityId: "c1" });
    write(B, "invoice.create", { entityId: "b1" });
    write({ ...A, source: "import" }, "invoice.create", { entityId: "a2" });

    const all = listAudit(A, {});
    expect(all.rows.every((row) => row.ownerId === "user-a")).toBe(true);
    expect(all.rows.map((row) => row.entityId)).not.toContain("b1");

    expect(listAudit(A, { action: "invoice.update" }).rows.map((r) => r.action)).toEqual([
      "invoice.update",
    ]);
    expect(listAudit(A, { entity: "customer" }).rows.map((r) => r.entityId)).toEqual(["c1"]);
    expect(listAudit(A, { source: "import" }).rows.map((r) => r.entityId)).toEqual(["a2"]);
    expect(
      listAudit(A, { from: "2026-03-02", to: "2026-03-06" }).rows.map((r) => r.action),
    ).toEqual(["invoice.update"]);
    expect(listAudit(A, { actor: "other" }).rows).toEqual([]);
    expect(listAudit(A, { actor: "self" }).rows.length).toBe(all.rows.length);
    expect(listAudit(B, { action: "invoice.update" }).rows).toEqual([]);
  });

  test("[AUD-007] stránkování vrací hasNext a rozdíl před/po", () => {
    for (let i = 0; i < 5; i++) {
      write(B, "invoice.update", { entityId: `p${i}`, before: { n: i }, after: { n: i + 1 } });
    }
    const first = listAudit(B, { pageSize: 2 });
    expect(first.rows).toHaveLength(2);
    expect(first.hasNext).toBe(true);
    expect(first.rows[0]).toMatchObject({ before: { n: 4 }, after: { n: 5 } });
    const last = listAudit(B, { pageSize: 2, page: 3 });
    expect(last.hasNext).toBe(false);
    expect(last.page).toBe(3);
    expect(last.rows.length).toBeGreaterThan(0);
  });

  test("[AUD-007] bez přihlášeného uživatele služba odmítne čtení", () => {
    expect(() => listAudit({ userId: null, source: "system" }, {})).toThrow();
  });
});

describe("parseAuditFilter", () => {
  test("[AUD-007] neplatné hodnoty z adresy se zahodí a platné projdou", () => {
    expect(
      parseAuditFilter({
        action: "invoice.create",
        source: "hacker",
        actor: ["self", "other"],
        from: "2026-13-xx",
        to: "2026-03-31",
        page: "abc",
        entity: "",
      }),
    ).toEqual({ action: "invoice.create", actor: "self", to: "2026-03-31" });
  });
});

describe("entityHistory", () => {
  test("[AUD-009] historie entity obsahuje jen záznamy dané entity vlastníka", async () => {
    write(A, "invoice.create", { entityId: "h1" });
    write(A, "invoice.update", { entityId: "h1" });
    write(A, "invoice.update", { entityId: "h2" });
    write(B, "invoice.update", { entityId: "h1" });

    const rows = await entityHistory("user-a", "invoice", "h1");

    expect(rows.map((row) => row.action).sort()).toEqual(["invoice.create", "invoice.update"]);
    expect(rows.every((row) => row.ownerId === "user-a")).toBe(true);
  });

  test("[ARC-005] cache nepřekročí hranici účtu", async () => {
    write(A, "secret.create", { entity: "secret", entityId: "same" });
    const forB = await entityHistory("user-b", "secret", "same");
    expect(forB).toEqual([]);
    expect(await entityHistory("user-a", "secret", "same")).toHaveLength(1);
  });

  test("[ARC-005] každá položka use cache nese userId v argumentech i v tagu", () => {
    const root = join(process.cwd(), "src");
    const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter((f) =>
      /\.tsx?$/.test(f),
    );
    const cached = files.filter((f) => readFileSync(join(root, f), "utf8").includes('"use cache"'));
    expect(cached.length).toBeGreaterThan(0);
    for (const file of cached) {
      const source = readFileSync(join(root, file), "utf8");
      const blocks = source
        .split(/async function /)
        .slice(1)
        .filter((b) => b.includes('"use cache"'));
      expect(blocks.length, file).toBeGreaterThan(0);
      for (const block of blocks) {
        expect(block, file).toMatch(/^\w+\(\s*userId: string/);
        expect(block, file).toMatch(/cacheTag\(accountTag\(userId\)\)/);
      }
    }
  });
});

describe("exportAuditCsv", () => {
  test.each(["=1+1", "+cmd", "-2+3", "@SUM(A1)", "\tx", "\rx"])(
    "[EXP-008] CSV neutralizuje hodnotu %j",
    (value) => {
      expect(neutralizeCsvCell(value)).toBe(`'${value}`);
    },
  );

  test("[EXP-008] běžné hodnoty zůstanou a uvozovky se zdvojí", () => {
    expect(neutralizeCsvCell("Faktura 1")).toBe("Faktura 1");
  });

  test("[EXP-004] export obsahuje jen vlastní záznamy a zapíše se do auditu", () => {
    write(A, "invoice.create", { entityId: "x1", after: { note: "=HYPERLINK(1)" } });
    write(B, "invoice.create", { entityId: "y1" });

    const csv = exportAuditCsv(A, {});

    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toContain("x1");
    expect(csv).not.toContain("y1");
    const lines = csv.slice(1).trim().split("\r\n");
    expect(lines[0]).toContain("Čas");
    const logged = db.select().from(auditLog).where(eq(auditLog.action, "audit.export")).all();
    expect(logged.at(-1)).toMatchObject({ ownerId: "user-a", entity: "audit_log" });
  });

  test("[EXP-008] buňka z auditu začínající = je v CSV neutralizovaná", () => {
    write(A, "invoice.create", { entityId: "=cmd|calc" });
    const csv = exportAuditCsv(A, { entity: "invoice" });
    expect(csv).toContain("'=cmd|calc");
    expect(csv).not.toMatch(/(^|,)"?=cmd/m);
  });

  test("[EXP-004] export respektuje filtr", () => {
    write(A, "customer.create", { entity: "customer", entityId: "only-customer" });
    const csv = exportAuditCsv(A, { entity: "customer" });
    expect(csv).toContain("only-customer");
    expect(csv).not.toContain("x1");
  });

  test("[AUD-002] [SEC-001] export je omezený rate limitem a překročení se zapíše", () => {
    const limit = RATE_RULES.exportUser.limit;
    const rater: Actor = { userId: "user-rate", source: "web" };
    for (let i = 0; i < limit; i++) exportAuditCsv(rater, {});
    expect(() => exportAuditCsv(rater, {})).toThrow("Příliš mnoho pokusů");
    const rows = db.select().from(rateLimit).all();
    expect(rows.some((row) => row.key.startsWith("exportUser:user-rate"))).toBe(true);
    expect(
      db.select().from(auditLog).where(eq(auditLog.action, "rate_limit.exceeded")).all().length,
    ).toBeGreaterThan(0);
  });
});
