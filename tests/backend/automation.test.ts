import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AUTOMATIONS, DEFAULT_SEND_TIME } from "@/lib/automation";
import { setClockForTests } from "@/server/clock";
import { appearanceFrom } from "@/lib/invoice";
import { DEFAULT_PREFERENCES } from "@/lib/preferences";
import { auditLog, automationSettings, customer, invoice, user } from "@/server/db/schema";
import { ServiceError } from "@/server/services/access";
import {
  automaticSendAllowed,
  automationImpact,
  getAutomation,
  setAutomation,
  setDailyDigest,
  setPaused,
  setSendTime,
} from "@/server/services/automation";
import { deactivateUser, deleteUser, USER_OWNED_TABLES } from "@/server/services/users";
import { createTestDb } from "../helpers/db";
import { assertIsolated } from "../helpers/isolation";

vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-automation-")));

const db = createTestDb();
const T0 = new Date("2026-11-02T10:00:00Z");
const actor = (userId: string) => ({ userId, source: "web" as const });
const confirmed = { confirmed: true };

afterEach(() => setClockForTests(null));

function seed(role: "admin" | "user" = "user"): string {
  const id = randomUUID();
  db.insert(user)
    .values({ id, name: id, email: `${id}@x.cz`, role, createdAt: T0, updatedAt: T0 })
    .run();
  return id;
}

const audits = (ownerId: string) =>
  db
    .select()
    .from(auditLog)
    .where(eq(auditLog.ownerId, ownerId))
    .all()
    .filter((row) => row.entity === "automation");

describe("výchozí stav", () => {
  for (const { key } of AUTOMATIONS) {
    test(`[SET-041] ${key} je na čisté databázi vypnutá`, () => {
      const id = seed();

      expect(getAutomation(id)[key]).toBe(false);
      expect(automaticSendAllowed(id, key)).toBe(false);
      expect(
        db.select().from(automationSettings).where(eq(automationSettings.userId, id)).all(),
      ).toEqual([]);
    });
  }

  test("[REM-001] upomínky jsou na novém účtu vypnuté", () => {
    const id = seed();

    expect(getAutomation(id)).toMatchObject({
      reminders: false,
      paused: false,
      remindersOpenSince: null,
      sendTime: DEFAULT_SEND_TIME,
      dailyDigest: false,
    });
  });

  test("[SET-040] nedostupné automatiky jdou vidět, ale nejdou zapnout", () => {
    const id = seed();

    expect(AUTOMATIONS.filter((entry) => !entry.available).map((entry) => entry.key)).toEqual([
      "paymentReceipt",
      "advanceInvoice",
    ]);
    expect(() => setAutomation(actor(id), "paymentReceipt", true, confirmed)).toThrow(ServiceError);
    expect(getAutomation(id).paymentReceipt).toBe(false);
  });
});

