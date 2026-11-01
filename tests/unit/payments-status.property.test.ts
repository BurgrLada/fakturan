import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { canAmendPayment, canTakePayment, deriveStatus } from "@/lib/payments";
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
            deriveStatus({
              status,
              sentAt,
              totalMinor,
              paidMinor,
              creditsMinor: 0,
              advanceMinor: 0,
            }),
          );
          expect(new Set(results).size).toBe(1);
        },
      ),
    );
  });

  test("[TST-012] stav je funkcí součtů a nezávisí na předchozím stavu včetně credited", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5_000_000 }),
        fc.integer({ min: 0, max: 5_000_000 }),
        fc.integer({ min: 0, max: 5_000_000 }),
        fc.integer({ min: 0, max: 5_000_000 }),
        fc.boolean(),
        (totalMinor, paidMinor, credit, advanceMinor, wasSent) => {
          const input = {
            sentAt: wasSent ? SENT_AT : null,
            totalMinor,
            paidMinor,
            creditsMinor: -credit,
            advanceMinor,
          };
          const results = INVOICE_STATUSES.filter(canAmendPayment).map((status) =>
            deriveStatus({ status, ...input }),
          );
          expect(new Set(results).size).toBe(1);
        },
      ),
    );
  });

  test("[TST-012] úplná oprava bez plateb je credited a jinak nikdy", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5_000_000 }),
        fc.integer({ min: 0, max: 5_000_000 }),
        fc.integer({ min: 0, max: 5 }),
        (totalMinor, paidMinor, advanceMinor) => {
          const creditsMinor = -totalMinor;
          const status = deriveStatus({
            status: "sent",
            sentAt: SENT_AT,
            totalMinor,
            paidMinor,
            creditsMinor,
            advanceMinor,
          });
          expect(status === "credited").toBe(paidMinor === 0 && advanceMinor === 0);
        },
      ),
    );
  });
});
