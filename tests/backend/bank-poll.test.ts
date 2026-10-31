import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fioParser } from "@/lib/bank-notices/fio";
import type { BankNoticeParser } from "@/lib/bank-notices/types";
import { notificationText } from "@/lib/notification-text";
import { setClockForTests } from "@/server/clock";
import {
  auditLog,
  automationSettings,
  bankMailbox,
  bankNotification,
  job,
  notification,
  payment,
  rateLimit,
  user,
} from "@/server/db/schema";
import { parseEnv } from "@/server/env";
import { claimNext, completeJob, purgeFinishedJobs } from "@/server/jobs/queue";
import { registerJob } from "@/server/jobs/registry";
import { drainJobs } from "@/server/jobs/worker";
import { bankStatus } from "@/server/services/bank-notices";
import {
  checkMailboxNow,
  firstRawHeader,
  planBankPolls,
  pollMailbox,
  type PollOptions,
} from "@/server/services/bank-poll";
import { RateLimitError } from "@/server/services/access";
import { getInvoice } from "@/server/services/invoices";
import { listPayments } from "@/server/services/payments";
import { assertConsistent } from "../helpers/consistency";
import { createTestDb } from "../helpers/db";
import {
  COUNTERPARTY,
  encodedSubject,
  INVOICE_TOTAL,
  jobsOf,
  noticeText,
  PASS_HEADER,
  pollJob,
  rawMail,
  seedAccount,
  seedMailbox,
} from "../helpers/fixtures-bank";
import { startImap, type TestImap } from "../helpers/imap";

const report = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock("@sentry/nextjs", () => ({ captureException: report.captureException }));

vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-bank-poll-")));
vi.stubEnv("SENTRY_DSN", "https://key@example.test/1");

const db = createTestDb();
const NOW = new Date("2026-11-01T10:00:00Z");
const DAY = 86_400_000;
const FIVE_MINUTES = 5 * 60_000;
const env = parseEnv({ ...process.env, ALLOW_PRIVATE_MAIL_HOSTS: "true" });

let current = NOW;
let imap: TestImap;
let stdout: string[];

beforeEach(async () => {
  current = NOW;
  setClockForTests({ now: () => current });
  imap = await startImap();
  stdout = [];
  report.captureException.mockClear();
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  setClockForTests(null);
  await imap.close();
});

function account(over: Parameters<typeof seedMailbox>[4] = {}) {
  const seeded = seedAccount(db, NOW);
  seedMailbox(db, seeded.owner, imap.port, NOW, over);
  return seeded;
}

const poll = (owner: string, opts: PollOptions = {}) =>
  pollMailbox(pollJob(owner, current), { env, ...opts });
const mailbox = (owner: string) =>
  db.select().from(bankMailbox).where(eq(bankMailbox.userId, owner)).get()!;
const notices = (owner: string) =>
  db.select().from(bankNotification).where(eq(bankNotification.userId, owner)).all();
const payments = (owner: string) =>
  db.select().from(payment).where(eq(payment.userId, owner)).all();
const invoiceStatus = (owner: string, id: string) => getInvoice(owner, id)!.status;
const bodyFetches = () => imap.commands.filter((command) => /BODY/i.test(command));

describe("firstRawHeader", () => {
  test("vrátí první výskyt bez závěrečného CRLF a se zachovaným složením", () => {
    const raw = Buffer.from(
      "Received: x\r\nAuthentication-Results: a;\r\n dkim=pass\r\nauthentication-results: b\r\n\r\nbody",
    );
    expect(firstRawHeader(raw, "authentication-results")).toBe("a;\r\n dkim=pass");
  });

  test("funguje i s holým LF a ignoruje podobná jména a tělo zprávy", () => {
    const raw = Buffer.from(
      "ARC-Authentication-Results: x\nX-Authentication-Results: y\n\nAuthentication-Results: z\n",
    );
    expect(firstRawHeader(raw, "authentication-results")).toBeNull();
    expect(
      firstRawHeader(Buffer.from("Authentication-Results: a\n"), "authentication-results"),
    ).toBe("a");
  });

  test("zpráva bez hlaviček nic nevrátí", () => {
    expect(firstRawHeader(Buffer.from("\r\nAuthentication-Results: z\r\n"), "x")).toBeNull();
    expect(firstRawHeader(Buffer.alloc(0), "authentication-results")).toBeNull();
  });
});

