import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { setClockForTests } from "@/server/clock";
import {
  auditLog,
  emailLog,
  file,
  invoice,
  job,
  rateLimit,
  schedulerState,
} from "@/server/db/schema";
import { registerJob } from "@/server/jobs/registry";
import { drainJobs } from "@/server/jobs/worker";
import { RATE_RULES } from "@/server/rate-limit";
import { RateLimitError, ServiceError } from "@/server/services/access";
import { archiveSentPdf, deleteFile } from "@/server/services/files";
import { cancelInvoice } from "@/server/services/invoice-lifecycle";
import {
  archivedPdf,
  listEmailLog,
  queueMail,
  resendFromLog,
  sendInvoice,
} from "@/server/services/invoice-mail";
import { InvoicePdfNotFoundError } from "@/server/services/invoice-pdf";
import { deliverMail, recoverMail } from "@/server/services/mail-delivery";
import { mutate } from "@/server/services/mutation";
import { deleteUser, USER_OWNED_TABLES } from "@/server/services/users";
import { createTestDb } from "../helpers/db";
import {
  draftFor,
  issuedInvoice,
  ownSmtp,
  seedCustomer,
  seedOwner,
  webActor,
} from "../helpers/fixtures-mail";
import { assertIsolated } from "../helpers/isolation";
import { startSmtp, type TestSmtp } from "../helpers/smtp";

const session = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock("@/server/auth/session", () => ({
  actorFromRequest: async () => ({ userId: session.userId, source: "web" }),
}));

vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-invoice-mail-")));
vi.stubEnv("ALLOW_PRIVATE_MAIL_HOSTS", "true");
vi.stubEnv("SMTP_HOST", "");
vi.stubEnv("SMTP_PORT", "");
vi.stubEnv("SMTP_FROM", "");

const db = createTestDb();
const T0 = new Date("2026-11-02T10:00:00Z");
const WORKER = "worker-2";

let smtp: TestSmtp;

beforeAll(async () => {
  smtp = await startSmtp();
});
afterAll(() => smtp.stop());
beforeEach(() => {
  smtp.reset();
  db.delete(job).run();
  db.delete(schedulerState).run();
  setClockForTests({ now: () => T0 });
  registerJob("mail.send", { run: deliverMail, recover: recoverMail });
});
afterEach(() => setClockForTests(null));

function account() {
  const owner = seedOwner(db, T0);
  ownSmtp(db, owner, smtp.port);
  return { owner, invoiceId: issuedInvoice(owner) };
}

const input = (over: Record<string, unknown> = {}) => ({
  requestId: randomUUID(),
  to: ["alfa@example.cz"],
  cc: [],
  bcc: [],
  subject: "Faktura",
  body: "Text",
  ...over,
});

const logsOf = (owner: string) =>
  db.select().from(emailLog).where(eq(emailLog.userId, owner)).all();

const fail = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ServiceError);
    return (error as Error).message;
  }
  throw new Error("Nemělo projít");
};

