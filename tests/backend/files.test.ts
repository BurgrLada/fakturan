import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { auditLog, file, user } from "@/server/db/schema";
import { userDir } from "@/server/files/store";
import { deleteFile, readOwnedFile, storeFile } from "@/server/services/files";
import { deleteUser } from "@/server/services/users";
import { assertIsolated } from "../helpers/isolation";
import { createTestDb } from "../helpers/db";

const session = vi.hoisted(() => ({ userId: null as string | null }));

vi.mock("@/server/auth/session", () => ({
  actorFromRequest: async () => ({ userId: session.userId, source: "web" }),
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-files-")));
vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));

const db = createTestDb();
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 1),
]);
const actor = (userId: string) => ({ userId, source: "web" as const });
const admin = actor("admin-1");

function seedUser(id: string, role = "user") {
  const now = new Date();
  db.insert(user)
    .values({ id, name: id, email: `${id}@example.cz`, role, createdAt: now, updatedAt: now })
    .onConflictDoNothing()
    .run();
}

beforeEach(() => {
  db.delete(file).run();
  for (const id of ["admin-1", "u1", "u2"]) seedUser(id, id === "admin-1" ? "admin" : "user");
});

describe("ukládání souborů", () => {
  test("[SEC-005] soubor s příponou .png a obsahem HTML je odmítnut", () => {
    const html = Buffer.from("<html><script>alert(1)</script></html>");

    expect(() => storeFile(actor("u1"), "logo", html, "logo.png")).toThrow("PNG, JPEG, WebP");
    expect(db.select().from(file).all()).toEqual([]);
    expect(existsSync(userDir("u1"))).toBe(false);
  });

  test("[SEC-005] typ se pozná z obsahu, ne z přípony", () => {
    const { id } = storeFile(actor("u1"), "logo", PNG, "logo.svg");

    expect(readOwnedFile(actor("u1"), id).mimeType).toBe("image/png");
  });

  test("[SEC-005] SVG se skriptem a on* atributy je po uložení bez nich", () => {
    const svg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script>` +
        `<foreignObject><div>x</div></foreignObject><a href="javascript:alert(3)"><rect width="5" height="5" onclick="x()"/></a></svg>`,
    );

    const { id } = storeFile(actor("u1"), "logo", svg, "logo.svg");
    const stored = readOwnedFile(actor("u1"), id);
    const text = stored.data.toString("utf8");

    expect(stored.mimeType).toBe("image/svg+xml");
    expect(text).toContain("<rect");
    expect(text).not.toMatch(/script|onload|onclick|foreignObject|javascript:/i);
  });

  test("[SEC-005] reálné logo si zachová styly, přechody a lokální odkazy", () => {
    const svg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10">` +
        `<defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient>` +
        `<linearGradient id="h" xlink:href="#g"/></defs>` +
        `<style>.a{fill:url(#h)}</style>` +
        `<rect style="fill:#123456;stroke:url(#g)" width="5" height="5"/><circle class="a" fill="url(#g)" r="2"/></svg>`,
    );

    const text = readOwnedFile(
      actor("u1"),
      storeFile(actor("u1"), "logo", svg, "l.svg").id,
    ).data.toString("utf8");

    expect(text).toContain("fill:#123456");
    expect(text).toContain("<linearGradient");
    expect(text).toContain("<stop");
    expect(text).toContain('fill="url(#g)"');
    expect(text).toContain("fill:url(#h)");
    expect(text).toMatch(/xlink:href="#g"/);
  });

  test("[SEC-005] @import, externí url() a odkazy javascript: a http: se odstraní", () => {
    const svg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">` +
        `<style>@import url(http://evil.example/x.css); .a{fill:red}</style>` +
        `<rect style="fill:url(http://evil.example/p.svg#x)" width="1" height="1"/>` +
        `<rect style="width:expression(alert(1))" width="1" height="1"/>` +
        `<use href="javascript:alert(1)"/><use xlink:href="http://evil.example/a.svg#b"/></svg>`,
    );

    const text = readOwnedFile(
      actor("u1"),
      storeFile(actor("u1"), "logo", svg, "l.svg").id,
    ).data.toString("utf8");

    expect(text).not.toMatch(/@import|evil\.example|expression|javascript:|http:\/\/evil/i);
    expect(text).toContain("fill:red");
  });

  test("[SEC-005] neznámý druh souboru je odmítnut", () => {
    expect(() => storeFile(actor("u1"), "evil" as never, PNG, "a.png")).toThrow("druh");
  });

  test("[SEC-005] soubor přesně 2 MB projde, o bajt větší ne", () => {
    const pad = (n: number) => Buffer.concat([PNG, Buffer.alloc(n - PNG.length)]);

    expect(storeFile(actor("u1"), "logo", pad(2 * 1024 * 1024), "a.png").id).toBeTruthy();
    expect(() => storeFile(actor("u1"), "logo", pad(2 * 1024 * 1024 + 1), "a.png")).toThrow("2 MB");
  });

  test("[SEC-005] soubor nad 2 MB je odmítnut", () => {
    const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]);

    expect(() => storeFile(actor("u1"), "logo", big, "big.png")).toThrow("2 MB");
    expect(
      storeFile(actor("u1"), "logo", Buffer.concat([PNG, Buffer.alloc(1024)]), "ok.png").id,
    ).toBeTruthy();
  });

  test("[SEC-005] povoleny jsou PNG, JPEG, WebP a SVG, jiné ne", () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
    const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]);
    const svg = Buffer.from(
      `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>`,
    );
    const gif = Buffer.from("GIF89a....");
    const kinds = [PNG, jpeg, webp, svg].map(
      (data) =>
        readOwnedFile(actor("u1"), storeFile(actor("u1"), "qr_logo", data, "a").id).mimeType,
    );

    expect(kinds).toEqual(["image/png", "image/jpeg", "image/webp", "image/svg+xml"]);
    expect(() => storeFile(actor("u1"), "logo", gif, "a.gif")).toThrow();
  });

  test("[SEC-005] podpis se uloží jako samostatný druh souboru", () => {
    const { id } = storeFile(actor("u1"), "signature", PNG, "podpis.png");

    expect(db.select().from(file).where(eq(file.id, id)).get()).toMatchObject({
      kind: "signature",
      userId: "u1",
    });
  });

  test("[SEC-005] název od uživatele se na disku nepoužije", () => {
    const { id } = storeFile(actor("u1"), "logo", PNG, '../../etc/passwd".png');

    expect(readdirSync(userDir("u1"))).toContain(id);
    expect(readdirSync(userDir("u1")).every((n) => /^[0-9a-f-]{36}$/.test(n))).toBe(true);
    expect(readOwnedFile(actor("u1"), id).name).toBe("passwd.png");
  });

  test("[SEC-005] uložení i smazání zapíše auditní záznam", () => {
    const { id } = storeFile(actor("u1"), "logo", PNG, "a.png");
    deleteFile(actor("u1"), id);

    expect(existsSync(join(userDir("u1"), id))).toBe(false);
    const actions = db.select().from(auditLog).where(eq(auditLog.entityId, id)).all();
    expect(actions.map((r) => r.action).sort()).toEqual(["file.create", "file.delete"]);
  });
});