describe("tok ze schránky", () => {
  test("[TST-006] tok přes testovací IMAP server od zprávy po uhrazenou fakturu", async () => {
    const { owner, invoiceId } = account();
    const uid = imap.addMessage(rawMail());

    await poll(owner);

    expect(invoiceStatus(owner, invoiceId)).toBe("paid");
    expect(listPayments(owner, invoiceId)).toEqual([
      expect.objectContaining({
        source: "notice",
        paidOn: "2026-10-30",
        amountMinor: INVOICE_TOTAL,
        creditedMinor: INVOICE_TOTAL,
        currency: "CZK",
        method: "transfer",
        notificationId: notices(owner)[0]!.id,
      }),
    ]);
    expect(notices(owner)[0]).toMatchObject({ status: "matched", authResult: "pass" });
    expect(mailbox(owner)).toMatchObject({
      lastUid: uid,
      uidValidity: 1000,
      lastCheckAt: NOW,
      lastSuccessAt: NOW,
      lastNoticeAt: NOW,
      firstReadAt: NOW,
    });
    assertConsistent(db, owner);
  });

  test("testovací server neviděl žádný zapisovací příkaz", async () => {
    const { owner } = account();
    imap.addMessage(rawMail());
    imap.addMessage(rawMail({ subject: "Fio banka - expense" }));
    imap.addMessage(rawMail({ subject: "Fio banka - novinky" }));

    await poll(owner);

    expect(imap.commands.some((command) => command.startsWith("EXAMINE"))).toBe(true);
    expect(imap.commands.join("\n")).not.toMatch(
      /\b(STORE|EXPUNGE|MOVE|COPY|DELETE|APPEND|SELECT)\b/i,
    );
    expect(bodyFetches().every((command) => /BODY\.PEEK/i.test(command))).toBe(true);
  });

  test("[BNK-004] výdaj ani cizí odesílatel se nestáhnou", async () => {
    const { owner } = account();
    imap.addMessage(rawMail({ subject: "Fio banka - expense on account" }));
    imap.addMessage(rawMail({ from: "Někdo <jiny@example.cz>" }));
    imap.addMessage(rawMail({ from: '"automat@fio.cz" <podvod@example.cz>' }));
    const last = imap.addMessage(rawMail({ from: "automat@fio.cz, druhy@example.cz" }));

    await poll(owner);

    expect(bodyFetches()).toEqual([]);
    expect(notices(owner)).toEqual([]);
    expect(mailbox(owner).lastUid).toBe(last);
  });

  test("[BNK-004] parser dostane holou adresu i u odesílatele se jménem", async () => {
    const { owner, invoiceId } = account();
    imap.addMessage(rawMail({ from: '"Fio banka, a.s." <AUTOMAT@fio.cz>' }));

    await poll(owner);

    expect(invoiceStatus(owner, invoiceId)).toBe("paid");
  });

  test("prozatímní česká varianta jde do fronty a neuhradí nic", async () => {
    const { owner, invoiceId } = account({ requireConfirmation: false });
    const body = [
      "Příjem na kontě: 9999999999/2010",
      "Částka: 3 000,00",
      "Měna: CZK",
      "Datum: 30.10.2026 14:05",
      "VS: 20260042",
      "ID pokynu: 10000000003",
    ].join("\r\n");
    imap.addMessage(rawMail({ subject: encodedSubject("Fio banka - příjem na kontě"), body }));

    await poll(owner);

    expect(notices(owner)[0]).toMatchObject({
      status: "pending",
      reason: "provisional",
      variant: "cs_block",
      authResult: "pass",
    });
    expect(payments(owner)).toEqual([]);
    expect(invoiceStatus(owner, invoiceId)).not.toBe("paid");
  });
});

