import "server-only";
import { isNull } from "drizzle-orm";
import { z } from "zod";
import { CURRENCIES } from "@/lib/currency";
import { MAX_EXCHANGE_RATE_MICROS } from "@/lib/fx";
import { MAX_DOCUMENT_MINOR, ROUNDING_MODES } from "@/lib/invoice-totals";
import {
  ADVANCE_FINAL_MODES,
  DATE_FORMATS,
  DEFAULT_PREFERENCES,
  FX_BASES,
  ISSUE_DATE_MODES,
  LANGUAGES,
  LOGO_POSITIONS,
  PAYMENT_METHODS,
  TURNOVER_BASES,
  VARIABLE_SYMBOL_FORMATS,
  type Preferences,
} from "@/lib/preferences";
import { TEXTS } from "@/lib/texts";
import { isDesignId } from "../pdf/designs";
import type { Actor } from "../audit/context";
import { clock } from "../clock";
import { db } from "../db";
import { preferences } from "../db/schema";
import { scoped } from "../db/scoped";
import { ServiceError } from "./access";
import { mutate } from "./mutation";

const V = TEXTS.preferences.validation;
const FOREIGN: ReadonlySet<string> = new Set(CURRENCIES.filter((code) => code !== "CZK"));
const text = (max: number) => z.string().trim().max(max, V.tooLong);

export const colorSchema = z.string(V.accentColor).regex(/^(#[0-9a-fA-F]{6})?$/, V.accentColor);
export const designIdSchema = z
  .string(V.designId)
  .trim()
  .regex(/^[a-z0-9-]{1,40}$/, V.designId);
export const knownDesignIdSchema = designIdSchema.refine(isDesignId, V.designId);
export const logoPositionSchema = z.enum(LOGO_POSITIONS, V.logoPosition);

const limitSchema = z
  .number(V.turnoverLimit)
  .int(V.turnoverLimit)
  .min(1, V.turnoverLimit)
  .max(MAX_DOCUMENT_MINOR, V.turnoverLimit)
  .nullable();

export const preferencesSchema = z.object({
  dueDays: z.number(V.dueDays).int(V.dueDays).min(0, V.dueDays).max(365, V.dueDays),
  language: z.enum(LANGUAGES, V.language),
  currency: z.enum(CURRENCIES, V.currency),
  designId: knownDesignIdSchema,
  accentColor: colorSchema,
  surfaceColor: colorSchema,
  textColor: colorSchema,
  lineColor: colorSchema,
  logoPosition: logoPositionSchema,
  paymentMethod: z.enum(PAYMENT_METHODS, V.paymentMethod),
  unit: text(20).min(1, V.unit),
  showLogo: z.boolean(),
  showQr: z.boolean(),
  showQrLogo: z.boolean(),
  showSignature: z.boolean(),
  showDuzp: z.boolean(),
  textBefore: text(2000),
  textAfter: text(2000),
  note: text(2000),
  issueDateMode: z.enum(ISSUE_DATE_MODES, V.issueDateMode),
  dateFormat: z.enum(DATE_FORMATS, V.dateFormat),
  variableSymbolFormat: z.enum(VARIABLE_SYMBOL_FORMATS, V.variableSymbolFormat),
  rounding: z.enum(ROUNDING_MODES, V.rounding),
  pdfFileName: z
    .string(V.pdfFileName)
    .trim()
    .max(100, V.tooLong)
    .regex(/^[^/\\\p{Cc}\p{Zl}\p{Zp}]+$/u, V.pdfFileName),
  fxBasis: z.enum(FX_BASES, V.fxBasis),
  fixedRates: z.record(
    z.string(V.fixedRates).refine((code) => FOREIGN.has(code), V.fixedRates),
    z
      .number(V.fixedRates)
      .int(V.fixedRates)
      .positive(V.fixedRates)
      .max(MAX_EXCHANGE_RATE_MICROS, V.fixedRates),
    V.fixedRates,
  ),
  advanceFinalMode: z.enum(ADVANCE_FINAL_MODES, V.advanceFinalMode),
  turnoverVatLimitMinor: limitSchema,
  turnoverFlatLimitMinor: limitSchema,
  turnoverBasis: z.enum(TURNOVER_BASES, V.turnoverBasis),
});

export const preferencesPatchSchema = preferencesSchema.partial();

export type PreferencesPatch = z.input<typeof preferencesPatchSchema>;

function ownerOf(actor: Actor): string {
  if (!actor.userId) throw new ServiceError(TEXTS.preferences.forbidden);
  return actor.userId;
}

function readRow(ownerId: string) {
  return db.select().from(preferences).where(scoped(ownerId).where(preferences)).get();
}

function merged(row: ReturnType<typeof readRow>): Preferences {
  if (!row) return { ...DEFAULT_PREFERENCES };
  const result = { ...DEFAULT_PREFERENCES };
  for (const key of Object.keys(DEFAULT_PREFERENCES) as (keyof Preferences)[]) {
    (result as Record<string, unknown>)[key] = row[key];
  }
  // A design removed from the registry must not make every later save fail validation.
  if (!isDesignId(result.designId)) result.designId = DEFAULT_PREFERENCES.designId;
  return result;
}

export function getPreferences(ownerId: string): Preferences {
  return merged(readRow(ownerId));
}

export function isOnboarded(ownerId: string): boolean {
  return readRow(ownerId)?.onboardingCompletedAt != null;
}

export function savePreferences(actor: Actor, raw: PreferencesPatch): void {
  const userId = ownerOf(actor);
  const patch = preferencesPatchSchema.safeParse(raw);
  if (!patch.success) {
    throw new ServiceError(patch.error.issues[0]?.message ?? TEXTS.preferences.validation.invalid);
  }
  mutate(actor, "preferences.save", (tx, audit) => {
    const row = tx.select().from(preferences).where(scoped(userId).where(preferences)).get();
    const before = merged(row);
    const parsed = preferencesSchema.safeParse({ ...before, ...patch.data });
    if (!parsed.success) {
      throw new ServiceError(parsed.error.issues[0]?.message ?? V.invalid);
    }
    const values = parsed.data;
    tx.insert(preferences)
      .values({ userId, ...values, updatedAt: clock.now() })
      .onConflictDoUpdate({
        target: preferences.userId,
        set: { ...values, updatedAt: clock.now() },
      })
      .run();
    audit({
      entity: "preferences",
      entityId: userId,
      ownerId: userId,
      scope: "user",
      before,
      after: values,
    });
  });
}

class AlreadyOnboarded extends Error {}

export function completeOnboarding(actor: Actor): void {
  const userId = ownerOf(actor);
  try {
    mutate(actor, "preferences.onboarding_complete", (tx, audit) => {
      const row = tx.select().from(preferences).where(scoped(userId).where(preferences)).get();
      // Thrown to roll back: mutate refuses a transaction without an audit entry.
      if (row?.onboardingCompletedAt) throw new AlreadyOnboarded();
      const at = clock.now();
      tx.insert(preferences)
        .values({ userId, updatedAt: at, onboardingCompletedAt: at })
        .onConflictDoUpdate({
          target: preferences.userId,
          set: { onboardingCompletedAt: at, updatedAt: at },
          setWhere: isNull(preferences.onboardingCompletedAt),
        })
        .run();
      audit({
        entity: "preferences",
        entityId: userId,
        ownerId: userId,
        scope: "user",
        after: { onboardingCompletedAt: at.toISOString() },
      });
    });
  } catch (error) {
    if (!(error instanceof AlreadyOnboarded)) throw error;
  }
}