describe("izolace souborů", () => {
  test("[SEC-005] soubor vidí a maže jen vlastník", async () => {
    await assertIsolated<string>({
      create: (ownerId) => {
        seedUser(ownerId);
        return storeFile(actor(ownerId), "logo", PNG, "a.png").id;
      },
      find: (ownerId, id) => {
        try {
          return readOwnedFile(actor(ownerId), id);
        } catch {
          return null;
        }
      },
      remove: (ownerId, id) => {
        deleteFile(actor(ownerId), id);
        return 1;
      },
    });
  });
});

describe("route souborů", () => {
  async function get(id: string) {
    const { GET } = await import("@/app/(app)/soubory/[id]/route");
    return GET(new Request("http://localhost/soubory/" + id), { params: Promise.resolve({ id }) });
  }

  test("[SEC-005] cizí uživatel dostane 404 i se správným ID", async () => {
    const { id } = storeFile(actor("u1"), "logo", PNG, "a.png");

    session.userId = "u2";
    expect((await get(id)).status).toBe(404);
    session.userId = null;
    expect((await get(id)).status).toBe(404);
  });

  test("[SEC-005] nelatinský název jde v hlavičce jako filename*=UTF-8", async () => {
    const { id } = storeFile(actor("u1"), "logo", PNG, "Žluťoučký kůň.png");

    session.userId = "u1";
    const header = (await get(id)).headers.get("content-disposition") ?? "";

    expect(header).toContain("filename*=UTF-8''%C5%BDlu%C5%A5ou%C4%8Dk%C3%BD%20k%C5%AF%C5%88.png");
    expect(header).toMatch(/^inline; filename="[\x20-\x7e]+";/);
  });

  test("[SEC-005] vlastník dostane soubor s bezpečnými hlavičkami", async () => {
    const { id } = storeFile(actor("u1"), "logo", PNG, "logo.png");

    session.userId = "u1";
    const response = await get(id);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-disposition")).toContain('filename="logo.png"');
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe("sandbox");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG);
  });
});

describe("smazání účtu", () => {
  test("[ADM-006] smazání účtu odstraní soubory z disku", () => {
    storeFile(actor("u1"), "logo", PNG, "a.png");
    storeFile(actor("u2"), "logo", PNG, "a.png");
    expect(existsSync(userDir("u1"))).toBe(true);

    deleteUser(admin, "u1", "u1@example.cz");

    expect(existsSync(userDir("u1"))).toBe(false);
    expect(db.select().from(file).where(eq(file.userId, "u1")).all()).toEqual([]);
    expect(readFileSync(join(userDir("u2"), readdirSync(userDir("u2"))[0])).length).toBe(
      PNG.length,
    );
  });

  test("[ADM-006] složka zůstane, když smazání účtu selže", () => {
    storeFile(actor("u1"), "logo", PNG, "a.png");

    expect(() => deleteUser(admin, "u1", "jiny@example.cz")).toThrow();
    expect(existsSync(userDir("u1"))).toBe(true);
  });
});
