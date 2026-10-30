import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { auditLog } from "@/server/db/schema";
import { assertConsistent } from "../helpers/consistency";
import { createTestDb } from "../helpers/db";

const db = createTestDb();

function createUser(): string {
  const id = randomUUID();
  db.$client
    .prepare(
      "INSERT INTO user (id, name, email, created_at, updated_at) VALUES (?, 'Test', ?, 0, 0)",
    )
    .run(id, `${id}@example.test`);
  return id;
}

function createSeries(ownerId: string): string {
  const id = randomUUID();
  db.$client
    .prepare(
      "INSERT INTO number_series (id, user_id, name, document_type, template, reset, is_default, created_at, updated_at) VALUES (?, ?, 'Řada', 'invoice', '{YYYY}{NNNN}', 'yearly', 0, 0, 0)",
    )
    .run(id, ownerId);
  return id;
}

describe("assertConsistent", () => {
  test("[TST-018] prochází na čistém účtu", () => {
    const owner = createUser();
    const series = createSeries(owner);
    db.$client
      .prepare(
        "INSERT INTO number_series_counter (series_id, period_key, user_id, next) VALUES (?, '2026', ?, 1)",
      )
      .run(series, owner);
    db.insert(auditLog)
      .values({
        at: new Date(),
        source: "web",
        scope: "user",
        ownerId: owner,
        action: "a",
        entity: "e",
      })
      .run();

    expect(() => assertConsistent(db, owner)).not.toThrow();
  });

  test("[TST-018] kontrola souladu odhalí ručně poškozený řádek", () => {
    const owner = createUser();
    const stranger = createUser();
    const foreignSeries = createSeries(stranger);

    db.$client.pragma("foreign_keys = OFF");
    db.$client
      .prepare(
        "INSERT INTO number_series_counter (series_id, period_key, user_id, next) VALUES (?, '2026', ?, 1)",
      )
      .run(foreignSeries, owner);
    db.$client.pragma("foreign_keys = ON");

    expect(() => assertConsistent(db, owner)).toThrow(/number_series_counter/);
    expect(() => assertConsistent(db, stranger)).not.toThrow();
  });

  test("[TST-018] odhalí řádek patřící neexistujícímu účtu", () => {
    const ghost = randomUUID();
    db.$client.pragma("foreign_keys = OFF");
    db.run(
      sql`INSERT INTO unit (id, user_id, name, position, created_at) VALUES (${randomUUID()}, ${ghost}, 'ks', 0, 0)`,
    );
    db.$client.pragma("foreign_keys = ON");

    expect(() => assertConsistent(db, ghost)).toThrow(/unit/);
  });

  // Last on purpose: audit_log is append-only, so the orphan row stays in this file's database.
  test("[TST-018] odhalí uživatelský auditní záznam bez vlastníka", () => {
    const owner = createUser();
    db.insert(auditLog)
      .values({
        at: new Date(),
        source: "web",
        scope: "user",
        ownerId: null,
        action: "a",
        entity: "e",
      })
      .run();

    expect(() => assertConsistent(db, owner)).toThrow(/audit_log/);
  });
});
