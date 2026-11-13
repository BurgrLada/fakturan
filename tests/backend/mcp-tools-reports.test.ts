import { randomUUID } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { and, desc, eq } from "drizzle-orm";
import { describe, expect, test, vi } from "vitest";
import { clock } from "@/server/clock";
import { customer, exchangeRate, importBatch, mcpCallLog } from "@/server/db/schema";
import { getInvoice } from "@/server/services/invoices";
import { createTestDb } from "../helpers/db";
import { issuedInvoice, seedCustomer, seedSupplier } from "../helpers/fixtures-mail";
import { callTool, lastAuditSource, mcpAccount } from "../helpers/mcp-tools";

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

const db = createTestDb();
const NOT_FOUND = /nenalezen|neexistuje/i;

type Level = "read" | "drafts" | "accounting" | "issue_send" | "full";
type Data = Record<string, any>;
const data = (result: CallToolResult): Data => {
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  return result.structuredContent as Data;
};
const textOf = (result: CallToolResult) =>
  result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");

async function account(level: Level = "full") {
  const { ownerId, claims } = await mcpAccount(db, { level });
  seedSupplier(ownerId);
  return { ownerId, claims };
}

const lastCall = (ownerId: string, tool: string) =>
  db
    .select()
    .from(mcpCallLog)
    .where(and(eq(mcpCallLog.ownerId, ownerId), eq(mcpCallLog.tool, tool)))
    .orderBy(desc(mcpCallLog.id))
    .get();

// A finished import that brought one new customer, so undoing it has something to take back.
function doneBatch(ownerId: string) {
  const id = randomUUID();
  const now = clock.now();
  db.insert(importBatch)
    .values({
      id,
      userId: ownerId,
      kind: "isdoc",
      status: "done",
      summary: { invoices: 0, customers: 1 },
      createdAt: now,
      updatedAt: now,
      committedAt: now,
    })
    .run();
  const customerId = seedCustomer(ownerId);
  db.update(customer).set({ importBatchId: id }).where(eq(customer.id, customerId)).run();
  return { id, customerId };
}

describe("přehledy", () => {
  test("get_report se shoduje s get_overview za stejné období", async () => {
    const { ownerId, claims } = await account("read");
    issuedInvoice(ownerId);
    const today = clock.now().toISOString().slice(0, 10);
    const period = { from: `${today.slice(0, 4)}-01-01`, to: today };
    const overview = data(await callTool("get_overview", claims, period));
    const report = data(await callTool("get_report", claims, period));
    expect(report.range).toEqual(period);
    expect(report.currency).toBe("CZK");
    for (const key of ["invoiced", "income", "outstanding", "overdue", "advanceOpen"]) {
      expect(report.summary[key].amount).toBe(overview[key].amount);
    }
    expect(report.summary.invoiced.amount).toBeGreaterThan(0);
    expect(report.customers.length).toBeGreaterThan(0);
    expect(textOf(await callTool("get_report", claims, period))).toContain("Alfa s.r.o.");
  });

  test("get_report odmítne období s obráceným pořadím dat", async () => {
    const { claims } = await account("read");
    const result = await callTool("get_report", claims, { from: "2026-05-01", to: "2026-01-01" });
    expect(result.isError).toBe(true);
  });

  test("get_tax_overview vrátí řádky za rok podle data vystavení", async () => {
    const { ownerId, claims } = await account("read");
    const id = issuedInvoice(ownerId);
    const year = Number(clock.now().toISOString().slice(0, 4));
    const got = data(await callTool("get_tax_overview", claims, { year, basis: "issued" }));
    expect(got).toMatchObject({ year, basis: "issued" });
    expect(got.lines.map((line: Data) => line.number)).toContain(getInvoice(ownerId, id)!.number);
    expect(got.total.amount).toBeGreaterThan(0);
  });
});

