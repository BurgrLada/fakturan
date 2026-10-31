import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { canTakePayment, deriveStatus } from "@/lib/payments";
import { INVOICE_STATUSES } from "@/lib/invoice";

const SENT_AT = new Date("2026-03-01T10:00:00Z");
const payments = fc.array(fc.integer({ min: 1, max: 1_000_000 }), { maxLength: 20 });
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

describe("stav z plateb", () => {
  test("[TST-012] pro libovolnou posloupnost plateb je stav funkcí součtu", () => {
    fc.assert(
      fc.property(
        payments,
        fc.integer({ min: 0, max: 5_000_000 }),
        fc.boolean(),
        fc.constantFrom(...INVOICE_STATUSES.filter(canTakePayment)),
        (values, totalMinor, wasSent, status) => {
          const sentAt = wasSent ? SENT_AT : null;
          const paidMinor = sum(values);
          const shuffled = [...values].reverse();
          const derived = deriveStatus({ status, sentAt, totalMinor, paidMinor });

          expect(derived).toBe(
            deriveStatus({ status, sentAt, totalMinor, paidMinor: sum(shuffled) }),
          );
          if (totalMinor > 0 && paidMinor >= totalMinor) expect(derived).toBe("paid");
          else if (paidMinor > 0 && paidMinor < totalMinor) expect(derived).toBe("partially_paid");
          else expect(derived).toBe(wasSent ? "sent" : "issued");
        },
      ),
    );
  });

  test("[TST-012] výsledek nezávisí na předchozím stavu", () => {
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
