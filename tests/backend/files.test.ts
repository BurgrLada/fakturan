import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { auditLog, file, rateLimit, user } from "@/server/db/schema";
import { userDir, writeBlob } from "@/server/files/store";
import { RATE_RULES } from "@/server/rate-limit";
import { deleteFile, readOwnedFile, storeFile } from "@/server/services/files";
import { deleteUser } from "@/server/services/users";
import { assertIsolated } from "../helpers/isolation";
import { createTestDb } from "../helpers/db";

const session = vi.hoisted(() => ({ userId: null as string | null }));

vi.mock("@/server/auth/session", () => ({
  actorFromRequest: async () => ({ userId: session.userId, source: "web" }),
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
const blobReads = vi.hoisted(() => ({ count: 0 }));
vi.mock("@/server/files/store", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/files/store")>();
  return {
    ...real,
    readBlob: (...args: Parameters<typeof real.readBlob>) => {
      blobReads.count += 1;
      return real.readBlob(...args);
    },
  };
});

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

  test("[SEC-005] původní PDF importu a historie ze zálohy jdou jen stáhnout, nahrávka ani archiv ne", async () => {
    const { id } = storeFile(actor("u1"), "logo", PNG, "a.png");
    session.userId = "u1";
    db.update(file).set({ kind: "import_pdf" }).where(eq(file.id, id)).run();
    const pdf = await get(id);
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-disposition")).toMatch(/^attachment;/);
    session.userId = "u2";
    expect((await get(id)).status).toBe(404);
    session.userId = "u1";
    db.update(file).set({ kind: "audit_archive" }).where(eq(file.id, id)).run();
    const history = await get(id);
    expect(history.status).toBe(200);
    expect(history.headers.get("content-disposition")).toMatch(/^attachment;/);
    session.userId = "u2";
    expect((await get(id)).status).toBe(404);
    session.userId = "u1";
    for (const kind of ["import_upload", "export", "sent_pdf"] as const) {
      db.update(file).set({ kind }).where(eq(file.id, id)).run();
      expect((await get(id)).status).toBe(404);
    }
  });
});

describe("stažení souborů proudem", () => {
  async function get(id: string) {
    const { GET } = await import("@/app/(app)/soubory/[id]/route");
    return GET(new Request("http://localhost/soubory/" + id), { params: Promise.resolve({ id }) });
  }
  const downloads = (owner: string) =>
    db
      .select()
      .from(auditLog)
      .all()
      .filter((row) => row.action === "file.download" && row.ownerId === owner);

  function stored(owner: string, kind: "audit_archive" | "import_pdf", bytes: Buffer) {
    seedUser(owner);
    const id = randomUUID();
    db.insert(file)
      .values({
        id,
        userId: owner,
        kind,
        mimeType: kind === "import_pdf" ? "application/pdf" : "application/x-ndjson",
        name: kind === "import_pdf" ? "doklad.pdf" : "historie.jsonl",
        size: bytes.length,
        createdAt: new Date(),
      })
      .run();
    writeBlob(owner, id, bytes);
    return id;
  }

  test("[SEC-005] historie 50 MiB se stáhne proudem a readBlob se nevolá", async () => {
    const owner = `d-${randomUUID()}`;
    const bytes = randomBytes(50 * 1024 * 1024);
    const id = stored(owner, "audit_archive", bytes);
    session.userId = owner;
    const before = blobReads.count;
    const response = await get(id);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(String(bytes.length));
    const body = Buffer.from(await response.arrayBuffer());
    expect(body.length).toBe(bytes.length);
    const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
    expect(sha(body)).toBe(sha(bytes));
    expect(blobReads.count).toBe(before);
  });

  test("[SEC-001] 31. stažení historie za hodinu vrátí 429 a zapíše audit", async () => {
    const owner = `d-${randomUUID()}`;
    const id = stored(owner, "audit_archive", Buffer.from('{"a":1}\n'));
    session.userId = owner;
    for (let attempt = 0; attempt < RATE_RULES.fileDownloadUser.limit; attempt++) {
      const response = await get(id);
      expect(response.status).toBe(200);
      await response.arrayBuffer();
    }
    expect((await get(id)).status).toBe(429);
    const denied = db
      .select()
      .from(auditLog)
      .all()
      .filter((row) => row.action === "rate_limit.exceeded" && row.ownerId === owner);
    expect(denied).toHaveLength(1);
    expect(denied[0]!.after).toMatchObject({ rule: "fileDownloadUser" });
    expect(downloads(owner)).toHaveLength(RATE_RULES.fileDownloadUser.limit);
  });

  test("[AUD-002] stažení import_pdf zapíše file.download s druhem a velikostí", async () => {
    const owner = `d-${randomUUID()}`;
    const pdf = Buffer.from("%PDF-1.4 import");
    const id = stored(owner, "import_pdf", pdf);
    session.userId = owner;
    expect((await get(id)).status).toBe(200);
    expect(downloads(owner)).toMatchObject([
      { entity: "file", entityId: id, after: { kind: "import_pdf", size: pdf.length } },
    ]);
    // Images render on every page view: no audit, no limit.
    const logo = storeFile(actor(owner), "logo", PNG, "logo.png").id;
    expect((await get(logo)).status).toBe(200);
    expect(downloads(owner)).toHaveLength(1);
  });

  test("[SEC-002] cizí soubor je 404 a nezapíše audit ani limit", async () => {
    const owner = `d-${randomUUID()}`;
    const stranger = `d-${randomUUID()}`;
    seedUser(stranger);
    const id = stored(owner, "audit_archive", Buffer.from("x\n"));
    session.userId = stranger;
    expect((await get(id)).status).toBe(404);
    expect(downloads(owner)).toEqual([]);
    expect(downloads(stranger)).toEqual([]);
    const key = `${RATE_RULES.fileDownloadUser.name}:${stranger}`;
    expect(db.select().from(rateLimit).where(eq(rateLimit.key, key)).get()).toBeUndefined();
  });
});