describe("zapnutí a potvrzení", () => {
  test("[SET-042] zapnutí bez potvrzení je odmítnuté službou", () => {
    const id = seed();

    expect(() => setAutomation(actor(id), "reminders", true, { confirmed: false })).toThrow(
      ServiceError,
    );
    expect(getAutomation(id).reminders).toBe(false);
    expect(audits(id)).toEqual([]);
  });

  test("[SET-042] zapnutí s potvrzením zapne jen vybranou automatiku", () => {
    const id = seed();

    setAutomation(actor(id), "recurringSend", true, confirmed);

    expect(getAutomation(id)).toMatchObject({ recurringSend: true, reminders: false });
    expect(automaticSendAllowed(id, "recurringSend")).toBe(true);
    expect(automaticSendAllowed(id, "reminders")).toBe(false);
  });

  test("[SET-042] vypnutí potvrzení nepotřebuje", () => {
    const id = seed();
    setAutomation(actor(id), "recurringSend", true, confirmed);

    setAutomation(actor(id), "recurringSend", false, { confirmed: false });

    expect(getAutomation(id).recurringSend).toBe(false);
  });

  test("[SET-042] dialog počítá jen zákazníky s adresou a dokladem, kterým upomínka může odejít", () => {
    const id = seed();
    const row = (name: string, extra: Partial<typeof customer.$inferInsert> = {}) => {
      const customerId = randomUUID();
      db.insert(customer)
        .values({
          id: customerId,
          userId: id,
          name,
          email: `${name}@example.cz`,
          createdAt: T0,
          updatedAt: T0,
          ...extra,
        })
        .run();
      return customerId;
    };
    const document = (customerId: string, extra: Partial<typeof invoice.$inferInsert> = {}) =>
      db
        .insert(invoice)
        .values({
          id: randomUUID(),
          userId: id,
          customerId,
          type: "invoice",
          language: "cs",
          currency: "CZK",
          paymentMethod: "cash",
          appearance: appearanceFrom(DEFAULT_PREFERENCES),
          createdAt: T0,
          updatedAt: T0,
          ...extra,
        })
        .run();
    document(row("a"), { status: "sent" });
    document(row("b", { remindersEnabled: true }), { status: "partially_paid" });
    document(row("c", { remindersEnabled: false }), { status: "sent" });
    document(row("d", { archivedAt: T0 }), { status: "sent" });
    document(row("e", { email: "" }), { status: "sent" });
    document(row("f"), { status: "issued" });
    document(row("g"), { status: "paid" });
    document(row("h"), { status: "sent", type: "credit_note" });
    row("i");

    expect(automationImpact(id)).toEqual({ plans: 0, customers: 3 });
  });

  test("[REM-001] zapnutí upomínek si pamatuje den, od kterého platí", () => {
    const id = seed();
    setClockForTests({ now: () => new Date("2026-11-02T23:30:00Z") });

    setAutomation(actor(id), "reminders", true, confirmed);

    expect(getAutomation(id).remindersOpenSince).toBe("2026-11-03");
  });

  test("[SET-042] zapnutí jiné automatiky den upomínek nemění", () => {
    const id = seed();
    setClockForTests({ now: () => T0 });
    setAutomation(actor(id), "recurringSend", true, confirmed);

    expect(getAutomation(id).remindersOpenSince).toBeNull();
  });
});

describe("hlavní vypínač", () => {
  test("[SET-043] hlavní vypínač zavře automaticSendAllowed všem automatikám", () => {
    const id = seed();
    for (const entry of AUTOMATIONS.filter((item) => item.available)) {
      setAutomation(actor(id), entry.key, true, confirmed);
    }
    const open = AUTOMATIONS.filter((entry) => entry.available).map((entry) => entry.key);
    expect(open.map((key) => automaticSendAllowed(id, key))).toEqual([true, true]);

    setPaused(actor(id), true, { confirmed: false });

    for (const { key } of AUTOMATIONS) expect(automaticSendAllowed(id, key)).toBe(false);
    expect(getAutomation(id)).toMatchObject({ recurringSend: true, reminders: true, paused: true });
  });

  test("[SET-043] zrušení pozastavení bez potvrzení služba odmítne", () => {
    const id = seed();
    setPaused(actor(id), true, { confirmed: false });

    expect(() => setPaused(actor(id), false, { confirmed: false })).toThrow(ServiceError);
    expect(getAutomation(id).paused).toBe(true);
  });

  test("[SET-043] zrušení pozastavení otevře automatiky a posune den upomínek", () => {
    const id = seed();
    setClockForTests({ now: () => T0 });
    setAutomation(actor(id), "reminders", true, confirmed);
    setPaused(actor(id), true, { confirmed: false });
    setClockForTests({ now: () => new Date("2026-11-09T10:00:00Z") });

    setPaused(actor(id), false, confirmed);

    expect(automaticSendAllowed(id, "reminders")).toBe(true);
    expect(getAutomation(id).remindersOpenSince).toBe("2026-11-09");
  });

  test("[SET-043] zrušení pozastavení bez upomínek den nenastavuje", () => {
    const id = seed();
    setPaused(actor(id), true, { confirmed: false });

    setPaused(actor(id), false, confirmed);

    expect(getAutomation(id).remindersOpenSince).toBeNull();
  });

  test("[SET-043] deaktivovaný účet nic automaticky neposílá", () => {
    const admin = seed("admin");
    const id = seed();
    setAutomation(actor(id), "recurringSend", true, confirmed);
    expect(automaticSendAllowed(id, "recurringSend")).toBe(true);

    deactivateUser(actor(admin), id);

    expect(automaticSendAllowed(id, "recurringSend")).toBe(false);
  });

  test("[SET-043] neexistující účet nic neposílá", () => {
    expect(automaticSendAllowed(randomUUID(), "recurringSend")).toBe(false);
  });
});

