import { expect, test } from "vitest";
import { createTestDb } from "../helpers/db";

const db = createTestDb();

test("[ARC-003] databáze běží ve WAL a s foreign_keys", () => {
  expect(db.$client.pragma("journal_mode", { simple: true })).toBe("wal");
  expect(db.$client.pragma("foreign_keys", { simple: true })).toBe(1);
  expect(db.$client.pragma("busy_timeout", { simple: true })).toBe(5000);
});