describe("HEAD a chybějící soubor", () => {
  const openFds = () => readdirSync("/proc/self/fd").length;
  async function head(id: string) {
    const { HEAD } = await import("@/app/(app)/soubory/[id]/route");
    return HEAD(new Request(`http://localhost/soubory/${id}`, { method: "HEAD" }), {
      params: Promise.resolve({ id }),
    });
  }

  test("[SEC-005] HEAD nenechá otevřený popisovač, nespotřebuje limit ani nezapíše audit", async () => {
    const owner = `h-${randomUUID()}`;
    seedUser(owner);
    session.userId = owner;
    const logo = storeFile(actor(owner), "logo", PNG, "logo.png").id;
    const history = randomUUID();
    db.insert(file)
      .values({
        id: history,
        userId: owner,
        kind: "audit_archive",
        mimeType: "application/x-ndjson",
        name: "historie.jsonl",
        size: 2,
        createdAt: new Date(),
      })
      .run();
    writeBlob(owner, history, Buffer.from("{}\n"));
    const before = openFds();
    for (let round = 0; round < 50; round++) {
      for (const id of [logo, history]) {
        const response = await head(id);
        expect(response.status).toBe(200);
        expect(response.body).toBeNull();
      }
    }
    expect((await head(history)).headers.get("content-length")).toBe("3");
    expect(openFds()).toBeLessThanOrEqual(before);
    const key = `${RATE_RULES.fileDownloadUser.name}:${owner}`;
    expect(db.select().from(rateLimit).where(eq(rateLimit.key, key)).get()).toBeUndefined();
    expect(
      db
        .select()
        .from(auditLog)
        .all()
        .filter((row) => row.action === "file.download" && row.ownerId === owner),
    ).toEqual([]);
    session.userId = `cizi-${randomUUID()}`;
    expect((await head(logo)).status).toBe(404);
  });

  test("[SEC-001] chybějící blob je 404 a limit nespotřebuje", async () => {
    const owner = `h-${randomUUID()}`;
    seedUser(owner);
    session.userId = owner;
    const id = randomUUID();
    db.insert(file)
      .values({
        id,
        userId: owner,
        kind: "import_pdf",
        mimeType: "application/pdf",
        name: "a.pdf",
        size: 1,
        createdAt: new Date(),
      })
      .run();
    const { GET } = await import("@/app/(app)/soubory/[id]/route");
    const response = await GET(new Request(`http://localhost/soubory/${id}`), {
      params: Promise.resolve({ id }),
    });
    expect(response.status).toBe(404);
    const key = `${RATE_RULES.fileDownloadUser.name}:${owner}`;
    expect(db.select().from(rateLimit).where(eq(rateLimit.key, key)).get()).toBeUndefined();
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
