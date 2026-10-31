import "server-only";
import { runWithActor, type Actor } from "../audit/context";
import { recordAudit, type AuditAction, type AuditEntry } from "../audit/record";
import { db, type Tx } from "../db";

type MutationEntry = Omit<AuditEntry, "action"> & { action?: AuditAction };

export type Audit = (entry: MutationEntry) => void;

type NotThenable<T> = T extends PromiseLike<unknown> ? never : unknown;

function isThenable(value: unknown): boolean {
  return typeof (value as { then?: unknown } | null | undefined)?.then === "function";
}

export function mutate<T>(
  actor: Actor,
  action: AuditAction,
  fn: (tx: Tx, audit: Audit) => T & NotThenable<T>,
): T {
  return runWithActor(actor, () =>
    db.transaction(
      (tx) => {
        let recorded = 0;
        let open = true;
        try {
          const result = fn(tx, (entry) => {
            if (!open) throw new Error(`Audit akce ${action} po skončení transakce`);
            recordAudit(tx, { ...entry, action: entry.action ?? action });
            recorded += 1;
          });
          // A better-sqlite3 transaction commits when fn returns, so anything after an await would
          // run outside it, and a Drizzle query builder is thenable but never executes here.
          if (isThenable(result)) throw new Error(`Mutace ${action} nesmí být asynchronní`);
          if (recorded === 0) throw new Error(`Mutace ${action} nevytvořila auditní záznam`);
          return result;
        } finally {
          open = false;
        }
      },
      { behavior: "immediate" },
    ),
  );
}