describe("hledání", () => {
  test("quick_search s jedním znakem vrátí prázdný výsledek", async () => {
    const { ownerId, claims } = await account("read");
    seedCustomer(ownerId);
    expect(data(await callTool("quick_search", claims, { query: "A" }))).toEqual({
      hits: [],
      limited: false,
    });
  });

  test("quick_search najde zákazníka a fakturu", async () => {
    const { ownerId, claims } = await account("read");
    issuedInvoice(ownerId);
    const got = data(await callTool("quick_search", claims, { query: "Alfa" }));
    expect(got.hits.map((hit: Data) => hit.group)).toEqual(
      expect.arrayContaining(["invoice", "customer"]),
    );
    expect(got.hits[0].link).toMatch(/^http/);
  });
});

describe("historie změn", () => {
  test("list_audit nevrací ip ani userAgent", async () => {
    const { ownerId, claims } = await account("read");
    seedCustomer(ownerId);
    const got = data(await callTool("list_audit", claims, { entity: "customer" }));
    expect(got.rows.length).toBeGreaterThan(0);
    for (const row of got.rows) {
      expect(row).not.toHaveProperty("ip");
      expect(row).not.toHaveProperty("userAgent");
      expect(row).not.toHaveProperty("requestId");
      expect(row.entity).toBe("customer");
    }
  });

  test("get_entity_history vrátí změny jedné faktury, cizí faktura nemá žádné", async () => {
    const { ownerId, claims } = await account("read");
    const id = issuedInvoice(ownerId);
    const got = data(
      await callTool("get_entity_history", claims, { entity: "invoice", entityId: id }),
    );
    expect(got.rows.length).toBeGreaterThan(0);
    expect(got.rows.every((row: Data) => row.entityId === id)).toBe(true);
    expect(got.rows[0]).not.toHaveProperty("ip");

    const other = await account();
    const foreign = issuedInvoice(other.ownerId);
    const none = data(
      await callTool("get_entity_history", claims, { entity: "invoice", entityId: foreign }),
    );
    expect(none.rows).toEqual([]);
  });
});

describe("importy", () => {
  test("undo_import vrátí dávku a audit má zdroj mcp", async () => {
    const { ownerId, claims } = await account("full");
    const { id, customerId } = doneBatch(ownerId);
    const listed = data(await callTool("list_import_batches", claims, {}));
    expect(listed.batches).toContainEqual(expect.objectContaining({ id, status: "done" }));

    const got = data(await callTool("undo_import", claims, { id }));
    expect(got).toMatchObject({ id, status: "undone" });
    expect(db.select().from(customer).where(eq(customer.id, customerId)).get()).toBeUndefined();
    expect(lastAuditSource(db, ownerId)).toBe("mcp");
  });

  test("undo_import vyžaduje plný přístup", async () => {
    const { ownerId, claims } = await account("issue_send");
    const { id } = doneBatch(ownerId);
    const result = await callTool("undo_import", claims, { id });
    expect(result.isError).toBe(true);
    expect(lastCall(ownerId, "undo_import")).toMatchObject({
      outcome: "denied",
      requiredLevel: "full",
    });
  });

  test("[MCP-074] cizí import se chová jako neexistující", async () => {
    const other = await account();
    const { id } = doneBatch(other.ownerId);
    const { claims } = await account("full");
    expect(textOf(await callTool("undo_import", claims, { id }))).toMatch(NOT_FOUND);
    const batch = db.select().from(importBatch).where(eq(importBatch.id, id)).get();
    expect(batch?.status).toBe("done");
  });
});

describe("kurz", () => {
  test("get_exchange_rate vrátí kurz ČNB z uloženého lístku", async () => {
    const { claims } = await account("read");
    const today = clock.now().toISOString().slice(0, 10);
    db.insert(exchangeRate)
      .values({ currency: "USD", listDate: today, rateMicros: 21_456_000, fetchedAt: clock.now() })
      .onConflictDoNothing()
      .run();
    const got = data(await callTool("get_exchange_rate", claims, { currency: "USD", date: today }));
    expect(got).toMatchObject({ currency: "USD", rate: "21,456", source: "cnb", listDate: today });
  });
});
