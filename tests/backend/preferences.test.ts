import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_PREFERENCES, defaultIssueDate } from "@/lib/preferences";
import { setClockForTests } from "@/server/clock";
import { auditLog, preferences, user } from "@/server/db/schema";
import {
  completeOnboarding,
  getPreferences,
  isOnboarded,
  savePreferences,
} from "@/server/services/preferences";
import { deleteUser, USER_OWNED_TABLES } from "@/server/services/users";
import { assertIsolated } from "../helpers/isolation";
import { createTestDb } from "../helpers/db";

vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-preferences-")));

const db = createTestDb();
const actor = (userId: string) => ({ userId, source: "web" as const });

afterEach(() => setClockForTests(null));

function seed(id: string) {
  const now = new Date();
  db.insert(user)
    .values({ id, name: id, email: `${id}@example.cz`, createdAt: now, updatedAt: now })
    .onConflictDoNothing()
    .run();
}

const rows = (ownerId: string) =>
  db.select().from(preferences).where(eq(preferences.userId, ownerId)).all();

const audits = (ownerId: string, action: string) =>
  db
    .select()
    .from(auditLog)
    .where(eq(auditLog.ownerId, ownerId))
    .all()
    .filter((row) => row.action === action);

describe("výchozí hodnoty", () => {
  test("[SET-030] nový účet dostane výchozí hodnoty bez řádku v databázi", () => {
    seed("p1");

    expect(getPreferences("p1")).toEqual(DEFAULT_PREFERENCES);
    expect(getPreferences("p1")).toMatchObject({
      dueDays: 14,
      language: "cs",
      currency: "CZK",
      designId: "cisty",
      unit: "ks",
      paymentMethod: "transfer",
      showLogo: true,
      showQr: true,
    });
    expect(rows("p1")).toEqual([]);
    expect(isOnboarded("p1")).toBe(false);
  });

  test("[SET-030] uložená hodnota se sloučí s výchozími a audituje", () => {
    seed("p2");

    savePreferences(actor("p2"), { dueDays: 30, language: "en", designId: "moderni" });

    expect(getPreferences("p2")).toEqual({
      ...DEFAULT_PREFERENCES,
      dueDays: 30,
      language: "en",
      designId: "moderni",
    });
    expect(rows("p2")).toHaveLength(1);
    const [entry] = audits("p2", "preferences.save");
    expect(entry).toMatchObject({ entity: "preferences", scope: "user" });
  });

  test("[SET-030] druhé uložení nepřepíše dřív změněné hodnoty", () => {
    seed("p3");
    savePreferences(actor("p3"), { dueDays: 7 });

    savePreferences(actor("p3"), { unit: "hod" });

    expect(getPreferences("p3")).toMatchObject({ dueDays: 7, unit: "hod" });
  });

  test("[SET-030] neplatná hodnota je odmítnuta a nic se neuloží", () => {
    seed("p4");

    expect(() => savePreferences(actor("p4"), { dueDays: -1 })).toThrow();
    expect(() => savePreferences(actor("p4"), { dueDays: 1.5 })).toThrow();
    expect(() => savePreferences(actor("p4"), { currency: "XYZ" as "CZK" })).toThrow();
    expect(() => savePreferences(actor("p4"), { language: "de" as "cs" })).toThrow();
    expect(() => savePreferences(actor("p4"), { designId: "" })).toThrow();
    expect(() => savePreferences(actor("p4"), { unit: " " })).toThrow();
    expect(rows("p4")).toEqual([]);
  });

  test("[SET-031] přepínače zobrazení se uloží", () => {
    seed("p5");

    savePreferences(actor("p5"), {
      showLogo: false,
      showQr: false,
      showQrLogo: true,
      showSignature: true,
      showDuzp: true,
    });

    expect(getPreferences("p5")).toMatchObject({
      showLogo: false,
      showQr: false,
      showQrLogo: true,
      showSignature: true,
      showDuzp: true,
    });
  });

  test("[SET-032] výchozí texty a poznámka se uloží", () => {
    seed("p6");

    savePreferences(actor("p6"), { textBefore: "Fakturuji vám", textAfter: "Děkuji", note: "N" });

    expect(getPreferences("p6")).toMatchObject({
      textBefore: "Fakturuji vám",
      textAfter: "Děkuji",
      note: "N",
    });
  });
});

