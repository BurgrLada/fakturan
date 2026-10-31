import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { canTakePayment, deriveStatus } from "@/lib/payments";
import { INVOICE_STATUSES } from "@/lib/invoice";

const SENT_AT = new Date("2026-03-01T10:00:00Z");

describe("stav z plateb", () => {
  test("výsledek nezávisí na předchozím stavu", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5_000_000 }),
        fc.integer({ min: 0, max: 5_000_000 }),
        fc.boolean(),
        (paidMinor, totalMinor, wasSent) => {
          const sentAt = wasSent ? SENT_AT : null;
          const results = INVOICE_STATUSES.filter(canTakePayment).map((status) =>
            deriveStatus({ status, sentAt, totalMinor, paidMinor }),
          );
          expect(new Set(results).size).toBe(1);
        },
      ),
    );
  });
});
