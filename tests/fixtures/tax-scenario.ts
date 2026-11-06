import { eq } from "drizzle-orm";
import type { Db } from "@/server/db";
import { invoice } from "@/server/db/schema";
import { finalOf } from "@/server/services/invoice-balance";
import { getInvoice } from "@/server/services/invoices";
import { addRefund } from "@/server/services/payments";
import { webActor } from "../helpers/fixtures-mail";
import { externalInvoice } from "./external-invoice";
import {
  at,
  creditNote,
  issue,
  issuedDocument,
  namedCustomer,
  pay,
  reportOwner,
  seedReportScenario,
  type ReportScenario,
} from "./report-scenario";

export const TAX_TODAY = "2027-01-10";

export type TaxScenario = {
  base: ReportScenario;
  owner: string;
  ids: Record<"h" | "iAdvance" | "iFinal" | "j" | "jNote" | "k" | "l" | "m", string>;
};

// The report scenario stays as it is, so its 2026 numbers (REP tests) hold here too. Cases H to M
// live in a second account: each of them moves a year on its own and would blur those numbers.
export function seedTaxScenario(db: Db): TaxScenario {
  const base = seedReportScenario(db);
  const owner = reportOwner(db, "2025-12-01");
  const client = namedCustomer(owner, "Delta s.r.o.");

  const k = issuedDocument(owner, client, { issueDate: "2025-12-01", totalMinor: 300_000 });
  pay(owner, k, "2025-12-20", 300_000);
  const j = issuedDocument(owner, client, {
    issueDate: "2025-12-15",
    dueDate: "2025-12-29",
    totalMinor: 200_000,
  });
  const h = issuedDocument(owner, client, {
    issueDate: "2025-12-20",
    dueDate: "2026-01-03",
    totalMinor: 100_000,
  });
  pay(owner, h, "2026-01-03", 100_000);
  const jNote = creditNote(owner, j, "2026-01-02", -50_000);
  at("2026-01-15");
  addRefund(webActor(owner), k, {
    revision: getInvoice(owner, k)!.revision,
    paidOn: "2026-01-15",
    amountMinor: 300_000,
    currency: "CZK",
    method: "transfer",
    note: "Vrácení",
  });

  at("2026-03-15");
  const l = externalInvoice(db, owner, {
    number: "IMP-L-1",
    totalMinor: 120_000,
    issueDate: "2026-03-01",
    dueDate: "2026-03-15",
    customerName: "Import a.s.",
    paid: "full",
  });

  const m = issuedDocument(owner, client, {
    issueDate: "2026-08-03",
    dueDate: "2026-08-17",
    totalMinor: 10_000,
    currency: "EUR",
    rateMicros: 25_000_000,
  });
  pay(owner, m, "2026-08-10", 10_000, "EUR");

  const iAdvance = issuedDocument(owner, client, {
    type: "advance",
    issueDate: "2026-12-14",
    dueDate: "2026-12-28",
    totalMinor: 500_000,
  });
  pay(owner, iAdvance, "2026-12-28", 500_000);
  const draft = finalOf(db, owner, iAdvance)!;
  db.update(invoice)
    .set({ issueDate: "2027-01-05", dueDate: "2027-01-19" })
    .where(eq(invoice.id, draft.id))
    .run();
  at("2027-01-05");
  const iFinal = issue(owner, draft.id);

  at(TAX_TODAY);
  return { base, owner, ids: { h, iAdvance, iFinal, j, jNote, k, l, m } };
}