describe("datum vystavení a formáty", () => {
  test("[SET-033] datum vystavení jde nastavit na poslední den minulého měsíce", () => {
    seed("d1");
    const now = new Date("2026-03-15T10:00:00Z");
    setClockForTests({ now: () => now });
    expect(defaultIssueDate(getPreferences("d1").issueDateMode, now)).toBe("2026-03-15");

    savePreferences(actor("d1"), { issueDateMode: "last_day_previous_month" });

    expect(getPreferences("d1").issueDateMode).toBe("last_day_previous_month");
    expect(defaultIssueDate(getPreferences("d1").issueDateMode, now)).toBe("2026-02-28");
  });

  test.each([
    ["2026-01-10T12:00:00Z", "2025-12-31"],
    ["2024-03-01T12:00:00Z", "2024-02-29"],
    ["2026-03-31T23:30:00Z", "2026-03-31"],
    ["2026-04-30T22:30:00Z", "2026-04-30"],
    ["2026-04-30T21:30:00Z", "2026-03-31"],
  ])("[SET-033] poslední den minulého měsíce pro %s je %s", (instant, expected) => {
    expect(defaultIssueDate("last_day_previous_month", new Date(instant))).toBe(expected);
  });

  test("[SET-033] neznámý režim data vystavení je odmítnut", () => {
    seed("d2");

    expect(() => savePreferences(actor("d2"), { issueDateMode: "tomorrow" as "today" })).toThrow();
  });

  test("[SET-034] formát data a variabilního symbolu se uloží", () => {
    seed("d3");

    savePreferences(actor("d3"), { dateFormat: "yyyy-MM-dd", variableSymbolFormat: "empty" });

    expect(getPreferences("d3")).toMatchObject({
      dateFormat: "yyyy-MM-dd",
      variableSymbolFormat: "empty",
    });
  });

  test("[SET-034] neplatný formát data je odmítnut", () => {
    seed("d4");

    expect(() =>
      savePreferences(actor("d4"), { dateFormat: "dd/mm/yy" as "yyyy-MM-dd" }),
    ).toThrow();
    expect(() => savePreferences(actor("d4"), { dateFormat: "" as "yyyy-MM-dd" })).toThrow();
    expect(rows("d4")).toEqual([]);
  });

  test("[SET-034] neplatný formát variabilního symbolu je odmítnut", () => {
    seed("d5");

    expect(() =>
      savePreferences(actor("d5"), { variableSymbolFormat: "random" as "digits" }),
    ).toThrow();
  });
});

describe("průvodce", () => {
  test("[SET-001] dokončení průvodce se pamatuje, je auditované a opakované nic nemění", () => {
    seed("o1");
    const first = new Date("2026-05-01T08:00:00Z");
    setClockForTests({ now: () => first });

    completeOnboarding(actor("o1"));
    setClockForTests({ now: () => new Date("2026-06-01T08:00:00Z") });
    completeOnboarding(actor("o1"));

    expect(isOnboarded("o1")).toBe(true);
    expect(rows("o1")[0]?.onboardingCompletedAt).toEqual(first);
    expect(audits("o1", "preferences.onboarding_complete")).toHaveLength(1);
    expect(getPreferences("o1")).toEqual(DEFAULT_PREFERENCES);
  });

  test("[SET-001] dokončení průvodce nezmění dřív uložené hodnoty", () => {
    seed("o2");
    savePreferences(actor("o2"), { dueDays: 21 });

    completeOnboarding(actor("o2"));
    savePreferences(actor("o2"), { unit: "hod" });

    expect(isOnboarded("o2")).toBe(true);
    expect(getPreferences("o2")).toMatchObject({ dueDays: 21, unit: "hod" });
  });

  test("[SET-001] cizí účet průvodcem nedotčený zůstane nedokončený", () => {
    seed("o3");
    seed("o4");

    completeOnboarding(actor("o3"));

    expect(isOnboarded("o3")).toBe(true);
    expect(isOnboarded("o4")).toBe(false);
  });
});

describe("izolace a mazání účtu", () => {
  test("[SET-030] izolace výchozích hodnot", async () => {
    let marker = 40;
    await assertIsolated<number>({
      create: (ownerId) => {
        seed(ownerId);
        marker += 1;
        savePreferences(actor(ownerId), { dueDays: marker });
        return marker;
      },
      find: (ownerId, id) => {
        const current = getPreferences(ownerId);
        return current.dueDays === id ? current : null;
      },
      update: (ownerId, id) => {
        savePreferences(actor(ownerId), { note: "změna" });
        const current = getPreferences(ownerId);
        return current.dueDays === id && current.note === "změna" ? 1 : 0;
      },
    });
  });

  test("[SET-030] tabulka je mezi daty smazanými s účtem a smaže se", () => {
    seed("x0");
    db.update(user).set({ role: "admin" }).where(eq(user.id, "x0")).run();
    seed("x1");
    savePreferences(actor("x1"), { dueDays: 21 });
    completeOnboarding(actor("x1"));
    expect(USER_OWNED_TABLES).toContain(preferences);
    expect(rows("x1")).toHaveLength(1);

    deleteUser(actor("x0"), "x1", "x1@example.cz");

    expect(rows("x1")).toEqual([]);
  });
});
