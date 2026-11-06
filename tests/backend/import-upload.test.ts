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
import { invoice } from "@/server/db/schema";
import { externalInvoice } from "../fixtures/external-invoice";
import { issuedInvoice, seedOwner, webActor } from "../helpers/fixtures-mail";
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

describe("ruční PDF k importovanému dokladu", () => {
  async function attach(
    id: string,
    body: Uint8Array,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    const { POST } = await import("@/app/(app)/faktury/[id]/priloha/route");
    return POST(
      new Request(`${ORIGIN}/faktury/${id}/priloha`, {
        method: "POST",
        body: streamOf(body),
        headers: { origin: ORIGIN, "x-file-name": "faktura.pdf", ...headers },
        duplex: "half",
      } as RequestInit),
      { params: Promise.resolve({ id }) },
    );
  }
  const pdf = new TextEncoder().encode("%PDF-1.4\nobsah\n%%EOF");
  const linked = (id: string) =>
    db.select().from(invoice).where(eq(invoice.id, id)).get()!.importPdfFileId;

  function imported() {
    const owner = seedOwner(db, new Date());
    session.userId = owner;
    return { owner, id: externalInvoice(db, owner) };
  }

  test("[IMP-005] PDF k importovanému dokladu se uloží a jde stáhnout přes soubory", async () => {
    const { owner, id } = imported();

    const response = await attach(id, pdf);

    expect(response.status).toBe(200);
    const { fileId } = (await response.json()) as { fileId: string };
    expect(linked(id)).toBe(fileId);
    expect(filesOf(owner).map((row) => row.kind)).toEqual(["import_pdf"]);
    const { GET } = await import("@/app/(app)/soubory/[id]/route");
    const download = await GET(new Request(`${ORIGIN}/soubory/${fileId}`), {
      params: Promise.resolve({ id: fileId }),
    });
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("application/pdf");
    expect(download.headers.get("content-disposition")).toContain("attachment");
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(pdf);
  });

  test("[IMP-005] vlastní doklad PDF nepřijme a vrátí 409", async () => {
    const owner = seedOwner(db, new Date());
    session.userId = owner;
    const own = issuedInvoice(owner);

    const response = await attach(own, pdf);

    expect(response.status).toBe(409);
    expect(filesOf(owner)).toEqual([]);
    expect(onDisk(owner)).toEqual([]);
  });

  test("[SEC-005] soubor bez %PDF- je 415 a 25 MiB + 1 B je 413, na disku nic nezůstane", async () => {
    const { owner, id } = imported();
    const big = new Uint8Array(MAX_UPLOAD_BYTES + 1).fill(0x20);
    big.set(pdf);

    expect((await attach(id, new TextEncoder().encode("PK\u0003\u0004"))).status).toBe(415);
    expect((await attach(id, big, { "content-length": String(big.length) })).status).toBe(413);
    expect((await attach(id, big)).status).toBe(413);
    expect((await attach(id, big, { "content-length": "100" })).status).toBe(413);
    expect(linked(id)).toBeNull();
    expect(filesOf(owner)).toEqual([]);
    expect(onDisk(owner)).toEqual([]);
  });

  test("[SEC-001] bez přihlášení nebo z cizího původu se nic neuloží", async () => {
    const { owner, id } = imported();

    expect((await attach(id, pdf, { origin: "http://evil.example" })).status).toBe(403);
    session.userId = null;
    expect((await attach(id, pdf)).status).toBe(401);
    expect(filesOf(owner)).toEqual([]);
  });
});
