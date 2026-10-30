import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, test, vi } from "vitest";
import {
  formatNumber,
  periodKey,
  validateSeriesPeriod,
  validateTemplate,
  variableSymbolFrom,
  type ResetPeriod,
} from "@/lib/number-format";
import { user } from "@/server/db/schema";
import { mutate } from "@/server/services/mutation";
import { allocateNumber, saveSeries } from "@/server/services/number-series";
import { createTestDb } from "../helpers/db";

vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-series-prop-")));

const db = createTestDb();

const literal = fc.constantFrom("", "", "-", "/", "FV", "Z-", "7", ".");
const sequence = fc.integer({ min: 1, max: 6 }).map((width) => `{${"N".repeat(width)}}`);
const year = fc.constantFrom("{RRRR}", "{RR}");
const extra = fc.constantFrom("", "{DD}", "{MM}", "{Q}");

const parts: Record<ResetPeriod, fc.Arbitrary<string[]>> = {
  yearly: fc.tuple(year, extra).map((p) => [...p]),
  quarterly: fc.tuple(year, fc.constantFrom("{Q}", "{MM}"), extra).map((p) => [...p]),
  monthly: fc.tuple(year, fc.constant("{MM}"), extra).map((p) => [...p]),
  never: fc.tuple(extra).map((p) => [...p]),
};

// Shuffled, so the sequence can land between period tokens as well as at either end.
const validSeries = fc
  .constantFrom<ResetPeriod>(...(Object.keys(parts) as ResetPeriod[]))
  .chain((reset) =>
    fc
      .tuple(parts[reset], sequence)
      .chain(([tokens, n]) => fc.shuffledSubarray([...tokens, n], { minLength: tokens.length + 1 }))
      .chain((tokens) =>
        fc
          .array(literal, { minLength: tokens.length + 1, maxLength: tokens.length + 1 })
          .map((texts) => ({
            reset,
            template: tokens.reduce((out, token, i) => `${out}${token}${texts[i + 1]}`, texts[0]!),
          })),
      ),
  );

const date = fc
  .date({ min: new Date("2000-01-01"), max: new Date("2099-12-31"), noInvalidDate: true })
  .map((value) => value.toISOString().slice(0, 10));

let runs = 0;

describe("vlastnosti číselných řad", () => {
  test("[NUM-005] [NUM-002] libovolná platná šablona a data dají unikátní a v období rostoucí čísla", () => {
    fc.assert(
      fc.property(validSeries, fc.array(date, { minLength: 1, maxLength: 25 }), (series, dates) => {
        expect(validateTemplate(series.template)).toBeNull();
        expect(validateSeriesPeriod(series.template, series.reset)).toBeNull();

        runs += 1;
        const ownerId = `prop-${runs}`;
        const now = new Date();
        db.insert(user)
          .values({
            id: ownerId,
            name: ownerId,
            email: `${ownerId}@example.cz`,
            createdAt: now,
            updatedAt: now,
          })
          .run();
        const actor = { userId: ownerId, source: "web" as const };
        const id = saveSeries(actor, { name: "P", documentType: "invoice", ...series });

        const seen = new Set<string>();
        const last = new Map<string, number>();
        for (const day of dates) {
          const { number, n } = mutate(actor, "number_series.test_allocate", (tx, audit) => {
            const result = allocateNumber(tx, ownerId, id, day);
            audit({ entity: "number_series", entityId: id, ownerId, scope: "user" });
            return result;
          });
          const key = periodKey(series.reset, day);
          expect(n).toBe((last.get(key) ?? 0) + 1);
          last.set(key, n);
          expect(seen.has(number), `${series.template}: ${number}`).toBe(false);
          seen.add(number);
        }
      }),
      { numRuns: 150 },
    );
  }, 60_000);

  test("[NUM-001] formatNumber nikdy nezkrátí pořadí", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 6 }), date, fc.nat(), (width, day, raw) => {
        const n = raw + 1;
        const formatted = formatNumber(`{${"N".repeat(width)}}`, day, n);

        expect(Number(formatted)).toBe(n);
        expect(formatted.length).toBe(Math.max(width, String(n).length));
      }),
    );
  });

  test("[NUM-007] variabilní symbol má jen číslice a nejvýš 10 znaků", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), (number) => {
        expect(variableSymbolFrom(number)).toMatch(/^\d{0,10}$/);
      }),
    );
  });

  test("[NUM-007] variabilní symbol zachová posledních 10 číslic čísla", () => {
    fc.assert(
      fc.property(validSeries, date, fc.integer({ min: 1, max: 999_999 }), (series, day, n) => {
        const number = formatNumber(series.template, day, n);
        const digits = number.replace(/\D/g, "");

        expect(variableSymbolFrom(number)).toBe(digits.slice(-10));
        expect(digits.endsWith(variableSymbolFrom(number))).toBe(true);
      }),
    );
  });
});
