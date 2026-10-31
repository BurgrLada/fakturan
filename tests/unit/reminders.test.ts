import { describe, expect, test } from "vitest";
import {
  dueStage,
  isEligibleForReminder,
  MANUAL_STAGE,
  reminderRuleSchema,
  stageForReview,
  type ReminderRule,
} from "@/lib/reminders";

const rule = (id: string, offsetDays: number): ReminderRule => ({ id, offsetDays, texts: null });
const BEFORE = rule("before", -3);
const AFTER = rule("after", 1);
const LATE = rule("late", 7);
const RULES = [BEFORE, AFTER, LATE];

const invoice = { dueDate: "2026-03-10", remindersSnoozeUntil: null };
const input = (over: Partial<Parameters<typeof dueStage>[0]> = {}) => ({
  invoice,
  rules: RULES,
  sentStages: [] as string[],
  today: "2026-03-11",
  openSince: "2026-01-01",
  ...over,
});

describe("dueStage", () => {
  test("stupeň přijde v den svého data, ne dřív", () => {
    expect(dueStage(input({ today: "2026-03-06" }))).toBeNull();
    expect(dueStage(input({ today: "2026-03-07" }))).toBe(BEFORE);
    expect(dueStage(input({ today: "2026-03-11" }))).toBe(AFTER);
  });

  test("datum rovné openSince neprojde, o den pozdější ano", () => {
    expect(dueStage(input({ openSince: "2026-03-11" }))).toBeNull();
    const single = input({ rules: [AFTER], openSince: "2026-03-10" });
    expect(dueStage(single)).toBe(AFTER);
  });

  test("stupeň starý 3 dny ještě odejde, starší ne", () => {
    const rules = [AFTER];
    expect(dueStage(input({ rules, today: "2026-03-14" }))).toBe(AFTER);
    expect(dueStage(input({ rules, today: "2026-03-15" }))).toBeNull();
  });

  test("z několika způsobilých se vezme nejpozdější", () => {
    const rules = [rule("a", 1), rule("b", 2), rule("c", 3)];
    expect(dueStage(input({ rules, today: "2026-03-13" }))?.id).toBe("c");
  });

  test("po pozdějším stupni už dřívější neodejde", () => {
    const rules = [rule("a", 1), rule("b", 3)];
    const today = "2026-03-13";
    expect(dueStage(input({ rules, today, sentStages: ["b"] }))).toBeNull();
    expect(dueStage(input({ rules, today: "2026-03-11", sentStages: ["b"] }))).toBeNull();
    expect(dueStage(input({ rules: [AFTER], sentStages: ["after"] }))).toBeNull();
  });

  test("odklad posune datum stupně", () => {
    const snoozed = { ...invoice, remindersSnoozeUntil: "2026-03-20" };
    const rules = [AFTER];
    expect(dueStage(input({ rules, invoice: snoozed, today: "2026-03-19" }))).toBeNull();
    expect(dueStage(input({ rules, invoice: snoozed, today: "2026-03-20" }))).toBe(AFTER);
  });

  test("ruční upomínka bez stupně pořadí nemění", () => {
    expect(dueStage(input({ sentStages: [MANUAL_STAGE] }))).toBe(AFTER);
  });

  test("bez splatnosti není stupeň", () => {
    expect(dueStage(input({ invoice: { ...invoice, dueDate: null } }))).toBeNull();
  });
});

describe("stageForReview", () => {
  test("ukáže stupeň před zapnutím a stupeň starší 3 dnů", () => {
    expect(stageForReview(input({ today: "2026-03-20", openSince: "2026-03-20" }))).toBe(LATE);
    expect(stageForReview(input({ today: "2026-03-30" }))).toBe(LATE);
  });

  test("stupeň, který ještě může odejít, ke kontrole nepatří", () => {
    expect(stageForReview(input({ rules: [AFTER] }))).toBeNull();
  });

  test("po pozdějším odeslaném stupni není co kontrolovat", () => {
    expect(stageForReview(input({ today: "2026-03-30", sentStages: ["late"] }))).toBeNull();
  });
});

describe("isEligibleForReminder", () => {
  const row = {
    type: "invoice" as const,
    status: "sent" as const,
    totalMinor: 1000,
    paidMinor: 0,
    remindersOff: false,
    remindersPartial: false,
  };
  const client = { remindersEnabled: null };

  test("odeslaná dlužná faktura i záloha ano, dobropis ne", () => {
    expect(isEligibleForReminder(row, client)).toBe(true);
    expect(isEligibleForReminder({ ...row, type: "advance" }, null)).toBe(true);
    expect(isEligibleForReminder({ ...row, type: "credit_note" }, client)).toBe(false);
  });

  test("true na zákazníkovi nic nepřidá, false blokuje", () => {
    expect(isEligibleForReminder(row, { remindersEnabled: true })).toBe(true);
    expect(isEligibleForReminder(row, { remindersEnabled: false })).toBe(false);
  });

  test.each(["draft", "issued", "paid", "cancelled", "credited"] as const)(
    "stav %s nikdy, ani se zapnutou částečnou",
    (status) => {
      expect(isEligibleForReminder({ ...row, status, remindersPartial: true }, client)).toBe(false);
    },
  );

  test("částečná jen po zapnutí", () => {
    const partial = { ...row, status: "partially_paid" as const, paidMinor: 400 };
    expect(isEligibleForReminder(partial, client)).toBe(false);
    expect(isEligibleForReminder({ ...partial, remindersPartial: true }, client)).toBe(true);
  });

  test("vypnutá nebo plně zaplacená ne", () => {
    expect(isEligibleForReminder({ ...row, remindersOff: true }, client)).toBe(false);
    expect(isEligibleForReminder({ ...row, paidMinor: 1000 }, client)).toBe(false);
  });
});

describe("reminderRuleSchema", () => {
  const raw = { offsetDays: 7, texts: null };

  test("stupeň přijme jen celé dny v rozsahu", () => {
    expect(reminderRuleSchema.safeParse(raw).success).toBe(true);
    expect(reminderRuleSchema.safeParse({ ...raw, offsetDays: 1.5 }).success).toBe(false);
    expect(reminderRuleSchema.safeParse({ ...raw, offsetDays: 366 }).success).toBe(false);
  });

  test("vlastní text smí použít jen známé proměnné a předmět je jeden řádek", () => {
    const texts = (subject: string) => ({ ...raw, texts: { cs: { subject, body: "Text" } } });
    expect(reminderRuleSchema.safeParse(texts("Zbývá {{zbyva}}")).success).toBe(true);
    expect(reminderRuleSchema.safeParse(texts("{{neznama}}")).success).toBe(false);
    expect(reminderRuleSchema.safeParse(texts("A\nBcc: x@y.cz")).success).toBe(false);
  });
});