describe("Authentication-Results", () => {
  test("[BNK-013] věří se první surové hlavičce, podvržená nižší nic nezmění", async () => {
    const { owner, invoiceId } = account({ requireConfirmation: false });
    imap.addMessage(
      rawMail({
        headers: ["Authentication-Results: mx.example.cz; dkim=fail header.d=fio.cz", PASS_HEADER],
      }),
    );

    await poll(owner);

    expect(notices(owner)[0]).toMatchObject({ reason: "auth_failed", authResult: "fail" });
    expect(invoiceStatus(owner, invoiceId)).not.toBe("paid");
  });

  test("[BNK-013] první hlavička s pass rozhodne, oříznutá o závěrečný CRLF i složená", async () => {
    const { owner, invoiceId } = account();
    imap.addMessage(
      rawMail({
        headers: [
          "Authentication-Results: mx.example.cz;\r\n dkim=pass header.d=fio.cz",
          "Authentication-Results: mx.example.cz; dkim=fail header.d=fio.cz",
        ],
      }),
    );

    await poll(owner);

    expect(notices(owner)[0]).toMatchObject({ status: "matched", authResult: "pass" });
    expect(invoiceStatus(owner, invoiceId)).toBe("paid");
  });

  test("[BNK-013] hlavička v těle se nepočítá a none se řídí nastavením", async () => {
    const { owner, invoiceId } = account();
    imap.addMessage(rawMail({ headers: [], body: `${noticeText()}\r\n\r\n${PASS_HEADER}` }));

    await poll(owner);

    expect(notices(owner)[0]).toMatchObject({
      status: "pending",
      reason: "unverified",
      authResult: "none",
    });
    expect(invoiceStatus(owner, invoiceId)).not.toBe("paid");
  });

  test("[BNK-013] none bez vyžadovaného potvrzení spáruje", async () => {
    const { owner, invoiceId } = account({ requireConfirmation: false });
    imap.addMessage(rawMail({ headers: [] }));

    await poll(owner);

    expect(notices(owner)[0]).toMatchObject({ status: "matched", authResult: "none" });
    expect(invoiceStatus(owner, invoiceId)).toBe("paid");
  });

  test("[BNK-013] fail jde do fronty i s vypnutým potvrzením", async () => {
    const { owner } = account({ requireConfirmation: false });
    imap.addMessage(
      rawMail({
        headers: ["Authentication-Results: mx.example.cz; spf=fail smtp.mailfrom=fio.cz"],
      }),
    );

    await poll(owner);

    expect(notices(owner)[0]).toMatchObject({ status: "pending", reason: "auth_failed" });
    expect(payments(owner)).toEqual([]);
  });
});

describe("kurzor a duplicity", () => {
  test("[BNK-006] znovu přečtená zpráva nic nezmění", async () => {
    const { owner, invoiceId } = account();
    imap.addMessage(rawMail());
    await poll(owner);
    const revision = getInvoice(owner, invoiceId)!.revision;
    const audits = db.select().from(auditLog).all().length;

    db.update(bankMailbox).set({ lastUid: null }).where(eq(bankMailbox.userId, owner)).run();
    await poll(owner);

    expect(notices(owner)).toHaveLength(1);
    expect(payments(owner)).toHaveLength(1);
    expect(getInvoice(owner, invoiceId)!.revision).toBe(revision);
    expect(db.select().from(auditLog).all()).toHaveLength(audits);
    assertConsistent(db, owner);
  });

  test("[BNK-006] stejné ID pokynu v jiné zprávě a jiném zápisu účtu se nepočítá", async () => {
    const { owner } = account();
    imap.addMessage(rawMail());
    imap.addMessage(rawMail({ body: noticeText({ account: "0-9999999999" }) }));

    await poll(owner);

    expect(notices(owner)).toHaveLength(1);
    expect(payments(owner)).toHaveLength(1);
  });

  test("[BNK-006] reset UIDVALIDITY nezaloží druhou platbu", async () => {
    const { owner } = account();
    imap.addMessage(rawMail());
    await poll(owner);

    imap.setUidValidity(2000);
    await poll(owner);

    expect(payments(owner)).toHaveLength(1);
    expect(mailbox(owner)).toMatchObject({ uidValidity: 2000, lastUid: 1, firstReadAt: NOW });
  });

  test("první běh čte nejvýš 30 dní zpět", async () => {
    const { owner } = account();
    imap.addMessage(rawMail({ body: noticeText({ id: "1" }) }), new Date(NOW.getTime() - 40 * DAY));
    imap.addMessage(rawMail({ body: noticeText({ id: "2", amount: "1.00" }) }), NOW);

    await poll(owner);

    expect(notices(owner).map((row) => row.instructionId)).toEqual(["2"]);
  });

  test("limit 50 zpráv nechá přebytek dalšímu běhu", async () => {
    const { owner } = account();
    for (let i = 0; i < 51; i += 1) imap.addMessage(rawMail({ subject: "Fio banka - expense" }));

    await poll(owner);
    expect(mailbox(owner).lastUid).toBe(50);

    await poll(owner);
    expect(mailbox(owner).lastUid).toBe(51);
  });

  test("[BNK-012] nerozpoznané avízo zůstane a nezablokuje další zprávy", async () => {
    const { owner, invoiceId } = account();
    imap.addMessage(rawMail({ body: "Nový formát 1111111116" }));
    imap.addMessage(rawMail({ subject: "Fio banka - změna podmínek", messageId: null }));
    imap.addMessage(rawMail({ body: "" }));
    imap.addMessage(rawMail());

    await poll(owner);

    const stored = notices(owner);
    expect(stored.filter((row) => row.status === "matched")).toHaveLength(1);
    expect(stored.filter((row) => row.status === "unrecognized")).toHaveLength(3);
    expect(stored.map((row) => row.textMasked)).toContain("Nový formát ******1116");
    expect(stored.filter((row) => row.textMasked === null)).toHaveLength(2);
    expect(invoiceStatus(owner, invoiceId)).toBe("paid");
    expect(mailbox(owner).lastUid).toBe(4);
    expect(bodyFetches()).toHaveLength(3);
    assertConsistent(db, owner);
  });

  test("[BNK-012] příliš velká zpráva je nerozpoznaná bez textu", async () => {
    const { owner } = account();
    imap.addMessage(rawMail({ body: "x".repeat(257 * 1024) }));

    await poll(owner);

    expect(notices(owner)).toEqual([
      expect.objectContaining({ status: "unrecognized", textMasked: null }),
    ]);
    expect(mailbox(owner).lastUid).toBe(1);
  });

  test("[BNK-012] reset UIDVALIDITY nezaloží nerozpoznané avízo znovu", async () => {
    const { owner } = account();
    imap.addMessage(rawMail({ body: "Nový formát" }));
    await poll(owner);
    imap.setUidValidity(2000);
    await poll(owner);
    expect(notices(owner)).toHaveLength(1);
  });
});

