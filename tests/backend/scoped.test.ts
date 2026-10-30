import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { listAuditForOwner } from "@/server/audit/read";
import { auditLog } from "@/server/db/schema";
import { scoped } from "@/server/db/scoped";
import { mutate } from "@/server/services/mutation";
import { assertIsolated } from "../helpers/isolation";
import { createTestDb } from "../helpers/db";

const db = createTestDb();

function writeAudit(ownerId: string): number {
  return mutate({ userId: ownerId, source: "web" }, "note.create", (tx, audit) => {
    audit({ entity: "note", entityId: randomUUID(), ownerId, scope: "user" });
    return tx.select().from(auditLog).all().at(-1)!.id;
  });
}

describe("scoped", () => {
  test("[SEC-002] scoped nevrátí řádek cizího uživatele", () => {
    const [a, b] = [randomUUID(), randomUUID()];
    const idA = writeAudit(a);
    writeAudit(b);

    const rows = db.select().from(auditLog).where(scoped(a).where(auditLog)).all();

    expect(rows.map((r) => r.id)).toEqual([idA]);
  });

  test("[SEC-002] scoped odmítne prázdné ID vlastníka", () => {
    expect(() => scoped("")).toThrow();
    expect(() => scoped(undefined as unknown as string)).toThrow();
  });

  test("[SEC-002] doplňující podmínka se k omezení na vlastníka přidává, nenahrazuje ho", () => {
    const [a, b] = [randomUUID(), randomUUID()];
    const idB = writeAudit(b);
    writeAudit(a);

    const rows = db
      .select()
      .from(auditLog)
      .where(scoped(a).where(auditLog, (t, { eq }) => eq(t.id, idB)))
      .all();

    expect(rows).toEqual([]);
  });

  test("[SEC-002] čtení auditu je izolované mezi vlastníky", async () => {
    await assertIsolated({
      create: (ownerId) => writeAudit(ownerId),
      find: (ownerId, id) => listAuditForOwner(ownerId).filter((r) => r.id === id),
      list: (ownerId) => listAuditForOwner(ownerId).map((r) => r.id),
    });
  });

  test("[SEC-002] assertIsolated selže, když čtení cizí řádek vrací", async () => {
    const leaky = assertIsolated({
      create: (ownerId) => writeAudit(ownerId),
      find: (_owner, id) =>
        db
          .select()
          .from(auditLog)
          .all()
          .filter((r) => r.id === id),
    });
    await expect(leaky).rejects.toThrow();
  });
});
