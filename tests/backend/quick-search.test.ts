import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { quickSearch } from "@/app/(app)/hledani-actions";
import { rateLimit } from "@/server/db/schema";
import { setClockForTests } from "@/server/clock";
import { saveCatalogItem } from "@/server/services/catalog";
import { archiveCustomer, saveCustomer } from "@/server/services/customers";
import { issueInvoice } from "@/server/services/invoice-lifecycle";
import { listSeries, saveSeries } from "@/server/services/number-series";
import { searchAll } from "@/server/services/quick-search";
import { createTestDb } from "../helpers/db";
import { draftFor, seedOwner, webActor } from "../helpers/fixtures-mail";
import { savePlan } from "../helpers/fixtures-recurring";

const session = vi.hoisted(() => ({ userId: "" }));

vi.mock("@/server/auth/session", () => ({
  requireSession: async () => ({ user: { id: session.userId } }),
  getCurrentSession: async () => (session.userId ? { user: { id: session.userId } } : null),
  actorFromRequest: async () => ({ userId: session.userId, source: "web" }),
}));
vi.mock("next/cache", () => ({
  revalidatePath: () => {},
  revalidateTag: () => {},
  updateTag: () => {},
}));
vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-quick-search-")));

const db = createTestDb();
const NOW = new Date("2026-03-15T10:00:00Z");
setClockForTests({ now: () => NOW });

function customerNamed(owner: string, name: string, ico = ""): string {
  return saveCustomer(webActor(owner), {
    name,
    street: "Krátká 2",
    city: "Brno",
    zip: "602 00",
    country: "Česká republika",
    ico,
    dic: "",
    email: "",
    extraEmails: [],
    phone: "",
    note: "",
    dueDays: null,
    language: null,
    currency: null,
    designId: null,
    remindersEnabled: null,
  }).id;
}

function draftWithLine(owner: string, customerId: string, line: string) {
  return draftFor(owner, customerId, {
    lines: [
      {
        catalogItemId: null,
        name: line,
        description: "",
        quantityMilli: 1000,
        unit: "ks",
        unitPriceMinor: 100_000,
        discountKind: "none",
        discountValue: 0,
      },
    ],
  });
}

function catalogNamed(owner: string, name: string) {
  return saveCatalogItem(webActor(owner), {
    name,
    description: "",
    unit: "ks",
    priceMinor: 10_000,
    currency: "CZK",
    category: "",
    tags: [],
  }).id;
}

const groups = (hits: { group: string }[]) => hits.map((hit) => hit.group);

beforeEach(() => {
  db.delete(rateLimit).run();
});