describe("selhání", () => {
  const leakyParser: BankNoticeParser = {
    ...fioParser,
    parse() {
      throw new Error(`Protistrana Ukazkova ${COUNTERPARTY}`);
    },
  };

  test("pád parseru se ohlásí bez obsahu a zpráva je nerozpoznaná", async () => {
    const { owner, invoiceId } = account();
    imap.addMessage(rawMail());
    imap.addMessage(rawMail({ body: noticeText({ id: "2" }) }));

    await poll(owner, { parsers: [leakyParser] });

    expect(notices(owner).map((row) => row.status)).toEqual(["unrecognized", "unrecognized"]);
    expect(payments(owner)).toEqual([]);
    expect(invoiceStatus(owner, invoiceId)).not.toBe("paid");
    expect(mailbox(owner)).toMatchObject({ lastUid: 2, failures: 0 });
    expect(report.captureException).toHaveBeenCalledTimes(2);
    expect(
      JSON.stringify(report.captureException.mock.calls.map(([e]) => String(e))),
    ).not.toContain("Ukazkova");
  });

  test("selhání zápisu avíza dávku zastaví bez posunu kurzoru", async () => {
    const { owner, invoiceId } = account();
    imap.addMessage(rawMail());
    imap.addMessage(rawMail({ body: noticeText({ id: "2" }) }));
    db.$client.exec(
      "CREATE TRIGGER stop_notice BEFORE INSERT ON bank_notification BEGIN SELECT RAISE(ABORT, 'zapis'); END",
    );

    try {
      await expect(poll(owner)).resolves.toBeUndefined();
    } finally {
      db.$client.exec("DROP TRIGGER stop_notice");
    }

    expect(notices(owner)).toEqual([]);
    expect(mailbox(owner)).toMatchObject({ lastUid: null, failureCode: "other", failures: 1 });
    expect(invoiceStatus(owner, invoiceId)).not.toBe("paid");

    await poll(owner);
    expect(invoiceStatus(owner, invoiceId)).toBe("paid");
    expect(mailbox(owner)).toMatchObject({ lastUid: 2, failures: 0 });
  });

  test("selhání zápisu platby vrátí celou zprávu a kurzor stojí", async () => {
    const { owner, invoiceId } = account();
    imap.addMessage(rawMail());
    db.$client.exec(
      "CREATE TRIGGER stop_payment BEFORE INSERT ON payment BEGIN SELECT RAISE(ABORT, 'zapis'); END",
    );

    try {
      await poll(owner);
    } finally {
      db.$client.exec("DROP TRIGGER stop_payment");
    }

    expect(notices(owner)).toEqual([]);
    expect(payments(owner)).toEqual([]);
    expect(invoiceStatus(owner, invoiceId)).not.toBe("paid");
    expect(mailbox(owner).lastUid).toBeNull();
    assertConsistent(db, owner);
  });

  test("běh dodrží strop času na zablokovaném serveru", async () => {
    const { owner } = account();
    imap.addMessage(rawMail());
    imap.blockUid(imap.addMessage(rawMail({ body: noticeText({ id: "2" }) })));
    const started = performance.now();

    await poll(owner, { deadlineMs: 400 });

    expect(performance.now() - started).toBeLessThan(3_000);
    expect(notices(owner)).toHaveLength(1);
    expect(mailbox(owner)).toMatchObject({ lastUid: 1, failureCode: "timeout", failures: 1 });
  });

  test("audit, log ani Sentry neobsahují protiúčet ani text zprávy", async () => {
    const { owner } = account();
    const secret = "TajnaZprava";
    imap.addMessage(rawMail({ body: noticeText({ message: secret }) }));
    imap.addMessage(rawMail({ body: noticeText({ id: "2", amount: "1.00", message: secret }) }));
    imap.addMessage(rawMail({ body: `Jiný formát ${secret}` }));
    await poll(owner);
    imap.addMessage(rawMail({ body: noticeText({ id: "3", message: secret }) }));
    await poll(owner, { parsers: [leakyParser] });
    imap.addMessage(rawMail({ body: noticeText({ id: "4", message: secret }) }));
    db.$client.exec(
      "CREATE TRIGGER stop_notice BEFORE INSERT ON bank_notification BEGIN SELECT RAISE(ABORT, 'zapis'); END",
    );
    try {
      await poll(owner);
    } finally {
      db.$client.exec("DROP TRIGGER stop_notice");
    }

    const sent = report.captureException.mock.calls.flatMap(([error]) => [
      String(error),
      String((error as Error).stack),
      String((error as Error).cause),
    ]);
    expect(sent.length).toBeGreaterThan(0);
    const stored = JSON.stringify(db.select().from(auditLog).all());
    for (const text of [stored, sent.join("\n"), stdout.join("\n")]) {
      for (const leak of [secret, "Ukazkova", "1111111116", "9999999999"]) {
        expect(text).not.toContain(leak);
      }
    }
    assertConsistent(db, owner);
  });
});

