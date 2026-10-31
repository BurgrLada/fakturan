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
import { cancelInvoice, markSent } from "@/server/services/invoice-lifecycle";
import { getInvoice } from "@/server/services/invoices";
import { MAX_BULK_DOCUMENTS } from "@/lib/invoice";
import {
  archivedPdf,
  bulkSend,
  bulkSendPreview,
  hasUnresolvedUnknown,
  listEmailLog,
  mailStateOf,
  queueMail,
  resendFromLog,
  sendInvoice,
  sendPrefill,
} from "@/server/services/invoice-mail";
import { InvoicePdfNotFoundError } from "@/server/services/invoice-pdf";
import { setPaused } from "@/server/services/automation";
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
import { TEXTS } from "@/lib/texts";

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

  describe("nevyřešené unknown", () => {
    async function unknown() {
      const fixture = account();
      smtp.dropDuringData();
      sendInvoice(webActor(fixture.owner), fixture.invoiceId, input());
      await drainJobs(WORKER);
      return fixture;
    }

    test("nové odeslání vyžaduje potvrzení a potvrzené projde", async () => {
      const { owner, invoiceId } = await unknown();
      expect(fail(() => sendInvoice(webActor(owner), invoiceId, input()))).toMatch(/potvrdit/);
      expect(logsOf(owner)).toHaveLength(1);
      const confirmed = input({ confirmedUnknown: true });
      expect(sendInvoice(webActor(owner), invoiceId, confirmed).logId).toBeTruthy();
    });

    test("novější sent ho vyřeší a jiný druh zprávy neblokuje", async () => {
      const { owner, invoiceId } = await unknown();
      expect(hasUnresolvedUnknown(owner, invoiceId, "invoice")).toBe(true);
      expect(hasUnresolvedUnknown(owner, invoiceId, "reminder")).toBe(false);
      sendInvoice(webActor(owner), invoiceId, input({ confirmedUnknown: true }));
      await drainJobs(WORKER);
      expect(hasUnresolvedUnknown(owner, invoiceId, "invoice")).toBe(false);
      expect(sendInvoice(webActor(owner), invoiceId, input()).logId).toBeTruthy();
    });

    test("znovu odeslání selhaného záznamu nepřeskočí nevyřešené unknown", async () => {
      const { owner, invoiceId } = await unknown();
      smtp.rejectNext(550);
      const { logId } = sendInvoice(webActor(owner), invoiceId, input({ confirmedUnknown: true }));
      await drainJobs(WORKER);
      const again = { confirmedUnknown: false, requestId: randomUUID() };
      expect(fail(() => resendFromLog(webActor(owner), logId, again))).toMatch(/potvrdit/);
    });

    test("cizí unknown se nezjistí", async () => {
      const { invoiceId } = await unknown();
      expect(hasUnresolvedUnknown(seedOwner(db, T0), invoiceId, "invoice")).toBe(false);
    });
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

  test("archiv patří jen k dokladu v adrese", async () => {
    const { owner, logId } = await delivered();
    session.userId = owner;
    expect((await route(issuedInvoice(owner), logId)).status).toBe(404);
  });

  test("obecná trasa souborů archiv nevydá", async () => {
    const { owner } = await delivered();
    session.userId = owner;
    const id = logsOf(owner)[0]!.fileId!;
    const { GET } = await import("@/app/(app)/soubory/[id]/route");
    const response = await GET(new Request("http://localhost/"), {
      params: Promise.resolve({ id }),
    });
    expect(response.status).toBe(404);
  });

  test("PDF neodeslaného pokusu se jako archiv nenabízí ani nevydá", async () => {
    const { owner, invoiceId } = account();
    smtp.rejectNext(550);
    const { logId } = sendInvoice(webActor(owner), invoiceId, input());
    await drainJobs(WORKER);
    expect(logsOf(owner)[0]!.fileId).toBeTruthy();
    expect(listEmailLog(owner, invoiceId)[0]!.hasArchive).toBe(false);
    expect(() => archivedPdf(webActor(owner), logId)).toThrow(InvoicePdfNotFoundError);
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
    expect(db.select().from(file).where(eq(file.userId, owner)).all()).toHaveLength(1);
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

const B = TEXTS.invoiceMail.bulk.reasons;

async function leaveUnknown(owner: string, invoiceId: string) {
  smtp.dropDuringData();
  const { logId } = sendInvoice(webActor(owner), invoiceId, input());
  await drainJobs(WORKER);
  expect(logsOf(owner).find((log) => log.id === logId)?.status).toBe("unknown");
  return logId;
}

describe("sendPrefill", () => {
  test("[MAIL-002] předvyplní zprávu ze šablony včetně stálých kopií, příjemců a nového requestId", () => {
    const owner = seedOwner(db, T0);
    ownSmtp(db, owner, smtp.port, { cc: ["ucetni@example.cz"], bcc: ["archiv@example.cz"] });
    const invoiceId = issuedInvoice(owner);

    const first = sendPrefill(owner, invoiceId);
    expect(first).toMatchObject({
      to: ["alfa@example.cz"],
      cc: ["ucetni@example.cz"],
      bcc: ["archiv@example.cz"],
      unknownPending: false,
      paused: false,
      log: null,
    });
    expect(first.subject).toContain(getInvoice(owner, invoiceId)?.number);
    expect(first.attachmentName).toMatch(/\.pdf$/);
    expect(first.requestId).not.toBe(sendPrefill(owner, invoiceId).requestId);
  });

  test("řekne, že hlavní vypínač je vypnutý, a ruční odeslání přesto projde", async () => {
    const { owner, invoiceId } = account();
    setPaused(webActor(owner), true, { confirmed: true });
    const draft = sendPrefill(owner, invoiceId);
    expect(draft.paused).toBe(true);

    const { to, cc, bcc, subject, body, requestId } = draft;
    sendInvoice(webActor(owner), invoiceId, { to, cc, bcc, subject, body, requestId });
    await drainJobs(WORKER);
    expect(logsOf(owner)).toMatchObject([{ status: "sent" }]);
  });

  test("hlásí nevyřešené unknown, dokud nepřijde novější doručení", async () => {
    const { owner, invoiceId } = account();
    await leaveUnknown(owner, invoiceId);
    expect(sendPrefill(owner, invoiceId).unknownPending).toBe(true);

    sendInvoice(webActor(owner), invoiceId, input({ confirmedUnknown: true }));
    await drainJobs(WORKER);
    expect(sendPrefill(owner, invoiceId).unknownPending).toBe(false);
  });

  test("ze záznamu vezme jeho příjemce a předmět a odmítne stornovaný doklad i cizí záznam", async () => {
    const { owner, invoiceId } = account();
    const logId = await leaveUnknown(owner, invoiceId);

    expect(sendPrefill(owner, invoiceId, logId)).toMatchObject({
      to: ["alfa@example.cz"],
      subject: "Faktura",
      unknownPending: true,
      log: { id: logId, status: "unknown" },
    });
    const other = account();
    expect(fail(() => sendPrefill(other.owner, other.invoiceId, logId))).toBe(
      TEXTS.invoiceMail.errors.logNotFound,
    );
    cancelInvoice(webActor(owner), invoiceId);
    expect(fail(() => sendPrefill(owner, invoiceId))).toBe(TEXTS.invoiceMail.errors.notSendable);
  });
});

describe("stav pošty na dokladu", () => {
  test("[MAIL-005] selhání je vidět s důvodem a záznam jde poslat znovu", async () => {
    const { owner, invoiceId } = account();
    smtp.rejectNext(550);
    sendInvoice(webActor(owner), invoiceId, input());
    await drainJobs(WORKER);

    const rows = listEmailLog(owner, invoiceId);
    expect(rows).toMatchObject([{ status: "failed", resendable: true }]);
    expect(rows[0].reason).toBeTruthy();
    expect(mailStateOf(rows)).toMatchObject({ sending: false, problem: { status: "failed" } });
  });

  test("po novějším doručení starý záznam nejde poslat znovu a problém zmizí", async () => {
    const { owner, invoiceId } = account();
    smtp.rejectNext(550);
    sendInvoice(webActor(owner), invoiceId, input());
    await drainJobs(WORKER);
    sendInvoice(webActor(owner), invoiceId, input());
    expect(mailStateOf(listEmailLog(owner, invoiceId))).toMatchObject({ sending: true });
    await drainJobs(WORKER);

    const rows = listEmailLog(owner, invoiceId);
    expect(rows).toMatchObject([
      { status: "sent", resendable: false },
      { status: "failed", resendable: false },
    ]);
    expect(mailStateOf(rows)).toEqual({ sending: false, problem: null });
  });

  test("unknown má přednost před novějším selháním, klient zprávu možná má", async () => {
    const { owner, invoiceId } = account();
    await leaveUnknown(owner, invoiceId);
    smtp.rejectNext(550);
    sendInvoice(webActor(owner), invoiceId, input({ confirmedUnknown: true }));
    await drainJobs(WORKER);
    expect(mailStateOf(listEmailLog(owner, invoiceId)).problem?.status).toBe("unknown");
  });
});

describe("hromadné odeslání", () => {
  function batch(count: number, cc: string[] = [], bcc: string[] = []) {
    const owner = seedOwner(db, T0);
    ownSmtp(db, owner, smtp.port, { cc, bcc });
    return {
      owner,
      ids: Array.from({ length: count }, () => issuedInvoice(owner)),
    };
  }

  test("[MAIL-008] souhrn ukáže příjemce a přeskočené s důvodem", async () => {
    const { owner, ids } = batch(3, ["ucetni@example.cz"]);
    const [ready, sentOne, unknownOne] = ids;
    markSent(webActor(owner), sentOne);
    await leaveUnknown(owner, unknownOne);
    const noAddress = issuedInvoice(owner, seedCustomer(owner, ""));
    const running = issuedInvoice(owner);
    sendInvoice(webActor(owner), running, input());
    const draft = draftFor(owner, seedCustomer(owner)).id;
    const foreign = batch(1).ids[0];

    const preview = bulkSendPreview(owner, [
      ready,
      sentOne,
      unknownOne,
      noAddress,
      running,
      draft,
      foreign,
    ]);

    expect(preview.ready).toMatchObject([
      {
        id: ready,
        number: getInvoice(owner, ready)?.number,
        customer: "Alfa s.r.o.",
        to: ["alfa@example.cz"],
        copies: ["ucetni@example.cz"],
      },
    ]);
    const reasons = Object.fromEntries(preview.skipped.map((s) => [s.id, s.reason]));
    expect(reasons).toEqual({
      [sentOne]: B.status,
      [unknownOne]: B.unknown,
      [noAddress]: B.noAddress,
      [running]: B.sending,
      [draft]: B.status,
      [foreign]: B.notFound,
    });
    expect(preview.skipped.find((s) => s.id === foreign)?.number).toBe("");
  });

  test("[MAIL-008] hromadné odeslání 3 dokladů pošle 3 zprávy se stálými kopiemi a přeskočí koncept", async () => {
    const { owner, ids } = batch(3, ["ucetni@example.cz"], ["archiv@example.cz"]);
    const draft = draftFor(owner, seedCustomer(owner)).id;

    expect(bulkSend(webActor(owner), [...ids, draft], randomUUID())).toEqual({
      queued: 3,
      skipped: 1,
    });
    await drainJobs(WORKER);

    const logs = logsOf(owner);
    expect(logs).toHaveLength(3);
    for (const log of logs) {
      expect(log).toMatchObject({
        status: "sent",
        trigger: "bulk",
        cc: ["ucetni@example.cz"],
        bcc: ["archiv@example.cz"],
      });
    }
    expect(smtp.messages).toHaveLength(3);
    for (const mail of smtp.messages) {
      expect(mail.to.toSorted()).toEqual([
        "alfa@example.cz",
        "archiv@example.cz",
        "ucetni@example.cz",
      ]);
      expect(mail.attachments).toHaveLength(1);
    }
    for (const id of ids) expect(getInvoice(owner, id)?.status).toBe("sent");
    expect(getInvoice(owner, draft)?.status).toBe("draft");
  });

  test("hromadné odeslání přeskočí doklad s unknown a nikdy ho nepotvrdí", async () => {
    const { owner, ids } = batch(2);
    await leaveUnknown(owner, ids[0]);

    expect(bulkSend(webActor(owner), ids, randomUUID())).toEqual({ queued: 1, skipped: 1 });
    await drainJobs(WORKER);
    expect(logsOf(owner).filter((log) => log.invoiceId === ids[0])).toMatchObject([
      { status: "unknown" },
    ]);
  });

  test("server stav vyhodnotí znovu: storno po náhledu se neodešle", () => {
    const { owner, ids } = batch(2);
    bulkSendPreview(owner, ids);
    cancelInvoice(webActor(owner), ids[0]);
    expect(bulkSend(webActor(owner), ids, randomUUID())).toEqual({ queued: 1, skipped: 1 });
  });

  test("selhání jednoho dokladu nezastaví ostatní", () => {
    const { owner, ids } = batch(2);
    const broken = draftFor(owner, seedCustomer(owner)).id;
    const badCustomer = seedCustomer(owner);
    const badInvoice = issuedInvoice(owner, badCustomer);
    db.run(sql`UPDATE customer SET email = 'neplatna' WHERE id = ${badCustomer}`);

    expect(bulkSend(webActor(owner), [badInvoice, broken, ...ids], randomUUID())).toEqual({
      queued: 2,
      skipped: 2,
    });
  });

  test("opakovaný stejný požadavek nic nezdvojí", async () => {
    const { owner, ids } = batch(2);
    const requestId = randomUUID();
    bulkSend(webActor(owner), ids, requestId);
    expect(bulkSend(webActor(owner), [...ids, ...ids], requestId)).toEqual({
      queued: 2,
      skipped: 0,
    });
    await drainJobs(WORKER);
    expect(smtp.messages).toHaveLength(2);
  });

  test("odmítne víc dokladů než limit, bez SMTP nic nezařadí a drží rate limit", () => {
    const { owner, ids } = batch(1);
    const tooMany = Array.from({ length: MAX_BULK_DOCUMENTS + 1 }, () => randomUUID());
    expect(fail(() => bulkSend(webActor(owner), tooMany, randomUUID()))).toBe(
      TEXTS.invoices.list.bulk.tooMany(MAX_BULK_DOCUMENTS),
    );

    const bare = seedOwner(db, T0);
    const invoiceId = issuedInvoice(bare);
    expect(fail(() => bulkSend(webActor(bare), [invoiceId], randomUUID()))).toBe(
      TEXTS.invoiceMail.errors.unavailable,
    );
    expect(logsOf(bare)).toEqual([]);

    for (let i = 0; i < RATE_RULES.sendBulkUser.limit; i += 1) {
      bulkSend(webActor(owner), ids, randomUUID());
    }
    expect(() => bulkSend(webActor(owner), ids, randomUUID())).toThrow(RateLimitError);
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