describe("čas odeslání a denní přehled", () => {
  test("čas odeslání se uloží a špatný tvar služba odmítne", () => {
    const id = seed();

    setSendTime(actor(id), "07:45");
    expect(getAutomation(id).sendTime).toBe("07:45");
    for (const bad of ["7:45", "24:00", "09:60", "", "09:00:00", "ráno"]) {
      expect(() => setSendTime(actor(id), bad)).toThrow(ServiceError);
    }
    expect(getAutomation(id).sendTime).toBe("07:45");
  });

  test("denní přehled jde zapnout i vypnout bez potvrzení", () => {
    const id = seed();

    setDailyDigest(actor(id), true);
    expect(getAutomation(id).dailyDigest).toBe(true);
    setDailyDigest(actor(id), false);
    expect(getAutomation(id).dailyDigest).toBe(false);
  });
});

describe("audit a izolace", () => {
  test("[AUD-001] každé přepnutí je v auditu", () => {
    const id = seed();
    setClockForTests({ now: () => T0 });

    setAutomation(actor(id), "recurringSend", true, confirmed);
    setAutomation(actor(id), "recurringSend", false, confirmed);
    setPaused(actor(id), true, confirmed);
    setPaused(actor(id), false, confirmed);
    setSendTime(actor(id), "08:15");
    setDailyDigest(actor(id), true);

    expect(audits(id).map((row) => row.action)).toEqual([
      "automation.enable",
      "automation.disable",
      "automation.pause",
      "automation.resume",
      "automation.send_time",
      "automation.daily_digest",
    ]);
    expect(audits(id)[0]).toMatchObject({
      ownerId: id,
      actorId: id,
      scope: "user",
      entityId: id,
      after: expect.objectContaining({ key: "recurringSend", enabled: true }),
    });
  });

  test("[AUD-001] přepnutí na stejnou hodnotu nic nezapíše", () => {
    const id = seed();

    setAutomation(actor(id), "reminders", false, confirmed);
    setPaused(actor(id), false, confirmed);
    setDailyDigest(actor(id), false);

    expect(audits(id)).toEqual([]);
  });

  test("[TST-009] izolace nastavení včetně update a remove", async () => {
    let marker = 0;
    await assertIsolated<string>({
      create: (ownerId) => {
        db.insert(user)
          .values({
            id: ownerId,
            name: ownerId,
            email: `${ownerId}@x.cz`,
            createdAt: T0,
            updatedAt: T0,
          })
          .run();
        marker += 1;
        const time = `0${marker}:00`;
        setSendTime(actor(ownerId), time);
        setAutomation(actor(ownerId), "recurringSend", true, confirmed);
        return time;
      },
      find: (ownerId, time) => {
        const current = getAutomation(ownerId);
        return current.sendTime === time && current.recurringSend ? current : null;
      },
      update: (ownerId, time) => {
        if (getAutomation(ownerId).sendTime !== time) return 0;
        setDailyDigest(actor(ownerId), true);
        return getAutomation(ownerId).dailyDigest ? 1 : 0;
      },
      remove: (ownerId, time) => {
        if (getAutomation(ownerId).sendTime !== time) return 0;
        setAutomation(actor(ownerId), "recurringSend", false, confirmed);
        return getAutomation(ownerId).recurringSend ? 0 : 1;
      },
    });
  });

  test("[TST-009] aktér bez účtu nastavení nezmění", () => {
    expect(() =>
      setAutomation({ userId: null, source: "scheduler" }, "reminders", true, confirmed),
    ).toThrow(ServiceError);
  });

  test("[ADM-006] nastavení se smaže s účtem", () => {
    const admin = seed("admin");
    const id = seed();
    setAutomation(actor(id), "recurringSend", true, confirmed);
    expect(USER_OWNED_TABLES).toContain(automationSettings);

    deleteUser(actor(admin), id, `${id}@x.cz`);

    expect(
      db.select().from(automationSettings).where(eq(automationSettings.userId, id)).all(),
    ).toEqual([]);
  });
});