describe("sendInvoice", () => {
  test("stejný requestId odešle jednu zprávu, souběžný druhý požadavek je odmítnutý", async () => {
    const { owner, invoiceId } = account();
    const first = input();
    const { logId } = sendInvoice(webActor(owner), invoiceId, first);
    expect(sendInvoice(webActor(owner), invoiceId, first)).toEqual({ logId });
    expect(logsOf(owner)).toHaveLength(1);

    expect(fail(() => sendInvoice(webActor(owner), invoiceId, input()))).toMatch(/odesílá/);
    expect(logsOf(owner)).toHaveLength(1);

    await drainJobs(WORKER);
    expect(sendInvoice(webActor(owner), invoiceId, first)).toEqual({ logId });
    await drainJobs(WORKER);
    expect(smtp.messages).toHaveLength(1);
  });

  test("queueMail vrátí null při obsazeném klíči i při běžícím odeslání", () => {
    const { owner, invoiceId } = account();
    const queue = (key: string) =>
      mutate(webActor(owner), "invoice.send", (tx, audit) => {
        const result = queueMail(tx, audit, {
          userId: owner,
          invoiceId,
          kind: "invoice",
          trigger: "automatic",
          key,
          message: { to: ["a@example.cz"], cc: [], bcc: [], subject: "S", body: "B" },
          automation: "recurringSend",
        });
        audit({ entity: "invoice", entityId: invoiceId, ownerId: owner, scope: "user" });
        return result;
      });
    expect(queue("mail:a")).not.toBeNull();
    expect(queue("mail:b")).toBeNull();
    expect(queue("mail:a")).toBeNull();
    expect(logsOf(owner)).toHaveLength(1);
    expect(db.select().from(job).where(eq(job.userId, owner)).all()).toHaveLength(1);
  });

  test("stejné requestId jiného účtu cizí odeslání neblokuje ani neprozradí", () => {
    const a = account();
    const b = account();
    const shared = input();
    const first = sendInvoice(webActor(a.owner), a.invoiceId, shared);
    const second = sendInvoice(webActor(b.owner), b.invoiceId, shared);
    expect(second.logId).not.toBe(first.logId);
    expect(logsOf(b.owner)).toHaveLength(1);
  });

  test("audit nese počet příjemců a předmět, ne adresy", () => {
    const { owner, invoiceId } = account();
    sendInvoice(webActor(owner), invoiceId, input({ cc: ["c@example.cz"], subject: "Předmět" }));
    const row = db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ownerId, owner), eq(auditLog.action, "invoice.send")))
      .get()!;
    expect(row.after).toMatchObject({ recipients: 2, subject: "Předmět", trigger: "manual" });
    expect(JSON.stringify(row.after)).not.toContain("example.cz");
  });

  test("koncept ani storno odeslat nejde", () => {
    const owner = seedOwner(db, T0);
    ownSmtp(db, owner, smtp.port);
    const customer = seedCustomer(owner);
    const draft = draftFor(owner, customer).id;
    fail(() => sendInvoice(webActor(owner), draft, input()));
    const issued = issuedInvoice(owner, customer);
    cancelInvoice(webActor(owner), issued);
    fail(() => sendInvoice(webActor(owner), issued, input()));
    expect(logsOf(owner)).toEqual([]);
  });

  test("bez SMTP je odeslání odmítnuté", () => {
    const owner = seedOwner(db, T0);
    const invoiceId = issuedInvoice(owner);
    expect(fail(() => sendInvoice(webActor(owner), invoiceId, input()))).toMatch(/SMTP|pošt/i);
  });

  test.each([
    ["bez příjemce", { to: [] }],
    ["neplatná adresa", { to: ["nikdo"] }],
    ["neplatná kopie", { cc: ["a b@example.cz"] }],
    ["hlavička v adrese", { to: ["a@example.cz\r\nBcc: x@example.cz"] }],
    ["21 příjemců", { to: Array.from({ length: 21 }, (_, i) => `a${i}@example.cz`) }],
    [
      "21 příjemců včetně kopií",
      {
        to: Array.from({ length: 11 }, (_, i) => `a${i}@example.cz`),
        bcc: Array.from({ length: 10 }, (_, i) => `b${i}@example.cz`),
      },
    ],
    ["konec řádku v předmětu", { subject: "A\r\nBcc: x@example.cz" }],
    ["prázdný text", { body: "  " }],
    ["bez requestId", { requestId: "" }],
  ])("%s je odmítnuté", (_name, over) => {
    const { owner, invoiceId } = account();
    fail(() => sendInvoice(webActor(owner), invoiceId, input(over)));
    expect(logsOf(owner)).toEqual([]);
  });

  test("20 příjemců projde", () => {
    const { owner, invoiceId } = account();
    const to = Array.from({ length: 20 }, (_, i) => `a${i}@example.cz`);
    expect(sendInvoice(webActor(owner), invoiceId, input({ to })).logId).toBeTruthy();
  });

  test("cizí faktura je odmítnutá", () => {
    const a = account();
    const b = account();
    fail(() => sendInvoice(webActor(b.owner), a.invoiceId, input()));
    expect(logsOf(b.owner)).toEqual([]);
  });

  test("[SEC-001] odesílání je omezené a překročení je v auditu", () => {
    const { owner, invoiceId } = account();
    db.insert(rateLimit)
      .values({
        key: `${RATE_RULES.sendUser.name}:${owner}`,
        windowStart: T0,
        count: RATE_RULES.sendUser.limit,
      })
      .run();
    expect(() => sendInvoice(webActor(owner), invoiceId, input())).toThrow(RateLimitError);
    expect(logsOf(owner)).toEqual([]);
    const denied = db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ownerId, owner), eq(auditLog.action, "rate_limit.exceeded")))
      .all();
    expect(denied).toHaveLength(1);
  });
});