describe("spuštění", () => {
  test("hlavní vypínač čtení nezastaví a deaktivovaný účet se nečte", async () => {
    const { owner, invoiceId } = account();
    db.insert(automationSettings).values({ userId: owner, paused: true, updatedAt: NOW }).run();
    imap.addMessage(rawMail());
    await poll(owner);
    expect(invoiceStatus(owner, invoiceId)).toBe("paid");

    imap.commands.length = 0;
    db.update(user).set({ banned: true }).where(eq(user.id, owner)).run();
    await poll(owner);
    expect(imap.commands).toEqual([]);
  });

  test("vypnutá schránka se nečte a nepoškozené heslo je podmínka", async () => {
    const off = account({ enabled: false });
    await poll(off.owner);
    expect(imap.connections()).toBe(0);
    expect(mailbox(off.owner).lastCheckAt).toBeNull();

    const broken = account({ passwordEnc: "rozbite" });
    await poll(broken.owner);
    expect(imap.connections()).toBe(0);
    expect(mailbox(broken.owner)).toMatchObject({ failureCode: "decrypt", failures: 1 });
  });

  test("[BNK-015] stav ukáže kontrolu a avízo, 3 selhání založí upozornění, úspěch ho vyřeší", async () => {
    const { owner } = account();
    imap.addMessage(rawMail());
    await poll(owner);
    expect(bankStatus(owner)).toMatchObject({
      enabled: true,
      lastCheckAt: NOW,
      lastSuccessAt: NOW,
      lastNoticeAt: NOW,
      failureCode: null,
      failures: 0,
    });
    const rows = () => db.select().from(notification).where(eq(notification.userId, owner)).all();

    for (let i = 1; i <= 2; i += 1) {
      imap.failNext("auth");
      current = new Date(NOW.getTime() + i * FIVE_MINUTES);
      await poll(owner);
      expect(rows()).toEqual([]);
    }
    imap.failNext("auth");
    current = new Date(NOW.getTime() + 3 * FIVE_MINUTES);
    await poll(owner);
    expect(bankStatus(owner)).toMatchObject({
      failureCode: "auth",
      failures: 3,
      lastCheckAt: current,
      lastSuccessAt: NOW,
    });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ kind: "bank_connection_failed", resolvedAt: null });
    expect(notificationText("bank_connection_failed", rows()[0]!.params)).not.toContain(
      "undefined",
    );

    imap.failNext("auth");
    await poll(owner);
    expect(rows()).toHaveLength(1);

    current = new Date(NOW.getTime() + 5 * FIVE_MINUTES);
    await poll(owner);
    expect(bankStatus(owner)).toMatchObject({ failureCode: null, failures: 0 });
    expect(rows()[0]!.resolvedAt).toEqual(current);

    for (let i = 0; i < 3; i += 1) {
      imap.failNext("folder");
      await poll(owner);
    }
    expect(rows()).toHaveLength(2);
    expect(bankStatus(owner)).toMatchObject({ failureCode: "folder" });
  });

  test("změna schránky během běhu nepřepíše novou pozici", async () => {
    const { owner } = account();
    imap.addMessage(rawMail({ subject: "Fio banka - expense" }));
    const moving: BankNoticeParser = {
      ...fioParser,
      classify(meta) {
        db.update(bankMailbox)
          .set({ updatedAt: new Date(NOW.getTime() + 1), uidValidity: null, firstReadAt: null })
          .where(eq(bankMailbox.userId, owner))
          .run();
        return fioParser.classify(meta);
      },
    };

    await poll(owner, { parsers: [moving] });

    expect(mailbox(owner)).toMatchObject({ uidValidity: null, lastUid: null, lastCheckAt: null });
  });
});

