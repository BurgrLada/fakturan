import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { MAX_UPLOAD_BYTES } from "@/lib/import-preview";
import { auditLog, file, importBatch, rateLimit } from "@/server/db/schema";
import { userDir } from "@/server/files/store";
import { createBatch } from "@/server/services/import-batch";
import { createTestDb } from "../helpers/db";
import { seedOwner, webActor } from "../helpers/fixtures-mail";
import { isdoc, streamOf } from "../helpers/import";

const session = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock("@/server/auth/session", () => ({
  requireSession: async () => ({ user: { id: session.userId } }),
  getCurrentSession: async () => (session.userId ? { user: { id: session.userId } } : null),
  actorFromRequest: async () => ({ userId: session.userId, source: "web" }),
}));
vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-import-upload-")));

const db = createTestDb();
const ORIGIN = "http://localhost:3000";

beforeEach(() => {
  db.delete(rateLimit).run();
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

async function post(
  batchId: string,
  body: Uint8Array,
  headers: Record<string, string> = {},
): Promise<Response> {
  const { POST } = await import("@/app/(app)/nastaveni/import/nahrani/route");
  return POST(
    new Request(`${ORIGIN}/nastaveni/import/nahrani?davka=${batchId}`, {
      method: "POST",
      body: streamOf(body),
      headers: { origin: ORIGIN, "x-file-name": "faktura.isdoc", ...headers },
      duplex: "half",
    } as RequestInit),
  );
}

function ownerWithBatch() {
  const owner = seedOwner(db, new Date());
  const { id } = createBatch(webActor(owner), "isdoc");
  session.userId = owner;
  return { owner, id };
}

const filesOf = (owner: string) => db.select().from(file).where(eq(file.userId, owner)).all();
const onDisk = (owner: string) => (existsSync(userDir(owner)) ? readdirSync(userDir(owner)) : []);

describe("nahrání importu", () => {
  test("[IMP-011] 25 MiB + 1 B skončí 413 a na disku nic nezůstane", async () => {
    const { owner, id } = ownerWithBatch();
    const big = new Uint8Array(MAX_UPLOAD_BYTES + 1).fill(0x20);

    const declared = await post(id, big, { "content-length": String(big.length) });
    const counted = await post(id, big);

    expect(declared.status).toBe(413);
    expect(counted.status).toBe(413);
    expect(filesOf(owner)).toEqual([]);
    expect(onDisk(owner)).toEqual([]);
    expect(db.select().from(importBatch).where(eq(importBatch.id, id)).get()!.uploadedBytes).toBe(
      0,
    );
  });

  test("[IMP-011] lživý Content-Length neobejde počítání proudu", async () => {
    const { owner, id } = ownerWithBatch();
    const big = new Uint8Array(MAX_UPLOAD_BYTES + 1).fill(0x20);

    const response = await post(id, big, { "content-length": "100" });

    expect(response.status).toBe(413);
    expect(filesOf(owner)).toEqual([]);
    expect(onDisk(owner)).toEqual([]);
  });

  test("[IMP-011] limit platí pro celou dávku přes víc požadavků", async () => {
    const { owner, id } = ownerWithBatch();
    const half = new Uint8Array(MAX_UPLOAD_BYTES / 2 + 1).fill(0x20);
    half.set(new TextEncoder().encode("<"), 0);

    expect((await post(id, half)).status).toBe(200);
    expect((await post(id, half)).status).toBe(413);
    expect(filesOf(owner)).toHaveLength(1);
    expect(onDisk(owner)).toHaveLength(1);
  });

  test("[IMP-011] obsah rozhoduje, ne přípona", async () => {
    const { owner, id } = ownerWithBatch();
    const response = await post(id, new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0]), {
      "x-file-name": "faktura.isdoc",
    });
    expect(response.status).toBe(422);
    expect(filesOf(owner)).toEqual([]);
    expect(onDisk(owner)).toEqual([]);
  });

  test("[SEC-001] překročení importUser vrátí 429 a zapíše audit", async () => {
    const { owner, id } = ownerWithBatch();
    const statuses: number[] = [];
    for (let i = 0; i < 61; i++) statuses.push((await post(id, isdoc("faktura-czk.isdoc"))).status);

    expect(statuses.slice(0, 60).every((status) => status === 200)).toBe(true);
    expect(statuses[60]).toBe(429);
    const audit = db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "rate_limit.exceeded"), eq(auditLog.ownerId, owner)))
      .all();
    expect(audit).toHaveLength(1);
    expect(filesOf(owner)).toHaveLength(60);
  });

  test("[SEC-002] nahrání s cizím batchId je 404 a nic nezapíše", async () => {
    const { id } = ownerWithBatch();
    const stranger = seedOwner(db, new Date());
    session.userId = stranger;

    const response = await post(id, isdoc("faktura-czk.isdoc"));

    expect(response.status).toBe(404);
    expect(db.select().from(file).where(eq(file.importBatchId, id)).all()).toEqual([]);
    expect(filesOf(stranger)).toEqual([]);
    expect(onDisk(stranger)).toEqual([]);
  });

  test("cizí původ je 403 a bez relace 401", async () => {
    const { id } = ownerWithBatch();
    expect(
      (await post(id, isdoc("faktura-czk.isdoc"), { origin: "https://evil.example" })).status,
    ).toBe(403);
    session.userId = null;
    expect((await post(id, isdoc("faktura-czk.isdoc"))).status).toBe(401);
  });
});
