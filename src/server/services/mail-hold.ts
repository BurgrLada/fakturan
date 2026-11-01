import "server-only";
import { eq, type SQL } from "drizzle-orm";
import { clock } from "../clock";
import type { Tx } from "../db";
import { emailLog, invoice } from "../db/schema";
import { scoped } from "../db/scoped";
import type { Audit } from "./mutation";
import { notify } from "./notifications";

export const mailNoticeKey = (logId: string) => `mail:${logId}`;
export const receiptNoticeKey = (paymentId: string) => `receipt:${paymentId}`;

// Only `queued`: what is sending or sent can no longer be recalled. The job stays behind and finds
// a record that is no longer queued, so a later resume cannot release the message.
export function holdQueuedMail(
  tx: Tx,
  audit: Audit,
  userId: string,
  which: (t: typeof emailLog) => SQL | undefined,
  { reason, quiet }: { reason: string; quiet: boolean },
): void {
  const queued = (t: typeof emailLog) =>
    scoped(userId).where(t, (row, { and, eq: is }) => and(is(row.status, "queued"), which(row)));
  const rows = tx
    .select({ log: emailLog, number: invoice.number })
    .from(emailLog)
    .innerJoin(invoice, eq(invoice.id, emailLog.invoiceId))
    .where(queued(emailLog))
    .all();
  tx.update(emailLog)
    .set({ status: "held", reason, updatedAt: clock.now() })
    .where(queued(emailLog))
    .run();
  for (const { log, number } of rows) {
    if (!quiet) {
      notify(tx, {
        userId,
        kind: "mail_held",
        dedupeKey: mailNoticeKey(log.id),
        params: { invoice: number },
        entity: { type: "invoice", id: log.invoiceId },
      });
    }
    audit({
      action: "mail.held",
      entity: "invoice",
      entityId: log.invoiceId,
      ownerId: userId,
      scope: "user",
      after: { logId: log.id, kind: log.kind, status: "held", trigger: log.trigger },
    });
  }
}