describe("resendFromLog", () => {
  async function failed() {
    const fixture = account();
    smtp.rejectNext(550);
    const { logId } = sendInvoice(webActor(fixture.owner), fixture.invoiceId, input());
    await drainJobs(WORKER);
    return { ...fixture, logId };
  }

  const again = (
    owner: string,
    logId: string,
    confirmedUnknown = false,
    requestId = randomUUID(),
  ) => resendFromLog(webActor(owner), logId, { confirmedUnknown, requestId });

  test("selhaný záznam založí nový pokus a stejné requestId jen jeden", async () => {
    const { owner, logId } = await failed();
    const requestId = randomUUID();
    const next = again(owner, logId, false, requestId);
    expect(next.logId).not.toBe(logId);
    expect(again(owner, logId, false, requestId)).toEqual(next);
    await drainJobs(WORKER);
    expect(smtp.messages).toHaveLength(1);
    expect(
      logsOf(owner)
        .map((row) => row.status)
        .toSorted(),
    ).toEqual(["failed", "sent"]);
  });

  test("unknown vyžaduje výslovné potvrzení", async () => {
    const { owner, invoiceId } = account();
    smtp.dropDuringData();
    const { logId } = sendInvoice(webActor(owner), invoiceId, input());
    await drainJobs(WORKER);
    expect(fail(() => again(owner, logId))).toMatch(/potvr/i);
    expect(again(owner, logId, true).logId).not.toBe(logId);
  });

  test("po pozdějším úspěchu už starý záznam znovu odeslat nejde", async () => {
    const { owner, logId } = await failed();
    again(owner, logId);
    await drainJobs(WORKER);
    fail(() => again(owner, logId));
  });

  test("odeslaný a čekající záznam znovu odeslat nejde", async () => {
    const { owner, invoiceId } = account();
    const { logId } = sendInvoice(webActor(owner), invoiceId, input());
    fail(() => again(owner, logId));
    await drainJobs(WORKER);
    fail(() => again(owner, logId));
  });

  test("zrušený doklad znovu odeslat nejde a cizí záznam neexistuje", async () => {
    const { owner, invoiceId, logId } = await failed();
    fail(() => again(seedOwner(db, T0), logId));
    cancelInvoice(webActor(owner), invoiceId);
    fail(() => again(owner, logId));
  });

  test("[SEC-001] nové odeslání spotřebuje limit", async () => {
    const { owner, logId } = await failed();
    db.update(rateLimit)
      .set({ count: RATE_RULES.sendUser.limit })
      .where(eq(rateLimit.key, `${RATE_RULES.sendUser.name}:${owner}`))
      .run();
    expect(() => again(owner, logId)).toThrow(RateLimitError);
  });
});

