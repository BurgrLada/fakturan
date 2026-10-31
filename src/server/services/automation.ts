import "server-only";
import { and, count, eq, exists, inArray, isNull, ne, or } from "drizzle-orm";
import {
  AUTOMATIONS,
  DEFAULT_AUTOMATION,
  SEND_TIME_PATTERN,
  type AutomationKey,
  type AutomationSettings,
} from "@/lib/automation";
import { calendarDateInPrague } from "@/lib/number-format";
import { REMINDABLE_TYPES } from "@/lib/reminders";
import { TEXTS } from "@/lib/texts";
import type { Actor } from "../audit/context";
import { clock } from "../clock";
import { db } from "../db";
import { automationSettings, customer, invoice, recurringInvoice, user } from "../db/schema";
import { scoped } from "../db/scoped";
import { ServiceError } from "./access";
import { mutate } from "./mutation";

const T = TEXTS.automation.errors;

function ownerOf(actor: Actor): string {
  if (!actor.userId) throw new ServiceError(T.forbidden);
  return actor.userId;
}

function toSettings(row: typeof automationSettings.$inferSelect | undefined): AutomationSettings {
  if (!row) return { ...DEFAULT_AUTOMATION };
  return {
    recurringSend: row.recurringSend,
    reminders: row.reminders,
    paymentReceipt: row.paymentReceipt,
    advanceInvoice: row.advanceInvoice,
    paused: row.paused,
    remindersOpenSince: row.remindersOpenSince,
    sendTime: row.sendTime,
    dailyDigest: row.dailyDigest,
  };
}

export function getAutomation(ownerId: string): AutomationSettings {
  return toSettings(
    db.select().from(automationSettings).where(scoped(ownerId).where(automationSettings)).get(),
  );
}

// The one place that decides whether anything may leave without a click (SET-043).
export function automaticSendAllowed(ownerId: string, key: AutomationKey): boolean {
  const account = db.select({ banned: user.banned }).from(user).where(eq(user.id, ownerId)).get();
  if (!account || account.banned) return false;
  const settings = getAutomation(ownerId);
  return !settings.paused && settings[key];
}

// A null override follows the account (R-12). Only a customer with an address and a document that
// could be reminded of can actually receive anything.
export function automationImpact(ownerId: string): { plans: number; customers: number } {
  const row = db
    .select({ n: count() })
    .from(customer)
    .where(
      scoped(ownerId).where(customer, (t) =>
        and(
          isNull(t.archivedAt),
          or(isNull(t.remindersEnabled), ne(t.remindersEnabled, false)),
          ne(t.email, ""),
          exists(
            db
              .select({ id: invoice.id })
              .from(invoice)
              .where(
                and(
                  eq(invoice.customerId, t.id),
                  inArray(invoice.status, ["sent", "partially_paid"]),
                  inArray(invoice.type, REMINDABLE_TYPES),
                ),
              ),
          ),
        ),
      ),
    )
    .get();
  const plans = db
    .select({ n: count() })
    .from(recurringInvoice)
    .where(
      scoped(ownerId).where(recurringInvoice, (t, { and, eq }) =>
        and(eq(t.mode, "send"), eq(t.status, "active")),
      ),
    )
    .get();
  return { plans: plans?.n ?? 0, customers: row?.n ?? 0 };
}

type Change = {
  action: string;
  patch: Partial<typeof automationSettings.$inferInsert>;
  after: Record<string, unknown>;
};

function apply(actor: Actor, change: (before: AutomationSettings) => Change | null): void {
  const userId = ownerOf(actor);
  const probe = change(getAutomation(userId));
  if (!probe) return;
  mutate(actor, probe.action as `${string}.${string}`, (tx, audit) => {
    const row = tx
      .select()
      .from(automationSettings)
      .where(scoped(userId).where(automationSettings))
      .get();
    const before = toSettings(row);
    const next = change(before);
    if (!next) throw new ServiceError(T.changed);
    tx.insert(automationSettings)
      .values({ ...before, ...next.patch, userId, updatedAt: clock.now() })
      .onConflictDoUpdate({
        target: automationSettings.userId,
        set: { ...next.patch, updatedAt: clock.now() },
      })
      .run();
    audit({
      action: next.action as `${string}.${string}`,
      entity: "automation",
      entityId: userId,
      ownerId: userId,
      scope: "user",
      before,
      after: next.after,
    });
  });
}

function today(): string {
  return calendarDateInPrague(clock.now());
}

export function setAutomation(
  actor: Actor,
  key: AutomationKey,
  enabled: boolean,
  opts: { confirmed: boolean },
): void {
  const entry = AUTOMATIONS.find((item) => item.key === key);
  if (!entry) throw new ServiceError(T.unknown);
  if (enabled && !entry.available) throw new ServiceError(T.unavailable);
  if (enabled && !opts.confirmed) throw new ServiceError(T.confirmRequired);
  apply(actor, (before) => {
    if (before[key] === enabled) return null;
    return {
      action: enabled ? "automation.enable" : "automation.disable",
      patch: {
        [key]: enabled,
        ...(key === "reminders" && enabled ? { remindersOpenSince: today() } : {}),
      },
      after: { key, enabled },
    };
  });
}

export function setPaused(actor: Actor, paused: boolean, opts: { confirmed: boolean }): void {
  if (!paused && !opts.confirmed) throw new ServiceError(T.confirmRequired);
  apply(actor, (before) => {
    if (before.paused === paused) return null;
    return {
      action: paused ? "automation.pause" : "automation.resume",
      patch: {
        paused,
        ...(!paused && before.reminders ? { remindersOpenSince: today() } : {}),
      },
      after: { paused },
    };
  });
}

export function setSendTime(actor: Actor, value: string): void {
  if (!SEND_TIME_PATTERN.test(value)) throw new ServiceError(T.sendTime);
  apply(actor, (before) =>
    before.sendTime === value
      ? null
      : { action: "automation.send_time", patch: { sendTime: value }, after: { sendTime: value } },
  );
}

export function setDailyDigest(actor: Actor, enabled: boolean): void {
  apply(actor, (before) =>
    before.dailyDigest === enabled
      ? null
      : {
          action: "automation.daily_digest",
          patch: { dailyDigest: enabled },
          after: { dailyDigest: enabled },
        },
  );
}