describe("plán", () => {
  beforeEach(() => {
    db.delete(job).run();
    db.delete(bankMailbox).run();
  });

  test("[BNK-003] plán založí běh každých 5 minut a výpadek dá jeden běh", () => {
    const { owner } = account();

    planBankPolls(NOW);
    planBankPolls(new Date(NOW.getTime() + 60_000));
    expect(jobsOf(db, owner)).toHaveLength(1);
    expect(jobsOf(db, owner)[0]).toMatchObject({
      kind: "bank.poll",
      key: `bank:${owner}:${Math.floor(NOW.getTime() / FIVE_MINUTES)}`,
    });

    planBankPolls(new Date(NOW.getTime() + FIVE_MINUTES));
    expect(jobsOf(db, owner)).toHaveLength(1);

    const claimed = claimNext("w")!;
    completeJob(claimed.id, "w");
    planBankPolls(new Date(NOW.getTime() + 3 * 3_600_000));
    expect(jobsOf(db, owner)).toHaveLength(2);
  });

  test("[BNK-003] plán vynechá deaktivované účty a vypnuté schránky", () => {
    const off = account({ enabled: false });
    const banned = account();
    db.update(user).set({ banned: true }).where(eq(user.id, banned.owner)).run();

    planBankPolls(NOW);

    expect(jobsOf(db, off.owner)).toEqual([]);
    expect(jobsOf(db, banned.owner)).toEqual([]);
  });

  test("[BNK-003] Zkontrolovat teď založí běh hned", async () => {
    const { owner, invoiceId } = account();
    const actor = { userId: owner, source: "web" as const };
    imap.addMessage(rawMail());

    checkMailboxNow(actor, "req-1");
    checkMailboxNow(actor, "req-1");

    expect(jobsOf(db, owner).map((row) => row.key)).toEqual([`bank:${owner}:now:req-1`]);
    registerJob("bank.poll", { run: (row) => pollMailbox(row, { env }) });
    await drainJobs("w-poll");
    expect(invoiceStatus(owner, invoiceId)).toBe("paid");
  });

  test("[BNK-003] Zkontrolovat teď má limit a chce povolenou schránku", () => {
    const { owner } = account();
    const off = account({ enabled: false });
    db.delete(rateLimit).run();
    expect(() => checkMailboxNow({ userId: off.owner, source: "web" }, "r")).toThrow();
    for (let i = 0; i < 10; i += 1) {
      checkMailboxNow({ userId: owner, source: "web" }, `r-${i}`);
    }
    expect(() => checkMailboxNow({ userId: owner, source: "web" }, "r-x")).toThrow(RateLimitError);
  });

  test("hotové běhy bank.poll zmizí po 7 dnech", () => {
    const { owner } = account();
    planBankPolls(NOW);
    const claimed = claimNext("w")!;
    completeJob(claimed.id, "w");

    purgeFinishedJobs(new Date(NOW.getTime() + 6 * DAY));
    expect(jobsOf(db, owner)).toHaveLength(1);
    purgeFinishedJobs(new Date(NOW.getTime() + 8 * DAY));
    expect(jobsOf(db, owner)).toEqual([]);
  });
});
