import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { PaymentInput } from "@/lib/payments";
import { setClockForTests } from "@/server/clock";
import { ServiceError } from "@/server/services/access";
import { getInvoice } from "@/server/services/invoices";
import {
  addPayment,
  addRefund,
  deletePayment,
  listPayments,
  updatePayment,
} from "@/server/services/payments";
import { assertConsistent } from "../helpers/consistency";
import { createTestDb } from "../helpers/db";
import { issuedInvoice, seedOwner, webActor } from "../helpers/fixtures-mail";

vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-payments-property-")));

const db = createTestDb();
const NOW = new Date("2026-03-20T10:00:00Z");
const TOTAL = 300_000;

type Step =
  | { kind: "add"; amountMinor: number }
  | { kind: "refund"; amountMinor: number }
  | { kind: "update"; index: number; amountMinor: number }
  | { kind: "delete"; index: number };

const amount = fc.integer({ min: 1, max: 200_000 });
const index = fc.nat({ max: 20 });
const step: fc.Arbitrary<Step> = fc.oneof(
  fc.record({ kind: fc.constant("add" as const), amountMinor: amount }),
  fc.record({ kind: fc.constant("refund" as const), amountMinor: amount }),
  fc.record({ kind: fc.constant("update" as const), index, amountMinor: amount }),
  fc.record({ kind: fc.constant("delete" as const), index }),
);

beforeAll(() => setClockForTests({ now: () => NOW }));
afterAll(() => setClockForTests(null));

describe("stav z plateb", () => {
  test("[TST-012] pro libovolnou posloupnost plateb je stav funkcí součtu", () => {
    const owner = seedOwner(db, NOW);

    fc.assert(
      fc.property(fc.array(step, { maxLength: 12 }), (steps) => {
        const id = issuedInvoice(owner);
        const actor = webActor(owner);
        const revision = () => getInvoice(owner, id)!.revision;
        const input = (amountMinor: number): PaymentInput => ({
          revision: revision(),
          paidOn: "2026-03-20",
          amountMinor,
          currency: "CZK",
          method: "transfer",
          note: "",
        });

        for (const item of steps) {
          const rows = listPayments(owner, id);
          // Each step may be refused for lowering the sum under zero, which must change nothing.
          try {
            if (item.kind === "add") addPayment(actor, id, input(item.amountMinor));
            else if (item.kind === "refund") addRefund(actor, id, input(item.amountMinor));
            else {
              const target = rows[item.index % (rows.length || 1)];
              if (target && item.kind === "update") {
                updatePayment(actor, target.id, input(item.amountMinor));
              } else if (target) deletePayment(actor, target.id, revision());
            }
          } catch (error) {
            if (!(error instanceof ServiceError)) throw error;
          }

          const paid = listPayments(owner, id).reduce((sum, p) => sum + p.creditedMinor, 0);
          const { status, paidMinor } = getInvoice(owner, id)!;
          expect(paidMinor).toBe(paid);
          expect(paid).toBeGreaterThanOrEqual(0);
          if (paid >= TOTAL) expect(status).toBe("paid");
          else expect(status).toBe(paid > 0 ? "partially_paid" : "issued");
        }
      }),
      { numRuns: 40 },
    );
    assertConsistent(db, owner);
  });
});
