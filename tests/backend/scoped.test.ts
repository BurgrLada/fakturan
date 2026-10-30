import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
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

db.$client.exec("CREATE TABLE note (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, body TEXT)");
const note = sqliteTable("note", {
  id: text().primaryKey(),
  ownerId: text("owner_id"),
  body: text(),
});

function createNote(ownerId: string): string {
  const id = randomUUID();
  db.insert(note).values({ id, ownerId, body: "původní" }).run();
  return id;
}

const scopedNote = {
  create: createNote,
  find: (ownerId: string, id: string) =>
    db
      .select()
      .from(note)
      .where(scoped(ownerId).where(note, (t, { eq }) => eq(t.id, id)))
      .get(),
  update: (ownerId: string, id: string) =>
    db
      .update(note)
      .set({ body: "změněno" })
      .where(scoped(ownerId).where(note, (t, { eq }) => eq(t.id, id)))
      .run().changes,
  remove: (ownerId: string, id: string) =>
    db
      .delete(note)
      .where(scoped(ownerId).where(note, (t, { eq }) => eq(t.id, id)))
      .run().changes,
};

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

  test("[SEC-002] cizí úprava a smazání nic nezmění, vlastní projdou", async () => {
    await assertIsolated(scopedNote);
  });

  test("[SEC-002] odmítnutí cizího zápisu výjimkou se počítá jako izolace", async () => {
    const guarded = (write: (ownerId: string, id: string) => number) => {
      return (ownerId: string, id: string) => {
        if (!scopedNote.find(ownerId, id)) throw new Error("Záznam neexistuje");
        return write(ownerId, id);
      };
    };
    await assertIsolated({
      ...scopedNote,
      update: guarded(scopedNote.update),
      remove: guarded(scopedNote.remove),
    });
  });

  test("[SEC-002] assertIsolated selže, když cizí úprava projde", async () => {
    const leaky = assertIsolated({
      ...scopedNote,
      update: (_owner, id) =>
        db.update(note).set({ body: "změněno" }).where(eq(note.id, id)).run().changes,
    });
    await expect(leaky).rejects.toThrow("cizí záznam");
  });

  test("[SEC-002] assertIsolated selže, když cizí úprava změní řádek a nepřizná to", async () => {
    const leaky = assertIsolated({
      ...scopedNote,
      update: (ownerId, id) => {
        db.update(note).set({ body: "změněno" }).where(eq(note.id, id)).run();
        return ownerId === "nikdo" ? 1 : 0;
      },
    });
    await expect(leaky).rejects.toThrow();
  });

  test("[SEC-002] assertIsolated selže, když cizí smazání projde", async () => {
    const leaky = assertIsolated({
      ...scopedNote,
      remove: (_owner, id) => db.delete(note).where(eq(note.id, id)).run().changes,
    });
    await expect(leaky).rejects.toThrow("cizí záznam");
  });

  test("[SEC-002] assertIsolated selže, když zápis nefunguje ani vlastníkovi", async () => {
    await expect(assertIsolated({ ...scopedNote, update: () => 0 })).rejects.toThrow("vlastní");
    await expect(assertIsolated({ ...scopedNote, remove: () => 0 })).rejects.toThrow("vlastní");
  });
});