describe("rychlé hledání", () => {
  test("[UI-010] najde fakturu podle čísla 2026-0001, jména zákazníka i názvu položky", () => {
    const owner = seedOwner(db, NOW);
    const series = listSeries(owner).find((row) => row.documentType === "invoice")!;
    saveSeries(webActor(owner), {
      id: series.id,
      name: series.name,
      documentType: "invoice",
      template: "{RRRR}-{NNNN}",
      reset: "yearly",
    });
    const customerId = customerNamed(owner, "Beta Stavby s.r.o.");
    const { id, revision } = draftWithLine(owner, customerId, "Pokládka dlažby");
    issueInvoice(webActor(owner), id, { revision });

    const byNumber = searchAll(owner, "2026-0001").filter((hit) => hit.group === "invoice");
    expect(byNumber).toEqual([
      {
        group: "invoice",
        id,
        label: "2026-0001",
        detail: "Beta Stavby s.r.o.",
        href: `/faktury/${id}`,
      },
    ]);
    const byCustomer = searchAll(owner, "beta stavby");
    expect(byCustomer.filter((hit) => hit.group === "invoice").map((hit) => hit.id)).toEqual([id]);
    expect(byCustomer.filter((hit) => hit.group === "customer")).toEqual([
      expect.objectContaining({ id: customerId, href: `/zakaznici/${customerId}` }),
    ]);
    expect(searchAll(owner, "DLAZBY").map((hit) => hit.id)).toEqual([id]);
  });

  test("[UI-010] koncept má popisek Koncept a archivovaný zákazník je označený", () => {
    const owner = seedOwner(db, NOW);
    const customerId = customerNamed(owner, "Epsilon Archiv s.r.o.", "27082440");
    const draft = draftWithLine(owner, customerId, "Úklid");
    archiveCustomer(webActor(owner), customerId);
    const hits = searchAll(owner, "epsilon");
    expect(hits.find((hit) => hit.group === "invoice")).toEqual(
      expect.objectContaining({ id: draft.id, label: "Koncept" }),
    );
    const customer = hits.find((hit) => hit.group === "customer");
    expect(customer?.label).toBe("Epsilon Archiv s.r.o.");
    expect(customer?.detail).toContain("Archivovaný");
  });

  test("[UI-010] najde položku ceníku a pravidelný plán bez diakritiky", () => {
    const owner = seedOwner(db, NOW);
    const itemId = catalogNamed(owner, "Údržba zahrady");
    const planId = savePlan(owner, null, { name: "Měsíční údržba" });
    const hits = searchAll(owner, "udrzba");
    expect(hits.find((hit) => hit.group === "catalog")).toEqual(
      expect.objectContaining({ id: itemId, href: `/cenik/${itemId}` }),
    );
    expect(hits.find((hit) => hit.group === "recurring")).toEqual(
      expect.objectContaining({
        id: planId,
        label: "Měsíční údržba",
        href: `/pravidelne/${planId}`,
      }),
    );
  });

  test("[UI-010] 50%_\\ se hledá doslova a nic nevrátí", () => {
    const owner = seedOwner(db, NOW);
    const customerId = customerNamed(owner, "Firma 500 let");
    draftWithLine(owner, customerId, "Sleva 50 procent");
    catalogNamed(owner, "Balík 50 kusů");
    savePlan(owner, customerId, { name: "Plán 50 x" });
    expect(searchAll(owner, "50")).not.toEqual([]);
    for (const q of ["50%_\\", "50%", "5_", "%", "\\"]) {
      expect(searchAll(owner, q), q).toEqual([]);
    }
  });

  test("[SEC-002] cizí účet se stejným jménem zákazníka nic nevrátí", () => {
    const stranger = seedOwner(db, NOW);
    const me = seedOwner(db, NOW);
    const theirs = customerNamed(stranger, "Gama Shodná s.r.o.");
    draftWithLine(stranger, theirs, "Gama Shodná práce");
    catalogNamed(stranger, "Gama Shodná položka");
    savePlan(stranger, theirs, { name: "Gama Shodná plán" });
    expect(searchAll(me, "gama shodna")).toEqual([]);

    const mine = customerNamed(me, "Gama Shodná s.r.o.");
    const hits = searchAll(me, "gama shodna");
    expect(hits.map((hit) => [hit.group, hit.id])).toEqual([["customer", mine]]);
  });

  test("[UI-010] každá skupina vrátí nejvýš 5 výsledků", () => {
    const owner = seedOwner(db, NOW);
    for (let i = 1; i <= 7; i += 1) {
      const customerId = customerNamed(owner, `Delta ${i}`);
      draftWithLine(owner, customerId, "Práce");
      catalogNamed(owner, `Delta položka ${i}`);
      savePlan(owner, customerId, { name: `Delta plán ${i}` });
    }
    const hits = searchAll(owner, "delta");
    for (const group of ["invoice", "customer", "catalog", "recurring"]) {
      expect(
        groups(hits).filter((g) => g === group),
        group,
      ).toHaveLength(5);
    }
    expect(groups(searchAll(owner, "delta", 2))).toHaveLength(8);
  });

  test("[UI-010] dotaz kratší než 2 znaky nic nehledá", () => {
    const owner = seedOwner(db, NOW);
    customerNamed(owner, "D");
    expect(searchAll(owner, "d")).toEqual([]);
    expect(searchAll(owner, " d ")).toEqual([]);
  });

  test("[SEC-001] 121. hledání za minutu vrátí limited true a prázdný seznam", async () => {
    const owner = seedOwner(db, NOW);
    customerNamed(owner, "Kappa s.r.o.");
    session.userId = owner;
    for (let i = 0; i < 120; i += 1) {
      const reply = await quickSearch("kappa");
      expect(reply.limited).toBe(false);
      expect(reply.hits).toHaveLength(1);
    }
    expect(await quickSearch("kappa")).toEqual({ hits: [], limited: true });
  });

  test("[SEC-001] [SEC-006] krátký nebo neplatný dotaz nečerpá limit", async () => {
    const owner = seedOwner(db, NOW);
    session.userId = owner;
    expect(await quickSearch("k")).toEqual({ hits: [], limited: false });
    expect(await quickSearch("x".repeat(101))).toEqual({ hits: [], limited: false });
    expect(await quickSearch(42 as unknown as string)).toEqual({ hits: [], limited: false });
    expect(db.select().from(rateLimit).all()).toEqual([]);
  });
});
