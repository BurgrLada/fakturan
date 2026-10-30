import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, test, vi } from "vitest";
import { auditLog, user } from "@/server/db/schema";
import { setTheme } from "@/server/services/settings";
import { createTestDb } from "../helpers/db";

vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-settings-")));

const db = createTestDb();
const now = new Date();

function seed(id: string) {
  db.insert(user)
    .values({ id, name: id, email: `${id}@example.cz`, createdAt: now, updatedAt: now })
    .run();
}

const themeOf = (id: string) => db.select().from(user).where(eq(user.id, id)).get()?.theme;
const audits = (ownerId: string) =>
  db
    .select()
    .from(auditLog)
    .where(eq(auditLog.ownerId, ownerId))
    .all()
    .filter((row) => row.action === "user.theme_change");

describe("vzhled v účtu", () => {
  test("[SET-035] setTheme uloží volbu a zapíše audit", () => {
    seed("a1");
    seed("b1");
    expect(themeOf("a1")).toBe("system");
    setTheme({ userId: "a1", source: "web" }, "dark");
    expect(themeOf("a1")).toBe("dark");
    const [row] = audits("a1");
    expect(audits("a1")).toHaveLength(1);
    expect(row).toMatchObject({ ownerId: "a1", actorId: "a1", scope: "user", entityId: "a1" });
    expect(row.before).toEqual({ theme: "system" });
    expect(row.after).toEqual({ theme: "dark" });
  });

  test("[SET-035] neplatná hodnota se odmítne", () => {
    seed("a2");
    seed("b2");
    expect(() => setTheme({ userId: "a2", source: "web" }, "neon" as "dark")).toThrow();
    expect(themeOf("a2")).toBe("system");
    expect(audits("a2")).toHaveLength(0);
  });

  test("[SET-035] stejná hodnota nic nezapíše", () => {
    seed("a3");
    seed("b3");
    setTheme({ userId: "a3", source: "web" }, "system");
    expect(audits("a3")).toHaveLength(0);
    setTheme({ userId: "a3", source: "web" }, "light");
    setTheme({ userId: "a3", source: "web" }, "light");
    expect(audits("a3")).toHaveLength(1);
  });

  test("[SET-035] cizí uživatel ani bez přihlášení vzhled nezmění", () => {
    seed("a4");
    seed("b4");
    setTheme({ userId: "b4", source: "web" }, "dark");
    expect(themeOf("a4")).toBe("system");
    expect(themeOf("b4")).toBe("dark");
    expect(() => setTheme({ userId: null, source: "web" }, "dark")).toThrow();
    expect(themeOf("a4")).toBe("system");
  });
});