describe("archiv", () => {
  async function delivered() {
    const fixture = account();
    const { logId } = sendInvoice(webActor(fixture.owner), fixture.invoiceId, input());
    await drainJobs(WORKER);
    return { ...fixture, logId };
  }

  const route = async (invoiceId: string, logId: string) => {
    const { GET } = await import("@/app/(app)/faktury/[id]/odeslani/[logId]/route");
    return GET(new Request("http://localhost/"), {
      params: Promise.resolve({ id: invoiceId, logId }),
    });
  };

  test("[SEC-001] cizí uživatel dostane na archiv 404", async () => {
    const { invoiceId, logId } = await delivered();
    session.userId = seedOwner(db, T0);
    expect((await route(invoiceId, logId)).status).toBe(404);
    session.userId = null;
    expect((await route(invoiceId, logId)).status).toBe(404);
    expect(() => archivedPdf(webActor(seedOwner(db, T0)), logId)).toThrow(InvoicePdfNotFoundError);
  });

  test("trasa vrací přílohu s nosniff a audit s příznakem archivu", async () => {
    const { owner, invoiceId, logId } = await delivered();
    session.userId = owner;
    const response = await route(invoiceId, logId);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Disposition")).toMatch(/^attachment/);
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(
      Buffer.from(await response.arrayBuffer())
        .subarray(0, 5)
        .toString(),
    ).toBe("%PDF-");
    const row = db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ownerId, owner), eq(auditLog.action, "invoice.pdf_download")))
      .get()!;
    expect(row.after).toMatchObject({ archive: true });
  });

  test("[SEC-001] archiv spadá pod limit PDF", async () => {
    const { owner, invoiceId, logId } = await delivered();
    session.userId = owner;
    db.insert(rateLimit)
      .values({
        key: `${RATE_RULES.pdfUser.name}:${owner}`,
        windowStart: T0,
        count: RATE_RULES.pdfUser.limit,
      })
      .run();
    expect((await route(invoiceId, logId)).status).toBe(429);
  });

  test("záznam bez archivu je 404", () => {
    const { owner, invoiceId } = account();
    const { logId } = sendInvoice(webActor(owner), invoiceId, input());
    expect(() => archivedPdf(webActor(owner), logId)).toThrow(InvoicePdfNotFoundError);
  });

  test("archiveSentPdf přijme jen PDF a archiv nejde smazat ani přepsat", async () => {
    const { owner, logId } = await delivered();
    const scheduler = { userId: owner, source: "scheduler" as const };
    const fileId = logsOf(owner)[0]!.fileId!;
    expect(archiveSentPdf(scheduler, logId, Buffer.from("%PDF-nove"), "x.pdf")).toEqual({
      id: fileId,
    });
    expect(() => deleteFile(webActor(owner), fileId)).toThrow(ServiceError);

    const other = account();
    const { logId: waiting } = sendInvoice(webActor(other.owner), other.invoiceId, input());
    const actor = { userId: other.owner, source: "scheduler" as const };
    expect(() => archiveSentPdf(actor, waiting, Buffer.from("<html>"), "x.pdf")).toThrow(
      ServiceError,
    );
    expect(() => archiveSentPdf(scheduler, waiting, Buffer.from("%PDF-"), "x.pdf")).toThrow(
      ServiceError,
    );
    expect(db.select().from(file).where(eq(file.userId, other.owner)).all()).toEqual([]);
  });
});

describe("izolace a účet", () => {
  test("[TST-009] izolace historie odeslání", async () => {
    await assertIsolated<{ invoiceId: string; logId: string }>({
      owners: [seedOwner(db, T0), seedOwner(db, T0)],
      create: async (ownerId) => {
        ownSmtp(db, ownerId, smtp.port);
        smtp.rejectNext(550);
        const invoiceId = issuedInvoice(ownerId);
        const { logId } = sendInvoice(webActor(ownerId), invoiceId, input());
        await drainJobs(WORKER);
        return { invoiceId, logId };
      },
      find: (ownerId, { invoiceId, logId }) =>
        listEmailLog(ownerId, invoiceId).filter((row) => row.id === logId),
      update: (ownerId, { logId }) =>
        resendFromLog(webActor(ownerId), logId, {
          confirmedUnknown: true,
          requestId: randomUUID(),
        }).logId
          ? 1
          : 0,
    });
  });

  test("email_log leží v USER_OWNED_TABLES před invoice a file a smazání účtu ho odstraní", async () => {
    const { owner, invoiceId } = account();
    sendInvoice(webActor(owner), invoiceId, input());
    await drainJobs(WORKER);
    const position = USER_OWNED_TABLES.indexOf(emailLog);
    expect(position).toBeGreaterThanOrEqual(0);
    expect(position).toBeLessThan(USER_OWNED_TABLES.indexOf(invoice));
    expect(position).toBeLessThan(USER_OWNED_TABLES.indexOf(file));
    const admin = seedOwner(db, T0);
    db.run(sql`UPDATE user SET role = 'admin' WHERE id = ${admin}`);
    deleteUser(webActor(admin), owner, `${owner}@example.cz`);
    expect(logsOf(owner)).toEqual([]);
  });
});
